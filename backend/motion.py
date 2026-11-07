"""Short-gesture inertial estimation, deliberately without position claims.

Quiet detection is a heuristic: constant velocity can look stationary. Rotation
checks reduce gravity leakage but are not full six-degree-of-freedom tracking.
"""

import math
from statistics import fmean, pstdev

from .config import Config
from .protocol import Sample


def length(values) -> float:
    return math.sqrt(sum(value * value for value in values))


class Motion:
    def __init__(self, config: Config):
        self.config = config
        self.calibrated = False
        self.calibrating = False
        self.source: str | None = None
        self.angle = 0
        self.bias = [0.0] * 3
        self.noise = [0.03] * 3
        self.reference_gravity = None
        self.samples: list[Sample] = []
        self.settle_started: float | None = None
        self.last_t: float | None = None
        self.hz = 0.0
        self.progress = 0.0
        self.reason = "Calibrate while the phone is flat and stationary"
        self.acceleration = [0.0, 0.0]
        self.rotation_available = False
        self.reset("Waiting for calibration")

    def reset(self, reason: str) -> None:
        self.acceleration = [0.0, 0.0]
        self.velocity = [0.0, 0.0]
        self.filtered = [0.0, 0.0]
        self.previous = [0.0, 0.0]
        self.quiet_since = None
        self.gesture_start = None
        self.blocked = False
        self.reason = reason

    def invalidate(self, reason: str) -> None:
        self.calibrating = False
        self.calibrated = False
        self.progress = 0
        self.samples.clear()
        self.settle_started = None
        self.last_t = None
        self.reset(reason)

    def begin_calibration(self) -> None:
        self.invalidate("Keep phone flat and still for two seconds")
        self.source = None
        self.calibrating = True

    def fail(self, reason: str) -> None:
        self.invalidate(reason)
        raise ValueError(reason)

    @staticmethod
    def values(sample: Sample):
        if sample.linear is not None:
            return "linear", sample.linear
        if sample.gravity is not None:
            return "raw", sample.gravity
        raise ValueError("No usable accelerometer readings. Try touchpad mode.")

    def collect(self, sample: Sample, source: str) -> None:
        if self.settle_started is None:
            self.settle_started = sample.t
            self.source = source
            self.angle = sample.angle
        if source != self.source or sample.angle != self.angle:
            self.fail("Sensor source or screen orientation changed; recalibrate")
        # Tapping the calibration/start control can briefly shake the phone.
        # Ignore that settling interval; still require a full stable two seconds.
        if sample.t - self.settle_started < 750:
            self.reason = "Settling after tap; leave the phone flat and still"
            return
        self.reason = "Measuring calibration; keep the phone flat and still"
        if sample.rotation is not None and length(sample.rotation) > 3:
            self.fail("Rotation detected during calibration; place the phone down and retry")
        self.samples.append(sample)
        elapsed = (sample.t - self.samples[0].t) / 1000
        self.progress = min(1.0, elapsed / 2)
        if elapsed < 2:
            return
        if len(self.samples) < 30:
            self.fail("Calibration needs at least 15 usable samples/second; try another browser")
        vectors = [self.values(item)[1] for item in self.samples]
        mean = [fmean(row[axis] for row in vectors) for axis in range(3)]
        noise = [pstdev(row[axis] for row in vectors) for axis in range(3)]
        if max(noise) > 0.16 or (source == "linear" and length(mean) > 0.7):
            self.fail("Calibration was not stable. Keep the phone completely still and retry.")
        raw = [item.gravity for item in self.samples if item.gravity is not None]
        self.reference_gravity = None
        if raw:
            gravity = [fmean(row[axis] for row in raw) for axis in range(3)]
            magnitude = length(gravity)
            if not 7 < magnitude < 12 or length(gravity[:2]) / magnitude > math.sin(math.radians(25)):
                self.fail("Calibration requires a flat, screen-up phone")
            if max(pstdev(row[axis] for row in raw) for axis in range(3)) > 0.18:
                self.fail("Gravity direction changed during calibration; retry while still")
            self.reference_gravity = gravity
        self.bias = mean
        self.noise = [max(0.03, value * 3) for value in noise]
        self.calibrating = False
        self.calibrated = True
        self.samples.clear()
        self.progress = 1.0
        self.reset("Calibrated. Start tracking for short translation gestures.")

    def feed(self, sample: Sample, tracking: bool, sensitivity: float) -> tuple[float, float]:
        source, values = self.values(sample)
        self.rotation_available = sample.rotation is not None
        dt = (sample.t - self.last_t) / 1000 if self.last_t is not None else 0
        self.last_t = sample.t
        if dt > self.config.sample_gap:
            if self.calibrating:
                self.fail("Sensor sample gap during calibration; keep this page visible and retry")
            # A sampling gap invalidates velocity, not a stationary bias estimate.
            # Never integrate across it or silently resume active tracking.
            self.reset("Sensor gap; movement estimate reset")
            dt = 0
            if tracking:
                raise ValueError("Sensor gap; tracking paused. Wait for live readings, then start again.")
        if dt > 0:
            self.hz = 0.9 * self.hz + 0.1 / dt if self.hz else 1 / dt
        if self.calibrating:
            self.collect(sample, source)
            return 0.0, 0.0
        if not self.calibrated:
            self.source = source
            return 0.0, 0.0
        if source != self.source or sample.angle != self.angle:
            self.fail("Sensor source or screen orientation changed; recalibrate")
        if sample.rotation is not None and length(sample.rotation) > self.config.rotation_limit:
            self.fail("Rotation detected. Keep orientation steady and recalibrate.")
        if self.reference_gravity is not None and sample.gravity is not None:
            base, current = self.reference_gravity, sample.gravity
            denominator = length(base) * length(current)
            cosine = sum(a * b for a, b in zip(base, current)) / denominator if denominator > 1 else -1
            if cosine < math.cos(math.radians(self.config.tilt_limit)):
                self.fail("Phone tilted away from its calibration pose; recalibrate")
        if not tracking or dt <= 0:
            return 0.0, 0.0

        corrected = [values[i] - self.bias[i] for i in range(3)]
        angle = math.radians(sample.angle)
        # Natural device axes -> displayed screen axes, cursor Y points down.
        screen = [
            corrected[0] * math.cos(angle) - corrected[1] * math.sin(angle),
            -(corrected[0] * math.sin(angle) + corrected[1] * math.cos(angle)),
        ]
        threshold = max(self.noise[0], self.noise[1])
        quiet = length(screen) < threshold
        now = sample.t / 1000
        if quiet:
            if self.quiet_since is None:
                self.quiet_since = now
            if now - self.quiet_since >= self.config.quiet_seconds:
                # A quiet interval is not proof of rest. This deliberately loses
                # constant-speed travel in exchange for bounding cursor drift.
                self.reset("Quiet-window velocity reset (heuristic)")
                self.quiet_since = now
                if source == "raw":
                    self.bias = [0.995 * self.bias[i] + 0.005 * values[i] for i in range(3)]
                return 0.0, 0.0
        else:
            self.quiet_since = None
            self.reason = "Estimating short translation gesture"
            if self.gesture_start is None:
                self.gesture_start = now
        if self.gesture_start is not None and now - self.gesture_start > self.config.gesture_seconds:
            self.blocked = True
            self.velocity = [0.0, 0.0]
            self.reason = "Gesture time limit; pause briefly to rearm"
        if self.blocked:
            return 0.0, 0.0
        alpha = 1 - math.exp(-dt / self.config.filter_tau)
        self.acceleration = screen
        movement = []
        for axis in range(2):
            value = 0.0 if abs(screen[axis]) < threshold else screen[axis]
            self.filtered[axis] += alpha * (value - self.filtered[axis])
            old_velocity = self.velocity[axis]
            velocity = (old_velocity + 0.5 * (self.previous[axis] + self.filtered[axis]) * dt)
            velocity *= math.exp(-self.config.damping * dt)
            velocity = max(-self.config.max_velocity, min(self.config.max_velocity, velocity))
            self.velocity[axis] = velocity
            self.previous[axis] = self.filtered[axis]
            movement.append(0.5 * (old_velocity + velocity) * dt * self.config.gain * sensitivity)
        return movement[0], movement[1]

    def diagnostics(self) -> dict:
        return {
            "source": self.source, "calibrated": self.calibrated,
            "calibrating": self.calibrating, "progress": round(self.progress, 2),
            "hz": round(self.hz, 1), "rotation_available": self.rotation_available,
            "acceleration": [round(value, 3) for value in self.acceleration],
            "velocity": [round(value, 3) for value in self.velocity],
            "reason": self.reason,
        }
