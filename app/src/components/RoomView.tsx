import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { memberColor } from "../lib/colors";
import { useWidth } from "../lib/useWidth";
import type { McpMode, Message, RoomInfo, ToolActivity } from "../lib/types";
import { useChat, type LocalTool } from "../store";
import { Markdown } from "./Markdown";
import { MODE_OPTIONS, type SettingsTab } from "./Settings";
import { Avatar, Button, Icon, Logo, Modal, Segmented } from "./ui";

function time(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function snippet(text: string, n = 80) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  // Open while the model is still thinking; the user can toggle it after that.
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? live;
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, live]);
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!isOpen)}
        className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        <Icon name="chevron" size={13} className={`transition ${isOpen ? "rotate-90" : ""}`} />
        <Icon name="brain" size={13} />
        {live ? <span className="animate-pulse">Thinking…</span> : "Reasoning"}
      </button>
      {isOpen && (
        <div
          ref={box}
          className="mt-1.5 max-h-64 overflow-y-auto border-l-2 border-zinc-200 pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
        >
          {text}
        </div>
      )}
    </div>
  );
}

const TOOL_STATUS: Record<ToolActivity["status"], { label: string; cls: string }> = {
  awaiting_approval: { label: "waiting for approval", cls: "text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300" },
  running: { label: "running", cls: "text-indigo-700 bg-indigo-50 dark:bg-indigo-950/50 dark:text-indigo-300" },
  done: { label: "done", cls: "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300" },
  error: { label: "failed", cls: "text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300" },
  denied: { label: "declined", cls: "text-zinc-600 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400" },
};

function ToolCall({
  t,
  local,
  onAnswer,
}: {
  t: ToolActivity;
  local: LocalTool | undefined;
  onAnswer: (approved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const st = TOOL_STATUS[t.status];
  const waiting = t.status === "awaiting_approval" && !!local;
  const hasDetail = !!local && (!!local.args || !!local.detail);
  return (
    <div className={`rounded-lg text-xs ${waiting ? "border border-amber-300 p-2 dark:border-amber-800" : ""}`}>
      <button
        disabled={!hasDetail}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 ${st.cls} ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
        title={hasDetail ? "Show details (only you can see these)" : undefined}
      >
        {t.status === "running" ? (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <Icon name={t.status === "done" ? "check" : "wrench"} size={12} />
        )}
        <span className="truncate font-mono">
          {t.server} · {t.tool}
        </span>
        <span className="opacity-75">— {st.label}</span>
      </button>
      {waiting && (
        <div className="mt-2">
          <p className="mb-1 text-zinc-600 dark:text-zinc-400">The AI wants to run this tool on your computer with:</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-950">{local!.args || "{}"}</pre>
          <div className="mt-2 flex gap-2">
            <Button className="!px-3 !py-1 text-xs" onClick={() => onAnswer(true)}>
              Allow
            </Button>
            <Button variant="outline" className="!px-3 !py-1 text-xs" onClick={() => onAnswer(false)}>
              Deny
            </Button>
          </div>
        </div>
      )}
      {open && !waiting && local && (
        <div className="mt-1 space-y-1">
          {local.args && <pre className="max-h-40 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-950">{local.args}</pre>}
          {local.detail && (
            <pre className="max-h-40 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-[11px] whitespace-pre-wrap dark:bg-zinc-950">
              {local.detail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
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
  const answerToolCall = useChat((s) => s.answerToolCall);
  const generating = useChat((s) => !!s.myGenerations[m.id]);
  const localTools = useChat((s) => s.localTools[m.id]);
  const [copied, setCopied] = useState(false);

  if (m.kind === "human") {
    return (
      <div className={`group flex gap-3 px-4 sm:px-5 ${compact ? "pt-0.5" : "pt-3"}`}>
        <div className="w-8 shrink-0">{!compact && <Avatar userId={m.author_id} name={m.author_name} />}</div>
        <div className="min-w-0 flex-1">
          {!compact && (
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold" style={{ color: memberColor(m.author_id) }}>
                {m.author_name}
              </span>
              <span className="shrink-0 text-[11px] text-zinc-400">{time(m.created_at)}</span>
            </div>
          )}
          <div className="text-[15px] leading-relaxed break-words text-zinc-800 dark:text-zinc-200">
            <Markdown text={m.content} />
          </div>
          {!m.ai_requested && <span className="mt-0.5 inline-block text-[11px] text-zinc-400">humans only · no AI reply</span>}
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
  const waitingOnTools = m.tools.some((t) => t.status === "awaiting_approval" || t.status === "running");
  return (
    <div className="group flex gap-3 px-4 pt-3 sm:px-5">
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
              <span className="max-w-full truncate font-mono text-xs text-zinc-500">{m.model}</span>
            </>
          )}
          <span className="ml-1 text-[11px] text-zinc-400">{time(m.created_at)}</span>
        </div>
        {showAnchor && anchor && (
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            ↪ answering <span style={{ color: memberColor(anchor.author_id) }}>{anchor.author_name}</span>: “{snippet(anchor.content)}”
          </div>
        )}
        <div className="mt-1 rounded-xl rounded-tl-sm border border-zinc-200 bg-white px-3.5 py-2.5 text-[15px] leading-relaxed break-words shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {m.reasoning && <Reasoning text={m.reasoning} live={streaming && !m.content && !waitingOnTools} />}
          {m.tools.length > 0 && (
            <div className="mb-2 flex flex-col items-start gap-1.5">
              {m.tools.map((t) => (
                <ToolCall
                  key={t.call_id}
                  t={t}
                  local={mine ? localTools?.[t.call_id] : undefined}
                  onAnswer={(ok) => answerToolCall(m.id, t.call_id, ok)}
                />
              ))}
            </div>
          )}
          {m.content ? (
            <Markdown text={m.content} />
          ) : streaming && !m.reasoning && m.tools.length === 0 ? (
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
        <div className="mt-1 flex h-6 flex-wrap gap-1 text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
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

  // Keep the newest message in view when the window is resized.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const list = messages ?? [];
  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pb-4">
      <div className="mx-auto max-w-4xl">
        {!loaded && list.length === 0 && <div className="p-8 text-center text-sm text-zinc-400">Loading history…</div>}
        {loaded && list.length === 0 && (
          <div className="mx-auto mt-16 max-w-sm px-6 text-center">
            <Logo size={48} className="mx-auto mb-3" />
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
            m.kind === "human" && prev?.kind === "human" && prev.author_id === m.author_id && m.created_at - prev.created_at < 5 * 60_000;
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
    </div>
  );
}

/** Per-chat MCP switches: Off / Ask / Auto for each server the user added. */
function ToolsMenu({ room, onOpenSettings }: { room: RoomInfo; onOpenSettings: (tab: SettingsTab) => void }) {
  const servers = useChat((s) => s.client!.mcp_servers);
  const modes = useChat((s) => s.client!.mcp_modes_by_room[room.id]);
  const setRoomMcpMode = useChat((s) => s.setRoomMcpMode);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const modeOf = (id: string, fallback: McpMode): McpMode => modes?.[id] ?? fallback;
  const active = servers.filter((s) => modeOf(s.id, s.default_mode) !== "off").length;

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
          active
            ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
            : "border-zinc-300 text-zinc-500 dark:border-zinc-700"
        }`}
        title="MCP tools for this chat"
      >
        <Icon name="wrench" size={13} />
        <span className="hidden min-[480px]:inline">Tools</span>
        {active > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] text-white">{active}</span>}
      </button>
      {open && (
        <div className="fixed inset-x-3 bottom-24 z-30 rounded-xl sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-2 sm:w-80 border border-zinc-200 bg-white p-3 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Tools in #{room.name}</span>
            <span className="text-[11px] text-zinc-500">for your replies</span>
          </div>
          {servers.length === 0 ? (
            <p className="py-2 text-sm text-zinc-500">No MCP servers yet. Add one to let the AI use tools.</p>
          ) : (
            <div className="space-y-2">
              {servers.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm" title={s.name}>
                    {s.name}
                  </span>
                  <Segmented
                    size="sm"
                    value={modeOf(s.id, s.default_mode)}
                    onChange={(mode) => setRoomMcpMode(room.id, s.id, mode)}
                    options={MODE_OPTIONS}
                  />
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-snug text-zinc-500">
            <b>Ask</b> shows you each tool call to approve. <b>Auto</b> runs them without asking. Others in the room only see which tool ran.
          </p>
          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings("mcp");
            }}
            className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Manage MCP servers…
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({
  room,
  profileId,
  onOpenSettings,
}: {
  room: RoomInfo;
  profileId: string | null;
  onOpenSettings: (tab: SettingsTab) => void;
}) {
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
    <div className="border-t border-zinc-200 px-3 pt-3 pb-3 sm:px-4 sm:pb-4 dark:border-zinc-800">
      <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-300 bg-white shadow-sm transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900">
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
          placeholder={ai ? `Message #${room.name}` : `Message #${room.name} — humans only`}
          className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] outline-none placeholder:text-zinc-400"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 sm:gap-2">
          <button
            onClick={() => (profiles.length ? setAiOn((v) => !v) : onOpenSettings("profiles"))}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              ai
                ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
                : "border-zinc-300 text-zinc-500 dark:border-zinc-700"
            }`}
            title="Toggle whether this message gets an AI reply"
          >
            <Icon name="sparkle" size={13} />
            <span className="hidden min-[480px]:inline">{ai ? "AI on" : "AI off"}</span>
          </button>
          {profiles.length > 0 ? (
            <select
              value={profileId ?? ""}
              onChange={(e) => chooseProfile(room.id, e.target.value)}
              disabled={!aiOn}
              className="min-w-0 flex-shrink truncate rounded-full border border-zinc-300 bg-transparent px-2.5 py-1 text-xs outline-none disabled:opacity-50 sm:max-w-64 dark:border-zinc-700 dark:bg-zinc-900"
              title="Which of your profiles answers your next message"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.model}
                </option>
              ))}
            </select>
          ) : (
            <button onClick={() => onOpenSettings("profiles")} className="truncate text-xs text-indigo-600 hover:underline dark:text-indigo-400">
              Add an AI profile
            </button>
          )}
          <ToolsMenu room={room} onOpenSettings={onOpenSettings} />
          <div className="flex-1" />
          <span className="hidden text-[11px] text-zinc-400 lg:inline">Shift+Enter for newline</span>
          <button
            onClick={send}
            disabled={!text.trim() || status !== "online"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700"
            aria-label="Send"
          >
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MemberList({ room, overlay, onClose }: { room: RoomInfo; overlay: boolean; onClose: () => void }) {
  const myId = useChat((s) => s.client!.user_id);
  const members = [...room.members].sort((a, b) => Number(b.online) - Number(a.online) || a.display_name.localeCompare(b.display_name));
  const online = members.filter((m) => m.online).length;
  const panel = (
    <aside
      className={`flex w-60 shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950 ${
        overlay ? "h-full shadow-2xl" : ""
      }`}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
          Members — {online}/{members.length} online
        </span>
        {overlay && (
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close members">
            <Icon name="x" size={14} />
          </button>
        )}
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
  if (!overlay) return panel;
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()}>{panel}</div>
    </div>
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

/** Below this width the member list becomes a slide-over instead of a column. */
const MEMBERS_INLINE_MIN = 1100;

export function RoomView({
  room,
  onOpenSettings,
  onOpenNav,
}: {
  room: RoomInfo;
  onOpenSettings: (tab: SettingsTab) => void;
  /** Set when the sidebar is collapsed into a drawer. */
  onOpenNav?: () => void;
}) {
  const client = useChat((s) => s.client!);
  const leaveRoom = useChat((s) => s.leaveRoom);
  const width = useWidth();
  const inlineMembers = width >= MEMBERS_INLINE_MIN;
  const [membersPref, setMembersPref] = useState(true);
  const [membersOverlay, setMembersOverlay] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const remembered = client.last_profile_by_room[room.id];
  const profileId = client.profiles.some((p) => p.id === remembered) ? remembered : (client.profiles[0]?.id ?? null);
  const online = room.members.filter((m) => m.online).length;

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
        <header className="flex items-center gap-1 border-b border-zinc-200 px-2 py-2 sm:gap-2 sm:px-4 dark:border-zinc-800">
          {onOpenNav && (
            <button onClick={onOpenNav} className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800" aria-label="Rooms">
              <Icon name="menu" />
            </button>
          )}
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate font-semibold"># {room.name}</h1>
            <p className="truncate text-xs text-zinc-500">
              {room.system_prompt ? `Room instructions: ${snippet(room.system_prompt, 90)}` : "No room instructions"}
            </p>
          </div>
          <button
            onClick={copyCode}
            className="hidden shrink-0 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1 font-mono text-xs tracking-widest hover:bg-zinc-100 min-[560px]:block dark:border-zinc-700 dark:hover:bg-zinc-800"
            title="Copy invite code"
          >
            {copied ? "COPIED" : room.invite_code}
          </button>
          <Button variant="ghost" className="!px-2" onClick={() => setPromptOpen(true)} title="Room instructions">
            <Icon name="note" size={17} />
          </Button>
          <Button
            variant="ghost"
            className="!px-2"
            onClick={() => (inlineMembers ? setMembersPref((v) => !v) : setMembersOverlay(true))}
            title="Members"
          >
            <Icon name="users" size={17} />
            {!inlineMembers && <span className="text-xs">{online}</span>}
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
        <Composer room={room} profileId={profileId} onOpenSettings={onOpenSettings} />
      </div>
      {inlineMembers && membersPref && <MemberList room={room} overlay={false} onClose={() => setMembersPref(false)} />}
      {!inlineMembers && membersOverlay && <MemberList room={room} overlay onClose={() => setMembersOverlay(false)} />}
      {promptOpen && <RoomPromptDialog room={room} onClose={() => setPromptOpen(false)} />}
    </div>
  );
}
