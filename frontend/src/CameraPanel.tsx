import { useEffect, useRef, useState } from 'react';
import type { CameraStatus, CameraTracker } from './camera';

interface Props {
  tracker: CameraTracker;
  status: CameraStatus;
  connected: boolean;
  onPause: () => void;
}

export default function CameraPanel({ tracker, status, connected, onPause }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [axes, setAxes] = useState({ invertX: false, invertY: false, swapAxes: false });
  useEffect(() => {
    tracker.configure({ invertX: false, invertY: false, swapAxes: false });
    return () => tracker.stop();
  }, [tracker]);

  function changeAxis(key: keyof typeof axes, value: boolean) {
    onPause();
    const next = { ...axes, [key]: value };
    setAxes(next);
    tracker.configure(next);
  }

  return <div className="camera-panel">
    <p className="instruction">Hold the phone screen-up, with its rear camera about 15–30 cm above printed paper or a textured desk. Keep the lens uncovered and the phone parallel to the surface.</p>
    <video ref={video} className="camera-preview" muted playsInline autoPlay aria-label="Local rear camera preview" />
    <div className="row wrap">
      <button disabled={!connected || status.enabled || status.starting}
        onClick={() => { if (video.current) void tracker.start(video.current); }}>
        {status.starting ? 'Waiting for camera permission…' : 'Enable rear camera'}
      </button>
      <button disabled={!status.enabled && !status.starting} onClick={() => { onPause(); tracker.stop(); }}>Turn camera off</button>
    </div>
    <p className={status.ready ? 'hint' : 'warning'} role="status">{status.message}</p>
    <dl>
      <div><dt>Visual tracking</dt><dd>{status.ready ? 'Ready' : status.enabled ? 'Finding texture' : 'Camera off'}</dd></div>
      <div><dt>Processed frames</dt><dd>{status.fps} fps</dd></div>
      <div><dt>Matching confidence</dt><dd>{Math.round(status.quality * 100)}% · {status.features} patches</dd></div>
    </dl>
    <fieldset className="camera-axes">
      <legend>Adjust direction if needed · pauses tracking</legend>
      <label><input type="checkbox" checked={axes.invertX} onChange={event => changeAxis('invertX', event.target.checked)} /> Invert horizontal</label>
      <label><input type="checkbox" checked={axes.invertY} onChange={event => changeAxis('invertY', event.target.checked)} /> Invert vertical</label>
      <label><input type="checkbox" checked={axes.swapAxes} onChange={event => changeAxis('swapAxes', event.target.checked)} /> Swap horizontal / vertical</label>
    </fieldset>
    <p className="hint">Frames stay on this phone; only movement and confidence values are sent. No recording, video upload, or microphone access.</p>
    <p className="limitation">Camera mode measures scene displacement. Turning the phone, moving objects, poor light, blur, or a blank surface can cause errors. Keep height and orientation steady. Visual loss pauses control; start again when Ready.</p>
  </div>;
}
