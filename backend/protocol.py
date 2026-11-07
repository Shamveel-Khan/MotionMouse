"""Version 1 wire messages; all times are phone performance.now() milliseconds."""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

Finite = Annotated[float, Field(ge=-1000, le=1000, allow_inf_nan=False)]
Vector = tuple[Finite, Finite, Finite]
Timestamp = Annotated[float, Field(ge=0, le=1e15, allow_inf_nan=False)]


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    v: Literal[1]


class Auth(Message):
    type: Literal["auth"]
    token: Annotated[str, Field(min_length=32, max_length=512)]


class Sample(Message):
    type: Literal["sample"]
    seq: Annotated[int, Field(ge=0, le=2**53 - 1)]
    t: Timestamp
    linear: Vector | None
    gravity: Vector | None
    rotation: Vector | None
    angle: Literal[0, 90, 180, 270]


class Calibration(Message):
    type: Literal["calibrate"]


class Settings(Message):
    type: Literal["settings"]
    mode: Literal["inertial", "camera", "touchpad"]
    sensitivity: Annotated[float, Field(ge=0.1, le=5)]


class Tracking(Message):
    type: Literal["tracking"]
    enabled: bool
    calibrate_if_needed: bool = False


class Button(Message):
    type: Literal["button"]
    button: Literal["left", "right"]
    down: bool


class Touch(Message):
    type: Literal["touch"]
    dx: Annotated[float, Field(ge=-300, le=300)]
    dy: Annotated[float, Field(ge=-300, le=300)]


class CameraFrame(Message):
    type: Literal["camera"]
    seq: Annotated[int, Field(ge=0, le=2**53 - 1)]
    t: Timestamp
    dx: Annotated[float, Field(ge=-120, le=120)]
    dy: Annotated[float, Field(ge=-120, le=120)]
    quality: Annotated[float, Field(ge=0, le=1)]


class Release(Message):
    type: Literal["release"]


class Ping(Message):
    type: Literal["ping"]
    t: Timestamp


Incoming = Annotated[
    Union[Sample, Calibration, Settings, Tracking, Button, Touch, CameraFrame, Release, Ping],
    Field(discriminator="type"),
]
incoming = TypeAdapter(Incoming)
