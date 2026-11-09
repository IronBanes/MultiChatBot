import { useEffect, useState } from "react";
import { errorText } from "./lib/backend";
import { useChat } from "./store";
import { applyTheme } from "./theme";
import { ConfirmHost } from "./components/Confirm";
import { RoomView } from "./components/RoomView";
import { SettingsDialog, type SettingsTab } from "./components/Settings";
import { useKeyboardViewport } from "./lib/useKeyboardViewport";
import { useWidth } from "./lib/useWidth";
import { PhoneRoomList, RoomDialog, Sidebar } from "./components/Sidebar";
import { Button, Field, inputCls, Logo } from "./components/ui";

function Onboarding() {
  const client = useChat((s) => s.client)!;
  const saveIdentity = useChat((s) => s.saveIdentity);
  const [name, setName] = useState("");
  const [url, setUrl] = useState(client.server_url);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await saveIdentity(name, url);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-fuchsia-50 p-6 dark:from-zinc-950 dark:via-zinc-950 dark:to-indigo-950/40">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-200 bg-white p-7 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <Logo size={48} />
        <div>
          <h1 className="text-xl font-semibold">Welcome to Multichat</h1>
          <p className="mt-1 text-sm text-zinc-500">Group chats where everyone brings their own AI. Pick a name to get started.</p>
        </div>
        <Field label="Display name">
          <input autoFocus className={inputCls} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Alice" />
        </Field>
        <Field label="Relay server">
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full" disabled={!name.trim()}>
          Continue
        </Button>
        {client.instance !== "default" && <p className="text-center text-xs text-zinc-400">Instance “{client.instance}”</p>}
      </form>
    </div>
  );
}

/** Below this width the app switches to its phone layout. */
const NAV_INLINE_MIN = 760;

function EmptyState() {
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  return (
    <div className="relative flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-semibold">No room selected</h2>
        <p className="mt-1 text-sm text-zinc-500">Create a room and share its invite code, or join one with a code from a friend.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => setDialog("create")}>Create room</Button>
          <Button variant="outline" onClick={() => setDialog("join")}>
            Join with code
          </Button>
        </div>
      </div>
      {dialog && <RoomDialog mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

export default function App() {
  const client = useChat((s) => s.client);
  const init = useChat((s) => s.init);
  const room = useChat((s) => (s.activeRoomId ? s.rooms[s.activeRoomId] : undefined));
  const toasts = useChat((s) => s.toasts);
  const dismissToast = useChat((s) => s.dismissToast);
  const closeRoom = useChat((s) => s.closeRoom);
  const [settings, setSettings] = useState<null | SettingsTab>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const width = useWidth();
  // Narrow windows (phones): the room list and each room are separate screens.
  const compactNav = width < NAV_INLINE_MIN;
  useKeyboardViewport();

  // Phones open on the room list rather than jumping into the first room.
  useEffect(() => {
    if (window.innerWidth < NAV_INLINE_MIN) closeRoom();
  }, [closeRoom]);

  const instance = client?.instance;
  useEffect(() => {
    if (instance) document.title = instance === "default" ? "Multichat" : `Multichat — ${instance}`;
  }, [instance]);

  useEffect(() => {
    applyTheme();
    init().catch((e) => setFatal(errorText(e)));
  }, [init]);

  if (fatal) return <div className="p-8 text-red-600">Failed to start: {fatal}</div>;
  if (!client) return null;
  if (!client.display_name) return <Onboarding />;

  const overlays = (
    <>
      {settings && <SettingsDialog tab={settings} onClose={() => setSettings(null)} />}
      <ConfirmHost />
      <div className="pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={`pointer-events-auto max-w-[calc(100vw-2rem)] rounded-lg sm:max-w-sm px-4 py-2.5 text-left text-sm text-white shadow-lg ${
              t.kind === "error" ? "bg-red-600" : "bg-zinc-800"
            }`}
          >
            {t.text}
          </button>
        ))}
      </div>
    </>
  );

  // Phones: a room list screen, and each room as its own screen on top of it.
  if (compactNav) {
    return (
      <div className="flex h-full overflow-hidden bg-white pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] dark:bg-zinc-950">
        {room ? (
          <RoomView key={room.id} room={room} onOpenSettings={setSettings} onBack={closeRoom} />
        ) : (
          <PhoneRoomList onSettings={() => setSettings("general")} />
        )}
        {overlays}
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <Sidebar onSettings={() => setSettings("general")} />
      <main className="flex min-w-0 flex-1 bg-white dark:bg-zinc-950">
        {room ? <RoomView room={room} onOpenSettings={setSettings} /> : <EmptyState />}
      </main>
      {overlays}
    </div>
  );
}
