import { estimateFlow } from './optical-flow';
import type { CameraSample } from './protocol';

export interface CameraStatus {
  enabled: boolean;
  starting: boolean;
  ready: boolean;
  fps: number;
  quality: number;
  features: number;
  message: string;
}

interface CameraOptions { invertX: boolean; invertY: boolean; swapAxes: boolean }

export const INITIAL_CAMERA_STATUS: CameraStatus = {
  enabled: false, starting: false, ready: false, fps: 0, quality: 0, features: 0,
  message: 'Camera is off. Enable the rear camera to begin.',
};

export class CameraTracker {
  onSample: (sample: CameraSample) => void = () => {};
  onStatus: (status: CameraStatus) => void = () => {};
  onLost: (reason: string) => void = () => {};
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private previous: Uint8Array | null = null;
  private generation = 0;
  private request = 0;
  private sequence = 0;
  private lastFrame = 0;
  private lastVideoTime = -1;
  private lastReport = 0;
  private started = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private goodFrames = 0;
  private badFrames = 0;
  private armed = false;
  private blocked = true;
  private options: CameraOptions = { invertX: false, invertY: false, swapAxes: false };
  private status: CameraStatus = { ...INITIAL_CAMERA_STATUS };

  async start(video: HTMLVideoElement): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.publish({ message: 'Camera access requires trusted HTTPS, such as your ngrok HTTPS URL.' }, true);
      return;
    }
    this.publish({ starting: true, message: 'Allow rear camera access when prompted…' }, true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 20, max: 30 },
      } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.video = video;
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      if (generation !== this.generation) return;
      this.canvas = document.createElement('canvas');
      this.canvas.width = 160; this.canvas.height = 120;
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!this.context) throw new Error('Canvas image processing is unavailable in this browser.');
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (generation !== this.generation) return;
          this.lose('Camera stream ended; enable the camera again.');
          this.stop();
          this.publish({ message: 'Camera stream ended; enable the camera again.' }, true);
        });
      }
      window.addEventListener('orientationchange', this.orientation);
      screen.orientation?.addEventListener('change', this.orientation);
      this.started = performance.now();
      this.publish({ enabled: true, starting: false, message: 'Aim the rear camera at a well-lit textured surface. Warming up…' }, true);
      this.request = requestAnimationFrame(this.frame);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const name = error instanceof DOMException ? error.name : '';
      const message = name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in Chrome site settings.'
        : name === 'NotFoundError' ? 'No usable camera found on this device.'
        : name === 'NotReadableError' ? 'Camera is busy. Close other camera apps and try again.'
        : error instanceof Error ? error.message : 'Unable to start the camera.';
      this.publish({ message }, true);
    }
  }

  stop(): void {
    this.generation++;
    cancelAnimationFrame(this.request);
    window.removeEventListener('orientationchange', this.orientation);
    screen.orientation?.removeEventListener('change', this.orientation);
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.stream = null; this.video = null; this.canvas = null; this.context = null;
    this.armed = false; this.blocked = true; this.previous = null;
    this.lastFrame = 0; this.lastVideoTime = -1; this.lastWidth = 0; this.lastHeight = 0;
    this.goodFrames = 0; this.badFrames = 0;
    this.status = { ...INITIAL_CAMERA_STATUS };
    this.onStatus(this.status);
  }

  prepareTracking(): void {
    // Only an explicit user Start clears a loss latch; stale server state cannot.
    if (this.status.enabled && this.status.ready) this.blocked = false;
  }

  setTracking(enabled: boolean): void {
    if (!enabled) this.blocked = true;
    const next = enabled && !this.blocked && this.status.enabled;
    if (next === this.armed) return;
    this.armed = next;
    this.previous = null;
  }

  configure(options: Partial<CameraOptions>): void {
    this.options = { ...this.options, ...options };
    this.armed = false; this.blocked = true; this.previous = null;
  }

  private publish(change: Partial<CameraStatus>, immediate = false): void {
    this.status = { ...this.status, ...change };
    const now = performance.now();
    if (immediate || now - this.lastReport >= 250) {
      this.lastReport = now;
      this.onStatus(this.status);
    }
  }

  private lose(message: string): void {
    const wasArmed = this.armed;
    this.armed = false; this.blocked = true; this.previous = null;
    this.goodFrames = 0;
    this.publish({ ready: false, quality: 0, message }, true);
    if (wasArmed) this.onLost(message);
  }

  private orientation = (): void => { this.lose('Screen orientation changed. Hold steady, wait for Ready, and start again.'); };

  private frame = (now: number): void => {
    const video = this.video, context = this.context;
    if (!video || !context) return;
    this.request = requestAnimationFrame(this.frame);
    if (now - (this.lastFrame || this.started) > 500 && this.armed) this.lose('Camera frames stalled. Wait for live video and start again.');
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime || now - this.lastFrame < 50) {
      if (now - (this.lastFrame || this.started) > 2000) this.publish({ ready: false, fps: 0, message: 'No recent camera frames. Keep Chrome visible and check camera access.' });
      return;
    }
    const elapsed = this.lastFrame ? now - this.lastFrame : 0;
    if (elapsed > 250) this.previous = null;
    if (video.videoWidth !== this.lastWidth || video.videoHeight !== this.lastHeight) {
      this.previous = null; this.lastWidth = video.videoWidth; this.lastHeight = video.videoHeight;
    }
    this.lastFrame = now; this.lastVideoTime = video.currentTime;
    try {
      context.drawImage(video, 0, 0, 160, 120);
      const rgba = context.getImageData(0, 0, 160, 120).data;
      const gray = new Uint8Array(160 * 120);
      for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
      const flow = this.previous ? estimateFlow(this.previous, gray, 160, 120) : null;
      this.previous = gray;
      const quality = flow?.quality ?? 0;
      if (quality >= 0.6) { this.goodFrames++; this.badFrames = 0; }
      else { this.badFrames++; this.goodFrames = 0; }
      if (this.badFrames >= 3 && this.armed) this.lose(flow?.message ?? 'Visual tracking lost. Hold steady and start again.');
      let dx = -(flow?.dx ?? 0), dy = -(flow?.dy ?? 0);
      if (this.options.swapAxes) [dx, dy] = [dy, dx];
      if (this.options.invertX) dx = -dx;
      if (this.options.invertY) dy = -dy;
      // Four cursor counts per reduced-image pixel, before backend sensitivity.
      this.onSample({ seq: this.sequence++, t: now, dx: this.armed ? dx * 4 : 0,
        dy: this.armed ? dy * 4 : 0, quality });
      this.publish({ ready: this.goodFrames >= 3, quality, features: flow?.matches ?? 0,
        fps: elapsed ? Math.round(1000 / elapsed) : 0, message: flow?.message ?? 'Establishing a new frame reference…' });
    } catch (error) {
      this.lose(error instanceof Error ? error.message : 'Unable to process camera frames.');
      this.stop();
      this.publish({ message: 'Camera processing failed. Stop other camera apps and enable the camera again.' }, true);
    }
  };
}
