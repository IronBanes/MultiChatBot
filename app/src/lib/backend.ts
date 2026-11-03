// Typed wrappers around the Tauri commands in src-tauri/src/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ClientState,
  GenEvent,
  HistoryItem,
  HostStatus,
  McpMode,
  McpServer,
  McpServerView,
  McpToolInfo,
  ModelInfo,
  Profile,
  ProfileView,
  SecretEdit,
} from "./types";

export const backend = {
  getState: () => invoke<ClientState>("get_state"),
  setIdentity: (displayName: string, serverUrl: string) =>
    invoke<void>("set_identity", { displayName, serverUrl }),
  /** Switches this device to another device's account (device linking). */
  linkDevice: (userId: string, displayName: string) =>
    invoke<void>("link_device", { userId, displayName }),
  /** Returns this device to its own account after `linkDevice`. */
  unlinkDevice: () => invoke<void>("unlink_device"),
  /** apiKey: undefined keeps the stored key, "" removes it. */
  saveProfile: (profile: Profile, apiKey?: string) =>
    invoke<ProfileView>("save_profile", { profile, apiKey: apiKey ?? null }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
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
  setRoomMcpMode: (roomId: string, serverId: string, mode: McpMode) =>
    invoke<void>("set_room_mcp_mode", { roomId, serverId, mode }),
  resolveToolCall: (id: string, callId: string, approved: boolean) =>
    invoke<void>("resolve_tool_call", { id, callId, approved }),

  generate: (
    id: string,
    profileId: string,
    roomId: string,
    history: HistoryItem[],
    roomPrompt: string,
    onEvent: (e: GenEvent) => void,
  ) => {
    const channel = new Channel<GenEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate", { id, profileId, roomId, history, roomPrompt, onEvent: channel });
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
