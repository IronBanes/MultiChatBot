// Typed wrappers around the Tauri commands in src-tauri/src/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ClientState,
  GenEvent,
  HistoryItem,
  HostStatus,
  LentImage,
  LentServer,
  LentToolSpec,
  McpMode,
  McpServer,
  McpServerView,
  McpToolInfo,
  ModelInfo,
  NotifyMode,
  Profile,
  ProfileView,
  SecretEdit,
} from "./types";

/** A lent server as `lent_tools` returns it (real tools, unqualified names). */
export type LentServerOut = LentServer;

/** An image from `run_lent_tool` (base64). */
export type LentImageOut = LentImage;

export const backend = {
  getState: () => invoke<ClientState>("get_state"),
  setIdentity: (displayName: string, serverUrl: string) =>
    invoke<void>("set_identity", { displayName, serverUrl }),
  /** Switches this device to another device's account (device linking). */
  linkDevice: (userId: string, displayName: string, secret: string) =>
    invoke<void>("link_device", { userId, displayName, secret }),
  /** Returns this device to its own account after `linkDevice`. */
  unlinkDevice: () => invoke<void>("unlink_device"),
  /** apiKey: undefined keeps the stored key, "" removes it. */
  saveProfile: (profile: Profile, apiKey?: string) =>
    invoke<ProfileView>("save_profile", { profile, apiKey: apiKey ?? null }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  /** `remote`: asked by another device, so refused unless remote control is on. */
  setProfileEnabled: (id: string, enabled: boolean, remote = false) => invoke<void>("set_profile_enabled", { id, enabled, remote }),
  /** Whether this user's other devices may control this one. */
  setRemoteControl: (enabled: boolean) => invoke<void>("set_remote_control", { enabled }),
  setLastProfile: (roomId: string, profileId: string) =>
    invoke<void>("set_last_profile", { roomId, profileId }),
  testProfile: (profile: Profile, apiKey?: string) =>
    invoke<string>("test_profile", { profile, apiKey: apiKey || null }),
  listModels: (profile: Profile, apiKey?: string) =>
    invoke<ModelInfo[]>("list_models", { profile, apiKey: apiKey || null }),

  /** secrets: undefined keeps the stored env vars/headers unchanged. */
  saveMcpServer: (server: McpServer, secrets?: SecretEdit[]) =>
    invoke<McpServerView>("save_mcp_server", { server, secrets: secrets ?? null }),
  deleteMcpServer: (id: string) => invoke<void>("delete_mcp_server", { id }),
  testMcpServer: (server: McpServer, secrets?: SecretEdit[]) =>
    invoke<McpToolInfo[]>("test_mcp_server", { server, secrets: secrets ?? null }),
  setRoomMcpMode: (roomId: string, serverId: string, mode: McpMode, remote = false) =>
    invoke<void>("set_room_mcp_mode", { roomId, serverId, mode, remote }),
  /** Picks which messages in a room earn a system notification. */
  setRoomNotify: (roomId: string, mode: NotifyMode) =>
    invoke<void>("set_room_notify", { roomId, mode }),
  /** Drops a left room's notification choice. */
  forgetRoomNotify: (roomId: string) =>
    invoke<void>("forget_room_notify", { roomId }),
  resolveToolCall: (id: string, callId: string, approved: boolean, remote = false) =>
    invoke<void>("resolve_tool_call", { id, callId, approved, remote }),

  // ---- lending MCP tools to a room ----
  /** Lends (or unlends) one of this device's servers to a room. */
  setMcpLend: (roomId: string, serverId: string, lent: boolean) =>
    invoke<void>("set_mcp_lend", { roomId, serverId, lent }),
  /** Auto for one member: their AI runs a lent server's tools without asking. */
  setMcpLendAuto: (roomId: string, serverId: string, userId: string, auto: boolean) =>
    invoke<void>("set_mcp_lend_auto", { roomId, serverId, userId, auto }),
  /** The servers this device lends in a room, with their real tools. */
  lentTools: (roomId: string) => invoke<LentServerOut[]>("lent_tools", { roomId }),
  /** Answers a lent tool approval prompt. */
  answerLentTool: (approvalId: string, approved: boolean) =>
    invoke<void>("answer_lent_tool", { approvalId, approved }),
  /** Dismisses a lent tool approval prompt (counts as denied). */
  cancelLentTool: (approvalId: string) =>
    invoke<void>("cancel_lent_tool", { approvalId }),
  /** Runs another member's tool call on this computer (lender side). */
  runLentTool: (
    approvalId: string,
    roomId: string,
    fromUserId: string,
    fromName: string,
    serverId: string,
    tool: string,
    args: unknown,
  ) =>
    invoke<{ content: string; is_error: boolean; images: LentImageOut[] }>("run_lent_tool", {
      approvalId,
      roomId,
      fromUserId,
      fromName,
      serverId,
      tool,
      args,
    }),
  /** Hands the lender's answer to a waiting borrowed tool call. */
  lentToolResult: (messageId: string, callId: string, content: string, isError: boolean, images: LentImageOut[]) =>
    invoke<void>("lent_tool_result", { messageId, callId, content, isError, images }),
  /** Switches one of another member's lent servers on or off for this device. */
  setMcpBorrow: (roomId: string, key: string, on: boolean) =>
    invoke<void>("set_mcp_borrow", { roomId, key, on }),

  generate: (
    id: string,
    profileId: string,
    roomId: string,
    history: HistoryItem[],
    roomPrompt: string,
    /** The room's shared summary of messages before `history` ("" = none). */
    summary: string,
    /** Only messages with a smaller seq may be folded into a new summary (null = no limit). */
    foldBefore: number | null,
    /** For another of this user's devices: MCP tools only with remote control on, and
     *  every call is approved first, even on an Auto server. */
    delegated: boolean,
    /** Tools borrowed from room members (see `room_tools` / `call_lent_tool`). */
    lentTools: LentToolSpec[],
    onEvent: (e: GenEvent) => void,
  ) => {
    const channel = new Channel<GenEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate", { id, profileId, roomId, history, roomPrompt, summary, foldBefore, delegated, lentTools, onEvent: channel });
  },
  stopGeneration: (id: string) => invoke<void>("stop_generation", { id }),

  hostStatus: () => invoke<HostStatus>("host_status"),
  /** Starts the hosted relay on `port`, or restarts it if it's already running. */
  hostStart: (port: number) => invoke<HostStatus>("host_start", { port }),
  hostStop: () => invoke<HostStatus>("host_stop"),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Unexpected error";
}
