import { useEffect, useState } from "react";
import { errorText } from "./lib/backend";
import { useChat } from "./store";
import { applyTheme } from "./theme";
import { RoomView } from "./components/RoomView";
import { SettingsDialog } from "./components/Settings";
import { RoomDialog, Sidebar } from "./components/Sidebar";
import { Button, Field, Icon, inputCls } from "./components/ui";

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
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
          <Icon name="sparkle" />
        </div>
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

function EmptyState() {
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
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
  const [settings, setSettings] = useState<null | "general" | "profiles">(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    if (client) document.title = client.instance === "default" ? "Multichat" : `Multichat — ${client.instance}`;
  }, [client?.instance]);

  useEffect(() => {
    applyTheme();
    init().catch((e) => setFatal(errorText(e)));
  }, [init]);

  if (fatal) return <div className="p-8 text-red-600">Failed to start: {fatal}</div>;
  if (!client) return null;
  if (!client.display_name) return <Onboarding />;

  return (
    <div className="flex h-full">
      <Sidebar onSettings={() => setSettings("general")} />
      <main className="flex min-w-0 flex-1 bg-white dark:bg-zinc-950">
        {room ? <RoomView room={room} onNeedProfile={() => setSettings("profiles")} /> : <EmptyState />}
      </main>
      {settings && <SettingsDialog tab={settings} onClose={() => setSettings(null)} />}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={`pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-left text-sm text-white shadow-lg ${
              t.kind === "error" ? "bg-red-600" : "bg-zinc-800"
            }`}
          >
            {t.text}
          </button>
        ))}
      </div>
    </div>
  );
}
