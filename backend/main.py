"""Single-worker HTTPS receiver and static frontend host."""

import asyncio
from collections import deque
from contextlib import asynccontextmanager
import logging
from pathlib import Path
import secrets
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .config import Config
from .cursor import Cursor
from .motion import Motion
from .protocol import (
    Auth, Button, Calibration, CameraFrame, Ping, Release, Sample, Settings, Touch, Tracking, incoming,
)

log = logging.getLogger("motionmouse")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    app.state.config = Config.load()
    app.state.cursor = Cursor(app.state.config.output)
    app.state.controller = False
    try:
        yield
    finally:
        app.state.cursor.close()


app = FastAPI(title="MotionMouse", lifespan=lifespan, docs_url=None, redoc_url=None)


class Session:
    def __init__(self, socket: WebSocket, config: Config, cursor: Cursor):
        self.socket, self.config, self.cursor = socket, config, cursor
        self.motion = Motion(config)
        self.mode = "inertial"
        self.sensitivity = 1.0
        self.tracking = False
        self.start_after_calibration = False
        self.last_ping = time.monotonic()
        self.last_sample = 0.0
        self.calibration_started = 0.0
        self.last_diagnostic = 0.0
        self.last_seq = -1
        self.last_phone_time = -1.0
        self.phone_offset: float | None = None
        self.last_camera = 0.0
        self.camera_quality = 0.0
        self.camera_bad_frames = 0
        self.camera_seq = -1
        self.camera_phone_time = -1.0
        self.camera_offset: float | None = None
        self.rate: deque[float] = deque()

    async def send(self, kind: str, **payload) -> None:
        # A slow/dead client must not block the input watchdog indefinitely.
        await asyncio.wait_for(self.socket.send_json({"v": 1, "type": kind, **payload}), timeout=0.25)

    async def state(self) -> None:
        age = time.monotonic() - self.last_sample if self.last_sample else None
        fresh = age is not None and age <= self.config.stream_timeout
        camera_fresh = bool(self.last_camera and time.monotonic() - self.last_camera <= self.config.stream_timeout)
        if self.tracking:
            readiness = "Tracking active. Keep orientation steady."
        elif self.motion.calibrating:
            readiness = "Calibration in progress. Leave the phone flat and still."
        elif self.mode == "touchpad":
            readiness = "Ready to start touchpad control."
        elif self.mode == "camera":
            readiness = ("Camera ready. Tap Start tracking." if camera_fresh and self.camera_quality >= 0.6
                         else "Enable the rear camera and aim at a textured surface. Wait for visual tracking Ready.")
        elif not fresh:
            readiness = "Waiting for fresh sensor samples on the laptop. Enable sensors and keep this page visible."
        elif not self.motion.calibrated:
            readiness = "Sensors received. Calibrate first, or tap Calibrate & start tracking."
        else:
            readiness = "Calibration ready. Tap Start tracking."
        await self.send("state", mode=self.mode, sensitivity=self.sensitivity,
                        tracking=self.tracking, output=self.config.output,
                        sensor_fresh=fresh,
                        sensor_age_ms=round(age * 1000) if age is not None else None,
                        start_after_calibration=self.start_after_calibration,
                        readiness=readiness,
                        camera_fresh=camera_fresh, camera_quality=self.camera_quality,
                        **self.motion.diagnostics())

    def pause(self, reason: str, invalidate: bool = False) -> None:
        self.tracking = False
        self.start_after_calibration = False
        self.camera_bad_frames = 0
        self.cursor.release()
        if invalidate or self.motion.calibrating:
            self.motion.invalidate(reason)
        else:
            self.motion.reset(reason)
        self.motion.last_t = None

    def calibrate(self, start_after: bool) -> None:
        if self.mode != "inertial":
            raise ValueError("Select Inertial mode before calibrating")
        if time.monotonic() - self.last_sample > self.config.stream_timeout:
            raise ValueError("The laptop is not receiving fresh sensor samples. Enable sensors and check your connection.")
        self.pause("Calibration started")
        self.motion.begin_calibration()
        self.start_after_calibration = start_after
        self.calibration_started = time.monotonic()

    async def handle(self, message) -> None:
        now = time.monotonic()
        if isinstance(message, Ping):
            self.last_ping = now
            await self.send("pong", t=message.t)
        elif isinstance(message, Release):
            self.pause("Control released; start tracking manually to resume", invalidate=True)
            await self.state()
        elif isinstance(message, Settings):
            if message.mode != self.mode:
                self.last_sample = 0.0
                self.last_seq = -1
                self.last_phone_time = -1.0
                self.phone_offset = None
                self.last_camera = 0.0
                self.camera_quality = 0.0
                self.camera_seq = -1
                self.camera_phone_time = -1.0
                self.camera_offset = None
            self.pause("Settings changed; start tracking to resume", invalidate=message.mode != self.mode)
            self.mode = message.mode
            self.sensitivity = message.sensitivity
            await self.state()
        elif isinstance(message, Calibration):
            self.calibrate(start_after=False)
            await self.state()
        elif isinstance(message, Tracking):
            if not message.enabled:
                self.pause("Tracking stopped")
            else:
                if self.motion.calibrating:
                    # A repeated tap must not cancel an in-flight calibration.
                    await self.state()
                    return
                if self.mode == "inertial":
                    if now - self.last_sample > self.config.stream_timeout:
                        raise ValueError("Wait for fresh sensor samples on the laptop before starting")
                    if not self.motion.calibrated:
                        if message.calibrate_if_needed:
                            self.calibrate(start_after=True)
                            await self.state()
                            return
                        raise ValueError("Calibration is required. Keep the phone flat and tap Calibrate.")
                elif self.mode == "camera":
                    if now - self.last_camera > self.config.stream_timeout or self.camera_quality < 0.6:
                        raise ValueError("Camera is not ready. Enable the rear camera and aim at a textured surface.")
                    self.camera_bad_frames = 0
                self.motion.reset("Tracking active")
                self.tracking = True
            await self.state()
        elif isinstance(message, Sample):
            if self.mode != "inertial":
                return
            if message.seq <= self.last_seq or message.t <= self.last_phone_time:
                raise ValueError("Out-of-order sensor sample; tracking paused")
            self.last_seq, self.last_phone_time = message.seq, message.t
            offset = now - message.t / 1000
            self.phone_offset = offset if self.phone_offset is None else min(self.phone_offset, offset)
            if offset - self.phone_offset > self.config.max_sample_delay:
                self.pause("Delayed sensor sample discarded. Wait for live readings and start again.")
                return
            self.last_sample = now
            if self.mode == "inertial":
                was_calibrating = self.motion.calibrating
                dx, dy = self.motion.feed(message, self.tracking, self.sensitivity)
                if was_calibrating and not self.motion.calibrating and self.motion.calibrated:
                    if self.start_after_calibration:
                        self.start_after_calibration = False
                        self.motion.reset("Tracking active after calibration")
                        self.tracking = True
                    await self.state()
                if self.tracking:
                    self.cursor.move(dx, dy)
        elif isinstance(message, Button):
            if message.down and self.motion.calibrating:
                raise ValueError("Mouse buttons are disabled during calibration")
            self.cursor.button(message.button, message.down)
        elif isinstance(message, Touch):
            if self.mode == "touchpad" and self.tracking:
                self.cursor.move(message.dx * self.sensitivity, message.dy * self.sensitivity)
        elif isinstance(message, CameraFrame):
            if self.mode != "camera":
                return
            if message.seq <= self.camera_seq or message.t <= self.camera_phone_time:
                raise ValueError("Out-of-order camera frame; tracking paused")
            self.camera_seq, self.camera_phone_time = message.seq, message.t
            offset = now - message.t / 1000
            self.camera_offset = offset if self.camera_offset is None else min(self.camera_offset, offset)
            if offset - self.camera_offset > self.config.max_sample_delay:
                self.pause("Delayed camera motion discarded. Wait for Ready, then start again.")
                self.camera_quality = 0.0
                return
            self.last_camera = now
            self.camera_quality = message.quality
            if message.quality < 0.6:
                self.camera_bad_frames += 1
                if self.tracking and self.camera_bad_frames >= 3:
                    self.pause("Visual tracking lost. Aim at a textured surface and start again.")
                    await self.state()
                return
            self.camera_bad_frames = 0
            if self.tracking:
                # Already relative displacement: no inertial integration,
                # stationary heuristic or gesture-duration cutoff in this mode.
                self.cursor.move(message.dx * self.sensitivity, message.dy * self.sensitivity)

    async def watchdog(self) -> bool:
        now = time.monotonic()
        if now - self.last_ping > 2:
            self.pause("Heartbeat timeout", invalidate=True)
            await self.socket.close(code=1001, reason="Heartbeat timeout")
            return False
        if self.motion.calibrating and now - self.calibration_started > 5:
            self.pause("Calibration timed out; check sensor permissions and retry", invalidate=True)
            await self.state()
        if self.mode == "inertial" and self.tracking and now - self.last_sample > self.config.stream_timeout:
            self.pause("Sensor delivery paused; wait for live readings, then start tracking again")
            await self.state()
        if self.mode == "camera" and self.tracking and now - self.last_camera > self.config.stream_timeout:
            self.pause("Camera stream stale; wait for Ready and start again")
            self.camera_quality = 0.0
            await self.state()
        if now - self.last_diagnostic >= 0.1:
            await self.state()
            self.last_diagnostic = now
        return True

    async def run(self) -> None:
        await self.state()
        while await self.watchdog():
            try:
                raw = await asyncio.wait_for(self.socket.receive_text(), timeout=0.05)
            except TimeoutError:
                continue
            if len(raw) > 4096:
                await self.socket.close(code=1009, reason="Message too large")
                return
            now = time.monotonic()
            self.rate.append(now)
            while self.rate and self.rate[0] < now - 1:
                self.rate.popleft()
            if len(self.rate) > 240:
                await self.socket.close(code=1008, reason="Message rate limit")
                return
            try:
                message = incoming.validate_json(raw)
                await self.handle(message)
            except ValidationError:
                self.pause("Malformed protocol message", invalidate=True)
                await self.send("error", message="Invalid message: check protocol version, fields and numeric limits")
                await self.state()
            except ValueError as exc:
                self.pause(str(exc))
                await self.send("error", message=str(exc))
                await self.state()


@app.get("/api/health")
async def health():
    return {"status": "ok", "protocol": 1, "output": app.state.config.output,
            "controller_connected": app.state.controller}


@app.websocket("/ws")
async def websocket(socket: WebSocket):
    config = app.state.config
    # CORS middleware does not enforce WebSocket Origin checks.
    if socket.headers.get("origin") not in config.origins:
        await socket.close(code=1008)
        return
    await socket.accept()
    owns_cursor = False
    try:
        raw = await asyncio.wait_for(socket.receive_text(), timeout=5)
        if len(raw) > 4096:
            await socket.close(code=1009)
            return
        try:
            auth = Auth.model_validate_json(raw)
        except ValidationError:
            await socket.close(code=1008, reason="Authentication required")
            return
        if not secrets.compare_digest(auth.token.encode(), config.token.encode()):
            await socket.close(code=1008, reason="Authentication failed")
            return
        # No await between checking and claiming; one event loop, one worker.
        if app.state.controller:
            await socket.close(code=1013, reason="Another phone is already connected")
            return
        app.state.controller = owns_cursor = True
        app.state.cursor.release()
        await Session(socket, config, app.state.cursor).run()
    except (WebSocketDisconnect, TimeoutError):
        pass
    except OSError:
        log.exception("Virtual input device failed")
        try:
            await asyncio.wait_for(socket.close(code=1011, reason="Virtual input failed; see laptop logs"), timeout=0.25)
        except (OSError, RuntimeError, TimeoutError):
            pass
    finally:
        if owns_cursor:
            try:
                app.state.cursor.release()
            finally:
                app.state.controller = False
        # Also close accepted sockets on authentication/read/send timeouts.
        try:
            await asyncio.wait_for(socket.close(), timeout=0.25)
        except (OSError, RuntimeError, WebSocketDisconnect, TimeoutError):
            pass


# API routes take precedence over the static root. Restart after your first build.
frontend = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if frontend.is_dir():
    app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
else:
    @app.get("/")
    async def missing_frontend():
        return {"message": "Frontend bundle missing. Follow README to build frontend, then restart backend."}
