# Using MotionMouse with ngrok

This guide assumes your dependencies, pairing token and uinput access are already
set up, and touchpad control previously worked. No CA certificate is needed with
the public ngrok HTTPS address. The commands below are for you to run.

## Load the tracking fix

1. Stop the Python backend with Ctrl+C. Keep your ngrok tunnel open if it is
   already running, so its address does not change.
2. Open a laptop terminal in the project folder and rebuild the frontend:

   ```bash
   cd /home/shamveelkhan/Documents/Codes/phone-mouse-controller
   npm --prefix frontend run build
   ```

3. If ngrok is not running, start it in another terminal:

   ```bash
   ngrok http 8000
   ```

4. Ensure `.env` contains your token and the exact current HTTPS tunnel origin,
   without a trailing slash. Use your own URL, not this example:

   ```dotenv
   MOTIONMOUSE_ORIGINS=https://your-address.ngrok-free.app
   ```

5. Start the updated Python backend from the project folder:

   ```bash
   .venv/bin/python -m uvicorn backend.main:app \
     --env-file .env \
     --host 127.0.0.1 \
     --port 8000 \
     --workers 1 \
     --ws websockets \
     --ws-max-size 4096 \
     --ws-max-queue 4
   ```

6. Refresh the ngrok HTTPS page on your phone and reconnect with your pairing
   token. Close other tabs holding the controller slot. You should see the new
   **Laptop sensor stream** and **Calibration** diagnostics. If these are missing,
   the phone still has the old frontend: reload or clear that site's cache. If the
   page asks you to restart the backend, stop the old Python process and use the
   command above. The built frontend is served by Python; no Vite server is needed.

## Start translation tracking

1. Choose **Translation** and tap **Enable sensors**. Grant permission if asked.
2. Check **Laptop sensor stream: Live**. A nonzero **Phone sensor rate** alone
   only confirms readings on the phone, not successful delivery to the laptop.
3. Put the phone flat, screen facing up, with its top edge pointing away from you.
   Start on a desk to keep the orientation steady. Disable phone auto-rotation if
   it keeps changing the screen orientation.
4. Tap **Calibrate & start tracking**, then keep the phone still for about three
   seconds. It first settles after the tap, then measures two stable seconds.
   Tracking starts automatically only after successful calibration. You can tap
   **Cancel calibration** to cancel this pending start.
5. Check **Tracking: Active** and **Calibration: Ready**. If calibration fails,
   read the message beside the tracking button and try again while stationary.
6. Slide the phone a short distance right/left to move the cursor right/left.
   Slide away from you/toward you to move up/down. Keep its orientation fixed;
   do not tilt it as a control. Lifting vertically is not cursor-up in this mode.
7. Pause briefly between short movements. Hold **Left click** while moving to drag;
   release it to drop. Tap **Right click** for the context menu.

You can alternatively use **Calibrate · hold still** first. That control calibrates
without starting; once it finishes, tap **Start tracking** yourself.

Changing sensitivity pauses movement. If Calibration still says Ready, tap Start
tracking again. Stop tracking preserves calibration; **Release all & pause**,
backgrounding, disconnecting, or a pose/source change can require recalibration.
The connection never automatically resumes tracking after an interruption.

## If Start Tracking is unavailable

Read the explanation directly under the button:

| Status | Action |
| --- | --- |
| Connect to the laptop first | Reconnect using your token. |
| Tap Enable sensors first | Enable sensors on this page. |
| Waiting for usable accelerometer readings | Check browser motion permissions and keep the page visible. |
| Waiting for fresh samples on the laptop | Phone events are not arriving recently enough; check tunnel/network, then wait for Live. |
| Settling / measuring calibration | Leave the phone flat and still for about three seconds. |
| Calibration required | Use Calibrate & start tracking; frequency alone does not mean calibrated. |
| Restart the Python backend | The frontend is updated but the running backend is still the old version. |

If the diagnostic reason reports **Sensor sample gap during calibration**, the
phone stopped sampling continuously. Keep Chrome foregrounded, avoid locking the
screen and retry. A noisy calibration should be repeated on a stable surface.

If ngrok frequently reports **Delayed sensor sample discarded** or **Sensor
delivery paused**, try a better connection first. For moderate tunnel jitter you
may add these to `.env` and restart Python:

```dotenv
MOTIONMOUSE_STREAM_TIMEOUT=0.75
MOTIONMOUSE_MAX_SAMPLE_DELAY=0.5
```

These are optional tradeoffs: they allow more network jitter but also allow older
data and a longer delivery-loss pause. They do not improve physical tracking
accuracy. `MOTIONMOUSE_SAMPLE_GAP` remains the separate 150 ms phone sampling
limit; it is not a network latency setting. Internet latency through ngrok may
still make this mode unsuitable. The unchanged touchpad mode remains available.

## Manual checks after updating

- Sensors live but no calibration: the button offers Calibrate & start tracking.
- After manual calibration: Start tracking is available, and the cursor stays
  still until you tap it.
- After Calibrate & start: the settling/countdown completes, Calibration becomes
  Ready, and Tracking becomes Active.
- Cancel or background during calibration: tracking does not start later.
- After Stop tracking: wait a few seconds and confirm calibration remains Ready
  while the phone remains flat. Start again without recalibrating.
- Interrupt the network while dragging: held buttons release. After Live returns,
  restart manually; do not replay old movements.
- Recheck touchpad movement, left/right clicks and dragging.

Synthetic backend regression checks are provided in `tests/test_tracking.py`.
If you want to run them with your installed Python dependencies:

```bash
.venv/bin/python -m unittest discover -s tests -v
```

The agent did not execute these checks, builds, or the app. Translation still has
inertial drift, unreliable constant-speed detection, and possible braking reversal;
this fix addresses activation and timing behavior, not those physical limitations.
