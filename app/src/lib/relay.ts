// WebSocket connection to the relay server, with automatic reconnect.
//
// The socket is opened by the Rust side (tauri-plugin-websocket), not the webview.
// On iOS the app's pages count as a secure context, and WebKit blocks plain ws://
// connections from them; a native socket has no such restriction, so a ws:// relay
// on the LAN works the same on every platform.

import WebSocket, { type Message } from "@tauri-apps/plugin-websocket";
import type { ClientMsg, ServerMsg } from "./types";

export type ConnStatus = "connecting" | "online" | "offline";

interface Handlers {
  onMessage: (msg: ServerMsg) => void;
  onStatus: (status: ConnStatus) => void;
}

/** A silent connection (e.g. after a phone sleeps or switches networks) is detected
 *  by pinging; the relay answers pings automatically. */
const PING_EVERY = 20_000;
const PONG_TIMEOUT = 10_000;

export class Relay {
  private ws: WebSocket | null = null;
  private generation = 0;
  private retry = 0;
  private timer: number | undefined;
  private pingTimer: number | undefined;
  private lastHeard = 0;
  private closed = false;
  /** Sends go through one queue so frames reach the relay in the order they were sent. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private url: string,
    private hello: { user_id: string; display_name: string },
    private handlers: Handlers,
  ) {
    void this.connect();
  }

  private async connect() {
    const gen = ++this.generation;
    this.handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = await WebSocket.connect(this.url, { maxMessageSize: 64 << 20 });
    } catch {
      if (gen === this.generation) this.scheduleReconnect();
      return;
    }
    if (this.closed || gen !== this.generation) {
      void ws.disconnect().catch(() => {});
      return;
    }
    this.ws = ws;
    this.retry = 0;
    this.lastHeard = Date.now();
    ws.addListener((m) => this.onFrame(gen, m));
    this.startPings(gen);
    this.send({ type: "hello", ...this.hello });
  }

  private onFrame(gen: number, m: Message | unknown) {
    if (gen !== this.generation) return;
    this.lastHeard = Date.now();
    // The plugin reports network failures as a plain error value, not a typed message.
    const frame = m as Partial<Message> | null;
    if (!frame || typeof frame !== "object" || !("type" in frame) || frame.type === "Close") {
      this.dropped(gen);
      return;
    }
    if (frame.type !== "Text") return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(frame.data as string);
    } catch {
      return;
    }
    if (msg.type === "welcome") this.handlers.onStatus("online");
    this.handlers.onMessage(msg);
  }

  private startPings(gen: number) {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (gen !== this.generation || !this.ws) return;
      if (Date.now() - this.lastHeard > PING_EVERY + PONG_TIMEOUT) {
        this.dropped(gen);
        return;
      }
      const ws = this.ws;
      this.queue = this.queue.then(() => ws.send({ type: "Ping", data: [] })).catch(() => this.dropped(gen));
    }, PING_EVERY);
  }

  /** The connection is gone: report it once and reconnect. */
  private dropped(gen: number) {
    if (gen !== this.generation || !this.ws) return;
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    window.clearInterval(this.pingTimer);
    void ws.disconnect().catch(() => {});
    this.handlers.onStatus("offline");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.connect(), delay);
  }

  get isOpen() {
    return this.ws !== null;
  }

  /** Returns false if the socket is not open (the frame is dropped). */
  send(msg: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws) return false;
    const gen = this.generation;
    const text = JSON.stringify(msg);
    this.queue = this.queue.then(() => ws.send(text)).catch(() => this.dropped(gen));
    return true;
  }

  rename(display_name: string) {
    this.hello = { ...this.hello, display_name };
    this.send({ type: "hello", ...this.hello });
  }

  close() {
    this.closed = true;
    this.generation++;
    window.clearTimeout(this.timer);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    void ws?.disconnect().catch(() => {});
  }
}
