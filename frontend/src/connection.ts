import type { ClientMessage, ServerMessage, ServerState } from './protocol';

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'retrying';
  error: string;
  latency: number | null;
  server: ServerState | null;
}

export class Connection {
  private socket: WebSocket | null = null;
  private token = '';
  private desired = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastReply = 0;
  private listener: (state: ConnectionState) => void = () => {};
  private state: ConnectionState = { status: 'disconnected', error: '', latency: null, server: null };

  get ready(): boolean { return this.state.status === 'connected'; }

  listen(listener: (state: ConnectionState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => { this.listener = () => {}; };
  }

  private update(change: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...change };
    this.listener(this.state);
  }

  connect(token: string): void {
    this.disconnect();
    if (!window.isSecureContext || location.protocol !== 'https:') {
      this.update({ error: 'Open this page over trusted HTTPS. A LAN HTTP address cannot enable phone sensors.' });
      return;
    }
    if (token.length < 32 || token.length > 512) {
      this.update({ error: 'Enter the 32–512 character token configured on the laptop.' });
      return;
    }
    this.token = token;
    this.desired = true;
    this.attempts = 0;
    this.open();
  }

  private open(): void {
    this.update({ status: 'connecting', error: '', server: null, latency: null });
    const socket = new WebSocket(new URL('/ws', location.href).toString().replace(/^https:/, 'wss:'));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.update({ status: 'authenticating' });
      socket.send(JSON.stringify({ v: 1, type: 'auth', token: this.token }));
      this.lastReply = performance.now();
      this.heartbeat = setInterval(() => {
        if (performance.now() - this.lastReply > 2500) {
          this.update({ error: 'Laptop stopped responding. Tracking has been stopped.' });
          socket.close(4000, 'Reply timeout');
        } else if (this.ready) {
          this.send({ type: 'ping', t: performance.now() });
        }
      }, 500);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const data = JSON.parse(String(event.data)) as ServerMessage;
        if (data.v !== 1) throw new Error('Unsupported server protocol');
        this.lastReply = performance.now();
        if (data.type === 'state') {
          this.attempts = 0;
          this.update({ status: 'connected', server: data });
        } else if (data.type === 'error') {
          this.update({ error: data.message });
        } else if (data.type === 'pong') {
          this.update({ latency: Math.round(performance.now() - data.t) });
        }
      } catch {
        this.update({ error: 'Invalid response from laptop. Reconnect after checking backend versions.' });
        socket.close(4000, 'Invalid response');
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) this.update({ error: 'Connection failed. Check Wi-Fi, HTTPS trust, backend and allowed Origin.' });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      this.socket = null;
      const terminal = event.code === 1008 || event.code === 1013;
      if (terminal) this.desired = false;
      this.update({
        status: this.desired ? 'retrying' : 'disconnected', server: null, latency: null,
        error: event.reason || this.state.error || 'Connection closed. Tracking stopped.',
      });
      if (this.desired) {
        const delay = Math.min(10000, 500 * 2 ** Math.min(this.attempts++, 5));
        this.retry = setTimeout(() => this.open(), delay);
      } else {
        this.token = '';
      }
    };
  }

  send(message: ClientMessage): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > 8192) {
      this.socket.close(4000, 'Connection congested; motion discarded');
      return false;
    }
    this.socket.send(JSON.stringify({ v: 1, ...message }));
    return true;
  }

  clearError(): void { this.update({ error: '' }); }

  disconnect(): void {
    if (this.ready) this.send({ type: 'release' });
    this.desired = false;
    this.token = '';
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'User disconnected');
    this.update({ status: 'disconnected', server: null, latency: null, error: '' });
  }
}
