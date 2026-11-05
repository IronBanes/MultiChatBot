// App state: relay connection, rooms, messages, and AI reply orchestration.

import { create, type StoreApi } from "zustand";
import { backend, errorText } from "./lib/backend";
import { prepareImage } from "./lib/images";
import { Relay, type ConnStatus } from "./lib/relay";
import type {
  Attachment,
  ClientState,
  Device,
  HistoryItem,
  McpMode,
  Message,
  RoomInfo,
  SearchHit,
  ServerMsg,
  SharedProfile,
  ToolStatus,
} from "./lib/types";

/** Tool call details only the sender sees (arguments and a result preview). */
export interface LocalTool {
  status: ToolStatus;
  args: string | null;
  detail: string | null;
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
  answerToolCall(id: string, callId: string, approved: boolean): void;
  loadImage(attachmentId: string): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
}

let relay: Relay | null = null;
/** Human message id → profile id, waiting for the server echo before the AI call starts. */
const pendingAi = new Map<string, string>();

/** A profile on another of this user's devices is referenced as `remote:<device_id>:<profile_id>`. */
export function remoteProfileId(deviceId: string, profileId: string): string {
  return `remote:${deviceId}:${profileId}`;
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
const pendingDelegatedOpens = new Map<string, { requestId: string; anchorId: string; profileId: string; fromDeviceId: string }[]>();
/** Generation ids this client is generating for another of this user's devices.
 *  Nobody is at this computer to approve tools, so Ask-mode calls are denied. */
const delegatedGenerations = new Set<string>();
/** Images announced for a reply this client hasn't loaded yet (e.g. while joining). */
const unclaimedAttachments = new Map<string, Attachment[]>();
/** Room id → the message a search jump is waiting for, while older history that
 *  reaches back to it is being fetched. */
const pendingJumps = new Map<string, { id: string; seq: number }>();

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
    const profiles: SharedProfile[] = (client.profiles ?? []).map((p) => ({ id: p.id, label: p.label, model: p.model }));
    relay.send({ type: "share_profiles", profiles });
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

  /** Serves an `ai_requested` from another of this user's devices: find the anchor
   *  in the loaded messages (or wait for `room_history`), then generate with the
   *  local profile exactly as a local request. Failures go back to the asking
   *  device as `ai_request_failed`; nothing is stored for the request itself. */
  function runDelegatedAi(requestId: string, roomId: string, anchorId: string, profileId: string, fromDeviceId: string) {
    const fail = (message: string) =>
      relay?.send({ type: "ai_request_failed", request_id: requestId, to_device_id: fromDeviceId, message });
    // Only a local profile id that still exists can answer; the relay already
    // guarantees the request came from one of this user's own devices.
    if (!get().client?.profiles.some((p) => p.id === profileId)) {
      fail("That AI profile isn't on this computer anymore");
      return;
    }
    // The room's messages aren't loaded here yet: ask for them and retry when
    // the history arrives (or give up if the connection drops first).
    if (!get().loaded[roomId]) {
      const waiting = pendingDelegatedOpens.get(roomId) ?? [];
      waiting.push({ requestId, anchorId, profileId, fromDeviceId });
      pendingDelegatedOpens.set(roomId, waiting);
      if (waiting.length === 1) relay?.send({ type: "open_room", room_id: roomId });
      return;
    }
    const anchor = get().messages[roomId]?.find((m) => m.id === anchorId);
    if (!anchor) {
      fail("That message is too far back to reply to from here");
      return;
    }
    startAi(roomId, anchor, profileId, (id) => {
      delegatedGenerations.add(id);
      return () => delegatedGenerations.delete(id);
    });
  }

  function startAi(roomId: string, anchor: Message, profileId: string, delegated?: (id: string) => () => void) {
    const s = get();
    const profile = s.client?.profiles.find((p) => p.id === profileId);
    if (!profile) {
      get().toast("That AI profile no longer exists. Pick another one.");
      return;
    }
    const room = s.rooms[roomId];
    const usable = s.messages[roomId] ?? [];
    const byId = new Map(usable.map((m) => [m.id, m]));
    const history: HistoryItem[] = usable
      .filter((m) => m.seq <= anchor.seq && !m.deleted && (m.kind === "human" || m.status === "complete"))
      .map((m) => ({ kind: m.kind, author_name: m.author_name, content: historyText(m, byId) }));

    const id = crypto.randomUUID();
    if (!relay?.send({ type: "ai_start", room_id: roomId, id, anchor_id: anchor.id, model: profile.model })) {
      get().toast("Not connected to the server");
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
      set((st) => {
        const { [id]: _, ...rest } = st.myGenerations;
        return { myGenerations: rest };
      });
    };

    backend
      .generate(id, profileId, roomId, history, room?.system_prompt ?? "", (ev) => {
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
          // A delegated reply has nobody at this computer to approve tools, so
          // every call waiting for approval is denied the moment it appears.
          if (ev.status === "awaiting_approval" && delegatedGenerations.has(id)) {
            backend.resolveToolCall(id, ev.call_id, false).catch(() => {});
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
            finish();
          });
        }
      })
      .catch((e) => {
        relay?.send({ type: "ai_error", room_id: roomId, id, error: errorText(e) });
        finish();
      });
  }

  function handle(msg: ServerMsg) {
    switch (msg.type) {
      case "welcome": {
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
        get().selectRoom(r.id);
        break;
      }
      case "room_left":
        set((s) => {
          const { [msg.room_id]: _, ...rooms } = s.rooms;
          const roomOrder = s.roomOrder.filter((id) => id !== msg.room_id);
          return {
            rooms,
            roomOrder,
            activeRoomId: s.activeRoomId === msg.room_id ? (roomOrder[0] ?? null) : s.activeRoomId,
          };
        });
        break;
      case "room_history": {
        const waiting = pendingDelegatedOpens.get(msg.room_id) ?? [];
        if (waiting.length) pendingDelegatedOpens.delete(msg.room_id);
        set((s) => {
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
        for (const p of waiting) runDelegatedAi(p.requestId, msg.room_id, p.anchorId, p.profileId, p.fromDeviceId);
        break;
      }
      case "older_messages":
        set((s) => {
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
        set((s) => ({
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
            relay?.send({
              type: "request_ai",
              request_id: crypto.randomUUID(),
              room_id: m.room_id,
              anchor_id: m.id,
              device_id: remote.deviceId,
              profile_id: remote.profileId,
            });
          } else {
            startAi(m.room_id, m, profileId);
          }
        }
        break;
      }
      case "ai_requested":
        // Another of this user's devices asked this one to reply with its profile.
        runDelegatedAi(msg.request_id, msg.room_id, msg.anchor_id, msg.profile_id, msg.from_device_id);
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
        }));
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
      case "link_code": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (msg.request_id) pendingRequests.delete(msg.request_id);
        pending?.resolve({ code: msg.code, expires_in_secs: msg.expires_in_secs });
        break;
      }
      case "linked": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (msg.request_id) pendingRequests.delete(msg.request_id);
        pending?.resolve({ user_id: msg.user_id, display_name: msg.display_name });
        break;
      }
      case "devices":
        set({ devices: msg.devices });
        // This desktop's own profiles are what other devices can pick from:
        // keep the published list in step with the connection state too.
        shareMyProfiles();
        break;
      case "error": {
        const pending = msg.request_id ? pendingRequests.get(msg.request_id) : undefined;
        if (pending && msg.request_id) {
          pendingRequests.delete(msg.request_id);
          pending.reject(new Error(msg.message));
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
    hasMore: {},
    loadingOlder: {},
    unread: {},
    activeRoomId: null,
    roomClosed: false,
    devices: [],
    myGenerations: {},
    localTools: {},
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
      const reply = await request<LinkCodeReply>((request_id) => ({ type: "create_link_code", request_id }));
      return { code: reply.code, expiresInSecs: reply.expires_in_secs };
    },

    async redeemLinkCode(code) {
      const reply = await request<LinkedReply>((request_id) => ({ type: "redeem_link_code", request_id, code }));
      await backend.linkDevice(reply.user_id, reply.display_name);
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
        relay?.send({
          type: "request_ai",
          request_id: crypto.randomUUID(),
          room_id: ai.room_id,
          anchor_id: anchor.id,
          device_id: remote.deviceId,
          profile_id: remote.profileId,
        });
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
      backend.setRoomMcpMode(roomId, serverId, mode).catch((e) => get().toast(errorText(e)));
    },

    answerToolCall(id, callId, approved) {
      backend.resolveToolCall(id, callId, approved).catch((e) => get().toast(errorText(e)));
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
