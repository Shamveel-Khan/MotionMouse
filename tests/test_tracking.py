"""Regression checks using synthetic samples, no sensors, sockets or real input.

These checks are supplied for the user to run; they were not executed during
implementation. They require the project's Python dependencies.
"""

import os
import time
import unittest
from unittest.mock import patch

from backend.config import Config
from backend.main import Session
from backend.motion import Motion
from backend.protocol import Calibration, CameraFrame, Release, Sample, Settings, Tracking


def configuration():
    with patch.dict(os.environ, {
        "MOTIONMOUSE_TOKEN": "synthetic-test-token-never-use-in-production",
        "MOTIONMOUSE_ORIGINS": "https://example.test",
        "MOTIONMOUSE_OUTPUT": "log",
    }, clear=True):
        return Config.load()


def sample(sequence, timestamp):
    return Sample(v=1, type="sample", seq=sequence, t=float(timestamp),
                  linear=(0.0, 0.0, 0.0), gravity=(0.0, 0.0, 9.81),
                  rotation=(0.0, 0.0, 0.0), angle=0)


def calibrated_motion():
    motion = Motion(configuration())
    motion.begin_calibration()
    for index in range(65):
        motion.feed(sample(index, index * 50), tracking=False, sensitivity=1.0)
    return motion


class FakeCursor:
    def __init__(self):
        self.held = set()
        self.moves = []

    def release(self):
        self.held.clear()

    def move(self, dx, dy):
        self.moves.append((dx, dy))


class FakeSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, payload):
        self.messages.append(payload)


class MotionRegressionTests(unittest.TestCase):
    def test_idle_gap_keeps_calibration_and_emits_no_motion(self):
        motion = calibrated_motion()
        self.assertTrue(motion.calibrated)
        delta = motion.feed(sample(65, 4000), tracking=False, sensitivity=1.0)
        self.assertTrue(motion.calibrated)
        self.assertEqual(delta, (0.0, 0.0))
        self.assertEqual(motion.velocity, [0.0, 0.0])

    def test_active_gap_resets_velocity_and_requires_manual_restart(self):
        motion = calibrated_motion()
        motion.velocity = [0.3, -0.2]
        with self.assertRaisesRegex(ValueError, "tracking paused"):
            motion.feed(sample(65, 4000), tracking=True, sensitivity=1.0)
        self.assertTrue(motion.calibrated)
        self.assertEqual(motion.velocity, [0.0, 0.0])

    def test_tap_rotation_during_settling_is_ignored_but_during_measurement_fails(self):
        motion = Motion(configuration())
        motion.begin_calibration()
        motion.feed(sample(0, 0), False, 1.0)
        tap = sample(1, 100).model_copy(update={"rotation": (20.0, 0.0, 0.0)})
        motion.feed(tap, False, 1.0)
        self.assertTrue(motion.calibrating)
        for timestamp in range(150, 800, 50):
            motion.feed(sample(timestamp // 50, timestamp), False, 1.0)
        turn = sample(16, 800).model_copy(update={"rotation": (20.0, 0.0, 0.0)})
        with self.assertRaisesRegex(ValueError, "Rotation detected"):
            motion.feed(turn, False, 1.0)
        self.assertFalse(motion.calibrated)


class SessionRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cursor = FakeCursor()
        self.socket = FakeSocket()
        self.session = Session(self.socket, configuration(), self.cursor)
        await self.session.handle(sample(0, 1000))

    async def finish_calibration(self):
        for index in range(1, 66):
            await self.session.handle(sample(index, 1000 + index * 50))

    async def test_frequency_without_calibration_cannot_directly_start(self):
        with self.assertRaisesRegex(ValueError, "Calibration is required"):
            await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        self.assertFalse(self.session.tracking)

    async def test_calibrate_and_start_waits_for_success_then_starts(self):
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True, calibrate_if_needed=True))
        self.assertTrue(self.session.motion.calibrating)
        self.assertFalse(self.session.tracking)
        self.assertEqual(self.cursor.moves, [])
        await self.finish_calibration()
        self.assertTrue(self.session.motion.calibrated)
        self.assertTrue(self.session.tracking)
        self.assertFalse(self.session.start_after_calibration)
        self.assertTrue(all(delta == (0.0, 0.0) for delta in self.cursor.moves))

    async def test_manual_calibration_does_not_automatically_start(self):
        await self.session.handle(Calibration(v=1, type="calibrate"))
        await self.finish_calibration()
        self.assertTrue(self.session.motion.calibrated)
        self.assertFalse(self.session.tracking)

    async def test_release_cancels_pending_automatic_start(self):
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True, calibrate_if_needed=True))
        await self.session.handle(Release(v=1, type="release"))
        await self.finish_calibration()
        self.assertFalse(self.session.motion.calibrated)
        self.assertFalse(self.session.tracking)
        self.assertFalse(self.session.start_after_calibration)

    async def test_network_watchdog_does_not_use_integration_gap(self):
        self.session.motion = calibrated_motion()
        self.session.tracking = True
        # Between the 150 ms integration limit and the 500 ms network watchdog.
        self.session.last_sample = time.monotonic() - 0.25
        await self.session.watchdog()
        self.assertTrue(self.session.tracking)
        self.session.last_sample = time.monotonic() - 0.75
        self.cursor.held.add("left")
        await self.session.watchdog()
        self.assertFalse(self.session.tracking)
        self.assertTrue(self.session.motion.calibrated)
        self.assertEqual(self.cursor.held, set())

    async def test_delayed_sample_is_dropped_without_losing_idle_calibration(self):
        self.session.motion = calibrated_motion()
        self.session.phone_offset = time.monotonic() - 10
        # Old relative to the baseline, despite being in sequence.
        await self.session.handle(sample(1, 1100))
        self.assertTrue(self.session.motion.calibrated)
        self.assertFalse(self.session.tracking)
        self.assertEqual(self.cursor.moves, [])

    async def test_readiness_reports_received_samples_and_missing_calibration(self):
        await self.session.state()
        state = self.socket.messages[-1]
        self.assertTrue(state["sensor_fresh"])
        self.assertFalse(state["calibrated"])
        self.assertIn("Calibrate", state["readiness"])


class CameraSessionRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cursor = FakeCursor()
        self.session = Session(FakeSocket(), configuration(), self.cursor)
        await self.session.handle(Settings(v=1, type="settings", mode="camera", sensitivity=1.0))

    async def frame(self, sequence, quality=0.9, dx=2.0, dy=-1.0):
        await self.session.handle(CameraFrame(v=1, type="camera", seq=sequence,
            t=float(1000 + sequence * 50), dx=dx, dy=dy, quality=quality))

    async def test_camera_needs_fresh_confident_frames_before_start(self):
        with self.assertRaisesRegex(ValueError, "Camera is not ready"):
            await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        await self.frame(0, quality=0.1)
        with self.assertRaisesRegex(ValueError, "Camera is not ready"):
            await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        await self.frame(1)
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        self.assertTrue(self.session.tracking)
        self.assertFalse(self.session.motion.calibrated)

    async def test_camera_frames_while_paused_never_move_cursor(self):
        await self.frame(0)
        self.assertEqual(self.cursor.moves, [])

    async def test_visual_displacement_continues_beyond_inertial_gesture_limit(self):
        await self.frame(0)
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        for sequence in range(1, 101):
            await self.frame(sequence)
        self.assertTrue(self.session.tracking)
        self.assertEqual(len(self.cursor.moves), 100)
        self.assertTrue(all(delta == (2.0, -1.0) for delta in self.cursor.moves))

    async def test_low_confidence_suppresses_motion_and_releases_drag(self):
        await self.frame(0)
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        self.cursor.held.add("left")
        for sequence in range(1, 4):
            await self.frame(sequence, quality=0.0)
        self.assertEqual(self.cursor.moves, [])
        self.assertFalse(self.session.tracking)
        self.assertEqual(self.cursor.held, set())
        await self.frame(4)
        self.assertFalse(self.session.tracking)  # Reacquisition is never automatic.

    async def test_stale_camera_releases_drag_and_requires_restart(self):
        await self.frame(0)
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        self.cursor.held.add("left")
        self.session.last_camera = time.monotonic() - 0.75
        await self.session.watchdog()
        self.assertFalse(self.session.tracking)
        self.assertEqual(self.cursor.held, set())

    async def test_camera_messages_in_other_modes_are_ignored(self):
        await self.session.handle(Settings(v=1, type="settings", mode="touchpad", sensitivity=1.0))
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        await self.frame(0)
        self.assertEqual(self.cursor.moves, [])
        self.assertTrue(self.session.tracking)

    async def test_inertial_samples_do_not_interrupt_camera_tracking(self):
        await self.frame(0)
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        await self.session.handle(sample(999, 1))
        self.assertTrue(self.session.tracking)
        await self.frame(1)
        self.assertEqual(self.cursor.moves, [(2.0, -1.0)])

    async def test_delayed_camera_motion_is_discarded(self):
        await self.frame(0)
        await self.session.handle(Tracking(v=1, type="tracking", enabled=True))
        self.cursor.held.add("left")
        self.session.camera_offset = time.monotonic() - 10
        await self.frame(1)
        self.assertEqual(self.cursor.moves, [])
        self.assertFalse(self.session.tracking)
        self.assertEqual(self.cursor.held, set())


if __name__ == "__main__":
    unittest.main()
