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
  /** `error` says why the last connection attempt failed, while offline. */
  onStatus: (status: ConnStatus, error?: string) => void;
}

/** A silent connection (e.g. after a phone sleeps or switches networks) is detected
 *  by pinging; the relay answers pings automatically. */
const PING_EVERY = 20_000;
const PONG_TIMEOUT = 10_000;

/** `WebSocket.connect` resolves before the plugin registers the connection's writer,
 *  so the first sends can fail with this error; they're retried briefly. */
const NOT_REGISTERED = "connection not found";
const REGISTER_RETRIES = 20;
const REGISTER_RETRY_MS = 25;

/** Thrown for frames queued on a connection that has since been replaced. */
class StaleConnection extends Error {}

async function sendWhenRegistered(ws: WebSocket, frame: Parameters<WebSocket["send"]>[0], isCurrent: () => boolean) {
  for (let attempt = 0; ; attempt++) {
    if (!isCurrent()) throw new StaleConnection();
    try {
      await ws.send(frame);
      return;
    } catch (e) {
      // After a drop the plugin also reports "connection not found"; only retry while
      // this is still the live connection (i.e. the writer just isn't registered yet).
      if (attempt >= REGISTER_RETRIES || !isCurrent() || !String(e).toLowerCase().includes(NOT_REGISTERED)) throw e;
      await new Promise((r) => setTimeout(r, REGISTER_RETRY_MS));
    }
  }
}

/** Closes a connection, retrying briefly if its writer isn't registered yet (a close
 *  sent too early fails with "connection not found" and would leave the socket open). */
async function closeWhenRegistered(ws: WebSocket) {
  for (let attempt = 0; ; attempt++) {
    try {
      await ws.disconnect();
      return;
    } catch (e) {
      if (attempt >= REGISTER_RETRIES || !String(e).toLowerCase().includes(NOT_REGISTERED)) return;
      await new Promise((r) => setTimeout(r, REGISTER_RETRY_MS));
    }
  }
}

/** Name shown for this device in the other devices' "devices online" list. */
function deviceName(platform: string): string {
  return platform === "ios" ? "iPhone" : platform === "android" ? "Android phone" : "PC";
}

/** A short, human reason for a failed connection attempt. */
function connectError(url: string, e: unknown): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw URL */
  }
  const raw = String(e instanceof Error ? e.message : e).toLowerCase();
  if (raw.includes("refused") || raw.includes("10061") || raw.includes("os error 61") || raw.includes("os error 111"))
    return `Nothing is listening at ${host}. Is the relay running?`;
  if (raw.includes("timed out") || raw.includes("timeout") || raw.includes("10060"))
    return `${host} didn't answer. Check the address and that both devices are on the same network.`;
  if (raw.includes("dns") || raw.includes("resolve") || raw.includes("lookup") || raw.includes("11001"))
    return `Couldn't find ${host}. Check the address.`;
  if (raw.includes("certificate") || raw.includes("tls")) return `Secure connection to ${host} failed (TLS).`;
  return `Can't reach ${host}: ${String(e instanceof Error ? e.message : e)}`;
}

export class Relay {
  private ws: WebSocket | null = null;
  private generation = 0;
  private retry = 0;
  private timer: number | undefined;
  private pingTimer: number | undefined;
  private lastHeard = 0;
  private closed = false;
  /** Sends go through one queue per connection so frames reach the relay in the order
   *  they were sent; a new connection starts with an empty queue. */
  private queue: Promise<void> = Promise.resolve();

  private hello: {
    user_id: string;
    display_name: string;
    device_id: string;
    device_name: string;
    platform: string;
    secret: string;
  };

  constructor(
    private url: string,
    identity: { user_id: string; display_name: string; device_id: string; platform: string; secret: string },
    private handlers: Handlers,
  ) {
    this.hello = { ...identity, device_name: deviceName(identity.platform) };
    void this.connect();
  }

  private async connect() {
    const gen = ++this.generation;
    this.handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = await WebSocket.connect(this.url, { maxMessageSize: 64 << 20 });
    } catch (e) {
      if (gen === this.generation && !this.closed) {
        this.handlers.onStatus("offline", connectError(this.url, e));
        this.scheduleReconnect();
      }
      return;
    }
    if (this.closed || gen !== this.generation) {
      void closeWhenRegistered(ws);
      return;
    }
    this.ws = ws;
    this.queue = Promise.resolve();
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
      const isCurrent = () => gen === this.generation;
      this.queue = this.queue.then(() => sendWhenRegistered(ws, { type: "Ping", data: [] }, isCurrent)).catch(() => this.dropped(gen));
    }, PING_EVERY);
  }

  /** The connection is gone: report it once and reconnect. */
  private dropped(gen: number) {
    if (gen !== this.generation || !this.ws) return;
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    window.clearInterval(this.pingTimer);
    void closeWhenRegistered(ws);
    this.handlers.onStatus("offline");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.connect(), delay);
  }

  /** Drops the current connection (if any) and connects again right away. */
  reconnectNow() {
    if (this.closed) return;
    this.generation++;
    window.clearTimeout(this.timer);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) void closeWhenRegistered(ws);
    this.retry = 0;
    void this.connect();
  }

  get isOpen() {
    return this.ws !== null;
  }

  /** Queues a frame. Returns false if the socket is not open (the frame is dropped). */
  send(msg: ClientMsg): boolean {
    return this.enqueue(msg) !== null;
  }

  /** Like `send`, but resolves only once the frame was actually written (false if it wasn't). */
  sendConfirmed(msg: ClientMsg): Promise<boolean> {
    return this.enqueue(msg) ?? Promise.resolve(false);
  }

  private enqueue(msg: ClientMsg): Promise<boolean> | null {
    const ws = this.ws;
    if (!ws) return null;
    const gen = this.generation;
    const text = JSON.stringify(msg);
    const isCurrent = () => gen === this.generation;
    const written = this.queue.then(() => sendWhenRegistered(ws, text, isCurrent)).then(
      () => true,
      () => {
        this.dropped(gen);
        return false;
      },
    );
    this.queue = written.then(() => {});
    return written;
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
    if (ws) void closeWhenRegistered(ws);
  }
}
