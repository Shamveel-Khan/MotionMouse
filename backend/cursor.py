"""A persistent, narrowly scoped virtual relative mouse. No shell commands."""

import logging
import math

log = logging.getLogger("motionmouse.cursor")


class Cursor:
    def __init__(self, output: str):
        self.output = output
        self.device = None
        self.codes = None
        self.held: set[str] = set()
        self.remainder = [0.0, 0.0]
        if output == "uinput":
            try:
                from evdev import UInput, ecodes

                self.codes = ecodes
                self.device = UInput({
                    ecodes.EV_REL: [ecodes.REL_X, ecodes.REL_Y],
                    ecodes.EV_KEY: [ecodes.BTN_LEFT, ecodes.BTN_RIGHT],
                }, name="MotionMouse", bustype=ecodes.BUS_USB)
            except (ImportError, OSError) as exc:
                raise RuntimeError(
                    "Cannot create MotionMouse: install backend dependencies, load uinput, "
                    "and grant your user /dev/uinput access. See README. "
                    "Use MOTIONMOUSE_OUTPUT=log for explicit non-injecting diagnosis."
                ) from exc
        else:
            log.warning("LOG OUTPUT: events will not control the real cursor")

    def move(self, dx: float, dy: float) -> None:
        values = [dx + self.remainder[0], dy + self.remainder[1]]
        counts = [max(-120, min(120, math.trunc(value))) for value in values]
        self.remainder = [value - math.trunc(value) for value in values]
        if not any(counts):
            return
        if self.device is not None:
            self.device.write(self.codes.EV_REL, self.codes.REL_X, counts[0])
            self.device.write(self.codes.EV_REL, self.codes.REL_Y, counts[1])
            self.device.syn()
        else:
            log.info("move %d %d", *counts)

    def button(self, button: str, down: bool) -> None:
        if (button in self.held) == down:
            return
        if self.device is not None:
            code = self.codes.BTN_LEFT if button == "left" else self.codes.BTN_RIGHT
            self.device.write(self.codes.EV_KEY, code, int(down))
            self.device.syn()
        else:
            log.info("button %s %s", button, "down" if down else "up")
        if down:
            self.held.add(button)
        else:
            self.held.discard(button)

    def release(self) -> None:
        try:
            for button in tuple(self.held):
                self.button(button, False)
        finally:
            self.remainder = [0.0, 0.0]

    def close(self) -> None:
        try:
            self.release()
        finally:
            if self.device is not None:
                self.device.close()
