// Small shared UI primitives.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { initials, memberColor } from "../lib/colors";

/** Open modals, innermost last: only the topmost one handles Escape and Tab. */
const modalStack: string[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Read during the first render, before a child's autoFocus moves focus into the dialog.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const previous = opener;
    modalStack.push(id);
    // Move focus into the dialog unless something inside already took it (autoFocus).
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab" && panel.current) {
        // Keep keyboard focus inside the dialog.
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const inside = panel.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = modalStack.lastIndexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      if (previous?.isConnected) previous.focus();
    };
  }, [id, opener]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-900 ${wide ? "max-w-3xl" : "max-w-md"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-950";

export function Button({
  children,
  variant = "primary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-600/50",
    outline:
      "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800",
    ghost: "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
    danger: "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50",
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Avatar({ userId, name, size = 32 }: { userId: string; name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none"
      style={{ width: size, height: size, background: memberColor(userId), fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}

const paths: Record<string, string> = {
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  send: "M5 12h14M13 6l6 6-6 6",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15",
  stop: "M6 6h12v12H6z",
  door: "M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3",
  sparkle: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
  hash: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  note: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
  wrench: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.8-3.8a6 6 0 01-7.9 7.9l-6.9 6.9a2.1 2.1 0 01-3-3l6.9-6.9a6 6 0 017.9-7.9z",
  brain: "M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z",
  chevron: "M9 18l6-6-6-6",
  menu: "M3 6h18M3 12h18M3 18h18",
  check: "M20 6L9 17l-5-5",
  server: "M2 4h20v6H2zM2 14h20v6H2zM6 7h.01M6 17h.01",
  sun: "M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
};

export function Icon({ name, size = 18, className = "" }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800/70" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded-md font-medium transition ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"} ${
            value === o.value
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The Multichat "Orbit" mark (branding/logo.svg): members circling one shared AI. */
export function Logo({ size = 32, className = "" }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" className={`shrink-0 ${className}`} role="img" aria-label="Multichat">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill={`url(#${id})`} />
      <circle cx="64" cy="64" r="34" fill="none" stroke="#fff" strokeOpacity=".4" strokeWidth="3" />
      <path d="M64 42Q66.8 61.2 86 64Q66.8 66.8 64 86Q61.2 66.8 42 64Q61.2 61.2 64 42Z" fill="#fff" />
      <circle cx="64" cy="30" r="8" fill="#fbbf24" stroke="#fff" strokeWidth="3" />
      <circle cx="93.4" cy="81" r="8" fill="#34d399" stroke="#fff" strokeWidth="3" />
      <circle cx="34.6" cy="81" r="8" fill="#38bdf8" stroke="#fff" strokeWidth="3" />
    </svg>
  );
}
