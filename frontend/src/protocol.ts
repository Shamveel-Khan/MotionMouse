export type Vector = [number, number, number];
export type Mode = 'inertial' | 'touchpad';
export type MouseButton = 'left' | 'right';

export interface SensorSample {
  seq: number;
  t: number;
  linear: Vector | null;
  gravity: Vector | null;
  rotation: Vector | null;
  angle: 0 | 90 | 180 | 270;
}

export type ClientMessage =
  | ({ type: 'sample' } & SensorSample)
  | { type: 'calibrate' }
  | { type: 'settings'; mode: Mode; sensitivity: number }
  | { type: 'tracking'; enabled: boolean }
  | { type: 'button'; button: MouseButton; down: boolean }
  | { type: 'touch'; dx: number; dy: number }
  | { type: 'release' }
  | { type: 'ping'; t: number };

export interface ServerState {
  v: 1;
  type: 'state';
  mode: Mode;
  sensitivity: number;
  tracking: boolean;
  output: 'log' | 'uinput';
  source: 'raw' | 'linear' | null;
  calibrated: boolean;
  calibrating: boolean;
  progress: number;
  hz: number;
  rotation_available: boolean;
  acceleration: [number, number];
  velocity: [number, number];
  reason: string;
}

export type ServerMessage = ServerState
  | { v: 1; type: 'pong'; t: number }
  | { v: 1; type: 'error'; message: string };
