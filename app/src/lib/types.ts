// Wire types shared with the relay (server/src/protocol.rs) and the Tauri backend.

export interface Member {
  user_id: string;
  display_name: string;
  online: boolean;
}

export interface RoomInfo {
  id: string;
  name: string;
  invite_code: string;
  system_prompt: string;
  members: Member[];
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
  ai_requested: boolean;
  anchor_id: string | null;
  model: string | null;
  status: MessageStatus;
  error: string | null;
  created_at: number;
}

export type ClientMsg =
  | { type: "hello"; user_id: string; display_name: string }
  | { type: "create_room"; request_id: string; name: string }
  | { type: "join_room"; request_id: string; invite_code: string }
  | { type: "leave_room"; room_id: string }
  | { type: "open_room"; room_id: string }
  | { type: "send_message"; room_id: string; id: string; content: string; ai_requested: boolean }
  | { type: "ai_start"; room_id: string; id: string; anchor_id: string; model: string }
  | { type: "ai_delta"; room_id: string; id: string; delta: string }
  | { type: "ai_complete"; room_id: string; id: string; content: string }
  | { type: "ai_error"; room_id: string; id: string; error: string }
  | { type: "set_room_prompt"; room_id: string; system_prompt: string };

export type ServerMsg =
  | { type: "welcome"; user_id: string; rooms: RoomInfo[] }
  | { type: "room_joined"; request_id: string | null; room: RoomInfo }
  | { type: "room_left"; room_id: string }
  | { type: "room_history"; room_id: string; messages: Message[] }
  | { type: "message"; room_id: string; message: Message }
  | { type: "ai_delta"; room_id: string; id: string; delta: string }
  | { type: "ai_complete"; room_id: string; id: string; content: string }
  | { type: "ai_error"; room_id: string; id: string; error: string }
  | { type: "ai_interrupted"; room_id: string; id: string; content: string }
  | { type: "member_joined"; room_id: string; member: Member }
  | { type: "member_updated"; room_id: string; member: Member }
  | { type: "member_left"; room_id: string; user_id: string }
  | { type: "presence"; room_id: string; user_id: string; online: boolean }
  | { type: "room_updated"; room_id: string; system_prompt: string; updated_by: string }
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
}

export interface ProfileView extends Profile {
  has_key: boolean;
}

export interface ClientState {
  instance: string;
  user_id: string;
  display_name: string;
  server_url: string;
  last_profile_by_room: Record<string, string>;
  profiles: ProfileView[];
}

export interface HistoryItem {
  kind: "human" | "ai";
  author_name: string;
  content: string;
}

export type GenEvent =
  | { event: "delta"; text: string }
  | { event: "done"; content: string; stopped: boolean }
  | { event: "error"; message: string; partial: string };
