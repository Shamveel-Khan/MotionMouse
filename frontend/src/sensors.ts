import type { SensorSample, Vector } from './protocol';

export interface SensorStatus {
  enabled: boolean;
  source: 'linear' | 'raw' | 'none';
  rotation: boolean;
  hz: number;
  message: string;
}

function vector(x: number | null | undefined, y: number | null | undefined, z: number | null | undefined): Vector | null {
  if ([x, y, z].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000)) {
    return [x!, y!, z!];
  }
  return null;
}

function angle(): 0 | 90 | 180 | 270 {
  const legacy = (window as Window & { orientation?: number }).orientation;
  const value = screen.orientation?.angle ?? legacy ?? 0;
  return (((Math.round(value / 90) * 90) % 360 + 360) % 360) as 0 | 90 | 180 | 270;
}

export class Sensors {
  onSample: (sample: SensorSample) => void = () => {};
  onStatus: (status: SensorStatus) => void = () => {};
  onOrientationChange: () => void = () => {};
  private active = false;
  private sequence = 0;
  private lastSent = 0;
  private lastEvent = 0;
  private lastReport = 0;
  private started = 0;
  private frequency = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: SensorStatus = { enabled: false, source: 'none', rotation: false, hz: 0, message: 'Sensors have not been enabled.' };

  async enable(): Promise<void> {
    if (this.active) return;
    if (!window.isSecureContext) throw new Error('Sensors require trusted HTTPS. Install the laptop CA on your phone.');
    if (!('DeviceMotionEvent' in window)) throw new Error('Device motion API unavailable. Use touchpad mode.');
    const motion = DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> };
    if (motion.requestPermission && await motion.requestPermission() !== 'granted') {
      throw new Error('Motion permission denied. Enable it in browser site settings, or use touchpad mode.');
    }
    this.active = true;
    this.started = performance.now();
    this.lastSent = this.lastEvent = this.lastReport = this.frequency = 0;
    this.status = { enabled: true, source: 'none', rotation: false, hz: 0, message: 'Waiting for motion readings…' };
    this.onStatus(this.status);
    window.addEventListener('devicemotion', this.motion);
    window.addEventListener('orientationchange', this.orientation);
    screen.orientation?.addEventListener('change', this.orientation);
    this.timer = setInterval(() => {
      if (performance.now() - (this.lastEvent || this.started) > 2000) {
        this.onStatus({ ...this.status, source: 'none', hz: 0,
          message: 'No recent usable motion readings. Check sensor permissions or use touchpad mode.' });
      }
    }, 1000);
  }

  stop(): void {
    this.active = false;
    window.removeEventListener('devicemotion', this.motion);
    window.removeEventListener('orientationchange', this.orientation);
    screen.orientation?.removeEventListener('change', this.orientation);
    clearInterval(this.timer);
    this.status = { ...this.status, enabled: false, hz: 0, message: 'Sensors stopped. Enable again to calibrate.' };
    this.onStatus(this.status);
  }

  private orientation = (): void => { this.onOrientationChange(); };

  private motion = (event: DeviceMotionEvent): void => {
    const linear = vector(event.acceleration?.x, event.acceleration?.y, event.acceleration?.z);
    const gravity = vector(event.accelerationIncludingGravity?.x, event.accelerationIncludingGravity?.y, event.accelerationIncludingGravity?.z);
    if (!linear && !gravity) return;
    const now = performance.now();
    if (this.lastEvent) {
      const hz = 1000 / Math.max(1, now - this.lastEvent);
      this.frequency = this.frequency ? this.frequency * 0.9 + hz * 0.1 : hz;
    }
    this.lastEvent = now;
    const rotation = vector(event.rotationRate?.alpha, event.rotationRate?.beta, event.rotationRate?.gamma);
    const source = linear ? 'linear' : 'raw';
    this.status = { enabled: true, source, rotation: !!rotation, hz: Math.round(this.frequency),
      message: source === 'raw' ? 'Degraded: gravity estimated from raw acceleration. Keep the phone flat.'
        : 'Gravity-free acceleration available. Translation estimation is still experimental.' };
    if (now - this.lastReport >= 250) {
      this.lastReport = now;
      this.onStatus(this.status);
    }
    if (now - this.lastSent < 1000 / 60) return;
    this.lastSent = now;
    this.onSample({ seq: this.sequence++, t: now, linear, gravity, rotation, angle: angle() });
  };
}
