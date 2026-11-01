// Typed wrappers around the Tauri commands in src-tauri/src/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { ClientState, GenEvent, HistoryItem, Profile, ProfileView } from "./types";

export const backend = {
  getState: () => invoke<ClientState>("get_state"),
  setIdentity: (displayName: string, serverUrl: string) =>
    invoke<void>("set_identity", { displayName, serverUrl }),
  /** apiKey: undefined keeps the stored key, "" removes it. */
  saveProfile: (profile: Profile, apiKey?: string) =>
    invoke<ProfileView>("save_profile", { profile, apiKey: apiKey ?? null }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  setLastProfile: (roomId: string, profileId: string) =>
    invoke<void>("set_last_profile", { roomId, profileId }),
  testProfile: (profile: Profile, apiKey?: string) =>
    invoke<string>("test_profile", { profile, apiKey: apiKey || null }),
  generate: (
    id: string,
    profileId: string,
    history: HistoryItem[],
    roomPrompt: string,
    onEvent: (e: GenEvent) => void,
  ) => {
    const channel = new Channel<GenEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate", { id, profileId, history, roomPrompt, onEvent: channel });
  },
  stopGeneration: (id: string) => invoke<void>("stop_generation", { id }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Unexpected error";
}
