import { useState } from "react";
import { errorText } from "../lib/backend";
import { useChat } from "../store";
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
  const rooms = useChat((s) => s.rooms);
  const roomOrder = useChat((s) => s.roomOrder);
  const unread = useChat((s) => s.unread);
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
          </div>
        </div>
        {client.instance !== "default" && (
          <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {client.instance}
          </span>
        )}
      </div>

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
