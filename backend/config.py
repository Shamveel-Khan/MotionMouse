"""Environment configuration. Loading .env is handled by Uvicorn --env-file."""

from dataclasses import dataclass
import math
import os
from urllib.parse import urlsplit


def number(name: str, default: float, low: float, high: float) -> float:
    value = float(os.getenv(f"MOTIONMOUSE_{name}", str(default)))
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"MOTIONMOUSE_{name} must be between {low} and {high}")
    return value


@dataclass(frozen=True)
class Config:
    token: str
    origins: frozenset[str]
    output: str
    gain: float
    filter_tau: float
    damping: float
    quiet_seconds: float
    sample_gap: float
    stream_timeout: float
    max_sample_delay: float
    gesture_seconds: float
    max_velocity: float
    rotation_limit: float
    tilt_limit: float

    @classmethod
    def load(cls) -> "Config":
        token = os.getenv("MOTIONMOUSE_TOKEN", "")
        if not 32 <= len(token) <= 512 or token.startswith("replace-"):
            raise ValueError("Set MOTIONMOUSE_TOKEN to 32–512 random characters in .env")
        origins = frozenset(
            origin.strip().rstrip("/")
            for origin in os.getenv("MOTIONMOUSE_ORIGINS", "").split(",")
            if origin.strip()
        )
        if not origins:
            raise ValueError("Set MOTIONMOUSE_ORIGINS to explicit HTTPS browser origins")
        for origin in origins:
            parsed = urlsplit(origin)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.path
                    or parsed.query or parsed.fragment or parsed.username):
                raise ValueError("Each MOTIONMOUSE_ORIGINS entry must be an HTTPS origin, without a path")
        output = os.getenv("MOTIONMOUSE_OUTPUT", "uinput")
        if output not in {"uinput", "log"}:
            raise ValueError("MOTIONMOUSE_OUTPUT must be uinput or log")
        return cls(
            token=token, origins=origins, output=output,
            gain=number("GAIN", 2400, 100, 10000),
            filter_tau=number("FILTER_TAU", 0.04, 0.005, 0.5),
            damping=number("DAMPING", 2, 0, 20),
            quiet_seconds=number("QUIET_SECONDS", 0.15, 0.05, 1),
            sample_gap=number("SAMPLE_GAP", 0.15, 0.05, 0.5),
            stream_timeout=number("STREAM_TIMEOUT", 0.5, 0.15, 2),
            max_sample_delay=number("MAX_SAMPLE_DELAY", 0.25, 0.05, 2),
            gesture_seconds=number("GESTURE_SECONDS", 2, 0.25, 5),
            max_velocity=number("MAX_VELOCITY", 1.5, 0.1, 5),
            rotation_limit=number("ROTATION_LIMIT", 35, 5, 180),
            tilt_limit=number("TILT_LIMIT", 12, 3, 45),
        )
