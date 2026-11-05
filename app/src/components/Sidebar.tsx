import { useState } from "react";
import { errorText } from "../lib/backend";
import { useChat, SIGN_IN_REFUSED } from "../store";
import { Avatar, Button, Field, Icon, inputCls, Logo, Modal } from "./ui";

export function RoomDialog({ mode, onClose }: { mode: "create" | "join"; onClose: () => void }) {
  const createRoom = useChat((s) => s.createRoom);
  const joinRoom = useChat((s) => s.joinRoom);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await (mode === "create" ? createRoom(value.trim()) : joinRoom(value.trim()));
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={mode === "create" ? "Create a room" : "Join a room"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label={mode === "create" ? "Room name" : "Invite code"}
          hint={mode === "create" ? "You'll get an invite code to share." : "Ask a member for the 6-character code."}
        >
          <input
            autoFocus
            className={`${inputCls} ${mode === "join" ? "font-mono tracking-widest uppercase" : ""}`}
            value={value}
            maxLength={mode === "create" ? 80 : 12}
            onChange={(e) => setValue(e.target.value)}
            placeholder={mode === "create" ? "Design crew" : "ABC123"}
          />
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !value.trim()}>
            {mode === "create" ? "Create" : "Join"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const statusStyle = {
  online: ["bg-emerald-500", "Connected"],
  connecting: ["bg-amber-500 animate-pulse", "Connecting…"],
  offline: ["bg-red-500", "Offline — retrying"],
} as const;

export function Sidebar({ onSettings }: { onSettings: () => void }) {
  const client = useChat((s) => s.client)!;
  const status = useChat((s) => s.status);
  const connError = useChat((s) => s.connError);
  const reconnect = useChat((s) => s.reconnect);
  const rooms = useChat((s) => s.rooms);
  const roomOrder = useChat((s) => s.roomOrder);
  const unread = useChat((s) => s.unread);
  const mentioned = useChat((s) => s.mentioned);
  const activeRoomId = useChat((s) => s.activeRoomId);
  const selectRoom = useChat((s) => s.selectRoom);
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const [dot, label] = statusStyle[status];

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-3">
        <Logo size={32} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-tight">Multichat</div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} /> {label}
            {status !== "online" && (
              <button
                onClick={reconnect}
                className="ml-0.5 rounded px-1 font-medium text-indigo-600 hover:bg-zinc-200 dark:text-indigo-400 dark:hover:bg-zinc-800"
                title="Reconnect to the relay now"
              >
                Retry
              </button>
            )}
          </div>
        </div>
        {client.instance !== "default" && (
          <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {client.instance}
          </span>
        )}
      </div>

      {status !== "online" && connError && (
        <p className="mx-3 mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {connError}
          {!SIGN_IN_REFUSED.test(connError) && " Check the relay address in Settings."}
        </p>
      )}

      <div className="flex gap-2 px-3 pb-3">
        <Button variant="outline" className="flex-1 !py-1.5" onClick={() => setDialog("create")}>
          <Icon name="plus" size={15} /> New
        </Button>
        <Button variant="outline" className="flex-1 !py-1.5" onClick={() => setDialog("join")}>
          <Icon name="door" size={15} /> Join
        </Button>
      </div>

      <div className="px-4 pb-1 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Rooms</div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {roomOrder.length === 0 && <p className="px-2 py-3 text-sm text-zinc-500">No rooms yet.</p>}
        {roomOrder.map((id) => {
          const r = rooms[id];
          if (!r) return null;
          const active = id === activeRoomId;
          const online = r.members.filter((m) => m.online).length;
          return (
            <button
              key={id}
              onClick={() => selectRoom(id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                active
                  ? "bg-white font-medium shadow-sm dark:bg-zinc-800"
                  : "text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
              }`}
            >
              <Icon name="hash" size={15} className="shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {mentioned[id] && !active && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white" title="You were mentioned">@</span>
              )}
              {!!unread[id] && !active ? (
                <span className="rounded-full bg-indigo-600 px-1.5 text-[11px] font-semibold text-white">{unread[id]}</span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-zinc-400" title={`${online} online`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {online}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-2 border-t border-zinc-200 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        <Avatar userId={client.user_id} name={client.display_name} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{client.display_name}</div>
          <div className="truncate text-xs text-zinc-500">
            {client.profiles.length} AI profile{client.profiles.length === 1 ? "" : "s"}
          </div>
        </div>
        <button onClick={onSettings} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800" aria-label="Settings">
          <Icon name="gear" />
        </button>
      </div>

      {dialog && <RoomDialog mode={dialog} onClose={() => setDialog(null)} />}
    </aside>
  );
}

/** Phones: the room list is its own full screen, like a messaging app's inbox. */
export function PhoneRoomList({ onSettings }: { onSettings: () => void }) {
  const client = useChat((s) => s.client)!;
  const status = useChat((s) => s.status);
  const connError = useChat((s) => s.connError);
  const reconnect = useChat((s) => s.reconnect);
  const rooms = useChat((s) => s.rooms);
  const roomOrder = useChat((s) => s.roomOrder);
  const unread = useChat((s) => s.unread);
  const mentioned = useChat((s) => s.mentioned);
  const messages = useChat((s) => s.messages);
  const selectRoom = useChat((s) => s.selectRoom);
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const [dot, label] = statusStyle[status];

  return (
    <div className="flex h-full w-full flex-col bg-white dark:bg-zinc-950">
      <header className="px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <div className="flex items-center gap-1">
          <h1 className="flex-1 text-[28px] font-bold tracking-tight">Rooms</h1>
          <button
            onClick={() => setDialog("join")}
            className="flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-indigo-600 active:bg-zinc-100 dark:text-indigo-400 dark:active:bg-zinc-800"
          >
            <Icon name="door" size={18} /> Join
          </button>
          <button
            onClick={() => setDialog("create")}
            className="flex h-11 w-11 items-center justify-center rounded-full text-indigo-600 active:bg-zinc-100 dark:text-indigo-400 dark:active:bg-zinc-800"
            aria-label="New room"
          >
            <Icon name="plus" size={22} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} /> {label}
          {status !== "online" && (
            <button onClick={reconnect} className="ml-1 rounded px-1.5 py-1 font-medium text-indigo-600 dark:text-indigo-400">
              Retry
            </button>
          )}
          {client.instance !== "default" && <span className="ml-auto font-mono text-[10px] text-zinc-400">{client.instance}</span>}
        </div>
        {status !== "online" && connError && (
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {connError}
          {!SIGN_IN_REFUSED.test(connError) && " Check the relay address in Settings."}
          </p>
        )}
      </header>

      <nav className="min-h-0 flex-1 overflow-y-auto">
        {roomOrder.length === 0 && (
          <div className="px-8 pt-16 text-center">
            <p className="font-semibold">No rooms yet</p>
            <p className="mt-1 text-sm text-zinc-500">Create a room and share its invite code, or join one with a code from a friend.</p>
          </div>
        )}
        {roomOrder.map((id) => {
          const r = rooms[id];
          if (!r) return null;
          const online = r.members.filter((m) => m.online).length;
          const list = messages[id];
          const last = list?.[list.length - 1];
          const preview = last
            ? `${last.kind === "ai" ? "AI" : last.author_id === client.user_id ? "You" : last.author_name}: ${last.content.replace(/\s+/g, " ")}`
            : `${online} online · ${r.members.length} member${r.members.length === 1 ? "" : "s"}`;
          const count = unread[id] ?? 0;
          return (
            <button
              key={id}
              onClick={() => selectRoom(id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-zinc-100 dark:active:bg-zinc-900"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
                <Icon name="hash" size={20} />
              </span>
              <span className="min-w-0 flex-1 border-b border-zinc-100 pb-3 dark:border-zinc-900">
                <span className="flex items-baseline gap-2">
                  <span className={`min-w-0 flex-1 truncate text-[16px] ${count ? "font-semibold" : "font-medium"}`}>{r.name}</span>
                  {online > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {online}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={`min-w-0 flex-1 truncate text-sm ${count ? "text-zinc-700 dark:text-zinc-300" : "text-zinc-500"}`}>{preview}</span>
                  {mentioned[id] && (
                    <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white" aria-label="You were mentioned">@</span>
                  )}
                  {count > 0 && (
                    <span className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white">{count}</span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="safe-bottom flex items-center gap-3 border-t border-zinc-200 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        <Avatar userId={client.user_id} name={client.display_name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{client.display_name}</div>
          <div className="truncate text-xs text-zinc-500">
            {client.profiles.length} AI profile{client.profiles.length === 1 ? "" : "s"}
          </div>
        </div>
        <button
          onClick={onSettings}
          className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-100 dark:active:bg-zinc-800"
          aria-label="Settings"
        >
          <Icon name="gear" size={22} />
        </button>
      </div>

      {dialog && <RoomDialog mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
