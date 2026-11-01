// WebSocket connection to the relay server, with automatic reconnect.

import type { ClientMsg, ServerMsg } from "./types";

export type ConnStatus = "connecting" | "online" | "offline";

interface Handlers {
  onMessage: (msg: ServerMsg) => void;
  onStatus: (status: ConnStatus) => void;
}

export class Relay {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: number | undefined;
  private closed = false;

  constructor(
    private url: string,
    private hello: { user_id: string; display_name: string },
    private handlers: Handlers,
  ) {
    this.connect();
  }

  private connect() {
    this.handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: "hello", ...this.hello }));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === "welcome") this.handlers.onStatus("online");
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onStatus("offline");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Returns false if the socket is not open (the frame is dropped). */
  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  rename(display_name: string) {
    this.hello = { ...this.hello, display_name };
    this.send({ type: "hello", ...this.hello });
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
