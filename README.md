# MotionMouse

Turn a phone into a local wireless mouse for **Arch Linux KDE Wayland** using a
React website, a FastAPI WebSocket receiver, and a Linux uinput virtual mouse.

**Translation is experimental.** Hold the phone flat, screen up, with its top
pointing away from you. Translate right/left for cursor right/left; move it
forward/back for cursor up/down. Tilting and rotating are not cursor controls.
A separate **touchpad mode** provides finger-operated control without sensors.
**Camera mode** uses the phone's rear camera above a textured surface to estimate
movement from frame changes, without acceleration integration. See
[USAGE.md](USAGE.md#use-the-camera-option) for the ngrok camera setup.

This repository was written without dependency installation, application
execution, builds, tests, linters, or runtime verification. Treat it as an
unverified prototype; all commands and checks below are for you to run.

**Already set up and using ngrok?** See [USAGE.md](USAGE.md) for rebuilding after
the tracking fix, starting without a CA certificate, and using the new
**Calibrate & start tracking** flow. Sensor frequency alone does not indicate
successful calibration or fresh delivery to the laptop.

## What to expect

- Accelerometer-based short-gesture movement, stationary calibration, sensitivity,
  rotation rejection where readings permit, and live diagnostics.
- Left/right click buttons. Hold left and translate the phone to drag; in touchpad
  mode, hold left with one finger and move another finger on the pad.
- Authenticated encrypted local WebSockets, one controller, heartbeat timeout,
  stale-sensor protection, and release of held buttons on interrupted control.
- A real relative mouse on Wayland through python-evdev/uinput. No X11 automation
  and no ydotool subprocess per movement.
- Rear-camera optical flow with a local preview, confidence indicator, axis
  inversion/swap, and tracking-loss protection. Video stays on the phone.

**This cannot provide accurate physical position tracking.** Accelerometers cannot
distinguish rest from constant-speed motion. Tiny errors accumulate when integrated;
gravity leakage from small rotations can exceed useful translation signals.
Filtering, damping, deadbands and quiet-window resets reduce drift by discarding
some real motion. Slow/constant-speed travel can disappear; braking can produce
opposite-direction cursor movement; the cursor can drift briefly after stopping.
No sensitivity setting or calibration completely fixes this. Use touchpad mode
when inertial control is unsuitable. The exact sensor hardware and browser support
of your Infinix Smart 10 Pro are not assumed.

## Architecture

```text
Phone browser, trusted HTTPS
  DeviceMotionEvent / rear camera optical flow / pointer controls
  finite sensor samples (up to 60/s), camera deltas (up to 20/s)
                     │ WSS /ws, authenticated JSON v1
                     ▼
Laptop: FastAPI + Uvicorn (one process / one worker)
  origin/token validation → session/watchdogs → calibration and estimator
                     │ relative counts + button transitions
                     ▼
  python-evdev → /dev/uinput → KDE/libinput → real Wayland cursor
```

FastAPI also serves the compiled React frontend on the same HTTPS origin.
For development, Vite serves HTTPS on port 5173 and proxies `/ws` and `/api` to
the HTTPS backend on port 8000. No cloud service is involved.

```text
backend/
  config.py          Environment validation and tuning constants
  protocol.py        Strict versioned incoming message schemas
  motion.py          Calibration, filtering, integration, reset heuristics
  cursor.py          Persistent relative mouse or logging-only output
  main.py            Authentication, sessions, watchdogs, API/static hosting
  requirements.txt
frontend/
  src/
    App.tsx           Controls, pointer capture, safety lifecycle, diagnostics
    connection.ts     WebSocket authentication, heartbeat, bounded reconnect
    sensors.ts        Permission/capability detection and sample acquisition
    CameraPanel.tsx    Rear camera preview, permission and direction controls
    camera.ts         Capture lifecycle, local grayscale frames and motion output
    optical-flow.ts   Textured patch matching and dominant displacement estimate
    protocol.ts       TypeScript wire interfaces
    styles.css
  vite.config.mjs     Optional HTTPS development proxy
PLAN.md               Design, feasibility and development strategy
.env.example          Backend configuration template
```

## 1. Install dependencies on the laptop

Run from the repository root. You need an updated Arch system, Node.js
**22.12 or newer**, npm, and Python **3.11 or newer**.

```bash
sudo pacman -Syu --needed python python-pip base-devel nodejs npm mkcert nss
python -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
npm --prefix frontend install
```

`base-devel` supplies the compiler tools used if python-evdev needs to build its
extension. Python dependencies stay inside `.venv`; do not use system-wide pip
or `--break-system-packages`. No lockfiles are supplied because dependencies were
not resolved here. Your npm install creates `frontend/package-lock.json`; retain
it when you want reproducible subsequent installs with `npm ci`.

## 2. Grant access to the virtual mouse

The network backend should run as your regular user. It needs write access to
`/dev/uinput`, not permission to read every physical input device. The following
creates a dedicated group and udev rule:

```bash
sudo modprobe uinput
sudo groupadd --system --force motionmouse
sudo usermod -aG motionmouse "$USER"
printf '%s\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="motionmouse", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/80-motionmouse-uinput.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --action=add /sys/devices/virtual/misc/uinput
```

**Log out of KDE completely and log back in** so new terminal sessions inherit
the group. uinput access lets any process running as your user synthesize input;
only add trusted users to this group. MotionMouse itself creates only a mouse.

Optional, to load the module on future boots:

```bash
printf '%s\n' uinput | sudo tee /etc/modules-load.d/motionmouse.conf
```

If you already have an applicable uinput rule, use your existing setup rather
than adding conflicting rules. Do not make `/dev/uinput` world-writable. If access
is unavailable, explicit logging-only mode is described below.

## 3. Set a token and allowed browser origins

```bash
cp .env.example .env
.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))'
ip -4 addr show
```

Copy the generated token into `MOTIONMOUSE_TOKEN` in `.env`. Find your laptop's
Wi-Fi IPv4 address (for example `192.168.1.50`) and replace the example address in
`MOTIONMOUSE_ORIGINS`. For that example the value is:

```dotenv
MOTIONMOUSE_ORIGINS=https://192.168.1.50:8000,https://localhost:8000,https://192.168.1.50:5173,https://localhost:5173
```

Origins must be explicit HTTPS origins, with the exact port and no path or
wildcard. Include only addresses you will actually use. Token comparison is
constant-time; the first WebSocket message carries it, never the URL. The page
keeps it in memory, clears the input after connecting, and never persists it in
browser storage. Reloading the page requires entering it again. Do not commit
`.env` or share the token with others.

## 4. Create trusted HTTPS for the phone

Browsers restrict motion sensors to secure contexts. `http://192.168.1.50:8000`
does not qualify just because it is on local Wi-Fi. A certificate warning bypass
is not a dependable substitute for a trusted certificate.

Set the variable below to **your actual LAN IP**, then generate a certificate:

```bash
mkdir -p certs
mkcert -install
MOTIONMOUSE_LAN_IP=192.168.1.50
mkcert -cert-file certs/laptop.pem -key-file certs/laptop-key.pem "$MOTIONMOUSE_LAN_IP" localhost 127.0.0.1 ::1
cp "$(mkcert -CAROOT)/rootCA.pem" certs/motionmouse-ca.crt
```

Transfer **only `certs/motionmouse-ca.crt`** to the phone, for example using USB.
On Android/XOS, look under Settings → Security / More security settings →
Encryption & credentials → Install a certificate → CA certificate. Menu names
vary. Install the public CA certificate and acknowledge Android's local CA notice.
Restart your browser if necessary. Use Chrome/Chromium on Android as the initial
target; other browsers can have different certificate and sensor behavior.

Never copy `rootCA-key.pem` from mkcert's CA directory or `laptop-key.pem` to the
phone. The former can issue trusted certificates. All project `certs/` files are
ignored by Git.

If the laptop IP changes, regenerate the leaf certificate for the new address and
update `.env` origins. You normally do not need a new CA or to reinstall that CA.
A router DHCP reservation avoids this maintenance. A local DNS hostname also
works if the phone can resolve it and it appears in both certificate and origins.

## 5. Build the frontend and start the backend

Build once, then run the HTTPS backend from the repository root:

```bash
npm --prefix frontend run build
.venv/bin/python -m uvicorn backend.main:app --env-file .env --host 0.0.0.0 --port 8000 --workers 1 --ws websockets --ws-max-size 4096 --ws-max-queue 4 --ssl-certfile certs/laptop.pem --ssl-keyfile certs/laptop-key.pem --timeout-graceful-shutdown 3
```

Keep **one worker** and one backend instance: cursor ownership is process-local.
Stop with Ctrl+C; normal shutdown releases held buttons and closes the virtual
mouse. Rebuild after frontend changes, then refresh the phone. If the backend
started before `frontend/dist` existed, restart it after the initial build.

Both devices must be on the same local Wi-Fi. If your firewall blocks incoming
connections, allow TCP 8000 **only from your trusted LAN** using your firewall's
normal interface. Guest Wi-Fi/client isolation can prevent phone-to-laptop traffic.
Do not forward this port on the router or expose it to the internet.

### Optional: frontend development server

Keep the same HTTPS backend running. In another terminal at the repository root:

```bash
npm --prefix frontend run dev
```

Open `https://<laptop-ip>:5173` on the phone. Include this exact origin in `.env`.
The Vite proxy uses TLS verification bypass **only for its loopback connection to
the backend**; browser-to-laptop HTTPS must still be trusted. Dev mode additionally
needs LAN firewall access to TCP 5173. The config reads the same certificate files
and fails clearly if they do not exist. Use the compiled frontend for ordinary use.

## 6. Connect and control

1. Open `https://<laptop-ip>:8000` on the phone. There should be **no certificate
   warning**. Enter the configured pairing token and tap Connect.
2. In Inertial mode, tap Enable sensors. If prompted, grant motion permission.
   Watch the source, sample rate and capability messages. An API existing does not
   mean usable readings are available; null/missing readings are handled explicitly.
3. Check **Laptop sensor stream: Live**. Place the phone flat, screen up and still.
   Tap **Calibrate & start tracking** and leave it stationary for about three
   seconds: 750 ms to settle after tapping, then two seconds of measurement.
   Tracking starts automatically only after calibration succeeds. Calibration
   needs at least 30 samples in its measurement window; excessive noise, rotation
   or a non-flat pose when gravity is available causes a visible failure. You can
   instead use **Calibrate · hold still** and then tap **Start tracking** manually.
4. Check Tracking says Active. Make short right/left or forward/back gestures while
   keeping orientation steady. Pause briefly between gestures. Lift/movement out
   of the screen plane is not an up/down control in this selected flat-phone mode.
5. Tap the left/right buttons for clicks. Hold left with a finger while translating
   to drag. Buttons also work while tracking is paused, except during calibration.
6. Changing sensitivity pauses tracking; tap Start again. Sample gaps reset
   velocity and pause active output without erasing a valid stationary bias.
   Rotation, interrupted calibration, emergency release, or backgrounding can
   require fresh calibration. After a
   browser permission prompt blurs the page, simply calibrate again.
7. If inertial control is poor, select Touchpad, tap Start tracking and move a finger
   across the pad. Hold left with another finger to drag. Sensors are unnecessary.

**Release all & pause** is the emergency control and clears calibration. Switching
modes, stopping tracking, disconnecting, and backgrounding release held buttons.
Keep the page visible. The browser may suspend sensors/networking when the screen
locks. A screen wake lock is requested while tracking when the browser allows it,
but control never relies on background execution. After returning from the
background, enable sensors and recalibrate; reconnection never resumes tracking
automatically. Another open tab can hold the single controller slot.

## Configuration and estimator details

Uvicorn's `--env-file .env` loads backend configuration. Restart after changes.
No configuration is automatically written to system directories by the app.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOTIONMOUSE_TOKEN` | required | 32–512 character random pairing secret |
| `MOTIONMOUSE_ORIGINS` | required | Comma-separated explicit HTTPS origins |
| `MOTIONMOUSE_OUTPUT` | `uinput` | `uinput` for real cursor; `log` for event logging only |
| `MOTIONMOUSE_GAIN` | `2400` | Cursor counts per estimated metre, before UI sensitivity |
| `MOTIONMOUSE_FILTER_TAU` | `0.04` | Acceleration low-pass time constant, seconds |
| `MOTIONMOUSE_DAMPING` | `2.0` | Estimated velocity decay rate, per second |
| `MOTIONMOUSE_QUIET_SECONDS` | `0.15` | Quiet window before zeroing velocity |
| `MOTIONMOUSE_SAMPLE_GAP` | `0.15` | Maximum phone timestamp interval to integrate across, seconds |
| `MOTIONMOUSE_STREAM_TIMEOUT` | `0.5` | Network arrival watchdog and start-readiness window, seconds |
| `MOTIONMOUSE_MAX_SAMPLE_DELAY` | `0.25` | Maximum extra delivery delay above the best observed delay, seconds |
| `MOTIONMOUSE_GESTURE_SECONDS` | `2.0` | Gesture duration limit before requiring a quiet pause |
| `MOTIONMOUSE_MAX_VELOCITY` | `1.5` | Per-axis estimated speed bound, m/s |
| `MOTIONMOUSE_ROTATION_LIMIT` | `35` | Combined angular-rate rejection threshold, degrees/s |
| `MOTIONMOUSE_TILT_LIMIT` | `12` | Gravity-direction deviation rejection, degrees |

UI sensitivity ranges from 0.1× to 5× and resets to 1× per connection. Constants
are provisional, not tuned against this handset. KDE/libinput acceleration changes
the relationship between virtual mouse counts and on-screen pixels.

The backend prefers gravity-free `acceleration`. Otherwise it subtracts a
stationary estimate from `accelerationIncludingGravity` and labels the source
**raw/degraded**. Raw mode adapts its bias slowly during candidate stationary
windows; it may mistake actual motion for rest. Gravity-free readings themselves
may be software-fused and inaccurate. No readings are guaranteed by the phone name.

After calibration, the processor applies bias correction, a time-aware low-pass
filter, noise-derived deadband, trapezoidal velocity/displacement increments,
exponential velocity damping and speed/output clamps. It does not maintain or
claim an accurate absolute position. The screen-plane mapping uses screen
orientation; changing screen orientation invalidates calibration. Gravity
direction/rate checks pause motion on excessive rotation, but slow yaw and absent
gyroscopes limit rejection. Rotation alone is never intentionally mapped to motion.

Sensor timestamps are relative monotonic phone times; integration uses successive
differences. Laptop monotonic time drives watchdogs. Extra delivery delay above
`MOTIONMOUSE_MAX_SAMPLE_DELAY` relative to the session's lowest observed delay
discards samples and pauses output. Calibration interrupted this way must be
retried; a completed stationary calibration is retained. This relative check needs
no synchronized clocks and cannot detect
the absolute delay of the very first sample. WebSocket output exceeding 8 KiB
closes the client connection instead of replaying queued gestures. Incoming frames
are limited to 4 KiB with 240 messages/second per controller. Cursor output is
limited to 120 counts per axis per emission, with fractional counts retained.

Heartbeats run every 500 ms; the laptop releases input after two seconds without
one. In inertial tracking, network delivery loss pauses input after 500 ms by
default. Separately, phone sample intervals over 150 ms reset velocity; active
tracking pauses, and calibration in progress fails. While paused, sample gaps do
not erase a completed calibration. Neither kind of interruption automatically
restarts tracking. Actual detection includes event-loop scheduling delay. Frontend
reconnection backs off from 500 ms to 10 s; authentication failure or another
controller requires a manual connection attempt. Diagnostics report **round-trip**
latency, not a measured sensor-to-cursor delay. Filter and sensor delay add to it.

### Logging-only diagnosis

Set `MOTIONMOUSE_OUTPUT=log` in `.env`, then restart the same backend command.
The page prominently labels this mode; events are logged but **no real input is
injected**. It can be used without uinput access. Restore `uinput` and restart to
control the actual cursor. This is an explicit choice, never a silent fallback.

## Manual acceptance checks

These are instructions for you; they have not been executed here. Start with an
empty folder or other harmless desktop window, and keep a physical mouse available.

| Scenario | What to check |
| --- | --- |
| HTTPS | Page loads without warning; sensors can be enabled. Plain LAN HTTP is blocked by the UI. |
| Authentication | A wrong token cannot control input; correct token connects. Open a second phone/tab and confirm it cannot take over. |
| Origin | Remove the active browser origin from `.env`, restart and confirm connection is rejected. Restore afterward. |
| Calibration | Flat stationary phone succeeds. Moving/rotating the phone during calibration fails with a useful message. |
| Activation | Frequency without calibration offers Calibrate & start. Manual calibration stays paused; combined calibration starts only after success. Cancel/background prevents pending start. |
| Idle timing | Stop tracking, keep the phone flat, and wait. Calibration stays Ready across idle sample gaps; Start is available again when the laptop stream is Live. |
| Axes | Short right/left gestures move cursor right/left; forward/back maps to up/down. Keep orientation fixed. |
| Stop/drift | Stop after each gesture and observe drift/reset delay. Record suppression of slow/steady travel rather than expecting exact tracking. |
| Rotation | Rotate in place and check rejection/absence of intentional cursor control. Some gravity leakage remains possible. Recalibrate afterward. |
| Click | Left activates an item; right opens its context menu. Keyboard activation of the on-screen buttons also clicks. |
| Drag | Hold left, translate, release. Repeat with two fingers in touchpad mode. Confirm release ends drag. |
| Cancellation | Move a held finger outside a button, release, or interrupt with another app; no button should remain held. |
| Safety stop | Release all & pause stops tracking and ends dragging. Changing modes/sensitivity releases buttons and pauses. |
| Sensor loss | Disable motion permission or lock the phone during tracking; output stops and needs explicit reactivation. |
| Network loss | Turn off Wi-Fi while holding left; laptop should release within the heartbeat timeout plus scheduling delay. |
| Reconnect | Restore Wi-Fi; connection retries, but motion stays paused with fresh calibration required. |
| Touchpad | With sensors unavailable, select Touchpad and verify movement, clicks and two-finger dragging. |
| Permissions | Without uinput access, startup reports an actionable error. Explicit log mode starts without real cursor injection. |
| Shutdown | Ctrl+C on the laptop ends dragging and destroys the virtual mouse. Restart and reconnect manually. |

## Troubleshooting

- **Start tracking unavailable despite frequency:** check the explanation under
  the button and the separate Laptop sensor stream and Calibration diagnostics.
  Use Calibrate & start tracking while flat and stationary. See [USAGE.md](USAGE.md)
  for the updated ngrok flow and optional network jitter settings. After updating
  source, rebuild the frontend, restart Python and refresh the phone.
- **Certificate warning:** install the public CA as a CA certificate, restart the
  browser and check the IP matches the certificate. Do not disable browser security.
- **Cannot connect:** check Wi-Fi/client isolation, LAN address, firewall, backend
  terminal, certificate trust, and exact allowed origin/port. `/api/health` on the
  same HTTPS address reports backend readiness and selected output mode, without
  secrets. It does not verify cursor delivery or sensor accuracy.
- **No readings:** enable sensor access in browser site settings; try Android
  Chrome; keep the page foregrounded. Missing gyroscope or browser-fused linear
  acceleration can make translation impractical. Select Touchpad.
- **Calibrates but jumps/drifts:** keep the phone flat, use short gestures, reduce
  sensitivity, recalibrate, or select Touchpad. Browser APIs cannot recover an
  external position reference from noisy acceleration.
- **Cannot create virtual mouse:** check `/dev/uinput` exists and your login has
  the dedicated group. Restart your login after group changes. Read the backend
  exception; use explicit log mode to separate input permissions from networking.
- **Mouse connected but cursor does not move:** confirm UI output says `uinput`,
  tracking is Active, calibration is complete, sensors are recent, and KDE has not
  disabled the MotionMouse input device. In touchpad mode, finger movement is
  needed; physical translation is deliberately ignored.
- **Another phone connected:** disconnect the other tab, or wait for its heartbeat
  timeout after closing it, then connect again.
- **Background return:** sensors stop when hidden. Enable sensors, recalibrate and
  start tracking again. Stop/restart the backend if you need to revoke all sessions.

## Camera mode and remaining limitations

Select Camera, enable rear camera access, and hold the phone screen-up around
15–30 cm above well-lit printed text or a textured desk. Keep the rear lens clear,
height steady and phone parallel to the surface. Wait for Visual tracking Ready
and Laptop camera stream Live, then Start tracking. Calibration with motion
sensors is unnecessary. Direction controls accommodate camera orientation.

The browser processes 160×120 grayscale images at up to 20 fps, selects up to 24
textured patches, matches within an eight-pixel search radius, and estimates
dominant displacement from consistent matches. Subpixel refinement and a small
deadband reduce jitter. The backend receives bounded numeric displacements and
confidence rather than images. It scales them by sensitivity and emits relative
mouse movement directly: no inertial damping, quiet-window stop or gesture timer.
The algorithm needs at least six spatially distributed matches and 60% consensus.
Three bad frames, stale capture or delayed delivery pause and release input;
reacquisition requires manual Start. Off/mode switch/background/disconnect closes
camera tracks. Requests returning after cancellation are closed immediately.

This is apparent 2D image motion, not metric, rotation-independent phone tracking.
Phone rotation and moving objects can drive it, height changes affect scale, and
weak/repeated texture, dark scenes, motion blur, reflections or autofocus can
break matching. Keep the scene still and move slowly enough to retain features.
No extra CV package, model download, microphone or video recording is involved.
The camera path and its thresholds have not been tested on this phone by the agent.

A future fixed laptop camera observing a marker could add an external position
reference and perspective calibration. Full phone-camera visual odometry with
rotation separation and metric scale remains future work. Native Android sensors
alone would not eliminate the fundamental inertial drift problem.

Synthetic optical-flow and backend session regression sources are provided, but
were not executed. With your installed dependencies you can optionally run:

```bash
.venv/bin/python -m unittest discover -s tests -v
node --experimental-strip-types --test tests/optical-flow.test.mjs
```

## References

- [W3C Device Orientation and Motion](https://www.w3.org/TR/orientation-event/)
- [Linux kernel uinput documentation](https://docs.kernel.org/input/uinput.html)
- [python-evdev documentation](https://python-evdev.readthedocs.io/en/stable/)
- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)
- [Vite server configuration](https://vite.dev/config/server-options)
- [Vite 8 and React plugin 6 compatibility](https://vite.dev/blog/announcing-vite8)
- [mkcert and mobile certificate trust](https://github.com/FiloSottile/mkcert)
- [W3C Media Capture and Streams](https://w3c.github.io/mediacapture-main/)
- [MIT Vision Book: Optical Flow Estimation](https://visionbook.mit.edu/optical_flow.html)
