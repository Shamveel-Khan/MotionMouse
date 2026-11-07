import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Connection } from './connection';
import type { ConnectionState } from './connection';
import type { MouseButton } from './protocol';
import { Sensors } from './sensors';
import type { SensorStatus } from './sensors';

export default function App() {
  const [link] = useState(() => new Connection());
  const [sensors] = useState(() => new Sensors());
  const [connection, setConnection] = useState<ConnectionState>({ status: 'disconnected', error: '', latency: null, server: null });
  const [sensor, setSensor] = useState<SensorStatus>({ enabled: false, source: 'none', rotation: false, hz: 0, message: 'Sensors have not been enabled.' });
  const [token, setToken] = useState('');
  const [localError, setLocalError] = useState('');
  const [held, setHeld] = useState<MouseButton[]>([]);
  const presses = useRef(new Map<number, MouseButton>());
  const touch = useRef<{ id: number; x: number; y: number } | null>(null);
  const server = connection.server;
  const connected = connection.status === 'connected';
  const tracking = connected && !!server?.tracking;
  const mode = server?.mode ?? 'inertial';
  const sensitivity = server?.sensitivity ?? 1;

  const releaseControls = () => {
    presses.current.clear();
    touch.current = null;
    setHeld([]);
  };

  const stop = () => {
    releaseControls();
    link.send({ type: 'release' });
    setConnection(previous => ({ ...previous,
      server: previous.server ? { ...previous.server, tracking: false, calibrated: false } : null }));
  };

  useEffect(() => {
    const unsubscribe = link.listen(setConnection);
    sensors.onStatus = setSensor;
    sensors.onSample = sample => { link.send({ type: 'sample', ...sample }); };
    const suspend = () => {
      presses.current.clear();
      touch.current = null;
      setHeld([]);
      link.send({ type: 'release' });
      setConnection(previous => ({ ...previous,
        server: previous.server ? { ...previous.server, tracking: false, calibrated: false } : null }));
    };
    const hide = () => {
      if (document.hidden) {
        suspend();
        sensors.stop();
      }
    };
    const leave = () => { suspend(); sensors.stop(); };
    sensors.onOrientationChange = () => {
      suspend();
      setLocalError('Screen orientation changed. Keep the phone flat and recalibrate.');
    };
    window.addEventListener('blur', suspend);
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hide);
    return () => {
      unsubscribe();
      sensors.stop();
      link.disconnect();
      window.removeEventListener('blur', suspend);
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [link, sensors]);

  useEffect(() => {
    if (!tracking) {
      presses.current.clear();
      touch.current = null;
      setHeld([]);
    }
  }, [tracking, connected]);

  useEffect(() => {
    if (!tracking || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let disposed = false;
    void navigator.wakeLock.request('screen').then(value => {
      if (disposed) void value.release();
      else lock = value;
    }).catch(() => { /* Optional; background safety does not depend on wake lock. */ });
    return () => { disposed = true; if (lock) void lock.release().catch(() => {}); };
  }, [tracking]);

  async function enableSensors() {
    setLocalError('');
    try { await sensors.enable(); }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'Unable to enable sensors.'); }
  }

  function buttonDown(event: ReactPointerEvent<HTMLButtonElement>, button: MouseButton) {
    if (event.button !== 0 || [...presses.current.values()].includes(button)) return;
    event.preventDefault();
    if (!link.send({ type: 'button', button, down: true })) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    presses.current.set(event.pointerId, button);
    setHeld([...presses.current.values()]);
  }

  function buttonUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const button = presses.current.get(event.pointerId);
    if (!button) return;
    presses.current.delete(event.pointerId);
    link.send({ type: 'button', button, down: false });
    setHeld([...presses.current.values()]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function touchDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tracking || mode !== 'touchpad' || touch.current || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function touchMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = touch.current;
    if (!previous || previous.id !== event.pointerId || !tracking) return;
    event.preventDefault();
    const clamp = (value: number) => Math.max(-300, Math.min(300, value));
    link.send({ type: 'touch', dx: clamp(event.clientX - previous.x), dy: clamp(event.clientY - previous.y) });
    touch.current = { id: previous.id, x: event.clientX, y: event.clientY };
  }

  function touchUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (touch.current?.id !== event.pointerId) return;
    touch.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <main>
      <header>
        <div><p className="eyebrow">LOCAL WIRELESS CONTROL</p><h1>MotionMouse<span>↗</span></h1></div>
        <span className={`badge ${connected ? 'online' : ''}`} role="status">{connection.status}</span>
      </header>

      <p className="intro">Move your phone. Move your cursor.</p>
      <p className="muted">Experimental physical translation · Arch Linux / KDE Wayland</p>

      {(!window.isSecureContext || location.protocol !== 'https:') && <div className="alert" role="alert">Trusted HTTPS is required. Open the laptop’s HTTPS address after installing its public CA certificate on your phone.</div>}
      {(connection.error || localError) && <div className="alert" role="alert">
        <p>{localError || connection.error}</p>
        <button className="small" onClick={() => { setLocalError(''); link.clearError(); }}>Dismiss</button>
      </div>}
      {server?.output === 'log' && <div className="alert">Logging-only output: the real cursor will not move. Change MOTIONMOUSE_OUTPUT to uinput on the laptop to inject input.</div>}

      <section aria-labelledby="connection-title">
        <h2 id="connection-title">01 <span>Connect to your laptop</span></h2>
        <form onSubmit={event => { event.preventDefault(); setLocalError(''); link.connect(token.trim()); setToken(''); }}>
          <label htmlFor="token">Pairing token <span className="muted">from your laptop .env</span></label>
          <div className="row">
            <input id="token" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false}
              placeholder="Paste your pairing token" value={token} onChange={event => setToken(event.target.value)} disabled={connection.status !== 'disconnected'} />
            {connection.status === 'disconnected'
              ? <button type="submit" className="primary" disabled={!token.trim()}>Connect</button>
              : <button type="button" onClick={() => { releaseControls(); sensors.stop(); link.disconnect(); }}>Disconnect</button>}
          </div>
        </form>
        <p className="hint">Same Wi-Fi · token stays in memory · one phone at a time</p>
      </section>

      <section aria-labelledby="motion-title">
        <h2 id="motion-title">02 <span>Choose your control</span></h2>
        <div className="segments" aria-label="Control mode">
          <button disabled={!connected} aria-pressed={mode === 'inertial'} onClick={() => { releaseControls(); link.send({ type: 'settings', mode: 'inertial', sensitivity }); }}>Translation</button>
          <button disabled={!connected} aria-pressed={mode === 'touchpad'} onClick={() => { releaseControls(); sensors.stop(); link.send({ type: 'settings', mode: 'touchpad', sensitivity }); }}>Touchpad</button>
        </div>

        {mode === 'inertial' ? <>
          <div className="instruction"><span aria-hidden="true">↔</span><p>Hold the phone <strong>flat, screen up</strong>, top edge pointing away. Slide right/left or forward/back. Keep its orientation steady.</p></div>
          <div className="row wrap">
            <button disabled={sensor.enabled} onClick={() => void enableSensors()}>{sensor.enabled ? 'Sensors enabled' : 'Enable sensors'}</button>
            <button disabled={!connected || !sensor.enabled || sensor.source === 'none' || server?.calibrating}
              onClick={() => { releaseControls(); setLocalError(''); link.clearError(); link.send({ type: 'calibrate' }); }}>Calibrate · hold still</button>
          </div>
          <p className={sensor.source === 'raw' ? 'warning' : 'hint'}>{sensor.message}</p>
          {sensor.enabled && !sensor.rotation && <p className="warning">No rotation-rate readings. Rotation rejection is limited; keep the phone flat and steady.</p>}
          {server?.calibrating && <label className="calibration">Keep still… <progress aria-label="Calibration progress" max="1" value={server.progress} /></label>}
          <p className="limitation">Short gestures work best. Drift and stop detection are estimates; slow or constant-speed motion may be suppressed. Recalibrate when needed.</p>
        </> : <p className="instruction">Move a finger across the pad below. Hold the left button with another finger to drag. No motion sensors needed.</p>}

        <label htmlFor="sensitivity" className="slider-label">Sensitivity <output htmlFor="sensitivity">{sensitivity.toFixed(1)}×</output></label>
        <input id="sensitivity" type="range" min="0.1" max="5" step="0.1" value={sensitivity} disabled={!connected || server?.calibrating}
          onChange={event => { releaseControls(); link.send({ type: 'settings', mode, sensitivity: Number(event.target.value) }); }} />
        <p className="hint">Changing sensitivity pauses tracking. KDE mouse acceleration also affects speed.</p>
        <button className={`tracking ${tracking ? 'stop' : 'primary'}`}
          disabled={!connected || server?.calibrating || (mode === 'inertial' && (!server?.calibrated || !sensor.enabled))}
          onClick={() => { releaseControls(); link.send({ type: 'tracking', enabled: !tracking }); }}>
          {tracking ? '■ Stop tracking' : '▶ Start tracking'}
        </button>
      </section>

      <section aria-labelledby="mouse-title">
        <h2 id="mouse-title">03 <span>Mouse controls</span></h2>
        <div className="mouse-buttons" onContextMenu={event => event.preventDefault()}>
          {(['left', 'right'] as const).map(button => <button key={button} className={`mouse ${held.includes(button) ? 'pressed' : ''}`}
            disabled={!connected || server?.calibrating} aria-pressed={held.includes(button)}
            onPointerDown={event => buttonDown(event, button)} onPointerUp={buttonUp}
            onPointerCancel={buttonUp} onLostPointerCapture={buttonUp}
            onClick={event => {
              // Keyboard and assistive activation generates a click without a pointer.
              if (event.detail === 0 && connected) {
                link.send({ type: 'button', button, down: true });
                link.send({ type: 'button', button, down: false });
              }
            }}>
            <span>{button === 'left' ? 'Left click' : 'Right click'}</span>
            <small>{button === 'left' ? 'Hold + move to drag' : 'Context menu'}</small>
          </button>)}
        </div>
        {mode === 'touchpad' && <div className={`touchpad ${tracking ? 'active' : ''}`}
          aria-label="Touchpad movement area" onContextMenu={event => event.preventDefault()}
          onPointerDown={touchDown} onPointerMove={touchMove} onPointerUp={touchUp}
          onPointerCancel={event => { touchUp(event); stop(); }} onLostPointerCapture={touchUp}>
          <span aria-hidden="true">＋</span><p>{tracking ? 'Slide a finger here' : 'Start tracking to use touchpad'}</p>
        </div>}
        <button className="emergency" disabled={!connected} onClick={stop}>Release all &amp; pause</button>
      </section>

      <section className="diagnostics" aria-labelledby="diagnostics-title">
        <h2 id="diagnostics-title">Live diagnostics</h2>
        <dl>
          <div><dt>Tracking</dt><dd>{tracking ? 'Active' : 'Paused'}</dd></div>
          <div><dt>Sensor rate</dt><dd>{sensor.enabled ? sensor.hz : 0} Hz</dd></div>
          <div><dt>Round trip</dt><dd>{connection.latency ?? '—'} ms</dd></div>
          <div><dt>Source</dt><dd>{mode === 'touchpad' ? 'Touch' : server?.source === 'raw' ? 'Raw / degraded' : server?.source ?? '—'}</dd></div>
          <div><dt>Acceleration X / Y</dt><dd>{server?.acceleration.join(' / ') ?? '—'} m/s²</dd></div>
          <div><dt>Estimated velocity X / Y</dt><dd>{server?.velocity.join(' / ') ?? '—'} m/s</dd></div>
        </dl>
        <p className="hint" role="status">{server?.reason ?? 'Connect to begin.'}</p>
      </section>
      <footer>Keep this page visible. Backgrounding stops control.<br />Translation estimates are experimental. Touchpad is the reliable fallback.</footer>
    </main>
  );
}
