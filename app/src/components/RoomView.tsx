import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { memberColor } from "../lib/colors";
import { useWidth } from "../lib/useWidth";
import { remoteProfileId } from "../store";
import type { Attachment, McpMode, Member, Message, RoomInfo, SearchHit, ToolActivity } from "../lib/types";
import { useChat, type LocalTool } from "../store";
import { confirmAction } from "./Confirm";
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

const PREVIEW_MAX = 360;

/** Smallest clickable preview side; the image inside still keeps its proportions. */
const PREVIEW_MIN = 24;

/**
 * Explicit preview box size: the image scaled to fit within PREVIEW_MAX px on both
 * sides. Height is never derived from the clamped width, so extreme portrait ratios
 * (e.g. 1x8192) can't produce a huge box.
 */
function previewSize(a: Attachment): { width: number; height: number } {
  if (!a.width || !a.height) return { width: PREVIEW_MAX, height: (PREVIEW_MAX * 3) / 4 };
  const scale = Math.min(1, PREVIEW_MAX / a.width, PREVIEW_MAX / a.height);
  return {
    width: Math.max(PREVIEW_MIN, Math.round(a.width * scale)),
    height: Math.max(PREVIEW_MIN, Math.round(a.height * scale)),
  };
}

/** An image a tool produced, fetched from the relay on first view. */
function AttachmentImage({ a, onOpen }: { a: Attachment; onOpen: (src: string) => void }) {
  const src = useChat((s) => s.images[a.attachment_id]);
  const loadImage = useChat((s) => s.loadImage);
  useEffect(() => {
    if (src === undefined) loadImage(a.attachment_id);
  }, [src, a.attachment_id, loadImage]);
  return (
    <button
      onClick={() => src && onOpen(src)}
      className="block max-w-full overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800"
      style={previewSize(a)}
      title="Open full size"
    >
      {src ? (
        <img src={src} alt="Generated by a tool" className="h-full w-full object-contain" />
      ) : (
        <span className="flex h-full w-full animate-pulse items-center justify-center text-xs text-zinc-400">Loading image…</span>
      )}
    </button>
  );
}

function Gallery({ attachments }: { attachments: Attachment[] }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {attachments.map((a) => (
          <AttachmentImage key={a.attachment_id} a={a} onOpen={setOpen} />
        ))}
      </div>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setOpen(null)}>
          <img src={open} alt="Generated by a tool, full size" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </>
  );
}

/** Quick palette shared by the desktop popover and the phone's long-press sheet. */
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];

/** Emoji pills under a message body: emoji + count, highlighted while yours is in it. */
function ReactionChips({ m, members }: { m: Message; members: Member[] }) {
  const react = useChat((s) => s.react);
  const myId = useChat((s) => s.client!.user_id);
  if (m.reactions.length === 0) return null;
  const nameOf = (id: string) => members.find((x) => x.user_id === id)?.display_name || "Someone";
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {m.reactions.map((r) => {
        const mine = r.user_ids.includes(myId);
        const who = r.user_ids.map(nameOf).join(", ");
        return (
          <button
            key={r.emoji}
            onClick={() => react(m.room_id, m.id, r.emoji, !mine)}
            title={`${r.emoji} — ${who}`}
            aria-label={`${r.emoji} reaction from ${who}. Click to ${mine ? "remove it" : "add it"}.`}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-none transition active:scale-95 ${
              mine
                ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/60 dark:text-indigo-300"
                : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            }`}
          >
            <span className="text-sm leading-none">{r.emoji}</span>
            <span className="font-medium tabular-nums">{r.user_ids.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Desktop hover action: opens the quick palette right above the button. `align` is the
 *  side the palette lines up with, so it stays on screen near the right edge. */
function ReactButton({ m, align = "left" }: { m: Message; align?: "left" | "right" }) {
  const react = useChat((s) => s.react);
  const myId = useChat((s) => s.client!.user_id);
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

  const mine = (emoji: string) => m.reactions.some((r) => r.emoji === emoji && r.user_ids.includes(myId));
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <Icon name="smile" size={12} /> React
      </button>
      {open && (
        <div className={`absolute bottom-full ${align === "right" ? "right-0" : "left-0"} z-20 mb-1.5 flex gap-0.5 rounded-full border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900`}>
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                react(m.room_id, m.id, emoji, !mine(emoji));
                setOpen(false);
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                mine(emoji) ? "bg-indigo-50 dark:bg-indigo-950/60" : ""
              }`}
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The composer's editing/replying target: which message, and its text at pickup time. */
export interface Draft {
  mode: "edit" | "reply";
  room_id: string;
  id: string;
  /** Edit: the message's current text when editing started. */
  content: string;
}

/** Phones: the long-press sheet — the palette as large buttons, plus Copy text,
 *  Reply, and Edit/Delete on your own messages. */
function ReactionSheet({
  m,
  mine,
  onReply,
  onEdit,
  onClose,
}: {
  m: Message;
  /** author_id is this user (edit/delete only apply to your own messages). */
  mine: boolean;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onClose: () => void;
}) {
  const react = useChat((s) => s.react);
  const deleteMessage = useChat((s) => s.deleteMessage);
  const myId = useChat((s) => s.client!.user_id);
  const toast = useChat((s) => s.toast);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      window.setTimeout(onClose, 800);
    } catch {
      toast("Couldn't copy the text");
    }
  };
  const del = async () => {
    onClose();
    if (await confirmAction("Delete message?", "Everyone in the room will see it was deleted.", "Delete")) {
      deleteMessage(m.room_id, m.id);
    }
  };
  const mineEmoji = (emoji: string) => m.reactions.some((r) => r.emoji === emoji && r.user_ids.includes(myId));
  const row = "flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] active:bg-zinc-100 dark:active:bg-zinc-800";
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="animate-[sheet-up_180ms_ease-out] rounded-t-3xl bg-white pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <div className="grid grid-cols-8 px-2 pb-1">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                react(m.room_id, m.id, emoji, !mineEmoji(emoji));
                onClose();
              }}
              className={`mx-auto flex h-11 w-11 items-center justify-center rounded-full text-2xl leading-none transition active:bg-zinc-100 dark:active:bg-zinc-800 ${
                mineEmoji(emoji) ? "bg-indigo-50 dark:bg-indigo-950/60" : ""
              }`}
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
        {m.content && (
          <button onClick={copy} className={row}>
            <Icon name="copy" size={18} className="text-zinc-500" />
            <span className="flex-1">{copied ? "Copied" : "Copy text"}</span>
          </button>
        )}
        <button
          onClick={() => {
            onReply(m);
            onClose();
          }}
          className={row}
        >
          <Icon name="reply" size={18} className="text-zinc-500" />
          <span className="flex-1">Reply</span>
        </button>
        {mine && m.kind === "human" && (
          <button
            onClick={() => {
              onEdit(m);
              onClose();
            }}
            className={row}
          >
            <Icon name="pencil" size={18} className="text-zinc-500" />
            <span className="flex-1">Edit</span>
          </button>
        )}
        {mine && (
          <button onClick={del} className={`${row} text-red-600 dark:text-red-400`}>
            <Icon name="trash" size={18} />
            <span className="flex-1">Delete</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Long-press (500 ms) that opens the phone's reaction sheet. A finger moved over
 *  10 px cancels, so scrolling and the swipe-back gesture keep working. */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Set once the press fired, so lifting the finger isn't also taken as a tap. */
  const fired = useRef(false);
  const [pressing, setPressing] = useState(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
    setPressing(false);
  };
  return {
    /** True while a finger rests on the bubble: suppress text selection and the
     *  native callout menu for that time (only on the bubble). */
    pressing,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY };
        fired.current = false;
        setPressing(true);
        timer.current = window.setTimeout(() => {
          cancel();
          fired.current = true;
          onLongPress();
        }, 500);
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!start.current) return;
        const t = e.touches[0];
        if (Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) cancel();
      },
      onTouchEnd: (e: React.TouchEvent) => {
        // The lift would otherwise click whatever is now under the finger: the
        // sheet's backdrop, which closes it again.
        if (fired.current) e.preventDefault();
        cancel();
      },
      onTouchCancel: cancel,
    },
  };
}

/** The small "↪ name: snippet" line above a reply. Clicking it jumps to the original
 *  and flashes it; a deleted or unloaded original says so and isn't clickable. */
function ReplyQuote({
  orig,
  onJump,
}: {
  /** The original message, when it's loaded in the room. */
  orig: Message | undefined;
  onJump: (id: string) => void;
}) {
  if (orig?.deleted) return <div className="mb-1 max-w-full truncate px-1 text-xs text-zinc-400 dark:text-zinc-500">↪ Message deleted</div>;
  if (!orig)
    return <div className="mb-1 max-w-full truncate px-1 text-xs text-zinc-400 dark:text-zinc-500">↪ Earlier message</div>;
  return (
    <button
      onClick={() => onJump(orig.id)}
      className="mb-1 max-w-full truncate px-1 text-left text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      title="Jump to the message"
    >
      ↪ <span style={{ color: memberColor(orig.author_id) }}>{orig.author_name}</span>: {snippet(orig.content, 80)}
    </button>
  );
}

const MessageItem = memo(function MessageItem({
  m,
  anchor,
  showAnchor,
  compact,
  myProfileId,
  mine,
  bubbles,
  members,
  onEdit,
  onReply,
  onJump,
  replyOriginal,
}: {
  m: Message;
  anchor: Message | undefined;
  /** The message `reply_to` points at, when it's loaded (stable ref from MessageList). */
  replyOriginal: Message | undefined;
  showAnchor: boolean;
  compact: boolean;
  myProfileId: string | null;
  mine: boolean;
  /** Phone layout: chat bubbles, yours on the right. */
  bubbles: boolean;
  /** Room members, to name who reacted (stable reference from MessageList). */
  members: Member[];
  /** Start editing this message in the composer (own human messages). */
  onEdit: (m: Message) => void;
  /** Start a reply to this message in the composer (any message). */
  onReply: (m: Message) => void;
  /** Scroll a reply's quote to the message it answers. */
  onJump: (id: string) => void;
}) {
  const regenerate = useChat((s) => s.regenerate);
  const stopAi = useChat((s) => s.stopAi);
  const deleteMessage = useChat((s) => s.deleteMessage);
  const answerToolCall = useChat((s) => s.answerToolCall);
  const generating = useChat((s) => !!s.myGenerations[m.id]);
  const localTools = useChat((s) => s.localTools[m.id]);
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState(false);
  const longPress = useLongPress(() => setSheet(true));

  const del = async () => {
    if (await confirmAction("Delete message?", "Everyone in the room will see it was deleted.", "Delete")) {
      deleteMessage(m.room_id, m.id);
    }
  };

  if (m.deleted) {
    return (
      <div
        data-message-id={m.id}
        className={`flex gap-2 px-3 ${compact ? "pt-0.5" : "pt-3"} ${m.kind === "human" && bubbles && mine ? "justify-end" : ""}`}
      >
        {m.kind === "ai" && bubbles && (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
            <Icon name="sparkle" size={14} />
          </div>
        )}
        <div className="max-w-[80%] px-1 py-0.5 text-[14px] leading-snug text-zinc-400 italic dark:text-zinc-500">
          Message deleted
        </div>
      </div>
    );
  }

  if (m.kind === "human" && bubbles) {
    return (
      <div data-message-id={m.id} className={`flex gap-2 px-3 ${mine ? "justify-end" : ""} ${compact ? "pt-0.5" : "pt-3"}`}>
        {!mine && <div className="w-7 shrink-0">{!compact && <Avatar userId={m.author_id} name={m.author_name} size={28} />}</div>}
        <div className={`flex min-w-0 max-w-[80%] flex-col ${mine ? "items-end" : "items-start"}`}>
          {!compact && (
            <div className="mb-0.5 flex items-baseline gap-1.5 px-1 text-xs">
              {!mine && (
                <span className="truncate font-medium" style={{ color: memberColor(m.author_id) }}>
                  {m.author_name}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-zinc-400">{time(m.created_at)}</span>
            </div>
          )}
          {m.reply_to && <ReplyQuote orig={replyOriginal} onJump={onJump} />}
          <div
            {...longPress.handlers}
            className={`rounded-[20px] px-3.5 py-2 text-[16px] leading-snug break-words ${
              longPress.pressing ? "select-none [-webkit-touch-callout:none]" : ""
            } ${
              mine
                ? "md-on-accent rounded-br-md bg-indigo-600 text-white"
                : "rounded-bl-md bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
            }`}
          >
            <Markdown text={m.content} />
          </div>
          <ReactionChips m={m} members={members} />
          {/* "no AI reply" only on your own: on everyone else's it would repeat under every message. */}
          {(m.edited_at || (mine && !m.ai_requested)) && (
            <span className="mt-0.5 px-1 text-[11px] text-zinc-400">
              {[m.edited_at && "edited", mine && !m.ai_requested && "no AI reply"].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        {sheet && (
          <ReactionSheet m={m} mine={mine} onReply={onReply} onEdit={onEdit} onClose={() => setSheet(false)} />
        )}
      </div>
    );
  }

  if (m.kind === "human") {
    return (
      <div data-message-id={m.id} className={`group relative flex gap-3 px-4 sm:px-5 ${compact ? "pt-0.5" : "pt-3"}`}>
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
          {m.reply_to && <ReplyQuote orig={replyOriginal} onJump={onJump} />}
          <div
            {...longPress.handlers}
            className={`text-[15px] leading-relaxed break-words text-zinc-800 dark:text-zinc-200 ${
              longPress.pressing ? "select-none [-webkit-touch-callout:none]" : ""
            }`}
          >
            <Markdown text={m.content} />
          </div>
          <ReactionChips m={m} members={members} />
          {(m.edited_at || !m.ai_requested) && (
            <span className="mt-0.5 inline-block text-[11px] text-zinc-400">
              {[m.edited_at && "(edited)", !m.ai_requested && "humans only · no AI reply"].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        {/* Floats over the message's top edge on hover, so it adds no height to the chat.
            Touch screens long-press instead. */}
        <div className="pointer-events-none absolute -top-3 right-4 flex rounded-md border border-zinc-200 bg-white p-0.5 text-xs text-zinc-500 opacity-0 shadow-sm transition group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 sm:right-5 dark:border-zinc-700 dark:bg-zinc-900 [@media(hover:none)]:!hidden">
          <ReactButton m={m} align="right" />
          <button onClick={() => onReply(m)} className="flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Icon name="reply" size={12} /> Reply
          </button>
          {mine && (
            <>
              <button onClick={() => onEdit(m)} className="flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Icon name="pencil" size={12} /> Edit
              </button>
              <button onClick={del} className="flex items-center gap-1 rounded px-1.5 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50">
                <Icon name="trash" size={12} /> Delete
              </button>
            </>
          )}
        </div>
        {sheet && (
          <ReactionSheet m={m} mine={mine} onReply={onReply} onEdit={onEdit} onClose={() => setSheet(false)} />
        )}
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

  const body = (
    <>
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
      {m.attachments.length > 0 && <Gallery attachments={m.attachments} />}
      {m.content ? (
        <Markdown text={m.content} />
      ) : streaming && !m.reasoning && m.tools.length === 0 && m.attachments.length === 0 ? (
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
    </>
  );

  const actionCls = bubbles
    ? "flex h-8 items-center gap-1 rounded-full px-2 text-[11px] active:bg-zinc-100 dark:active:bg-zinc-800"
    : "flex items-center gap-1 rounded px-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800";
  const actions = (
    <>
      {mine && generating && (
        <button onClick={() => stopAi(m.id)} className={actionCls}>
          <Icon name="stop" size={12} /> Stop
        </button>
      )}
      {!streaming && m.content && (
        <button onClick={copy} className={actionCls}>
          <Icon name="copy" size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      )}
      {!bubbles && <ReactButton m={m} />}
      {!bubbles && !streaming && (
        <button onClick={() => onReply(m)} className={actionCls}>
          <Icon name="reply" size={12} /> Reply
        </button>
      )}
      {mine && !streaming && (
        <button onClick={del} className={actionCls}>
          <Icon name="trash" size={12} /> Delete
        </button>
      )}
      {!streaming && myProfileId && anchor && !anchor.deleted && (
        <button onClick={() => regenerate(m, myProfileId)} className={actionCls}>
          <Icon name="refresh" size={12} /> {bubbles || myProfileId.startsWith("remote:") ? "Regenerate" : "Regenerate with my profile"}
        </button>
      )}
    </>
  );

  if (bubbles) {
    return (
      <div data-message-id={m.id} className="flex gap-2 px-3 pt-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
          <Icon name="sparkle" size={14} />
        </div>
        <div className="flex min-w-0 max-w-[88%] flex-col items-start">
          <div className="mb-0.5 flex max-w-full items-baseline gap-1 px-1 text-xs text-zinc-500">
            <span className="shrink-0 font-semibold text-zinc-700 dark:text-zinc-300">AI</span>
            <span className="shrink-0">for</span>
            <span className="truncate font-medium" style={{ color: memberColor(m.author_id) }}>
              {m.author_name}
            </span>
            <span className="ml-1 shrink-0 text-[11px] text-zinc-400">{time(m.created_at)}</span>
          </div>
          {showAnchor && anchor && (
            <div className="mb-1 max-w-full truncate px-1 text-xs text-zinc-500">
              ↪ <span style={{ color: memberColor(anchor.author_id) }}>{anchor.author_name}</span>:{" "}
              {anchor.deleted ? <i>message deleted</i> : `“${snippet(anchor.content, 50)}”`}
            </div>
          )}
          {m.reply_to && <ReplyQuote orig={replyOriginal} onJump={onJump} />}
          <div
            {...longPress.handlers}
            className={`max-w-full rounded-[20px] rounded-bl-md bg-indigo-50 px-3.5 py-2 text-[16px] leading-snug break-words text-zinc-900 dark:bg-indigo-950/60 dark:text-zinc-100 ${
              longPress.pressing ? "select-none [-webkit-touch-callout:none]" : ""
            }`}
          >
            {body}
          </div>
          <ReactionChips m={m} members={members} />
          <div className="mt-0.5 flex flex-wrap text-xs text-zinc-500">{actions}</div>
          {sheet && (
            <ReactionSheet m={m} mine={mine && !streaming} onReply={onReply} onEdit={onEdit} onClose={() => setSheet(false)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-message-id={m.id} className="group flex gap-3 px-4 pt-3 sm:px-5">
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
            ↪ answering <span style={{ color: memberColor(anchor.author_id) }}>{anchor.author_name}</span>:{" "}
            {anchor.deleted ? <i>message deleted</i> : `“${snippet(anchor.content)}”`}
          </div>
        )}
        {m.reply_to && (
          <div className="mt-0.5">
            <ReplyQuote orig={replyOriginal} onJump={onJump} />
          </div>
        )}
        <div className="mt-1 rounded-xl rounded-tl-sm border border-zinc-200 bg-white px-3.5 py-2.5 text-[15px] leading-relaxed break-words shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {body}
        </div>
        <ReactionChips m={m} members={members} />
        <div className="mt-1 flex h-6 flex-wrap gap-1 text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100">
          {actions}
        </div>
      </div>
    </div>
  );
});

function MessageList({
  room,
  myProfileId,
  bubbles,
  onEdit,
  onReply,
}: {
  room: RoomInfo;
  myProfileId: string | null;
  bubbles: boolean;
  onEdit: (m: Message) => void;
  onReply: (m: Message) => void;
}) {
  const messages = useChat((s) => s.messages[room.id]);
  const loaded = useChat((s) => !!s.loaded[room.id]);
  const hasMore = useChat((s) => !!s.hasMore[room.id]);
  const loadingOlder = useChat((s) => !!s.loadingOlder[room.id]);
  const loadOlder = useChat((s) => s.loadOlder);
  const clearJump = useChat((s) => s.clearJump);
  const myId = useChat((s) => s.client!.user_id);
  // Stable reference: MessageItem is memo'd, so it must not see a new array each render.
  const members = useMemo(() => room.members, [room.members]);
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** Distance from the bottom of the list, kept when the list is resized (window, or an
   *  on-screen keyboard opening) so the same messages stay in view. */
  const fromBottom = useRef(0);
  /** Until when a jump's smooth scroll is running (onScroll leaves `stick` alone). */
  const jumpingUntil = useRef(0);
  /** The first message's id as of the last render. A change (with the same room) means
   *  older messages were prepended, not that the list grew at the bottom. */
  const firstId = useRef<string | null>(null);
  const byId = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);
  const list = messages ?? [];

  useLayoutEffect(() => {
    stick.current = true;
    fromBottom.current = 0;
  }, [room.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = list[0]?.id ?? null;
    if (!stick.current && firstId.current !== null && firstId.current !== first) {
      // Older messages were prepended: keep what the user is reading in place by
      // restoring the distance from the bottom saved before the change (the raw
      // scrollTop would land on the new rows instead). This isn't new content at the
      // bottom, so the stick flag is left alone.
      el.scrollTop = el.scrollHeight - el.clientHeight - fromBottom.current;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    firstId.current = first;
  }, [messages, room.id]);

  // On resize (window, or the keyboard opening), keep the newest message in view, or
  // wherever the user had scrolled to, measured from the bottom. Content that grows
  // after rendering (highlighted code, images) is watched too, so a room opened at its
  // newest message stays there.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      el.scrollTop = stick.current ? el.scrollHeight : el.scrollHeight - el.clientHeight - fromBottom.current;
    });
    ro.observe(el);
    // Growing content only matters at the bottom; scrolled up, what you're reading stays put.
    const grow = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    if (content.current) grow.observe(content.current);
    return () => {
      ro.disconnect();
      grow.disconnect();
    };
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    // While a jump's smooth scroll runs, a scroll event still queued from before it (or
    // the scroll's first frames, still near the bottom) must not pin the list again.
    if (Date.now() >= jumpingUntil.current) stick.current = fromBottom.current < 80;
    // Scrolled up to (or near) the top: fetch the previous page of older messages.
    if (hasMore && !loadingOlder && el.scrollTop < 300) loadOlder(room.id);
  };

  // A load can land short of filling the screen (no scrollbar): if older messages
  // still exist, keep asking until the list overflows or the history runs out.
  useEffect(() => {
    const el = ref.current;
    if (!el || !loaded || !hasMore || loadingOlder) return;
    if (el.scrollHeight <= el.clientHeight) loadOlder(room.id);
  }, [messages, loaded, hasMore, loadingOlder, room.id, loadOlder]);

  /** Scrolls a reply's quote (or a search hit) to its message and flashes it. */
  const onJump = useCallback((id: string) => {
    const root = ref.current;
    const el = root?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!el) return;
    // Jumping away from the bottom must not snap back on the next scroll effect.
    stick.current = false;
    jumpingUntil.current = Date.now() + 1500;
    fromBottom.current = root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash-highlight");
    // Restart the animation if it's still running from an earlier jump.
    void el.offsetWidth;
    el.classList.add("flash-highlight");
    window.setTimeout(() => el.classList.remove("flash-highlight"), 1500);
  }, []);

  // A search jump: scroll to the target (which may have needed older pages
  // loaded first) using the same path a reply quote uses, then clear it.
  const jumpTarget = useChat((s) => s.jumpTarget);
  useEffect(() => {
    if (!jumpTarget || jumpTarget.roomId !== room.id) return;
    onJump(jumpTarget.id);
    clearJump();
  }, [jumpTarget, room.id, onJump, clearJump]);

  return (
    <div ref={ref} onScroll={onScroll} className={`min-h-0 flex-1 overflow-y-auto ${bubbles ? "overscroll-contain pb-9" : "pb-8"}`}>
      {/* The bottom padding keeps the last row clear of the floating typing indicator. */}
      {/* Phones keep the newest message at the bottom, so a short chat starts there and
          older messages move up as new ones arrive. */}
      <div ref={content} className={`mx-auto max-w-4xl ${bubbles ? "flex min-h-full flex-col justify-end" : ""}`}>
        {!loaded && list.length === 0 && <div className="p-8 text-center text-sm text-zinc-400">Loading history…</div>}
        {/* Always the same height, so the status changing doesn't move what you're reading. */}
        {loaded && list.length > 0 && (
          <div className="h-9 pt-3 text-center text-xs text-zinc-500">
            {loadingOlder ? "Loading earlier messages…" : hasMore ? "" : `Start of #${room.name}`}
          </div>
        )}
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
              replyOriginal={m.reply_to ? byId.get(m.reply_to) : undefined}
              showAnchor={!!anchor && prev?.id !== anchor.id}
              compact={compact}
              myProfileId={myProfileId}
              mine={m.author_id === myId}
              bubbles={bubbles}
              members={members}
              onEdit={onEdit}
              onReply={onReply}
              onJump={onJump}
            />
          );
        })}
      </div>
    </div>
  );
}

/** The matched words in a search snippet are wrapped in STX/ETX control
 *  characters; split on them and render the marked parts as <mark>. */
function highlight(hit: SearchHit) {
  const parts = hit.snippet.split("\u0002");
  return parts.map((part, i) => {
    const end = part.indexOf("\u0003");
    if (end < 0) return <span key={i}>{part}</span>;
    return (
      <span key={i}>
        <mark className="rounded-[3px] bg-indigo-100 px-0.5 text-inherit dark:bg-indigo-500/30">{part.slice(0, end)}</mark>
        {part.slice(end + 1)}
      </span>
    );
  });
}

/** The room's message search: input (300 ms debounce, stale answers ignored) and
 *  the hits; clicking one jumps to the message, loading older history if needed.
 *  `phone` renders a full-screen overlay, otherwise a dropdown under the header. */
function SearchPanel({ room, phone, onJump, onClose }: { room: RoomInfo; phone: boolean; onJump: (hit: SearchHit) => void; onClose: () => void }) {
  const searchMessages = useChat((s) => s.searchMessages);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The latest keystroke's run number: a slower answer to an older query is dropped.
  const latestRun = useRef(0);
  useEffect(() => {
    input.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    // Desktop only (the phone overlay covers the screen and has a back button):
    // a click outside the panel closes it.
    const close = phone ? null : (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    if (close) document.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", esc);
      if (close) document.removeEventListener("mousedown", close);
    };
  }, [onClose, phone]);

  // Search as you type, debounced; the empty box shows nothing (not "no match").
  useEffect(() => {
    const query = text.trim();
    const run = ++latestRun.current;
    if (!query) {
      setHits(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const t = window.setTimeout(async () => {
      let got: SearchHit[] | null = null;
      let failed = false;
      try {
        got = await searchMessages(room.id, query);
      } catch {
        failed = true;
      }
      if (latestRun.current !== run) return; // a newer query has taken over
      setBusy(false);
      setHits(failed ? null : got);
    }, 300);
    return () => window.clearTimeout(t);
  }, [text, room.id, searchMessages]);

  const results = busy ? (
    <div className="px-3 py-6 text-center text-sm text-zinc-500">Searching…</div>
  ) : hits === null ? null : hits.length === 0 ? (
    <div className="px-3 py-6 text-center text-sm text-zinc-500">No messages match</div>
  ) : (
    hits.map((hit) => (
      <button
        key={hit.id}
        onClick={() => onJump(hit)}
        className="block w-full border-b border-zinc-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800/60 dark:active:bg-zinc-800"
      >
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">{hit.author_name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-zinc-400">{time(hit.created_at)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">{highlight(hit)}</span>
      </button>
    ))
  );

  const field = (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
      <Icon name="search" size={15} className="shrink-0 text-zinc-400" />
      <input
        ref={input}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Search #${room.name}`}
        aria-label="Search messages"
        className={`${phone ? "text-base" : "text-sm"} min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-zinc-400`}
      />
      {text && (
        <button onClick={() => setText("")} className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Clear search">
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );

  if (phone) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-white pt-[calc(env(safe-area-inset-top)+0.5rem)] dark:bg-zinc-950">
        <div className="flex items-center gap-1 border-b border-zinc-200 px-1 pb-2 dark:border-zinc-800">
          <button
            onClick={onClose}
            className="flex h-11 items-center gap-0.5 rounded-full pr-2 pl-1 text-indigo-600 active:bg-zinc-100 dark:text-indigo-400 dark:active:bg-zinc-800"
            aria-label="Back to the room"
          >
            <Icon name="chevron" size={24} className="rotate-180" />
          </button>
          <span className="sr-only">Search messages</span>
          {field}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{results}</div>
      </div>
    );
  }
  return (
    <div ref={box} className="absolute top-1 right-0 z-30 w-96 max-w-[calc(100%-1rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
      {field}
      <div className="max-h-[60vh] overflow-y-auto border-t border-zinc-100 dark:border-zinc-800">{results}</div>
    </div>
  );
}

/** When this app last sent `typing: true`, across all rooms: the relay accepts one per
 *  second per connection, so a Composer waits out that window instead of being dropped. */
let lastTypingTrueAt = 0;
const RELAY_TYPING_GAP = 1100;

/** "Sam is typing…" — live relay state, subscribed on its own so typing updates never
 *  re-render the memoized message rows. Entries expire on their own, so a lost
 *  `typing: false` frame just makes the line vanish a few seconds later. */
function TypingIndicator({ roomId, phone }: { roomId: string; phone: boolean }) {
  const typing = useChat((s) => s.typing[roomId]);
  const [now, setNow] = useState(() => Date.now());
  // Only entries whose expiry is still in the future.
  const names = useMemo(
    () => Object.values(typing ?? {}).filter((e) => e.until > now).map((e) => e.name),
    [typing, now],
  );

  // Tick once a second while anyone is shown, so stale entries disappear on time.
  // The interval is cleared when the line is hidden.
  useEffect(() => {
    if (names.length === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [names.length]);

  const rest = names.length - 2;
  const label =
    names.length === 0
      ? ""
      : names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? "" : "s"} are typing…`;

  // Floated over the list's bottom edge, outside the flow, so the layout never jumps.
  // The live region stays mounted (empty when nobody types) so screen readers announce
  // the first "… is typing" too; only the visible pill comes and goes.
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-3 pb-1.5"
      aria-live="polite"
    >
      {label && (
        <div
          className={`flex max-w-full items-center gap-1.5 rounded-full bg-white/90 px-3 py-0.5 text-zinc-500 shadow-sm backdrop-blur-sm dark:bg-zinc-900/90 ${phone ? "text-[13px]" : "text-xs"}`}
        >
          <span className="typing-dots shrink-0" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="truncate">{label}</span>
        </div>
      )}
    </div>
  );
}

/** The Off / Ask / Auto switch for each MCP server, in this room. */
function ToolsList({ room }: { room: RoomInfo }) {
  const servers = useChat((s) => s.client!.mcp_servers);
  const modes = useChat((s) => s.client!.mcp_modes_by_room[room.id]);
  const setRoomMcpMode = useChat((s) => s.setRoomMcpMode);
  if (servers.length === 0) return <p className="py-2 text-sm text-zinc-500">No MCP servers yet. Add one to let the AI use tools.</p>;
  return (
    <div className="space-y-2">
      {servers.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm" title={s.name}>
            {s.name}
          </span>
          <Segmented size="sm" value={modes?.[s.id] ?? s.default_mode} onChange={(mode) => setRoomMcpMode(room.id, s.id, mode)} options={MODE_OPTIONS} />
        </div>
      ))}
    </div>
  );
}

/** Per-chat MCP switches: Off / Ask / Auto for each server the user added. */
function ToolsMenu({ room, onOpenSettings }: { room: RoomInfo; onOpenSettings: (tab: SettingsTab) => void }) {
  const servers = useChat((s) => s.client!.mcp_servers);
  const modes = useChat((s) => s.client!.mcp_modes_by_room[room.id]);
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
          <ToolsList room={room} />
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

/** Phones: everything that sits beside the message box on desktop, in a bottom sheet. */
function ComposerSheet({
  room,
  profileId,
  aiOn,
  setAiOn,
  onOpenSettings,
  onClose,
}: {
  room: RoomInfo;
  profileId: string | null;
  aiOn: boolean;
  setAiOn: (on: boolean) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const profiles = useChat((s) => s.client!.profiles);
  const devices = useChat((s) => s.devices);
  const myDeviceId = useChat((s) => s.client!.device_id);
  const chooseProfile = useChat((s) => s.chooseProfile);
  const settings = (tab: SettingsTab) => {
    onClose();
    onOpenSettings(tab);
  };
  // Other devices of this account that share their profiles.
  const shared = devices
    .filter((d) => d.device_id !== myDeviceId)
    .flatMap((d) => d.profiles.map((p) => ({ id: remoteProfileId(d.device_id, p.id), label: p.label, model: p.model, device: d.device_name })));
  const anyProfile = profiles.length + shared.length > 0;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="max-h-[85%] animate-[sheet-up_180ms_ease-out] overflow-y-auto rounded-t-3xl bg-white px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="font-semibold">AI reply</div>
            <div className="text-xs text-zinc-500">Your next message gets an answer from your AI</div>
          </div>
          <Segmented
            value={aiOn ? "on" : "off"}
            onChange={(v) => setAiOn(v === "on")}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </div>
        <div className="mt-3 mb-1 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Answer with</div>
        {!anyProfile ? (
          <button onClick={() => settings("profiles")} className="py-2 text-sm font-medium text-indigo-600 dark:text-indigo-400">
            Add an AI profile
          </button>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => chooseProfile(room.id, p.id)}
                disabled={!aiOn}
                className="flex min-h-12 w-full items-center gap-3 border-b border-zinc-100 px-3 py-2 text-left last:border-b-0 disabled:opacity-50 active:bg-zinc-50 dark:border-zinc-800 dark:active:bg-zinc-800"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{p.label}</span>
                  <span className="block truncate font-mono text-xs text-zinc-500">{p.model}</span>
                </span>
                {p.id === profileId && <Icon name="check" size={18} className="shrink-0 text-indigo-600 dark:text-indigo-400" />}
              </button>
            ))}
            {shared.map((p) => (
              <button
                key={p.id}
                onClick={() => chooseProfile(room.id, p.id)}
                disabled={!aiOn}
                className="flex min-h-12 w-full items-center gap-3 border-b border-zinc-100 px-3 py-2 text-left last:border-b-0 disabled:opacity-50 active:bg-zinc-50 dark:border-zinc-800 dark:active:bg-zinc-800"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{p.label} · on {p.device}</span>
                  <span className="block truncate font-mono text-xs text-zinc-500">{p.model}</span>
                </span>
                {p.id === profileId && <Icon name="check" size={18} className="shrink-0 text-indigo-600 dark:text-indigo-400" />}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 mb-1 flex items-baseline justify-between">
          <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Tools in #{room.name}</span>
          <button onClick={() => settings("mcp")} className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
            Manage
          </button>
        </div>
        <ToolsList room={room} />
        <Button variant="outline" className="mt-5 w-full !py-3" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Composer({
  room,
  profileId,
  onOpenSettings,
  phone,
  editing,
  replyTo,
  onClearEditing,
  onClearReply,
}: {
  room: RoomInfo;
  profileId: string | null;
  onOpenSettings: (tab: SettingsTab) => void;
  /** Phone layout: a pill message box with the options in a sheet. */
  phone: boolean;
  /** Set while the box is editing one of this user's own messages. */
  editing: Draft | null;
  /** Set while the box is writing a reply to this message. */
  replyTo: Message | null;
  onClearEditing: () => void;
  onClearReply: () => void;
}) {
  const profiles = useChat((s) => s.client!.profiles);
  const devices = useChat((s) => s.devices);
  const myDeviceId = useChat((s) => s.client!.device_id);
  const platform = useChat((s) => s.client!.platform);
  const status = useChat((s) => s.status);
  const sendMessage = useChat((s) => s.sendMessage);
  const editMessage = useChat((s) => s.editMessage);
  const chooseProfile = useChat((s) => s.chooseProfile);
  const [text, setText] = useState("");
  const [aiOn, setAiOn] = useState(true);
  const [sheet, setSheet] = useState(false);
  const servers = useChat((s) => s.client!.mcp_servers);
  const modes = useChat((s) => s.client!.mcp_modes_by_room[room.id]);
  const ta = useRef<HTMLTextAreaElement>(null);
  // While editing, the AI-reply option doesn't apply: the edit goes out as-is.
  // The pickers list local profiles first, then other devices' shared ones.
  const shared = devices
    .filter((d) => d.device_id !== myDeviceId)
    .flatMap((d) => d.profiles.map((p) => ({ id: remoteProfileId(d.device_id, p.id), label: p.label, model: p.model, device: d.device_name })));
  const anyProfile = profiles.length + shared.length > 0;

  const ai = !editing && aiOn && !!profileId;

  // --- Typing indicator broadcast ------------------------------------------
  // `true` goes out at most every 3 s while typing continues; `false` when the text
  // empties, on send, after 5 s of silence, and on unmount (the Composer is keyed by
  // room, so that also covers switching rooms). A `false` is only sent if a `true`
  // went out since the last `false`. Timers live in refs and are cleared on unmount.
  const setTyping = useChat((s) => s.setTyping);
  /** When this Composer last sent `typing: true` (0 = never). */
  const lastTrue = useRef(0);
  /** A `true` waiting for the relay's 1 s window to pass, so it isn't dropped there. */
  const trueTimer = useRef<number | undefined>(undefined);
  /** True once a `true` went out and no `false` has followed. */
  const active = useRef(false);
  /** Silence timer: 5 s without a keystroke ends the indicator. */
  const idleTimer = useRef<number | undefined>(undefined);
  /** Bumped on every text change, so a send finishing late can tell newer typing apart. */
  const typingGeneration = useRef(0);
  const stopTyping = () => {
    window.clearTimeout(idleTimer.current);
    idleTimer.current = undefined;
    window.clearTimeout(trueTimer.current);
    trueTimer.current = undefined;
    if (!active.current) return;
    active.current = false;
    setTyping(room.id, false);
  };
  /** Sends `true` now, or as soon as the relay's per-connection window allows. */
  const sendTrue = () => {
    trueTimer.current = undefined;
    const now = Date.now();
    const wait = lastTypingTrueAt + RELAY_TYPING_GAP - now;
    if (wait > 0) {
      trueTimer.current = window.setTimeout(sendTrue, wait);
      return;
    }
    lastTypingTrueAt = now;
    lastTrue.current = now;
    active.current = true;
    setTyping(room.id, true);
  };
  // Unmount (also covers switching rooms, since the Composer is keyed by room).
  useEffect(() => stopTyping, []);
  /** Called on every text change. */
  const onTextChange = (value: string) => {
    typingGeneration.current++;
    setText(value);
    if (editing) return; // an edit isn't a new message
    if (!value.trim()) {
      stopTyping();
      return;
    }
    const now = Date.now();
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(stopTyping, 5000);
    // Start right away after a stop; otherwise refresh every 3 s.
    if (trueTimer.current === undefined && (!active.current || now - lastTrue.current >= 3000)) sendTrue();
  };

  // Entering edit mode loads the message's text (setting aside what was being typed) and
  // focuses the box; leaving it, by saving or cancelling, brings that draft back. If edit
  // mode ends some other way (the message was deleted, or Reply was picked) with unsaved
  // changes, those stay in the box, ahead of the earlier draft.
  const toast = useChat((s) => s.toast);
  const draftBeforeEdit = useRef<string | null>(null);
  const lastEdit = useRef<Draft | null>(null);
  const textNow = useRef(text);
  textNow.current = text;
  const leaving = useRef(false);
  const leaveEdit = () => {
    leaving.current = true;
    onClearEditing();
  };
  useEffect(() => {
    if (editing) {
      // An edit isn't a new message: end any typing broadcast still pending.
      stopTyping();
      lastEdit.current = editing;
      setText((t) => {
        if (draftBeforeEdit.current === null) draftBeforeEdit.current = t;
        return editing.content;
      });
      ta.current?.focus();
    } else if (draftBeforeEdit.current !== null) {
      const before = draftBeforeEdit.current;
      const original = lastEdit.current?.content;
      const t = textNow.current;
      if (leaving.current || t === original) {
        setText(before);
      } else {
        setText(before.trim() ? `${t}

${before}` : t);
        toast("Edit not saved. Your changes are still in the box.");
      }
      draftBeforeEdit.current = null;
      lastEdit.current = null;
      leaving.current = false;
    }
  }, [editing, toast]);

  // On phones, focusing would pop the keyboard up as soon as a room opens.
  useEffect(() => {
    if (!phone && !editing) ta.current?.focus();
  }, [room.id, phone, editing]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, phone ? 140 : 220) + "px";
  }, [text, phone]);

  const sending = useRef(false);
  const send = async () => {
    if (!text.trim() || status !== "online" || sending.current) return;
    if (editing) {
      if (text === editing.content) return leaveEdit();
      sending.current = true;
      try {
        // Stay in edit mode (keeping the text) if the edit couldn't be sent.
        if (await editMessage(room.id, editing.id, text)) leaveEdit();
      } finally {
        sending.current = false;
      }
      return;
    }
    const sent = text;
    const reply = replyTo?.id ?? null;
    const typingAtSend = typingGeneration.current;
    sending.current = true;
    try {
      // Only clear the box once the message really went out. Text typed after the sent
      // part is kept; if the sent part itself was edited meanwhile, keep everything.
      if (await sendMessage(room.id, sent, ai, ai ? profileId : null, reply)) {
        setText((t) => (t.startsWith(sent) ? t.slice(sent.length).trimStart() : t));
        if (reply) onClearReply();
        // Only if nothing was typed while it sent: newer text is still being typed.
        if (typingGeneration.current === typingAtSend) stopTyping();
        // Receivers drop our typing entry when the sent message lands, so re-announce
        // the text typed meanwhile (after the message, waiting out the relay's window).
        else if (active.current && trueTimer.current === undefined) sendTrue();
      }
    } finally {
      sending.current = false;
    }
  };

  // Escape cancels an edit or a reply-in-progress from the box itself.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (editing) {
      e.preventDefault();
      leaveEdit();
    } else if (replyTo) {
      e.preventDefault();
      onClearReply();
    }
  };

  // The "Editing message ✕" / "Replying to … ✕" bar above the box. Only one of the
  // two can be active at a time; starting one clears the other in RoomView.
  const contextBar = editing ? (
    <div className="mb-1 flex items-center gap-2 px-1 text-xs text-zinc-600 dark:text-zinc-300">
      <Icon name="pencil" size={13} className="shrink-0 text-indigo-600 dark:text-indigo-400" />
      <span className="min-w-0 flex-1 truncate font-medium">Editing message</span>
      <button
        onClick={leaveEdit}
        className="shrink-0 rounded-full p-1 text-zinc-400 active:bg-zinc-100 dark:active:bg-zinc-800"
        aria-label="Cancel editing"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  ) : replyTo ? (
    <div className="mb-1 flex items-center gap-2 px-1 text-xs text-zinc-600 dark:text-zinc-300">
      <Icon name="reply" size={13} className="shrink-0 text-indigo-600 dark:text-indigo-400" />
      <span className="min-w-0 flex-1 truncate">
        Replying to <span className="font-medium">{replyTo.author_name}</span>: {snippet(replyTo.content, 60)}
      </span>
      <button
        onClick={onClearReply}
        className="shrink-0 rounded-full p-1 text-zinc-400 active:bg-zinc-100 dark:active:bg-zinc-800"
        aria-label="Cancel reply"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  ) : null;

  if (phone) {
    // A remote id points at another device's shared profile; local picks resolve directly.
    const local = profiles.find((p) => p.id === profileId);
    const remote = shared.find((p) => p.id === profileId);
    const pickedLabel = local?.label ?? (remote ? `${remote.label} · on ${remote.device}` : "");
    const toolsOn = servers.filter((s) => (modes?.[s.id] ?? s.default_mode) !== "off").length;
    return (
      <div className="safe-bottom border-t border-zinc-200 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        {contextBar}
        <button
          onClick={() => (anyProfile ? setSheet(true) : onOpenSettings("profiles"))}
          className="mb-1 flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-zinc-500 active:bg-zinc-100 dark:active:bg-zinc-800"
        >
          <Icon name="sparkle" size={13} className={ai ? "text-indigo-600 dark:text-indigo-400" : ""} />
          <span className="truncate">
            {!anyProfile ? "Add an AI profile to get replies" : ai ? `AI reply · ${pickedLabel}` : "AI reply off"}
            {toolsOn > 0 && ` · ${toolsOn} tool${toolsOn === 1 ? "" : "s"}`}
          </span>
          <Icon name="chevron" size={12} className="shrink-0 -rotate-90" />
        </button>
        <div className="flex items-end gap-1.5">
          <button
            onClick={() => setSheet(true)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 active:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:active:bg-zinc-700"
            aria-label="Reply options"
          >
            <Icon name="plus" size={20} />
          </button>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={editing ? "Edit your message" : ai ? `Message #${room.name}` : `Message #${room.name} — humans only`}
            className="block min-h-10 min-w-0 flex-1 resize-none rounded-[20px] border border-zinc-300 bg-white px-4 py-2 text-[16px] leading-snug outline-none placeholder:text-zinc-400 focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            onClick={send}
            disabled={!text.trim() || status !== "online"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition active:bg-indigo-500 disabled:bg-zinc-200 disabled:text-zinc-400 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
            aria-label={editing ? "Save edit" : "Send"}
          >
            <Icon name={editing ? "check" : "send"} size={18} className={editing ? "" : "-rotate-90"} />
          </button>
        </div>
        {sheet && (
          <ComposerSheet
            room={room}
            profileId={profileId}
            aiOn={aiOn}
            setAiOn={setAiOn}
            onOpenSettings={onOpenSettings}
            onClose={() => setSheet(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-200 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
      <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-300 bg-white shadow-sm transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900">
        {contextBar && <div className="px-4 pt-2.5">{contextBar}</div>}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else {
              onKeyDown(e);
            }
          }}
          placeholder={editing ? "Edit your message — Enter to save, Esc to cancel" : ai ? `Message #${room.name}` : `Message #${room.name} — humans only`}
          className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] outline-none placeholder:text-zinc-400"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 sm:gap-2">
          <button
            onClick={() => (anyProfile ? setAiOn((v) => !v) : onOpenSettings("profiles"))}
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
          {anyProfile ? (
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
              {shared.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · on {p.device}
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
          {platform === "desktop" && (
            <span className="hidden text-[11px] text-zinc-400 lg:inline">Shift+Enter for newline</span>
          )}
          <button
            onClick={send}
            disabled={!text.trim() || status !== "online"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700"
            aria-label={editing ? "Save edit" : "Send"}
          >
            <Icon name={editing ? "check" : "send"} size={16} />
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
      <div className="h-full bg-white pr-[env(safe-area-inset-right)] dark:bg-zinc-950" onMouseDown={(e) => e.stopPropagation()}>
        {panel}
      </div>
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

/** Phones: room actions that sit in the header on desktop. */
function RoomMenu({
  room,
  onInstructions,
  onLeave,
  onClose,
}: {
  room: RoomInfo;
  onInstructions: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.invite_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const row = "flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] active:bg-zinc-100 dark:active:bg-zinc-800";
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="animate-[sheet-up_180ms_ease-out] rounded-t-3xl bg-white pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <button onClick={copyCode} className={row}>
          <Icon name="copy" size={18} className="text-zinc-500" />
          <span className="flex-1">Invite code</span>
          <span className="font-mono text-sm tracking-widest text-zinc-500">{copied ? "Copied" : room.invite_code}</span>
        </button>
        <button onClick={onInstructions} className={row}>
          <Icon name="note" size={18} className="text-zinc-500" />
          <span className="min-w-0 flex-1">
            <span className="block">Room instructions</span>
            <span className="block truncate text-xs text-zinc-500">{room.system_prompt ? snippet(room.system_prompt, 60) : "None yet"}</span>
          </span>
        </button>
        <button onClick={onLeave} className={`${row} text-red-600 dark:text-red-400`}>
          <Icon name="door" size={18} />
          <span className="flex-1">Leave room</span>
        </button>
      </div>
    </div>
  );
}

/** Swipe right from the left edge to go back, following the finger. */
function useSwipeBack(onBack: (() => void) | undefined) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  if (!onBack) return { dx: 0, handlers: {} };
  return {
    dx,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        start.current = t.clientX < 28 ? { x: t.clientX, y: t.clientY } : null;
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!start.current) return;
        const t = e.touches[0];
        const x = t.clientX - start.current.x;
        // A mostly vertical drag is a scroll, not a swipe.
        if (dx === 0 && Math.abs(t.clientY - start.current.y) > Math.abs(x)) {
          start.current = null;
          return;
        }
        setDx(Math.max(0, x));
      },
      onTouchEnd: () => {
        if (start.current && dx > 90) onBack();
        start.current = null;
        setDx(0);
      },
    },
  };
}

export function RoomView({
  room,
  onOpenSettings,
  onBack,
}: {
  room: RoomInfo;
  onOpenSettings: (tab: SettingsTab) => void;
  /** Set on phones, where the room is its own screen over the room list. */
  onBack?: () => void;
}) {
  const client = useChat((s) => s.client!);
  const devices = useChat((s) => s.devices);
  const leaveRoom = useChat((s) => s.leaveRoom);
  const width = useWidth();
  const phone = !!onBack;
  const inlineMembers = !phone && width >= MEMBERS_INLINE_MIN;
  const [membersPref, setMembersPref] = useState(true);
  const [membersOverlay, setMembersOverlay] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Editing/replying target for the composer, shared with the message list. */
  const [editing, setEditing] = useState<Draft | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const swipe = useSwipeBack(onBack);

  // Starting one clears the other: the composer bar shows only one at a time. Stable
  // callbacks keep the memoized message rows from re-rendering.
  const startEdit = useCallback((m: Message) => {
    setReplyTo(null);
    setEditing({ mode: "edit", room_id: m.room_id, id: m.id, content: m.content });
  }, []);
  const startReply = useCallback((m: Message) => {
    if (m.deleted) return;
    setEditing(null);
    setReplyTo(m);
  }, []);
  const clearEditing = useCallback(() => setEditing(null), []);
  const clearReply = useCallback(() => setReplyTo(null), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  // A hit from the search panel: close it and scroll the room to the message,
  // loading older history first when the hit is further back than what's loaded.
  const jumpToHit = useCallback(
    (hit: SearchHit) => {
      setSearchOpen(false);
      useChat.getState().jumpTo(room.id, hit.id, hit.seq);
    },
    [room.id],
  );
  // The desktop view isn't remounted per room, so ignore a target from another room,
  // and drop one that was deleted (from another device or by its author) meanwhile.
  const liveEdit = useChat((s) => (editing ? s.messages[editing.room_id]?.find((m) => m.id === editing.id) : undefined));
  const liveReply = useChat((s) => (replyTo ? s.messages[replyTo.room_id]?.find((m) => m.id === replyTo.id) : undefined));
  const editingHere = editing?.room_id === room.id && liveEdit && !liveEdit.deleted ? editing : null;
  const replyHere = replyTo?.room_id === room.id && liveReply && !liveReply.deleted ? liveReply : null;

  const remembered = client.last_profile_by_room[room.id];
  // Local profiles first, then the shared ones of this user's other online
  // devices (a remote profile stays pickable while its device is online with
  // that profile). With none of either, there is no AI reply to get.
  const myDeviceId = client.device_id;
  const sharingDevices = devices.filter((d) => d.device_id !== myDeviceId && d.profiles.length > 0);
  const sharedProfiles = useMemo(
    () =>
      sharingDevices.flatMap((d) =>
        d.profiles.map((p) => ({ id: remoteProfileId(d.device_id, p.id), label: p.label, model: p.model, device: d.device_name })),
      ),
    // `sharingDevices` is derived here, so the memo tracks its parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [devices, myDeviceId],
  );
  // A remembered remote id stays chosen while that device is online with that
  // profile; otherwise fall back to the first local profile, then the first
  // shared one.
  const profileId = client.profiles.some((p) => p.id === remembered)
    ? remembered
    : sharedProfiles.some((p) => p.id === remembered)
      ? remembered
      : (client.profiles[0]?.id ?? sharedProfiles[0]?.id ?? null);
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

  const leave = async () => {
    setMenuOpen(false);
    if (await confirmAction("Leave room", `Leave #${room.name}? You can rejoin with its invite code.`, "Leave")) {
      leaveRoom(room.id);
      onBack?.();
    }
  };

  const header = phone ? (
    <header className="flex items-center gap-1 border-b border-zinc-200 px-1 pb-1.5 pt-[calc(env(safe-area-inset-top)+0.25rem)] dark:border-zinc-800">
      <button
        onClick={onBack}
        className="flex h-11 items-center gap-0.5 rounded-full pr-2 pl-1 text-indigo-600 active:bg-zinc-100 dark:text-indigo-400 dark:active:bg-zinc-800"
        aria-label="Back to rooms"
      >
        <Icon name="chevron" size={24} className="rotate-180" />
      </button>
      <button onClick={() => setMembersOverlay(true)} className="min-w-0 flex-1 text-center">
        <span className="block truncate text-[16px] font-semibold">#{room.name}</span>
        <span className="block truncate text-xs text-zinc-500">
          {online} online · {room.members.length} member{room.members.length === 1 ? "" : "s"}
        </span>
      </button>
      <button
        onClick={() => setSearchOpen(true)}
        className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-600 active:bg-zinc-100 dark:text-zinc-300 dark:active:bg-zinc-800"
        aria-label="Search messages"
      >
        <Icon name="search" size={21} />
      </button>
      <button
        onClick={() => setMenuOpen(true)}
        className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-600 active:bg-zinc-100 dark:text-zinc-300 dark:active:bg-zinc-800"
        aria-label="Room options"
      >
        <Icon name="dots" size={22} />
      </button>
    </header>
  ) : (
    <header className="flex items-center gap-1 border-b border-zinc-200 px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:gap-2 sm:px-4 dark:border-zinc-800">
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
      <Button variant="ghost" className="!px-2" onClick={() => setSearchOpen(true)} title="Search messages" aria-label="Search messages">
        <Icon name="search" size={17} />
      </Button>
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
      <Button variant="ghost" className="!px-2" title="Leave room" onClick={leave}>
        <Icon name="door" size={17} />
      </Button>
    </header>
  );

  return (
    <div
      className={`flex min-w-0 flex-1 bg-white dark:bg-zinc-950 ${phone ? "animate-[slide-in_200ms_ease-out]" : ""}`}
      style={swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
      {...swipe.handlers}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList room={room} myProfileId={profileId} bubbles={phone} onEdit={startEdit} onReply={startReply} />
          {/* Floats over the list's bottom edge, outside the flow, so it appears and
              disappears without moving the messages. */}
          <TypingIndicator roomId={room.id} phone={phone} />
          {/* The search dropdown hangs from the top of this container, under the
              header; on phones SearchPanel renders a full-screen overlay instead. */}
          {searchOpen && !phone && <SearchPanel room={room} phone={false} onJump={jumpToHit} onClose={closeSearch} />}
        </div>
        {/* Keyed by room: each room gets a fresh draft, and a send that finishes after
            switching rooms can't edit the new room's text. The editing/replying state
            lives here so both the list and the composer reach it. */}
        <Composer
          key={room.id}
          room={room}
          profileId={profileId}
          onOpenSettings={onOpenSettings}
          phone={phone}
          editing={editingHere}
          replyTo={replyHere}
          onClearEditing={clearEditing}
          onClearReply={clearReply}
        />
      </div>
      {inlineMembers && membersPref && <MemberList room={room} overlay={false} onClose={() => setMembersPref(false)} />}
      {!inlineMembers && membersOverlay && <MemberList room={room} overlay onClose={() => setMembersOverlay(false)} />}
      {searchOpen && phone && <SearchPanel room={room} phone onJump={jumpToHit} onClose={closeSearch} />}
      {promptOpen && <RoomPromptDialog room={room} onClose={() => setPromptOpen(false)} />}
      {menuOpen && (
        <RoomMenu
          room={room}
          onInstructions={() => {
            setMenuOpen(false);
            setPromptOpen(true);
          }}
          onLeave={leave}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
