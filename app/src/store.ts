// App state: relay connection, rooms, messages, and AI reply orchestration.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { create, type StoreApi } from "zustand";
import { backend, errorText } from "./lib/backend";
import { prepareImage } from "./lib/images";
import { Relay, type ConnStatus } from "./lib/relay";
import type {
  Attachment,
  ClientState,
  Device,
  DeviceCommand,
  HistoryItem,
  McpMode,
  Message,
  NotifyMode,
  RoomInfo,
  SearchHit,
  ServerMsg,
  SharedMcpServer,
  SharedProfile,
  ToolStatus,
} from "./lib/types";

/** Tool call details only the sender sees (arguments and a result preview). */
export interface LocalTool {
  status: ToolStatus;
  args: string | null;
  detail: string | null;
}

/** A tool call of a reply another of this user's devices generates for this one. */
export interface RemoteTool {
  deviceId: string;
  args: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: "error" | "info";
}

interface ChatState {
  client: ClientState | null;
  status: ConnStatus;
  /** Why the last connection attempt failed, while not connected. */
  connError: string | null;
  rooms: Record<string, RoomInfo>;
  roomOrder: string[];
  messages: Record<string, Message[]>;
  loaded: Record<string, boolean>;
  /** Room id → true when a message there mentioned this user since the room was last open. */
  mentioned: Record<string, boolean>;
  /** Room id → whether older messages exist before the first one loaded. */
  hasMore: Record<string, boolean>;
  /** Room id → whether an older-messages request is in flight. */
  loadingOlder: Record<string, boolean>;
  unread: Record<string, number>;
  activeRoomId: string | null;
  /** True after the phone's back button: stay on the room list instead of opening a
   *  room automatically when the relay (re)connects. */
  roomClosed: boolean;
  /** This account's devices that are online right now (device linking). */
  devices: Device[];
  /** AI message ids this client is currently generating. */
  myGenerations: Record<string, true>;
  /** AI message id → call id → details, for replies this client generates. */
  localTools: Record<string, Record<string, LocalTool>>;
  /** AI message id → call id → approvals waiting here for a reply another device generates. */
  remoteTools: Record<string, Record<string, RemoteTool>>;
  /** attachment id → data URL ("" while loading). */
  images: Record<string, string>;
  /** Room id → user id → who is typing and when that expires (never persisted). */
  typing: Record<string, Record<string, { name: string; until: number }>>;
  /** A pending "scroll to this message" from a search jump: MessageList scrolls
   *  to it and flashes it, then clears it via clearJump. */
  jumpTarget: { roomId: string; id: string } | null;
  toasts: Toast[];

  init(): Promise<void>;
  refreshClient(): Promise<void>;
  /** Reconnects to the relay now instead of waiting for the next retry. */
  reconnect(): void;
  saveIdentity(displayName: string, serverUrl: string): Promise<void>;
  selectRoom(id: string): void;
  /** Back to the room list (phones). */
  closeRoom(): void;
  createRoom(name: string): Promise<RoomInfo>;
  joinRoom(code: string): Promise<RoomInfo>;
  /** Creates a one-use code another device can redeem to join this account. */
  createLinkCode(): Promise<{ code: string; expiresInSecs: number }>;
  /** Redeems another device's code and switches this device to its account. */
  redeemLinkCode(code: string): Promise<void>;
  /** Leaves the linked account and returns to this device's own. */
  unlink(): Promise<void>;
  leaveRoom(id: string): void;
  /** Resolves true once the message was actually written to the relay. */
  sendMessage(roomId: string, content: string, aiRequested: boolean, profileId: string | null, replyTo?: string | null): Promise<boolean>;
  /** Rewrites one of this user's own human messages. */
  editMessage(roomId: string, messageId: string, content: string): Promise<boolean>;
  /** Soft-deletes one of this user's own messages (human, or an AI reply they generated). */
  deleteMessage(roomId: string, messageId: string): Promise<boolean>;
  regenerate(ai: Message, profileId: string): void;
  stopAi(id: string): void;
  /** Asks the relay for the next page of older messages (scroll-up pagination). */
  loadOlder(roomId: string): void;
  /** Full-text search over a room's messages (newest first). */
  searchMessages(roomId: string, query: string): Promise<SearchHit[]>;
  /** Scrolls the room to a message, loading older history until it's on screen. */
  jumpTo(roomId: string, messageId: string, seq: number): void;
  /** Clears the jump target once MessageList has scrolled to it. */
  clearJump(): void;
  /** Adds or removes this user's reaction on a message (human or AI). */
  react(roomId: string, messageId: string, emoji: string, on: boolean): void;
  /** Best-effort "I'm typing" broadcast; never persisted by the relay. */
  setTyping(roomId: string, typing: boolean): void;
  setRoomPrompt(roomId: string, prompt: string): void;
  chooseProfile(roomId: string, profileId: string): void;
  setRoomMcpMode(roomId: string, serverId: string, mode: McpMode): void;
  /** Settings: turns one of this device's profiles on or off. */
  setProfileEnabled(id: string, enabled: boolean): Promise<void>;
  /** Settings: whether this user's other devices may control this one. */
  setRemoteControl(enabled: boolean): Promise<void>;
  /** Switches an MCP server on another of this user's devices, in one room. */
  setRemoteMcpMode(deviceId: string, roomId: string, serverId: string, mode: McpMode): void;
  /** Turns a profile on another of this user's devices on or off. */
  setRemoteProfileEnabled(deviceId: string, profileId: string, enabled: boolean): void;
  /** Picks which messages in a room earn a system notification. */
  setRoomNotify(roomId: string, mode: NotifyMode): void;
  /** Settings → General: asks for the OS permission if needed, then shows a sample. */
  testNotification(): Promise<void>;
  answerToolCall(id: string, callId: string, approved: boolean): void;
  loadImage(attachmentId: string): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
}

let relay: Relay | null = null;
/** Human message id → profile id, waiting for the server echo before the AI call starts. */
const pendingAi = new Map<string, string>();

/** The relay's answer to a `hello` whose account secret is wrong (see server `hello`). */
export const SIGN_IN_REFUSED = /isn't signed in to that account/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `content` mentions `name` as `@name` (case-insensitive, not followed by
 *  more of a word, so "@Sam" doesn't match "@Samantha"). Names may contain spaces. */
export function mentions(content: string, name: string): boolean {
  if (!name.trim()) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(name.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(content);
}

/** A profile on another of this user's devices is referenced as `remote:<device_id>:<profile_id>`. */
export function remoteProfileId(deviceId: string, profileId: string): string {
  return `remote:${deviceId}:${profileId}`;
}

/** What a remote server does for replies in `roomId`. Auto counts as Ask: a delegated
 *  reply asks before every tool call whatever the server's mode. */
export function remoteMode(s: SharedMcpServer, roomId: string): McpMode {
  return (s.room_modes[roomId] ?? s.default_mode) === "off" ? "off" : "ask";
}

export function parseRemoteProfileId(id: string): { deviceId: string; profileId: string } | null {
  if (!id.startsWith("remote:")) return null;
  const rest = id.slice("remote:".length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { deviceId: rest.slice(0, cut), profileId: rest.slice(cut + 1) };
}

/** An `ai_requested` waiting for the room's history to load here, so the anchor
 *  can be found and the reply generated: room → pending requests. */
const pendingDelegatedOpens = new Map<string, { requestId: string; anchorId: string; anchorSeq: number; profileId: string; fromDeviceId: string }[]>();
/** Generation id → the device of this user it's generating for. Only that device can
 *  answer the reply's tool calls remotely; a reply started here is never reachable. */
const delegatedGenerations = new Map<string, string>();
/** "<message id>:<call id>" → the approval a delegated reply is waiting on, kept so
 *  it can be sent again if the asking device was away (phones drop off often). */
const pendingApprovals = new Map<string, { deviceId: string; command: DeviceCommand }>();
/** Tool arguments sent for approval: enough to judge, and well inside the relay's limit. */
const MAX_APPROVAL_ARGS = 16_000;
/** The profile list last shared on the current connection (null: none yet). */
let lastSharedProfiles: string | null = null;
/** Images announced for a reply this client hasn't loaded yet (e.g. while joining). */
const unclaimedAttachments = new Map<string, Attachment[]>();
/** Room id → the message a search jump is waiting for, while older history that
 *  reaches back to it is being fetched. */
const pendingJumps = new Map<string, { id: string; seq: number }>();

/** System notifications: room id → when the last one went out, how many messages
 *  have been held back since (counted into the next one), and whether one is
 *  waiting on the permission ask. */
const notifyState = new Map<string, { lastAt: number; held: number; pending: boolean }>();
const NOTIFY_GAP = 5000;
/** The OS permission this run: "unknown" until the first notification would be
 *  shown, then "granted", or "denied" (which stops every attempt until restart). */
let notifyPermission: "unknown" | "granted" | "denied" = "unknown";
/** The one permission ask per run, shared by every room and the test button. */
let notifyPermissionAsk: Promise<boolean> | null = null;
/** Hooks notification clicks once; settles when the listener is in place. */
let notifyClicks: Promise<unknown> | null = null;
/** Saves of notification choices, run one at a time so the last choice wins. */
let notifyWrites: Promise<unknown> = Promise.resolve();
function queueNotifyWrite(write: () => Promise<void>): Promise<void> {
  const run = notifyWrites.then(write);
  notifyWrites = run.catch(() => {});
  return run;
}

/** Adds attachments not already on the message, plus any waiting for it. */
function withAttachments(m: Message, extra: Attachment[] = []): Message {
  const waiting = unclaimedAttachments.get(m.id) ?? [];
  unclaimedAttachments.delete(m.id);
  const add = [...extra, ...waiting].filter(
    (a, i, all) => !m.attachments.some((b) => b.attachment_id === a.attachment_id) && all.findIndex((b) => b.attachment_id === a.attachment_id) === i,
  );
  return add.length ? { ...m, attachments: [...m.attachments, ...add] } : m;
}

const pendingRequests = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
let toastSeq = 0;

/** Reply to `create_link_code`. */
interface LinkCodeReply {
  code: string;
  expires_in_secs: number;
}

/** Reply to `redeem_link_code`: the code owner's identity. */
interface LinkedReply {
  user_id: string;
  display_name: string;
  /** The account's secret, so this device can sign in to it. */
  secret: string;
}

function upsert(list: Message[] | undefined, m: Message): Message[] {
  const next = (list ?? []).filter((x) => x.id !== m.id);
  next.push(m);
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

function patchMessage(list: Message[] | undefined, id: string, f: (m: Message) => Message): Message[] | undefined {
  if (!list) return list;
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return list;
  const next = list.slice();
  next[i] = f(next[i]);
  return next;
}

/** How long a `typing: true` stays believable without a repeat frame (ms). */
const TYPING_TTL = 6000;

/** Drops one user's typing entry from a room, keeping the object identity when it
 *  wasn't there (so unrelated rooms' components don't re-render). */
function dropTyping(s: ChatState, roomId: string, userId: string) {
  const room = s.typing[roomId];
  if (!room || !(userId in room)) return {};
  const { [userId]: _, ...rest } = room;
  return { typing: { ...s.typing, [roomId]: rest } };
}

/** The OS permission this run, asked for at most once. Resolves true when
 *  notifications may be shown; false means "stop trying until restart" and
 *  says so once with a toast. */
function notificationPermission(get: () => ChatState): Promise<boolean> {
  if (notifyPermission === "granted") return Promise.resolve(true);
  if (notifyPermission === "denied") return Promise.resolve(false);
  notifyPermissionAsk ??= (async () => {
    // A failed check counts as denied: the ask must not stay rejected for the whole run.
    const granted = await (async () => (await isPermissionGranted()) || (await requestPermission()) === "granted")().catch(() => false);
    notifyPermission = granted ? "granted" : "denied";
    if (!granted) get().toast("Notifications are off for Multichat in your system settings", "info");
    return granted;
  })();
  return notifyPermissionAsk;
}

/** Clicking a notification focuses the window and opens its room. Where the
 *  platform doesn't report the click, nothing extra happens. Await it before
 *  sending: the plugin only tracks clicks on notifications sent after this. */
function hookNotificationClicks() {
  notifyClicks ??= onAction((event) => {
    if (event.actionId !== "tap") return;
    const roomId = event.notification?.extra?.roomId;
    if (typeof roomId !== "string") return;
    const win = getCurrentWindow();
    void win.show().catch(() => {});
    void win.unminimize().catch(() => {});
    void win.setFocus().catch(() => {});
    useChat.getState().selectRoom(roomId);
  }).catch(() => {
    /* the platform doesn't report clicks; the notifications still show */
  });
  return notifyClicks;
}

/** True while the user is actually looking at this room. */
function roomOnScreen(s: ChatState, roomId: string): boolean {
  return s.activeRoomId === roomId && document.visibilityState === "visible" && document.hasFocus();
}

/** Shows one system notification for `roomId`, or holds it (counted) while the
 *  5-second window for that room hasn't passed, so the next one can say how
 *  many messages piled up. */
async function notifyRoom(get: () => ChatState, roomId: string, roomName: string, body: string) {
  const st = notifyState.get(roomId);
  if (st && (st.pending || Date.now() - st.lastAt < NOTIFY_GAP)) {
    notifyState.set(roomId, { ...st, held: st.held + 1 });
    return;
  }
  // Claim the room before the permission ask, so messages arriving while the OS
  // prompt is open fold into this notification instead of sending their own.
  notifyState.set(roomId, { lastAt: Date.now(), held: st?.held ?? 0, pending: true });
  await hookNotificationClicks();
  const allowed = await notificationPermission(get);
  const claimed = notifyState.get(roomId);
  if (!claimed) return; // Left the room during the wait.
  // During the wait the room may have been set to Off (its text must not show)
  // or opened on screen.
  if (!allowed || get().client?.notify_by_room[roomId] === "off" || roomOnScreen(get(), roomId)) {
    notifyState.set(roomId, { ...claimed, held: 0, pending: false });
    return;
  }
  const count = claimed.held + 1;
  notifyState.set(roomId, { lastAt: Date.now(), held: 0, pending: false });
  sendNotification({
    title: `#${roomName}`,
    body: count > 1 ? `${count} new messages` : body,
    extra: { roomId },
  });
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = map;
  return rest;
}

/** One notifiable message arrived: someone else's human message, or one of their
 *  finished AI replies. Applies the room's mode and the "app isn't showing this
 *  room" rule; a room set to Off never puts message text in a notification. */
function maybeNotifyMessage(get: () => ChatState, m: Message, content: string) {
  const s = get();
  const me = s.client;
  if (!me || m.deleted) return;
  // Own messages, from this device or any other of this user's, never notify.
  if (m.author_id === me.user_id) return;
  const mode = me.notify_by_room[m.room_id] ?? "mentions";
  if (mode === "off") return;
  // Only when the app isn't showing that room: the window is hidden or
  // unfocused, or another room is open.
  if (roomOnScreen(s, m.room_id)) return;
  if (mode === "mentions") {
    if (m.kind === "human") {
      if (!mentions(content, me.display_name)) return;
    } else {
      // An AI reply counts only when it answers this user's message.
      const anchor = m.anchor_id ? s.messages[m.room_id]?.find((x) => x.id === m.anchor_id) : undefined;
      if (!anchor || anchor.author_id !== me.user_id) return;
    }
  }
  const who = m.kind === "ai" ? `AI for ${m.author_name}` : m.author_name;
  const text = content.replace(/\s+/g, " ").trim().slice(0, 120);
  void notifyRoom(get, m.room_id, s.rooms[m.room_id]?.name ?? m.room_id, `${who}: ${text}`);
}

function request<T>(build: (requestId: string) => Parameters<Relay["send"]>[0]): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    if (!relay?.send(build(requestId))) {
      reject(new Error("Not connected to the server"));
      return;
    }
    pendingRequests.set(requestId, { resolve: resolve as (r: unknown) => void, reject });
    window.setTimeout(() => {
      if (pendingRequests.delete(requestId)) reject(new Error("The server did not respond"));
    }, 10_000);
  });
}

/** After an older_messages page lands: if a search jump was waiting for it, point
 *  MessageList at the target now that it's loaded, or ask again when the page was
 *  capped short of it (the relay reaches back at most 2000 rows at a time). */
function continueJump(set: StoreApi<ChatState>["setState"], get: () => ChatState, roomId: string) {
  const jump = pendingJumps.get(roomId);
  if (!jump) return;
  const s = get();
  if (s.messages[roomId]?.some((m) => m.id === jump.id)) {
    pendingJumps.delete(roomId);
    set({ jumpTarget: { roomId, id: jump.id } });
    return;
  }
  // Still not on screen: fetch the next stretch toward it.
  const first = s.messages[roomId]?.[0];
  if (!first || !s.hasMore[roomId] || s.loadingOlder[roomId] || first.seq <= jump.seq) {
    pendingJumps.delete(roomId);
    return;
  }
  const ok = relay?.send({ type: "load_older", room_id: roomId, before_seq: first.seq, until_seq: jump.seq });
  if (!ok) pendingJumps.delete(roomId);
  else set((st) => ({ loadingOlder: { ...st.loadingOlder, [roomId]: true } }));
}

export const useChat = create<ChatState>((set, get) => {
  const patchRoom = (roomId: string, f: (r: RoomInfo) => RoomInfo) =>
    set((s) => (s.rooms[roomId] ? { rooms: { ...s.rooms, [roomId]: f(s.rooms[roomId]) } } : {}));

  const stopAllGenerations = () => {
    for (const id of Object.keys(get().myGenerations)) void backend.stopGeneration(id);
  };

  /** Desktops publish their profiles (id, label, model only) so the user's other
   *  devices can generate with them; phones share nothing. */
  function shareMyProfiles() {
    const client = get().client;
    if (!relay || client?.platform !== "desktop") return;
    const profiles: SharedProfile[] = (client.profiles ?? []).map((p) => ({ id: p.id, label: p.label, model: p.model, enabled: p.enabled }));
    const remote_control = client.remote_control;
    // Nothing about the servers leaves this device until the user allows remote control.
    const mcp_servers: SharedMcpServer[] = remote_control
      ? client.mcp_servers.map((s) => {
          const room_modes: Record<string, McpMode> = {};
          for (const [room, modes] of Object.entries(client.mcp_modes_by_room)) {
            if (modes[s.id]) room_modes[room] = modes[s.id];
          }
          return { id: s.id, name: s.name, default_mode: s.default_mode, room_modes };
        })
      : [];
    // Only when something changed on this connection: every share makes the relay
    // send `devices` again, so sharing in answer to that would never stop.
    const key = JSON.stringify({ profiles, mcp_servers, remote_control });
    if (key === lastSharedProfiles) return;
    if (relay.send({ type: "share_profiles", profiles, mcp_servers, remote_control })) lastSharedProfiles = key;
  }

  /** Sends a command to another of this user's devices; settles on its answer. */
  function deviceCommand(deviceId: string, command: DeviceCommand) {
    return request<void>((request_id) => ({ type: "device_command", request_id, device_id: deviceId, command }));
  }

  /** Offers a waiting tool call to the device the reply is for. Best effort: the PC
   *  shows the same prompt, and it's offered again on the next `devices` frame. */
  function offerApproval(p: { deviceId: string; command: DeviceCommand }) {
    deviceCommand(p.deviceId, p.command).catch(() => {});
  }

  /** Stops offering a reply's approvals: all of them, or just `callId`'s. */
  function dropApprovals(id: string, callId?: string) {
    const prefix = callId === undefined ? `${id}:` : `${id}:${callId}`;
    for (const key of pendingApprovals.keys()) {
      if (callId === undefined ? key.startsWith(prefix) : key === prefix) pendingApprovals.delete(key);
    }
  }

  /** Runs a command from another of this user's devices and answers it. The relay
   *  vouches for the account only, so what may happen here is decided here: nothing
   *  without the user's remote-control setting, and never a switch to Auto. */
  async function runDeviceCommand(requestId: string, from: string, command: DeviceCommand) {
    const reply = (error: string | null) =>
      relay?.send({ type: "device_reply", request_id: requestId, to_device_id: from, error });
    const client = get().client;
    if (command.kind === "tool_approval") {
      const { room_id: roomId, message_id: messageId, call_id: callId, args, tool } = command;
      // Rendered as text in the chat: anything else from the relay must not reach it.
      if (typeof args !== "string") {
        reply("Invalid tool approval");
        return;
      }
      // Offers repeat until answered; only the first one is news.
      const seen = !!get().remoteTools[messageId]?.[callId];
      set((s) => ({
        remoteTools: { ...s.remoteTools, [messageId]: { ...s.remoteTools[messageId], [callId]: { deviceId: from, args } } },
      }));
      reply(null);
      // The app may be in the background while the reply runs.
      const s = get();
      if (!seen && s.rooms[roomId] && client?.notify_by_room[roomId] !== "off" && !roomOnScreen(s, roomId)) {
        void notifyRoom(get, roomId, s.rooms[roomId].name, `The AI wants to use ${tool}`);
      }
      return;
    }
    // The backend checks again as it acts: this copy of the setting can be out of date.
    if (!client?.remote_control) {
      reply("Remote control is off on that device. Turn it on there in Settings > General.");
      return;
    }
    try {
      if (command.kind === "answer_tool") {
        if (delegatedGenerations.get(command.message_id) !== from) throw new Error("That reply wasn't requested from this device");
        await backend.resolveToolCall(command.message_id, command.call_id, command.approved, true);
      } else if (command.kind === "set_mcp_mode") {
        if (command.mode !== "off" && command.mode !== "ask") throw new Error("Auto can only be set on that device");
        if (!get().rooms[command.room_id]) throw new Error("That device isn't in this room");
        if (!client.mcp_servers.some((s) => s.id === command.server_id)) throw new Error("That MCP server is gone");
        await backend.setRoomMcpMode(command.room_id, command.server_id, command.mode, true);
        await get().refreshClient();
      } else if (command.kind === "set_profile_enabled") {
        await backend.setProfileEnabled(command.profile_id, command.enabled, true);
        await get().refreshClient();
      } else {
        // The relay's frames aren't trusted to match these types.
        throw new Error("This app doesn't know that command");
      }
      reply(null);
    } catch (e) {
      reply(errorText(e));
    }
  }

  function connect() {
    const client = get().client;
    relay?.close();
    relay = null;
    if (!client?.display_name) return;
    relay = new Relay(
      client.server_url,
      {
        user_id: client.user_id,
        display_name: client.display_name,
        device_id: client.device_id,
        platform: client.platform,
        secret: client.account_secret,
      },
      {
        onMessage: handle,
        onStatus: (status, error) => {
          // A lost answer can't arrive anymore; don't let it block loading forever.
          if (status === "offline") {
            set({ loadingOlder: {} });
            // A jump waiting on that answer is dropped too, so it can't fire later.
            pendingJumps.clear();
            // An `ai_requested` waiting for this connection's room_history can't
            // finish anymore; tell the asking device instead of waiting forever.
            for (const [roomId, pending] of pendingDelegatedOpens) {
              for (const p of pending) {
                relay?.send({
                  type: "ai_request_failed",
                  request_id: p.requestId,
                  to_device_id: p.fromDeviceId,
                  message: "Couldn't load the room",
                });
              }
              pendingDelegatedOpens.delete(roomId);
            }
          }
          // The relay marks our in-flight replies as interrupted when the socket drops.
          if (status === "offline") stopAllGenerations();
          if (status !== "online") set({ devices: [] });
          if (status === "online") set({ status, connError: null });
          else if (error) set({ status, connError: error });
          else set({ status });
        },
      },
    );
  }

  /** History text for one message: deleted ones are dropped by the caller; a reply
   *  gets a "(replying to …)" prefix so the model knows what it answers. */
  function historyText(m: Message, byId: Map<string, Message>): string {
    if (!m.reply_to) return m.content;
    const orig = byId.get(m.reply_to);
    if (!orig) return m.content;
    const quote = orig.deleted ? "a deleted message" : `${orig.author_name}: "${orig.content.slice(0, 120)}"`;
    return `(replying to ${quote})\n${m.content}`;
  }

  /** Asks another of this user's devices to reply to `anchorId` with its profile. Only
   *  counts once the frame was really written, so a drop right after queueing it is
   *  reported (not retried: it may have reached the relay). */
  function askRemote(roomId: string, anchorId: string, deviceId: string, profileId: string) {
    const msg = { type: "request_ai", request_id: crypto.randomUUID(), room_id: roomId, anchor_id: anchorId, device_id: deviceId, profile_id: profileId } as const;
    void (relay ? relay.sendConfirmed(msg) : Promise.resolve(false)).then((ok) => {
      if (!ok) get().toast("The AI reply wasn't requested: not connected to the server");
    });
  }

  /** Serves an `ai_requested` from another of this user's devices: find the anchor
   *  in the loaded messages (or wait for `room_history`), then generate with the
   *  local profile exactly as a local request. Failures go back to the asking
   *  device as `ai_request_failed`; nothing is stored for the request itself. */
  function runDelegatedAi(
    requestId: string,
    roomId: string,
    anchorId: string,
    anchorSeq: number,
    profileId: string,
    fromDeviceId: string,
  ) {
    const fail = (message: string) =>
      relay?.send({ type: "ai_request_failed", request_id: requestId, to_device_id: fromDeviceId, message });
    // Only a local profile id that still exists can answer; the relay already
    // guarantees the request came from one of this user's own devices.
    const asked = get().client?.profiles.find((p) => p.id === profileId);
    if (!asked) {
      fail("That AI profile isn't on this computer anymore");
      return;
    }
    if (!asked.enabled) {
      fail(`${asked.label} is turned off`);
      return;
    }
    // Left the room meanwhile: opening it would fail without telling the asking device.
    if (!get().rooms[roomId]) {
      fail("This computer isn't in that room anymore");
      return;
    }
    // The room's messages aren't loaded here yet: ask for them and retry when
    // the history arrives (or give up if the connection drops first).
    if (!get().loaded[roomId]) {
      const waiting = pendingDelegatedOpens.get(roomId) ?? [];
      waiting.push({ requestId, anchorId, anchorSeq, profileId, fromDeviceId });
      pendingDelegatedOpens.set(roomId, waiting);
      if (waiting.length === 1) relay?.send({ type: "open_room", room_id: roomId });
      return;
    }
    const s = get();
    const anchor = s.messages[roomId]?.find((m) => m.id === anchorId);
    if (!anchor) {
      // Older than what's loaded here: load back to it (one page reaching the anchor,
      // as a search jump does) and try again when it arrives.
      const first = s.messages[roomId]?.[0];
      if (first && s.hasMore[roomId] && anchorSeq < first.seq) {
        const waiting = pendingDelegatedOpens.get(roomId) ?? [];
        waiting.push({ requestId, anchorId, anchorSeq, profileId, fromDeviceId });
        pendingDelegatedOpens.set(roomId, waiting);
        if (!s.loadingOlder[roomId]) {
          const ok = relay?.send({ type: "load_older", room_id: roomId, before_seq: first.seq, until_seq: anchorSeq });
          if (ok) set((st) => ({ loadingOlder: { ...st.loadingOlder, [roomId]: true } }));
          else {
            pendingDelegatedOpens.delete(roomId);
            fail("Couldn't load the room");
          }
        }
        return;
      }
      fail("That message isn't in this room's history");
      return;
    }
    startAi(
      roomId,
      anchor,
      profileId,
      (id) => {
        delegatedGenerations.set(id, fromDeviceId);
        return () => delegatedGenerations.delete(id);
      },
      // The asking device hears about a failed reply directly, not only via the room.
      fail,
    );
  }

  function startAi(
    roomId: string,
    anchor: Message,
    profileId: string,
    delegated?: (id: string) => () => void,
    /** Also told when the reply fails (a delegated request's asking device). */
    onFail?: (message: string) => void,
  ) {
    const s = get();
    const profile = s.client?.profiles.find((p) => p.id === profileId);
    if (!profile) {
      get().toast("That AI profile no longer exists. Pick another one.");
      onFail?.("That AI profile isn't on this computer anymore");
      return;
    }
    const room = s.rooms[roomId];
    const usable = s.messages[roomId] ?? [];
    const byId = new Map(usable.map((m) => [m.id, m]));
    // Messages the room's shared summary already covers are replaced by it, so
    // they don't widen the prompt. A reply to a message the summary already covers
    // (a regenerate further up) uses the full history instead: the summary would
    // describe what comes after its anchor. Missing on an older relay: no summary.
    const covered = room?.summary_upto_seq ?? 0;
    const upto = anchor.seq > covered ? covered : 0;
    const summary = upto > 0 ? (room?.summary ?? "") : "";
    const history: HistoryItem[] = usable
      .filter((m) => m.seq <= anchor.seq && m.seq > upto && !m.deleted && (m.kind === "human" || m.status === "complete"))
      .map((m) => ({ kind: m.kind, author_name: m.author_name, content: historyText(m, byId), seq: m.seq }));

    // What may be folded into a new summary. The boundary must not pass a message
    // the summary never saw, so folding stops at:
    // - a gap: older messages after the boundary (or, with no summary yet, at the start
    //   of the room) aren't loaded here. Nothing is folded this time; those messages
    //   are loaded now so the next reply can summarize without skipping them.
    // - an earlier AI reply still streaming: it isn't in this history yet, and a
    //   boundary past it would leave its final text out of both summary and history.
    let foldBefore: number | null = null;
    const first = usable[0];
    if (first && s.hasMore[roomId] && first.seq > upto + 1) {
      foldBefore = 0;
      if (!s.loadingOlder[roomId]) {
        const ok = relay?.send({ type: "load_older", room_id: roomId, before_seq: first.seq, until_seq: upto + 1 });
        if (ok) set((st) => ({ loadingOlder: { ...st.loadingOlder, [roomId]: true } }));
      }
    } else {
      const streaming = usable.find(
        (m) => m.kind === "ai" && !m.deleted && m.seq > upto && m.seq < anchor.seq && m.status === "streaming",
      );
      if (streaming) foldBefore = streaming.seq;
    }

    const id = crypto.randomUUID();
    if (!relay?.send({ type: "ai_start", room_id: roomId, id, anchor_id: anchor.id, model: profile.model })) {
      get().toast("Not connected to the server");
      onFail?.("The other device couldn't reach the server");
      return;
    }
    set((st) => ({ myGenerations: { ...st.myGenerations, [id]: true } }));
    const stopDelegatedTracking = delegated?.(id);
    // Images are compressed before relaying; the reply only ends after they're sent.
    let uploads: Promise<void> = Promise.resolve();
    const afterUploads = (f: () => void) => {
      uploads = uploads.then(f, f);
    };
    const finish = () => {
      stopDelegatedTracking?.();
      dropApprovals(id);
      set((st) => {
        const { [id]: _, ...rest } = st.myGenerations;
        return { myGenerations: rest };
      });
    };

    backend
      .generate(id, profileId, roomId, history, room?.system_prompt ?? "", summary, foldBefore, !!stopDelegatedTracking, (ev) => {
        if (ev.event === "delta") {
          relay?.send({ type: "ai_delta", room_id: roomId, id, delta: ev.text });
        } else if (ev.event === "reasoning") {
          relay?.send({ type: "ai_reasoning", room_id: roomId, id, delta: ev.text });
        } else if (ev.event === "tool") {
          // The room only learns which tool ran and how it went.
          const activity = { call_id: ev.call_id, server: ev.server, tool: ev.tool, status: ev.status };
          relay?.send({ type: "ai_tool", room_id: roomId, id, activity });
          set((st) => {
            const prev = st.localTools[id]?.[ev.call_id];
            const local: LocalTool = { status: ev.status, args: ev.args ?? prev?.args ?? null, detail: ev.detail ?? prev?.detail ?? null };
            return { localTools: { ...st.localTools, [id]: { ...st.localTools[id], [ev.call_id]: local } } };
          });
          // A reply for another device: the approval goes there too, with the arguments
          // (to that device only, never the room). Either side may answer; first wins.
          const askedBy = delegatedGenerations.get(id);
          if (askedBy && ev.status === "awaiting_approval" && get().client?.remote_control) {
            const raw = ev.args ?? "{}";
            // Half an emoji at the cut would make the relay refuse the whole frame.
            const args = raw.length > MAX_APPROVAL_ARGS ? `… [cut short: the full call is on the computer]\n${raw.slice(0, MAX_APPROVAL_ARGS).replace(/[\uD800-\uDBFF]$/, "")}` : raw;
            const pending = {
              deviceId: askedBy,
              command: { kind: "tool_approval", room_id: roomId, message_id: id, call_id: ev.call_id, server: ev.server, tool: ev.tool, args } as const,
            };
            pendingApprovals.set(`${id}:${ev.call_id}`, pending);
            offerApproval(pending);
          } else if (askedBy) {
            dropApprovals(id, ev.call_id);
          }
        } else if (ev.event === "image") {
          const callId = ev.call_id;
          const { mime, data } = ev;
          uploads = uploads.then(async () => {
            try {
              const img = await prepareImage(mime, data);
              const attachment = { attachment_id: crypto.randomUUID(), mime: img.mime, call_id: callId, width: img.width, height: img.height };
              set((st) => ({ images: { ...st.images, [attachment.attachment_id]: `data:${img.mime};base64,${img.data}` } }));
              relay?.send({ type: "ai_attachment", room_id: roomId, id, attachment, data: img.data });
            } catch (e) {
              get().toast(`Couldn't share an image: ${errorText(e)}`);
            }
          });
        } else if (ev.event === "summary") {
          // The reply summarized the older history: share it with the room, so
          // every member's AI uses the same one.
          relay?.send({ type: "set_room_summary", room_id: roomId, summary: ev.text, upto_seq: ev.upto_seq });
          patchRoom(roomId, (r) =>
            (r.summary_upto_seq ?? 0) < ev.upto_seq ? { ...r, summary: ev.text, summary_upto_seq: ev.upto_seq } : r,
          );
        } else if (ev.event === "notice") {
          get().toast(ev.message, "info");
        } else if (ev.event === "done") {
          const content = ev.content;
          afterUploads(() => {
            relay?.send({ type: "ai_complete", room_id: roomId, id, content });
            finish();
          });
        } else {
          const error = ev.message;
          afterUploads(() => {
            relay?.send({ type: "ai_error", room_id: roomId, id, error });
            onFail?.(error);
            finish();
          });
        }
      })
      .catch((e) => {
        relay?.send({ type: "ai_error", room_id: roomId, id, error: errorText(e) });
        onFail?.(errorText(e));
        finish();
      });
  }

  function handle(msg: ServerMsg) {
    switch (msg.type) {
      case "welcome": {
        // A new connection starts with nothing shared: publish this desktop's profiles.
        lastSharedProfiles = null;
        shareMyProfiles();
        const rooms: Record<string, RoomInfo> = {};
        for (const r of msg.rooms) rooms[r.id] = r;
        const order = msg.rooms.map((r) => r.id);
        let active = get().activeRoomId;
        if (!active || !rooms[active]) active = get().roomClosed ? null : (order[0] ?? null);
        // Image fetches still pending when the connection dropped never got an answer;
        // forget them so the images request again on this connection.
        const images = Object.fromEntries(Object.entries(get().images).filter(([, src]) => src));
        // A new connection: no search jump is waiting on a page from the old one.
        pendingJumps.clear();
        // hasMore stays: room_history needs it for older pages it keeps.
        set({ rooms, roomOrder: order, loaded: {}, loadingOlder: {}, activeRoomId: active, images });
        if (active) relay?.send({ type: "open_room", room_id: active });
        break;
      }
      case "room_joined": {
        const r = msg.room;
        set((s) => ({
          rooms: { ...s.rooms, [r.id]: r },
          roomOrder: s.roomOrder.includes(r.id) ? s.roomOrder : [...s.roomOrder, r.id],
        }));
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (msg.request_id) pendingRequests.delete(msg.request_id);
        pending?.resolve(r);
        // Without a request id it's a room another of my devices created or joined:
        // list it, but don't switch to it here.
        if (msg.request_id) get().selectRoom(r.id);
        break;
      }
      case "room_left":
        // Requests from my other devices that waited for this room can't be answered now.
        for (const p of pendingDelegatedOpens.get(msg.room_id) ?? []) {
          relay?.send({ type: "ai_request_failed", request_id: p.requestId, to_device_id: p.fromDeviceId, message: "Couldn't load the room" });
        }
        pendingDelegatedOpens.delete(msg.room_id);
        // The room is gone; its notification choice (and in-flight throttle) go too.
        notifyState.delete(msg.room_id);
        queueNotifyWrite(() => backend.forgetRoomNotify(msg.room_id)).catch(() => {});
        set((s) => {
          const { [msg.room_id]: _, ...rooms } = s.rooms;
          const roomOrder = s.roomOrder.filter((id) => id !== msg.room_id);
          // Forget the room's cached history too: if the account rejoins later, it loads
          // fresh instead of showing (or generating from) messages that changed meanwhile.
          const { [msg.room_id]: _m, ...messages } = s.messages;
          const { [msg.room_id]: _l, ...loaded } = s.loaded;
          const { [msg.room_id]: _h, ...hasMore } = s.hasMore;
          const client = s.client && { ...s.client, notify_by_room: withoutKey(s.client.notify_by_room, msg.room_id) };
          return {
            client,
            rooms,
            roomOrder,
            messages,
            loaded,
            hasMore,
            activeRoomId: s.activeRoomId === msg.room_id ? (roomOrder[0] ?? null) : s.activeRoomId,
          };
        });
        break;
      case "room_history": {
        const waiting = pendingDelegatedOpens.get(msg.room_id) ?? [];
        if (waiting.length) pendingDelegatedOpens.delete(msg.room_id);
        set((s) => {
          // Left the room before its history arrived: don't keep (or mark loaded) a room
          // this device is no longer in, or a rejoin would skip loading it fresh.
          if (!s.rooms[msg.room_id]) return {};
          // Keep anything live that arrived after the history snapshot, including images
          // announced while the snapshot was being read.
          const current = s.messages[msg.room_id] ?? [];
          const maxSeq = msg.messages.length ? msg.messages[msg.messages.length - 1].seq : -1;
          const newer = current.filter((m) => m.seq > maxSeq);
          const live = new Map(current.map((m) => [m.id, m]));
          const merged = msg.messages.map((m) => withAttachments(m, live.get(m.id)?.attachments));
          // Older pages loaded before a reconnect stay, so the reader isn't moved, as long
          // as the fresh page connects to them (its first message is one we have). With a
          // gap in between (many messages while away), start again from the fresh page.
          const minSeq = merged.length ? merged[0].seq : Infinity;
          const older = merged.length && live.has(merged[0].id) ? current.filter((m) => m.seq < minSeq) : [];
          return {
            messages: { ...s.messages, [msg.room_id]: [...older, ...merged, ...newer] },
            loaded: { ...s.loaded, [msg.room_id]: true },
            // With older rows kept, what was known about the history before them still holds.
            hasMore: { ...s.hasMore, [msg.room_id]: older.length ? (s.hasMore[msg.room_id] ?? true) : msg.has_more },
          };
        });
        // Delegated `ai_requested`s that waited for this history: run them now
        // that the anchor is (or isn't) among the loaded messages.
        for (const p of waiting) runDelegatedAi(p.requestId, msg.room_id, p.anchorId, p.anchorSeq, p.profileId, p.fromDeviceId);
        break;
      }
      case "older_messages":
        set((s) => {
          if (!s.rooms[msg.room_id]) return { loadingOlder: { ...s.loadingOlder, [msg.room_id]: false } };
          const current = s.messages[msg.room_id] ?? [];
          // Keep only what's older than the current first message; skip ids already
          // present (a duplicate answer to a retry, or a race with room_history).
          const firstSeq = current.length ? current[0].seq : -1;
          const ids = new Set(current.map((m) => m.id));
          const add = msg.messages
            .filter((m) => m.seq < firstSeq && !ids.has(m.id))
            .map((m) => withAttachments(m));
          return {
            messages: add.length ? { ...s.messages, [msg.room_id]: [...add, ...current] } : s.messages,
            hasMore: { ...s.hasMore, [msg.room_id]: msg.has_more },
            loadingOlder: { ...s.loadingOlder, [msg.room_id]: false },
          };
        });
        // A search jump waiting for this page: point MessageList at the target,
        // or ask again when the page was capped short of it.
        continueJump(set, get, msg.room_id);
        {
          // Delegated requests that waited for older history: try them again.
          const waiting = pendingDelegatedOpens.get(msg.room_id) ?? [];
          pendingDelegatedOpens.delete(msg.room_id);
          for (const p of waiting) runDelegatedAi(p.requestId, msg.room_id, p.anchorId, p.anchorSeq, p.profileId, p.fromDeviceId);
        }
        break;
      case "search_results": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (msg.request_id) pendingRequests.delete(msg.request_id);
        pending?.resolve(msg.hits);
        break;
      }
      case "message": {
        const m = withAttachments(msg.message);
        const mine = m.author_id === get().client?.user_id;
        // Their message arrived: they're not typing anymore.
        const typingGone = m.kind === "human" ? dropTyping(get(), m.room_id, m.author_id) : {};
        // Someone @mentioned me in a room I'm not looking at: mark it in the room list.
        const me = get().client;
        const pinged =
          !mine && m.kind === "human" && get().activeRoomId !== m.room_id && !!me && mentions(m.content, me.display_name);
        // A human message from someone else may deserve a system notification.
        if (!mine && m.kind === "human") maybeNotifyMessage(get, m, m.content);
        set((s) => ({
          ...(pinged ? { mentioned: { ...s.mentioned, [m.room_id]: true } } : {}),
          messages: { ...s.messages, [m.room_id]: upsert(s.messages[m.room_id], m) },
          unread:
            s.activeRoomId === m.room_id || (mine && m.kind === "human")
              ? s.unread
              : { ...s.unread, [m.room_id]: (s.unread[m.room_id] ?? 0) + 1 },
          ...typingGone,
        }));
        const profileId = pendingAi.get(m.id);
        if (profileId && m.kind === "human") {
          pendingAi.delete(m.id);
          // A remote profile ("remote:<device>:<profile>") is generated by that
          // device: send it a `request_ai` instead of starting one here.
          const remote = parseRemoteProfileId(profileId);
          if (remote) {
            askRemote(m.room_id, m.id, remote.deviceId, remote.profileId);
          } else {
            startAi(m.room_id, m, profileId);
          }
        }
        break;
      }
      case "device_command":
        void runDeviceCommand(msg.request_id, msg.from_device_id, msg.command);
        break;
      case "device_reply": {
        const pending = pendingRequests.get(msg.request_id);
        pendingRequests.delete(msg.request_id);
        pending?.resolve(undefined);
        break;
      }
      case "ai_requested":
        // Another of this user's devices asked this one to reply with its profile.
        runDelegatedAi(msg.request_id, msg.room_id, msg.anchor_id, msg.anchor_seq, msg.profile_id, msg.from_device_id);
        break;
      case "ai_delta":
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.id, (m) =>
              m.status === "streaming" ? { ...m, content: m.content + msg.delta } : m,
            )!,
          },
        }));
        break;
      case "ai_reasoning":
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.id, (m) =>
              m.status === "streaming" ? { ...m, reasoning: m.reasoning + msg.delta } : m,
            )!,
          },
        }));
        break;
      case "ai_tool":
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.id, (m) => {
              const i = m.tools.findIndex((t) => t.call_id === msg.activity.call_id);
              const tools = i < 0 ? [...m.tools, msg.activity] : m.tools.map((t, j) => (j === i ? msg.activity : t));
              return { ...m, tools };
            })!,
          },
          // Answered or timed out: nothing is waiting on this device anymore.
          ...(msg.activity.status !== "awaiting_approval" && s.remoteTools[msg.id]?.[msg.activity.call_id]
            ? { remoteTools: { ...s.remoteTools, [msg.id]: withoutKey(s.remoteTools[msg.id], msg.activity.call_id) } }
            : {}),
        }));
        break;
      case "ai_attachment":
        if (!get().messages[msg.room_id]?.some((m) => m.id === msg.id)) {
          // The reply isn't loaded yet; attach the image when it arrives.
          unclaimedAttachments.set(msg.id, [...(unclaimedAttachments.get(msg.id) ?? []), msg.attachment]);
          break;
        }
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.id, (m) =>
              m.attachments.some((a) => a.attachment_id === msg.attachment.attachment_id)
                ? m
                : { ...m, attachments: [...m.attachments, msg.attachment] },
            )!,
          },
        }));
        break;
      case "attachment":
        set((s) => ({ images: { ...s.images, [msg.attachment_id]: `data:${msg.mime};base64,${msg.data}` } }));
        break;
      case "ai_complete":
      case "ai_error":
      case "ai_interrupted":
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.id, (m) =>
              msg.type === "ai_complete"
                ? { ...m, content: msg.content, status: "complete" }
                : msg.type === "ai_error"
                  ? { ...m, status: "error", error: msg.error }
                  : { ...m, content: msg.content, status: "interrupted" },
            )!,
          },
          remoteTools: s.remoteTools[msg.id] ? withoutKey(s.remoteTools, msg.id) : s.remoteTools,
        }));
        // Their finished AI reply: notify like a human message, with its final text.
        if (msg.type === "ai_complete") {
          const ai = get().messages[msg.room_id]?.find((m) => m.id === msg.id);
          if (ai && ai.author_id !== get().client?.user_id) maybeNotifyMessage(get, ai, msg.content);
        }
        break;
      case "member_joined":
      case "member_updated":
        patchRoom(msg.room_id, (r) => {
          const exists = r.members.some((m) => m.user_id === msg.member.user_id);
          return {
            ...r,
            members: exists
              ? r.members.map((m) => (m.user_id === msg.member.user_id ? { ...m, display_name: msg.member.display_name } : m))
              : [...r.members, msg.member],
          };
        });
        break;
      case "member_left":
        patchRoom(msg.room_id, (r) => ({ ...r, members: r.members.filter((m) => m.user_id !== msg.user_id) }));
        // They left: no "… is typing" lingering until it expires.
        set((s) => dropTyping(s, msg.room_id, msg.user_id));
        break;
      case "presence":
        patchRoom(msg.room_id, (r) => ({
          ...r,
          members: r.members.map((m) => (m.user_id === msg.user_id ? { ...m, online: msg.online } : m)),
        }));
        // Gone offline: their typing entry (if any) is stale immediately.
        if (!msg.online) set((s) => dropTyping(s, msg.room_id, msg.user_id));
        break;
      case "typing": {
        // Other devices of this same account: nothing to show.
        if (msg.user_id === get().client?.user_id) break;
        set((s) => {
          const room = s.typing[msg.room_id] ?? {};
          if (!msg.typing) {
            if (!(msg.user_id in room)) return {};
            const { [msg.user_id]: _, ...rest } = room;
            return { typing: { ...s.typing, [msg.room_id]: rest } };
          }
          return {
            typing: {
              ...s.typing,
              [msg.room_id]: { ...room, [msg.user_id]: { name: msg.display_name, until: Date.now() + TYPING_TTL } },
            },
          };
        });
        break;
      }
      case "reactions":
        // The frame always carries the message's full current list, so replace.
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.message_id, (m) => ({ ...m, reactions: msg.reactions }))!,
          },
        }));
        break;
      case "message_updated":
        // The full row after an edit or delete; keep locally loaded image previews, unless
        // the message was deleted (its images go with it).
        set((s) => ({
          messages: {
            ...s.messages,
            [msg.room_id]: patchMessage(s.messages[msg.room_id], msg.message.id, (old) => ({
              ...msg.message,
              attachments: msg.message.attachments.length || msg.message.deleted ? msg.message.attachments : old.attachments,
            }))!,
          },
        }));
        break;
      case "room_updated":
        patchRoom(msg.room_id, (r) => ({ ...r, system_prompt: msg.system_prompt }));
        break;
      case "room_summary":
        // Another member's AI summarized the older history; only a newer one applies.
        // At an equal boundary the relay's copy wins: it's the one it accepted, and a
        // local summary for the same messages may have been refused.
        patchRoom(msg.room_id, (r) =>
          (r.summary_upto_seq ?? 0) <= msg.upto_seq ? { ...r, summary: msg.summary, summary_upto_seq: msg.upto_seq } : r,
        );
        break;
      case "link_code": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (msg.request_id) pendingRequests.delete(msg.request_id);
        pending?.resolve({ code: msg.code, expires_in_secs: msg.expires_in_secs });
        break;
      }
      case "linked": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (msg.request_id) pendingRequests.delete(msg.request_id);
        // The secret too: without it the device can't sign in to the linked account.
        pending?.resolve({ user_id: msg.user_id, display_name: msg.display_name, secret: msg.secret });
        break;
      }
      case "devices": {
        // An older relay leaves these out: that's sharing nothing, with profiles on.
        set({
          devices: msg.devices.map((d) => ({
            ...d,
            profiles: (d.profiles ?? []).map((p) => ({ ...p, enabled: p.enabled ?? true })),
            mcp_servers: d.mcp_servers ?? [],
            remote_control: !!d.remote_control,
          })),
        });
        // Every sign-in sends this frame, so a device that came back hears what's waiting
        // for it, even if its old connection hadn't dropped yet (it can't be seen leaving).
        for (const p of pendingApprovals.values()) {
          if (msg.devices.some((d) => d.device_id === p.deviceId)) offerApproval(p);
        }
        break;
      }
      case "error": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (pending && msg.request_id) {
          pendingRequests.delete(msg.request_id);
          pending.reject(new Error(msg.message));
        } else if (!msg.request_id && SIGN_IN_REFUSED.test(msg.message)) {
          // Signing in was refused: keep saying why, not just "Connecting…".
          set({ connError: msg.message });
        } else {
          get().toast(msg.message);
        }
        break;
      }
    }
  }

  return {
    client: null,
    status: "offline",
    connError: null,
    rooms: {},
    roomOrder: [],
    messages: {},
    loaded: {},
    mentioned: {},
    hasMore: {},
    loadingOlder: {},
    unread: {},
    activeRoomId: null,
    roomClosed: false,
    devices: [],
    myGenerations: {},
    localTools: {},
    remoteTools: {},
    images: {},
    typing: {},
    jumpTarget: null,
    toasts: [],

    async init() {
      await get().refreshClient();
      connect();
    },

    async refreshClient() {
      set({ client: await backend.getState() });
      // Profiles added, edited or deleted here change what this user's other
      // devices can pick; publish the fresh list (desktop only).
      shareMyProfiles();
    },

    reconnect() {
      if (relay) relay.reconnectNow();
      else connect();
    },

    async saveIdentity(displayName, serverUrl) {
      const before = get().client;
      await backend.setIdentity(displayName, serverUrl);
      await get().refreshClient();
      const after = get().client!;
      if (!relay || before?.server_url !== after.server_url || !before?.display_name) {
        set({ rooms: {}, roomOrder: [], messages: {}, loaded: {}, hasMore: {}, loadingOlder: {}, activeRoomId: null });
        connect();
      } else if (before.display_name !== after.display_name) {
        relay.rename(after.display_name);
      }
    },

    selectRoom(id) {
      // A search jump belongs to the room it was started in: leaving drops it.
      if (get().activeRoomId !== id) pendingJumps.clear();
      set((s) => ({
        activeRoomId: id,
        roomClosed: false,
        unread: { ...s.unread, [id]: 0 },
        mentioned: s.mentioned[id] ? { ...s.mentioned, [id]: false } : s.mentioned,
        jumpTarget: s.jumpTarget?.roomId === id ? s.jumpTarget : null,
      }));
      if (!get().loaded[id]) relay?.send({ type: "open_room", room_id: id });
    },

    closeRoom() {
      pendingJumps.clear();
      set({ activeRoomId: null, roomClosed: true, jumpTarget: null });
    },

    createRoom: (name) => request<RoomInfo>((request_id) => ({ type: "create_room", request_id, name })),
    joinRoom: (code) => request<RoomInfo>((request_id) => ({ type: "join_room", request_id, invite_code: code })),

    async createLinkCode() {
      const secret = get().client?.account_secret ?? "";
      const reply = await request<LinkCodeReply>((request_id) => ({ type: "create_link_code", request_id, secret }));
      return { code: reply.code, expiresInSecs: reply.expires_in_secs };
    },

    async redeemLinkCode(code) {
      const reply = await request<LinkedReply>((request_id) => ({ type: "redeem_link_code", request_id, code }));
      await backend.linkDevice(reply.user_id, reply.display_name, reply.secret);
      await get().refreshClient();
      // The relay refuses a user change on an open connection, so reconnect
      // fresh (the same reset saveIdentity does when the server URL changes).
      set({ rooms: {}, roomOrder: [], messages: {}, loaded: {}, hasMore: {}, loadingOlder: {}, activeRoomId: null, unread: {} });
      connect();
    },

    async unlink() {
      await backend.unlinkDevice();
      await get().refreshClient();
      set({ rooms: {}, roomOrder: [], messages: {}, loaded: {}, hasMore: {}, loadingOlder: {}, activeRoomId: null, unread: {} });
      connect();
    },

    leaveRoom(id) {
      relay?.send({ type: "leave_room", room_id: id });
    },

    async sendMessage(roomId, content, aiRequested, profileId, replyTo) {
      // A remote profile id ("remote:<device>:<profile>") is kept like any other:
      // the request goes to that device once the message echoes back.
      const id = crypto.randomUUID();
      if (aiRequested && profileId) pendingAi.set(id, profileId);
      const ok = relay
        ? await relay.sendConfirmed({ type: "send_message", room_id: roomId, id, content, ai_requested: aiRequested, reply_to: replyTo ?? null })
        : false;
      if (!ok) {
        pendingAi.delete(id);
        get().toast("Message not sent: you're not connected to the server. Your text is still in the box.");
      }
      return ok;
    },

    // Both resolve true once the frame was actually written to the relay.
    async editMessage(roomId, messageId, content) {
      const ok = relay ? await relay.sendConfirmed({ type: "edit_message", room_id: roomId, message_id: messageId, content }) : false;
      if (!ok) get().toast("Edit not sent: not connected to the server");
      return ok;
    },

    async deleteMessage(roomId, messageId) {
      const ok = relay ? await relay.sendConfirmed({ type: "delete_message", room_id: roomId, message_id: messageId }) : false;
      if (!ok) get().toast("Not deleted: not connected to the server");
      return ok;
    },

    regenerate(ai, profileId) {
      const anchor = get().messages[ai.room_id]?.find((m) => m.id === ai.anchor_id);
      if (!anchor) {
        get().toast("The message this reply answers is no longer loaded");
        return;
      }
      // With a remote profile id, the other device generates from the same anchor.
      const remote = parseRemoteProfileId(profileId);
      if (remote) {
        askRemote(ai.room_id, anchor.id, remote.deviceId, remote.profileId);
        return;
      }
      startAi(ai.room_id, anchor, profileId);
    },

    stopAi(id) {
      void backend.stopGeneration(id);
    },

    loadOlder(roomId) {
      const s = get();
      const first = s.messages[roomId]?.[0];
      // Nothing to anchor a request to, nothing older to get, or one already in flight.
      if (s.loadingOlder[roomId] || !s.hasMore[roomId] || !first) return;
      const ok = relay?.send({ type: "load_older", room_id: roomId, before_seq: first.seq });
      if (ok) set((st) => ({ loadingOlder: { ...st.loadingOlder, [roomId]: true } }));
    },

    searchMessages: (roomId, query) =>
      request<SearchHit[]>((request_id) => ({ type: "search_messages", request_id, room_id: roomId, query })),

    jumpTo(roomId, messageId, seq) {
      // The latest pick wins: an earlier jump still waiting for a page is dropped, and
      // so is a target the list hasn't scrolled to yet.
      pendingJumps.delete(roomId);
      if (get().jumpTarget) set({ jumpTarget: null });
      const s = get();
      if (s.messages[roomId]?.some((m) => m.id === messageId)) {
        set({ jumpTarget: { roomId, id: messageId } });
        return;
      }
      // Not loaded: fetch a page that reaches back to the message, then jump
      // (continueJump in the older_messages case finishes this).
      const first = s.messages[roomId]?.[0];
      if (!s.hasMore[roomId] || !first || seq >= first.seq) return;
      pendingJumps.set(roomId, { id: messageId, seq });
      // A page is already on its way: continueJump picks the jump up when it lands.
      if (s.loadingOlder[roomId]) return;
      const ok = relay?.send({ type: "load_older", room_id: roomId, before_seq: first.seq, until_seq: seq });
      if (!ok) pendingJumps.delete(roomId);
      else set((st) => ({ loadingOlder: { ...st.loadingOlder, [roomId]: true } }));
    },

    clearJump() {
      set((s) => (s.jumpTarget ? { jumpTarget: null } : {}));
    },

    react(roomId, messageId, emoji, on) {
      relay?.send({ type: "react", room_id: roomId, message_id: messageId, emoji, on });
    },

    setTyping(roomId, typing) {
      // Best effort: if it doesn't go out, others just see the indicator expire.
      relay?.send({ type: "typing", room_id: roomId, typing });
    },

    setRoomPrompt(roomId, prompt) {
      relay?.send({ type: "set_room_prompt", room_id: roomId, system_prompt: prompt });
    },

    chooseProfile(roomId, profileId) {
      set((s) =>
        s.client
          ? { client: { ...s.client, last_profile_by_room: { ...s.client.last_profile_by_room, [roomId]: profileId } } }
          : {},
      );
      void backend.setLastProfile(roomId, profileId);
    },

    setRoomMcpMode(roomId, serverId, mode) {
      set((s) => {
        if (!s.client) return {};
        const modes = { ...s.client.mcp_modes_by_room, [roomId]: { ...s.client.mcp_modes_by_room[roomId], [serverId]: mode } };
        return { client: { ...s.client, mcp_modes_by_room: modes } };
      });
      // Linked devices show this device's modes.
      shareMyProfiles();
      backend.setRoomMcpMode(roomId, serverId, mode).catch((e) => get().toast(errorText(e)));
    },

    async setProfileEnabled(id, enabled) {
      try {
        await backend.setProfileEnabled(id, enabled);
        await get().refreshClient();
      } catch (e) {
        get().toast(errorText(e));
      }
    },

    async setRemoteControl(enabled) {
      try {
        await backend.setRemoteControl(enabled);
        // Not refreshed: a failed read would leave the old setting in place here.
        set((s) => ({ client: s.client && { ...s.client, remote_control: enabled } }));
        // Tool arguments stop going out now; the prompt stays on this computer.
        if (!enabled) pendingApprovals.clear();
        shareMyProfiles();
      } catch (e) {
        get().toast(errorText(e));
      }
    },

    setRemoteMcpMode(deviceId, roomId, serverId, mode) {
      deviceCommand(deviceId, { kind: "set_mcp_mode", room_id: roomId, server_id: serverId, mode }).catch((e) => get().toast(errorText(e)));
    },

    setRemoteProfileEnabled(deviceId, profileId, enabled) {
      deviceCommand(deviceId, { kind: "set_profile_enabled", profile_id: profileId, enabled }).catch((e) => get().toast(errorText(e)));
    },

    setRoomNotify(roomId, mode) {
      set((s) => {
        if (!s.client) return {};
        const rest = withoutKey(s.client.notify_by_room, roomId);
        // The default ("mentions") is stored as no entry, like the backend keeps it.
        const notify_by_room = mode === "mentions" ? rest : { ...rest, [roomId]: mode };
        return { client: { ...s.client, notify_by_room } };
      });
      queueNotifyWrite(() => backend.setRoomNotify(roomId, mode)).catch((e) => get().toast(errorText(e)));
    },

    async testNotification() {
      await hookNotificationClicks();
      if (!(await notificationPermission(get))) return;
      sendNotification({
        title: "Multichat",
        body: "Test notification — new messages will pop up like this.",
      });
    },

    answerToolCall(id, callId, approved) {
      const remote = get().remoteTools[id]?.[callId];
      const answer = remote
        ? deviceCommand(remote.deviceId, { kind: "answer_tool", message_id: id, call_id: callId, approved })
        : backend.resolveToolCall(id, callId, approved);
      answer.catch((e) => get().toast(errorText(e)));
    },

    loadImage(attachmentId) {
      if (attachmentId in get().images) return;
      if (relay?.send({ type: "get_attachment", attachment_id: attachmentId })) {
        set((s) => ({ images: { ...s.images, [attachmentId]: "" } }));
      }
    },

    toast(text, kind = "error") {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
      window.setTimeout(() => get().dismissToast(id), 5000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
});
