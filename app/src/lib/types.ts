// Wire types shared with the relay (server/src/protocol.rs) and the Tauri backend.

export interface Member {
  user_id: string;
  display_name: string;
  online: boolean;
}

/** A profile another of this user's devices shares for delegated generation.
 *  Only id, label and model cross the wire — never a key or base URL. */
export interface SharedProfile {
  id: string;
  label: string;
  model: string;
}

/** One of this user's devices that is online right now (ServerMsg "devices"). */
export interface Device {
  device_id: string;
  device_name: string;
  platform: string;
  /** Profiles that device shares (empty unless it sent `share_profiles`). */
  profiles: SharedProfile[];
}

export interface RoomInfo {
  id: string;
  name: string;
  invite_code: string;
  system_prompt: string;
  members: Member[];
}

export type ToolStatus = "awaiting_approval" | "running" | "done" | "error" | "denied";

/** An MCP tool call shown to the room: names and status only. */
export interface ToolActivity {
  call_id: string;
  server: string;
  tool: string;
  status: ToolStatus;
}

/** An image attached to an AI reply; the bytes are fetched with `get_attachment`. */
export interface Attachment {
  attachment_id: string;
  mime: string;
  call_id: string | null;
  width: number | null;
  height: number | null;
}

/** One emoji and everyone who used it on a message, in reaction order. */
export interface Reaction {
  emoji: string;
  user_ids: string[];
}

export type MessageStatus = "complete" | "streaming" | "error" | "interrupted";

export interface Message {
  id: string;
  room_id: string;
  seq: number;
  kind: "human" | "ai";
  /** Human: the author. AI: the member whose profile generated it. */
  author_id: string;
  author_name: string;
  content: string;
  reasoning: string;
  tools: ToolActivity[];
  attachments: Attachment[];
  reactions: Reaction[];
  ai_requested: boolean;
  anchor_id: string | null;
  model: string | null;
  /** Message this one replies to, if any. */
  reply_to: string | null;
  status: MessageStatus;
  error: string | null;
  created_at: number;
  /** Set when the text was edited; shown as "(edited)". */
  edited_at: number | null;
  /** Soft delete: the row stays but the content is gone for everyone. */
  deleted: boolean;
}

/** One message search hit (ServerMsg "search_results"). The snippet's matched
 *  words are wrapped in STX/ETX control characters (\u0002 / \u0003). */
export interface SearchHit {
  id: string;
  seq: number;
  kind: "human" | "ai";
  author_name: string;
  created_at: number;
  snippet: string;
}

export type ClientMsg =
  | { type: "hello"; user_id: string; display_name: string; device_id: string; device_name: string; platform: string }
  | { type: "create_room"; request_id: string; name: string }
  | { type: "join_room"; request_id: string; invite_code: string }
  | { type: "leave_room"; room_id: string }
  | { type: "open_room"; room_id: string }
  | { type: "load_older"; room_id: string; before_seq: number; until_seq?: number }
  | { type: "send_message"; room_id: string; id: string; content: string; ai_requested: boolean; reply_to?: string | null }
  | { type: "ai_start"; room_id: string; id: string; anchor_id: string; model: string }
  | { type: "ai_delta"; room_id: string; id: string; delta: string }
  | { type: "ai_reasoning"; room_id: string; id: string; delta: string }
  | { type: "ai_tool"; room_id: string; id: string; activity: ToolActivity }
  | { type: "ai_attachment"; room_id: string; id: string; attachment: Attachment; data: string }
  | { type: "get_attachment"; attachment_id: string }
  | { type: "ai_complete"; room_id: string; id: string; content: string }
  | { type: "ai_error"; room_id: string; id: string; error: string }
  | { type: "set_room_prompt"; room_id: string; system_prompt: string }
  | { type: "react"; room_id: string; message_id: string; emoji: string; on: boolean }
  | { type: "typing"; room_id: string; typing: boolean }
  | { type: "edit_message"; room_id: string; message_id: string; content: string }
  | { type: "delete_message"; room_id: string; message_id: string }
  | { type: "share_profiles"; profiles: SharedProfile[] }
  | { type: "request_ai"; request_id: string; room_id: string; anchor_id: string; device_id: string; profile_id: string }
  | { type: "ai_request_failed"; request_id: string; to_device_id: string; message: string }
  | { type: "create_link_code"; request_id: string }
  | { type: "redeem_link_code"; request_id: string; code: string }
  | { type: "search_messages"; request_id: string; room_id: string; query: string };

export type ServerMsg =
  | { type: "welcome"; user_id: string; rooms: RoomInfo[] }
  | { type: "room_joined"; request_id: string | null; room: RoomInfo }
  | { type: "room_left"; room_id: string }
  | { type: "room_history"; room_id: string; messages: Message[]; has_more: boolean }
  | { type: "older_messages"; room_id: string; messages: Message[]; has_more: boolean }
  | { type: "search_results"; request_id: string; room_id: string; hits: SearchHit[] }
  | { type: "message"; room_id: string; message: Message }
  | { type: "message_updated"; room_id: string; message: Message }
  | { type: "ai_delta"; room_id: string; id: string; delta: string }
  | { type: "ai_reasoning"; room_id: string; id: string; delta: string }
  | { type: "ai_tool"; room_id: string; id: string; activity: ToolActivity }
  | { type: "ai_attachment"; room_id: string; id: string; attachment: Attachment }
  | { type: "attachment"; attachment_id: string; mime: string; data: string }
  | { type: "ai_complete"; room_id: string; id: string; content: string }
  | { type: "ai_error"; room_id: string; id: string; error: string }
  | { type: "ai_interrupted"; room_id: string; id: string; content: string }
  | { type: "member_joined"; room_id: string; member: Member }
  | { type: "member_updated"; room_id: string; member: Member }
  | { type: "member_left"; room_id: string; user_id: string }
  | { type: "presence"; room_id: string; user_id: string; online: boolean }
  | { type: "typing"; room_id: string; user_id: string; display_name: string; typing: boolean }
  | { type: "room_updated"; room_id: string; system_prompt: string; updated_by: string }
  | { type: "reactions"; room_id: string; message_id: string; reactions: Reaction[] }
  | { type: "ai_requested"; request_id: string; room_id: string; anchor_id: string; anchor_seq: number; profile_id: string; from_device_id: string }
  | { type: "link_code"; request_id: string; code: string; expires_in_secs: number }
  | { type: "linked"; request_id: string; user_id: string; display_name: string }
  | { type: "devices"; devices: Device[] }
  | { type: "error"; request_id: string | null; message: string };

// ---- Tauri backend ----

export type ProviderKind = "openai" | "anthropic";

export interface Profile {
  id: string;
  label: string;
  provider: ProviderKind;
  base_url: string;
  model: string;
  max_context_tokens: number;
  temperature: number | null;
  show_reasoning: boolean;
  reasoning_effort: string | null;
}

export interface ModelInfo {
  id: string;
  name: string | null;
  context_length: number | null;
  reasoning: boolean | null;
  tools: boolean | null;
}

export type McpMode = "off" | "ask" | "auto";

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  default_mode: McpMode;
  share_images: boolean;
  timeout_secs: number;
}

/** As returned by the backend: secret names only, never values. */
export interface McpServerView extends McpServer {
  env_names: string[];
  header_names: string[];
}

/** An env var or header row in the editor; value null keeps the stored value. */
export interface SecretEdit {
  kind: "env" | "header";
  name: string;
  value: string | null;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface ProfileView extends Profile {
  has_key: boolean;
}

/** Which kind of device this client runs on. Mobile cannot run stdio MCP servers. */
export type Platform = "desktop" | "ios" | "android";

export interface ClientState {
  instance: string;
  user_id: string;
  display_name: string;
  device_id: string;
  /** True while this device acts as another device's account (device linking). */
  linked: boolean;
  server_url: string;
  platform: Platform;
  last_profile_by_room: Record<string, string>;
  profiles: ProfileView[];
  mcp_servers: McpServerView[];
  mcp_modes_by_room: Record<string, Record<string, McpMode>>;
}

/** The relay this desktop app hosts (Settings > General). */
export interface HostStatus {
  /** False on phones, which can't keep a server running in the background. */
  supported: boolean;
  running: boolean;
  port: number | null;
  /** The port hosting resumes on at launch, even if it isn't running right now. */
  saved_port: number | null;
  /** Why hosting last failed to start. */
  error: string | null;
  lan_ip: string | null;
  tailscale_ip: string | null;
}

export interface HistoryItem {
  kind: "human" | "ai";
  author_name: string;
  content: string;
}

export type GenEvent =
  | { event: "delta"; text: string }
  | { event: "reasoning"; text: string }
  | {
      event: "tool";
      call_id: string;
      server: string;
      tool: string;
      status: ToolStatus;
      /** Local only: never sent to the relay. */
      args: string | null;
      detail: string | null;
    }
  | { event: "image"; call_id: string; mime: string; data: string }
  | { event: "notice"; message: string }
  | { event: "done"; content: string; stopped: boolean }
  | { event: "error"; message: string; partial: string };
