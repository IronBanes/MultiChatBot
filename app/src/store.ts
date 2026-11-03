// App state: relay connection, rooms, messages, and AI reply orchestration.

import { create } from "zustand";
import { backend, errorText } from "./lib/backend";
import { prepareImage } from "./lib/images";
import { Relay, type ConnStatus } from "./lib/relay";
import type { Attachment, ClientState, HistoryItem, McpMode, Message, RoomInfo, ServerMsg, ToolStatus } from "./lib/types";

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
  unread: Record<string, number>;
  activeRoomId: string | null;
  /** AI message ids this client is currently generating. */
  myGenerations: Record<string, true>;
  /** AI message id → call id → details, for replies this client generates. */
  localTools: Record<string, Record<string, LocalTool>>;
  /** attachment id → data URL ("" while loading). */
  images: Record<string, string>;
  toasts: Toast[];

  init(): Promise<void>;
  refreshClient(): Promise<void>;
  /** Reconnects to the relay now instead of waiting for the next retry. */
  reconnect(): void;
  saveIdentity(displayName: string, serverUrl: string): Promise<void>;
  selectRoom(id: string): void;
  createRoom(name: string): Promise<RoomInfo>;
  joinRoom(code: string): Promise<RoomInfo>;
  leaveRoom(id: string): void;
  /** Resolves true once the message was actually written to the relay. */
  sendMessage(roomId: string, content: string, aiRequested: boolean, profileId: string | null): Promise<boolean>;
  regenerate(ai: Message, profileId: string): void;
  stopAi(id: string): void;
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
/** Images announced for a reply this client hasn't loaded yet (e.g. while joining). */
const unclaimedAttachments = new Map<string, Attachment[]>();

/** Adds attachments not already on the message, plus any waiting for it. */
function withAttachments(m: Message, extra: Attachment[] = []): Message {
  const waiting = unclaimedAttachments.get(m.id) ?? [];
  unclaimedAttachments.delete(m.id);
  const add = [...extra, ...waiting].filter(
    (a, i, all) => !m.attachments.some((b) => b.attachment_id === a.attachment_id) && all.findIndex((b) => b.attachment_id === a.attachment_id) === i,
  );
  return add.length ? { ...m, attachments: [...m.attachments, ...add] } : m;
}

const pendingRequests = new Map<string, { resolve: (r: RoomInfo) => void; reject: (e: Error) => void }>();
let toastSeq = 0;

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

function request(build: (requestId: string) => Parameters<Relay["send"]>[0]): Promise<RoomInfo> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    if (!relay?.send(build(requestId))) {
      reject(new Error("Not connected to the server"));
      return;
    }
    pendingRequests.set(requestId, { resolve, reject });
    window.setTimeout(() => {
      if (pendingRequests.delete(requestId)) reject(new Error("The server did not respond"));
    }, 10_000);
  });
}

export const useChat = create<ChatState>((set, get) => {
  const patchRoom = (roomId: string, f: (r: RoomInfo) => RoomInfo) =>
    set((s) => (s.rooms[roomId] ? { rooms: { ...s.rooms, [roomId]: f(s.rooms[roomId]) } } : {}));

  const stopAllGenerations = () => {
    for (const id of Object.keys(get().myGenerations)) void backend.stopGeneration(id);
  };

  function connect() {
    const client = get().client;
    relay?.close();
    relay = null;
    if (!client?.display_name) return;
    relay = new Relay(
      client.server_url,
      { user_id: client.user_id, display_name: client.display_name },
      {
        onMessage: handle,
        onStatus: (status, error) => {
          // The relay marks our in-flight replies as interrupted when the socket drops.
          if (status === "offline") stopAllGenerations();
          if (status === "online") set({ status, connError: null });
          else if (error) set({ status, connError: error });
          else set({ status });
        },
      },
    );
  }

  function startAi(roomId: string, anchor: Message, profileId: string) {
    const s = get();
    const profile = s.client?.profiles.find((p) => p.id === profileId);
    if (!profile) {
      get().toast("That AI profile no longer exists. Pick another one.");
      return;
    }
    const room = s.rooms[roomId];
    const history: HistoryItem[] = (s.messages[roomId] ?? [])
      .filter((m) => m.seq <= anchor.seq && (m.kind === "human" || m.status === "complete"))
      .map((m) => ({ kind: m.kind, author_name: m.author_name, content: m.content }));

    const id = crypto.randomUUID();
    if (!relay?.send({ type: "ai_start", room_id: roomId, id, anchor_id: anchor.id, model: profile.model })) {
      get().toast("Not connected to the server");
      return;
    }
    set((st) => ({ myGenerations: { ...st.myGenerations, [id]: true } }));
    // Images are compressed before relaying; the reply only ends after they're sent.
    let uploads: Promise<void> = Promise.resolve();
    const afterUploads = (f: () => void) => {
      uploads = uploads.then(f, f);
    };
    const finish = () =>
      set((st) => {
        const { [id]: _, ...rest } = st.myGenerations;
        return { myGenerations: rest };
      });

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
        if (!active || !rooms[active]) active = order[0] ?? null;
        // Image fetches still pending when the connection dropped never got an answer;
        // forget them so the images request again on this connection.
        const images = Object.fromEntries(Object.entries(get().images).filter(([, src]) => src));
        set({ rooms, roomOrder: order, loaded: {}, activeRoomId: active, images });
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
      case "room_history":
        set((s) => {
          // Keep anything live that arrived after the history snapshot, including images
          // announced while the snapshot was being read.
          const current = s.messages[msg.room_id] ?? [];
          const maxSeq = msg.messages.length ? msg.messages[msg.messages.length - 1].seq : -1;
          const newer = current.filter((m) => m.seq > maxSeq);
          const live = new Map(current.map((m) => [m.id, m]));
          const merged = msg.messages.map((m) => withAttachments(m, live.get(m.id)?.attachments));
          return {
            messages: { ...s.messages, [msg.room_id]: [...merged, ...newer] },
            loaded: { ...s.loaded, [msg.room_id]: true },
          };
        });
        break;
      case "message": {
        const m = withAttachments(msg.message);
        const mine = m.author_id === get().client?.user_id;
        set((s) => ({
          messages: { ...s.messages, [m.room_id]: upsert(s.messages[m.room_id], m) },
          unread:
            s.activeRoomId === m.room_id || (mine && m.kind === "human")
              ? s.unread
              : { ...s.unread, [m.room_id]: (s.unread[m.room_id] ?? 0) + 1 },
        }));
        const profileId = pendingAi.get(m.id);
        if (profileId && m.kind === "human") {
          pendingAi.delete(m.id);
          startAi(m.room_id, m, profileId);
        }
        break;
      }
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
        break;
      case "presence":
        patchRoom(msg.room_id, (r) => ({
          ...r,
          members: r.members.map((m) => (m.user_id === msg.user_id ? { ...m, online: msg.online } : m)),
        }));
        break;
      case "room_updated":
        patchRoom(msg.room_id, (r) => ({ ...r, system_prompt: msg.system_prompt }));
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
    unread: {},
    activeRoomId: null,
    myGenerations: {},
    localTools: {},
    images: {},
    toasts: [],

    async init() {
      await get().refreshClient();
      connect();
    },

    async refreshClient() {
      set({ client: await backend.getState() });
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
        set({ rooms: {}, roomOrder: [], messages: {}, loaded: {}, activeRoomId: null });
        connect();
      } else if (before.display_name !== after.display_name) {
        relay.rename(after.display_name);
      }
    },

    selectRoom(id) {
      set((s) => ({ activeRoomId: id, unread: { ...s.unread, [id]: 0 } }));
      if (!get().loaded[id]) relay?.send({ type: "open_room", room_id: id });
    },

    createRoom: (name) => request((request_id) => ({ type: "create_room", request_id, name })),
    joinRoom: (code) => request((request_id) => ({ type: "join_room", request_id, invite_code: code })),

    leaveRoom(id) {
      relay?.send({ type: "leave_room", room_id: id });
    },

    async sendMessage(roomId, content, aiRequested, profileId) {
      const id = crypto.randomUUID();
      if (aiRequested && profileId) pendingAi.set(id, profileId);
      const ok = relay
        ? await relay.sendConfirmed({ type: "send_message", room_id: roomId, id, content, ai_requested: aiRequested })
        : false;
      if (!ok) {
        pendingAi.delete(id);
        get().toast("Message not sent: you're not connected to the server. Your text is still in the box.");
      }
      return ok;
    },

    regenerate(ai, profileId) {
      const anchor = get().messages[ai.room_id]?.find((m) => m.id === ai.anchor_id);
      if (!anchor) {
        get().toast("The message this reply answers is no longer loaded");
        return;
      }
      startAi(ai.room_id, anchor, profileId);
    },

    stopAi(id) {
      void backend.stopGeneration(id);
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
