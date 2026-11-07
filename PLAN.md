# MotionMouse implementation plan

## Tracking activation revision

The activation fix separates the 150 ms phone integration interval from a 500 ms
network delivery watchdog. Idle timing gaps reset velocity without clearing a
completed stationary calibration. Active interruptions pause and release input;
resuming remains manual. A 750 ms settling interval precedes the two stable
calibration seconds. The new explicit Calibrate & start action starts only after
success; cancel, release, backgrounding, failure or disconnect cancels that intent.
The UI exposes calibration and laptop sample freshness alongside phone frequency.
USAGE.md covers the ngrok HTTPS workflow; synthetic regression checks are supplied
but not executed, consistent with the user's no-runtime-testing constraint.

## Goal and feasibility

Build a local React/TypeScript controller and FastAPI backend for Arch Linux KDE
Wayland. Hold the phone flat, screen up, with its top pointing away from you.
Translate right/left for cursor X and forward/back for cursor Y. Rotation must
never directly drive the cursor. Include a separate finger-operated touchpad.

This is an experimental short-gesture translation estimator, not accurate
position tracking. Accelerometers cannot distinguish rest from constant velocity.
A constant acceleration bias of 0.02 m/s² produces 0.25 m displacement error in
five seconds. Gravity leakage, browser filtering, sensor noise, and hand rotation
make double integration unsuitable for long-term position tracking. Stop detection
is heuristic: it also suppresses slow or constant-speed travel. Drift cannot be
eliminated through filtering or calibration alone.

## Browser sensing and processing

Use DeviceMotionEvent, enabled by a user gesture over trusted HTTPS. Detect
permissions, missing/null fields, sample gaps, and observed sample frequency;
do not assume this phone has a hardware gyroscope. Prefer finite three-axis
gravity-free acceleration. Fall back to accelerationIncludingGravity with a
stationary gravity estimate and a prominent degraded-mode label. Use rotation
rate and gravity direction changes only to reject rotation, never as cursor input.
Pause and recalibrate on screen rotation.

Collect two seconds of stable calibration samples; estimate bias and per-axis
noise, rejecting motion or inadequate sampling. Correct bias, apply a time-aware
low-pass filter and noise deadband, integrate estimated velocity with trapezoidal
integration, and accumulate relative cursor counts. Apply velocity damping,
velocity/output limits, quiet-window resets (150 ms), sample-gap resets (150 ms),
and a two-second gesture limit. All constants are provisional and configurable.
Update raw-mode gravity/bias only during candidate stationary periods; this can
absorb real sustained acceleration. Freeze on stale data or rotation. Map device
axes through screen orientation and invert forward movement for cursor-up.

## Architecture and interfaces

- frontend/: React, TypeScript, Vite; sensor adapter, typed WebSocket client,
  pointer-captured mouse buttons, touchpad, calibration and diagnostic controls.
- backend/: FastAPI, Uvicorn, Pydantic, python-evdev; configuration, validated
  versioned protocol, estimator, persistent uinput mouse, session lifecycle.
- Root: README.md, PLAN.md, environment/configuration examples, .gitignore.

FastAPI serves the user-built frontend and /api/health plus /ws on one HTTPS
origin. Optional Vite HTTPS development server proxies /ws and /api. One worker
and one authenticated controller only. A persistent uinput device emits REL_X,
REL_Y, BTN_LEFT and BTN_RIGHT with SYN_REPORT. Logging-only output is explicit.
The backend runs unprivileged with narrowly scoped /dev/uinput access.

WebSocket JSON includes protocol version, authentication, samples (monotonic
phone timestamps and sequence), calibration, settings, tracking, mouse-button
transitions, touchpad deltas, release, and heartbeat. Server replies include state,
errors and diagnostics. Use server monotonic time for connection/sample watchdogs
and phone timestamp differences for integration. No synchronized clocks required.

## Connection, security and latency

Authenticate the first message with a high-entropy configured token, not a URL
parameter. Validate an explicit Origin allowlist. Bound messages, numeric values,
rates and queues. No command execution from incoming data. Bind to LAN only when
the user explicitly starts it that way; never expose to the public internet.
Token is held in frontend memory only and excluded from logs.

Transmit at most 60 samples/second; drop motion during socket backpressure rather
than replay it. Heartbeat every 500 ms, expire after two seconds, and reset stale
motion after 150 ms. Release buttons on timeout, disconnect, cancellation,
backgrounding, focus loss, mode changes, and shutdown. Reconnect with bounded
backoff but require manual tracking reactivation and calibration. Pointer capture
allows holding left while translating or using the touchpad. Request an optional
screen wake lock while tracking; background execution is not dependable.

## Delivery phases

1. Write this plan before implementation.
2. Write backend configuration, protocol, estimation and uinput/session code.
3. Write frontend sensors, controls, connection handling and touchpad fallback.
4. Write HTTPS/dev configuration and exact user-run setup/manual checks.
5. Stop without installing, executing, testing, building, formatting, or changing
   system configuration. All validation is delegated to the user.

## Documentation and manual acceptance

README will cover Arch prerequisites, isolated Python install, frontend install
and build, uinput module/access, mkcert LAN-address certificates and Android CA
trust, startup and same-Wi-Fi connection, optional frontend development startup,
configuration and actionable troubleshooting. Never share the CA private key.
Plain HTTP to a laptop LAN address is not a secure sensor context.

User checks: valid/invalid authentication and origin; stationary/moving
calibration; right/left/forward/back translations; rotation rejection; stop delay
and slow-motion limitations; left/right click and drag; touchpad without sensors;
stale data, Wi-Fi loss, backgrounding and restart; safe reconnect; missing uinput
permissions; certificate trust; sample rate and latency. No accuracy guarantee or
claim of successful runtime validation will be made.

## Camera fallback and sources

Camera tracking is future work, not implemented in this prototype. A fixed laptop
camera observing a marker on the phone provides an external position reference
and can measure planar translation after perspective/scale calibration. It needs
line of sight, adequate lighting, a marker visible while screen-up, and occlusion
handling. Phone-camera visual odometry is more complex, has scale/texture issues,
and does not automatically yield reliable cursor displacement.

- https://www.w3.org/TR/orientation-event/
- https://docs.kernel.org/input/uinput.html
- https://python-evdev.readthedocs.io/en/stable/
- https://fastapi.tiangolo.com/advanced/websockets/
- https://vite.dev/config/server-options
- https://github.com/FiloSottile/mkcert
