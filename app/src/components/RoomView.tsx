import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { memberColor } from "../lib/colors";
import type { Message, RoomInfo } from "../lib/types";
import { useChat } from "../store";
import { Markdown } from "./Markdown";
import { Avatar, Button, Icon, Modal } from "./ui";

function time(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function snippet(text: string, n = 80) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

const MessageItem = memo(function MessageItem({
  m,
  anchor,
  showAnchor,
  compact,
  myProfileId,
  mine,
}: {
  m: Message;
  anchor: Message | undefined;
  showAnchor: boolean;
  compact: boolean;
  myProfileId: string | null;
  mine: boolean;
}) {
  const regenerate = useChat((s) => s.regenerate);
  const stopAi = useChat((s) => s.stopAi);
  const generating = useChat((s) => !!s.myGenerations[m.id]);
  const [copied, setCopied] = useState(false);

  if (m.kind === "human") {
    return (
      <div className={`group flex gap-3 px-5 ${compact ? "pt-0.5" : "pt-3"}`}>
        <div className="w-8 shrink-0">{!compact && <Avatar userId={m.author_id} name={m.author_name} />}</div>
        <div className="min-w-0 flex-1">
          {!compact && (
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold" style={{ color: memberColor(m.author_id) }}>
                {m.author_name}
              </span>
              <span className="text-[11px] text-zinc-400">{time(m.created_at)}</span>
            </div>
          )}
          <div className="text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-200">
            <Markdown text={m.content} />
          </div>
          {!m.ai_requested && (
            <span className="mt-0.5 inline-block text-[11px] text-zinc-400">humans only · no AI reply</span>
          )}
        </div>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const streaming = m.status === "streaming";
  return (
    <div className="group flex gap-3 px-5 pt-3">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white ring-2 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950"
        style={{ ["--tw-ring-color" as string]: memberColor(m.author_id) }}
      >
        <Icon name="sparkle" size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
          <span className="font-semibold">AI</span>
          <span className="text-zinc-400">·</span>
          <span className="text-zinc-500">
            via{" "}
            <span className="font-medium" style={{ color: memberColor(m.author_id) }}>
              {m.author_name}
            </span>
          </span>
          {m.model && (
            <>
              <span className="text-zinc-400">·</span>
              <span className="font-mono text-xs text-zinc-500">{m.model}</span>
            </>
          )}
          <span className="ml-1 text-[11px] text-zinc-400">{time(m.created_at)}</span>
        </div>
        {showAnchor && anchor && (
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            ↪ answering <span style={{ color: memberColor(anchor.author_id) }}>{anchor.author_name}</span>: “{snippet(anchor.content)}”
          </div>
        )}
        <div className="mt-1 rounded-xl rounded-tl-sm border border-zinc-200 bg-white px-3.5 py-2.5 text-[15px] leading-relaxed shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {m.content ? (
            <Markdown text={m.content} />
          ) : streaming ? (
            <span className="text-sm text-zinc-400">Thinking…</span>
          ) : null}
          {streaming && m.content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-indigo-500 align-middle" />}
          {m.status === "error" && (
            <div className="mt-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
              Reply failed: {m.error || "unknown error"}
            </div>
          )}
          {m.status === "interrupted" && (
            <div className="mt-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Interrupted — {m.author_name} disconnected before the reply finished.
            </div>
          )}
        </div>
        <div className="mt-1 flex h-6 gap-1 text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100">
          {mine && generating && (
            <button onClick={() => stopAi(m.id)} className="flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <Icon name="stop" size={12} /> Stop
            </button>
          )}
          {!streaming && m.content && (
            <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <Icon name="copy" size={12} /> {copied ? "Copied" : "Copy"}
            </button>
          )}
          {!streaming && myProfileId && anchor && (
            <button
              onClick={() => regenerate(m, myProfileId)}
              className="flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <Icon name="refresh" size={12} /> Regenerate with my profile
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function MessageList({ room, myProfileId }: { room: RoomInfo; myProfileId: string | null }) {
  const messages = useChat((s) => s.messages[room.id]);
  const loaded = useChat((s) => !!s.loaded[room.id]);
  const myId = useChat((s) => s.client!.user_id);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const byId = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);

  useLayoutEffect(() => {
    stick.current = true;
  }, [room.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, room.id]);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const list = messages ?? [];
  return (
    <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto pb-4">
      {!loaded && list.length === 0 && <div className="p-8 text-center text-sm text-zinc-400">Loading history…</div>}
      {loaded && list.length === 0 && (
        <div className="mx-auto mt-16 max-w-sm text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
            <Icon name="sparkle" />
          </div>
          <h3 className="font-semibold">Say hi to #{room.name}</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Every message you send gets an AI reply generated with <em>your</em> profile. Share the invite code{" "}
            <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">{room.invite_code}</code> so others can bring theirs.
          </p>
        </div>
      )}
      {list.map((m, i) => {
        const prev = list[i - 1];
        const compact =
          m.kind === "human" &&
          prev?.kind === "human" &&
          prev.author_id === m.author_id &&
          m.created_at - prev.created_at < 5 * 60_000;
        const anchor = m.anchor_id ? byId.get(m.anchor_id) : undefined;
        return (
          <MessageItem
            key={m.id}
            m={m}
            anchor={anchor}
            showAnchor={!!anchor && prev?.id !== anchor.id}
            compact={compact}
            myProfileId={myProfileId}
            mine={m.author_id === myId}
          />
        );
      })}
    </div>
  );
}

function Composer({ room, profileId, onNeedProfile }: { room: RoomInfo; profileId: string | null; onNeedProfile: () => void }) {
  const profiles = useChat((s) => s.client!.profiles);
  const status = useChat((s) => s.status);
  const sendMessage = useChat((s) => s.sendMessage);
  const chooseProfile = useChat((s) => s.chooseProfile);
  const [text, setText] = useState("");
  const [aiOn, setAiOn] = useState(true);
  const ta = useRef<HTMLTextAreaElement>(null);
  const ai = aiOn && !!profileId;

  useEffect(() => {
    ta.current?.focus();
  }, [room.id]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  const send = () => {
    if (!text.trim() || status !== "online") return;
    if (sendMessage(room.id, text, ai, ai ? profileId : null)) setText("");
  };

  return (
    <div className="border-t border-zinc-200 px-4 pt-3 pb-4 dark:border-zinc-800">
      <div className="rounded-2xl border border-zinc-300 bg-white shadow-sm transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={ai ? `Message #${room.name} — AI replies with your profile` : `Message #${room.name} — humans only`}
          className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] outline-none placeholder:text-zinc-400"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <button
            onClick={() => (profiles.length ? setAiOn((v) => !v) : onNeedProfile())}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              ai
                ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
                : "border-zinc-300 text-zinc-500 dark:border-zinc-700"
            }`}
            title="Toggle whether this message gets an AI reply"
          >
            <Icon name="sparkle" size={13} />
            {ai ? "AI reply on" : "AI off"}
          </button>
          {profiles.length > 0 ? (
            <select
              value={profileId ?? ""}
              onChange={(e) => chooseProfile(room.id, e.target.value)}
              disabled={!aiOn}
              className="max-w-56 truncate rounded-full border border-zinc-300 bg-transparent px-2.5 py-1 text-xs outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
              title="Which of your profiles answers your next message"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.model}
                </option>
              ))}
            </select>
          ) : (
            <button onClick={onNeedProfile} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">
              Add an AI profile to get replies
            </button>
          )}
          <div className="flex-1" />
          <span className="hidden text-[11px] text-zinc-400 sm:inline">Shift+Enter for newline</span>
          <button
            onClick={send}
            disabled={!text.trim() || status !== "online"}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700"
            aria-label="Send"
          >
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MemberList({ room }: { room: RoomInfo }) {
  const myId = useChat((s) => s.client!.user_id);
  const members = [...room.members].sort((a, b) => Number(b.online) - Number(a.online) || a.display_name.localeCompare(b.display_name));
  const online = members.filter((m) => m.online).length;
  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-l border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
        Members — {online}/{members.length} online
      </div>
      {members.map((m) => (
        <div key={m.user_id} className={`flex items-center gap-2 rounded-lg px-1 py-1 ${m.online ? "" : "opacity-50"}`}>
          <div className="relative">
            <Avatar userId={m.user_id} name={m.display_name} size={26} />
            <span
              className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-zinc-950 ${
                m.online ? "bg-emerald-500" : "bg-zinc-400"
              }`}
            />
          </div>
          <span className="truncate text-sm" style={{ color: memberColor(m.user_id) }}>
            {m.display_name}
          </span>
          {m.user_id === myId && <span className="text-[11px] text-zinc-400">you</span>}
        </div>
      ))}
    </aside>
  );
}

function RoomPromptDialog({ room, onClose }: { room: RoomInfo; onClose: () => void }) {
  const setRoomPrompt = useChat((s) => s.setRoomPrompt);
  const [text, setText] = useState(room.system_prompt);
  return (
    <Modal title="Room instructions" onClose={onClose}>
      <p className="mb-3 text-sm text-zinc-500">
        Shared with everyone in #{room.name} and appended to the AI's system prompt, whichever member's model is answering. Any member can edit it.
      </p>
      <textarea
        autoFocus
        value={text}
        maxLength={8000}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        placeholder="e.g. We're designing a logo. Keep answers short and suggest SVG when useful."
        className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            setRoomPrompt(room.id, text);
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

export function RoomView({ room, onNeedProfile }: { room: RoomInfo; onNeedProfile: () => void }) {
  const client = useChat((s) => s.client!);
  const leaveRoom = useChat((s) => s.leaveRoom);
  const [showMembers, setShowMembers] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const remembered = client.last_profile_by_room[room.id];
  const profileId = client.profiles.some((p) => p.id === remembered) ? remembered : (client.profiles[0]?.id ?? null);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.invite_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-5 py-2.5 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold"># {room.name}</h1>
            <p className="truncate text-xs text-zinc-500">
              {room.system_prompt ? `Room instructions: ${snippet(room.system_prompt, 90)}` : "No room instructions"}
            </p>
          </div>
          <button
            onClick={copyCode}
            className="rounded-lg border border-dashed border-zinc-300 px-2.5 py-1 font-mono text-xs tracking-widest hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            title="Copy invite code"
          >
            {copied ? "COPIED" : room.invite_code}
          </button>
          <Button variant="ghost" className="!px-2" onClick={() => setPromptOpen(true)} title="Room instructions">
            <Icon name="note" size={17} />
          </Button>
          <Button variant="ghost" className="!px-2" onClick={() => setShowMembers((v) => !v)} title="Members">
            <Icon name="users" size={17} />
          </Button>
          <Button
            variant="ghost"
            className="!px-2"
            title="Leave room"
            onClick={() => window.confirm(`Leave #${room.name}?`) && leaveRoom(room.id)}
          >
            <Icon name="door" size={17} />
          </Button>
        </header>
        <MessageList room={room} myProfileId={profileId} />
        <Composer room={room} profileId={profileId} onNeedProfile={onNeedProfile} />
      </div>
      {showMembers && <MemberList room={room} />}
      {promptOpen && <RoomPromptDialog room={room} onClose={() => setPromptOpen(false)} />}
    </div>
  );
}
