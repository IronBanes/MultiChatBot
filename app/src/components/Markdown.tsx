// Sanitized markdown: raw HTML is dropped (skipHtml), URLs go through react-markdown's
// default safe transform, remote images are never loaded, links open in the system browser.
//
// Fenced ```html blocks in AI replies can also run live: `LiveFrame` loads a shell page
// served by Rust (the `mcframe` scheme) into an `allow-scripts` sandbox iframe and hands
// it the model's HTML by postMessage. The frame's CSP allows only inline scripts plus
// three public CDNs; no fetch/XHR/WebSocket, no remote images, no nested frames. The
// model's HTML never touches the app's DOM, a URL, or an IPC boundary.

import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useLiveHtml } from "../lib/liveHtml";
import { Icon } from "./ui";

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function codeLanguage(pre: HastNode | undefined): string | null {
  const code = pre?.children?.find((c) => c.tagName === "code");
  const cls = code?.properties?.className;
  const list = Array.isArray(cls) ? cls.map(String) : [];
  const lang = list.find((c) => c.startsWith("language-"));
  return lang ? lang.slice("language-".length) : null;
}

const PREVIEWABLE = new Set(["html", "svg", "xml", "css"]);

function previewDoc(lang: string, code: string): string {
  if (lang === "css") {
    return `<style>${code}</style><div class="demo"><h1>Heading</h1><p>Paragraph text with a <a href="#">link</a>.</p><button>Button</button><div class="box">.box</div></div>`;
  }
  return code;
}

/** Whether this Markdown render may run ```html blocks live (AI replies only, never mid-stream). */
const LiveContext = createContext(false);

/** The shell page served by the `mcframe` scheme in Rust (frame.rs); one origin, its own CSP. */
const FRAME_SRC = convertFileSrc("frame.html", "mcframe");

interface FrameMessage {
  type?: unknown;
  height?: unknown;
  token?: unknown;
}

/** The live ```html viewer: a sandboxed frame that renders `html` and reports its height. */
function LiveFrame({ html, fill, onEscape }: { html: string; fill?: boolean; onEscape?: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [left, setLeft] = useState(false);
  // The HTML goes out once per frame. The shell never reloads on its own (new content
  // remounts the frame), so a second "ready" comes from a page the block navigated to.
  // The sandbox stays in force after a navigation, so origin and source can't tell
  // that page from the shell.
  const rendered = useRef(false);
  // Identifies this frame's "left" message, whose source no longer matches after a navigation.
  const [token] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // The sandboxed shell has an opaque origin, which reports as "null".
      if (e.origin !== "null") return;
      const data = e.data as FrameMessage | null | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type === "mc-frame-left" && data.token === token) {
        // The block navigated its frame away: drop the frame so no outside page shows here.
        setLeft(true);
        return;
      }
      const win = ref.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (data.type === "mc-frame-ready") {
        if (rendered.current) return;
        rendered.current = true;
        // The sandboxed frame has an opaque origin, so target "*"; only that window listens.
        win.postMessage(
          { type: "mc-frame-render", html, token, dark: document.documentElement.classList.contains("dark") },
          "*",
        );
      } else if (data.type === "mc-frame-height" && typeof data.height === "number" && Number.isFinite(data.height)) {
        // The overlay is full height, so only the inline view resizes.
        if (!fill) setHeight(Math.min(Math.max(data.height, 40), 2000));
      } else if (data.type === "mc-frame-escape") {
        // Keys pressed inside the frame never reach this window, so the shell forwards Escape.
        onEscape?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html, fill, onEscape, token]);
  if (left) {
    return <p className="p-3 text-sm text-zinc-400">This block tried to open another page, so it was stopped.</p>;
  }
  return (
    <iframe
      ref={ref}
      title="Live HTML"
      // Exactly allow-scripts: no same-origin access, popups, top navigation, forms or modals.
      sandbox="allow-scripts"
      src={FRAME_SRC}
      referrerPolicy="no-referrer"
      className={`w-full border-0 bg-transparent ${fill ? "h-full" : ""}`}
      style={fill ? undefined : { height: `${height}px` }}
    />
  );
}

/** Full-window view of a live frame: dark scrim, close button top right, Escape closes. */
function LiveFrameOverlay({ html, onClose }: { html: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="flex shrink-0 items-center justify-end p-2">
        <button
          onClick={onClose}
          aria-label="Close"
          className="min-h-[44px] rounded-md px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10"
        >
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3" onMouseDown={(e) => e.stopPropagation()}>
        <LiveFrame html={html} fill onEscape={onClose} />
      </div>
    </div>
  );
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const live = useContext(LiveContext);
  const [setting] = useLiveHtml();
  const code = hastText(node).replace(/\n$/, "");
  const lang = codeLanguage(node);
  const canPreview = !!lang && PREVIEWABLE.has(lang) && (lang !== "xml" || code.includes("<svg"));
  // AI replies only: run html blocks live unless the viewer turned it off.
  const runLive = live && lang === "html" && setting !== "off";
  // null follows the setting; Run or Code overrides it for this block. Not a one-time
  // initial value: the block first renders mid-stream (live off) and must still start
  // running when the reply finishes.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const frame = toggled ?? setting === "auto";
  const [expanded, setExpanded] = useState(false);
  const showFrame = runLive && frame;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="code-block group my-2 overflow-hidden rounded-lg border border-zinc-800 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1 text-xs text-zinc-400">
        <span className="font-mono">{lang ?? "text"}</span>
        <div className="flex gap-1">
          {canPreview && !runLive && (
            <button
              onClick={() => setPreview((p) => !p)}
              className="min-h-[44px] rounded px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0"
            >
              {preview ? "Code" : "Preview"}
            </button>
          )}
          {runLive && (
            <button
              onClick={() => setToggled(!frame)}
              className="min-h-[44px] rounded px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0"
            >
              {frame ? "Code" : "Run"}
            </button>
          )}
          {showFrame && (
            <button
              onClick={() => setExpanded(true)}
              className="min-h-[44px] rounded px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0"
            >
              Expand
            </button>
          )}
          <button
            onClick={copy}
            className="min-h-[44px] rounded px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {showFrame ? (
        // key={code}: new content reloads the shell and re-posts the HTML.
        <LiveFrame key={code} html={code} />
      ) : preview && lang ? (
        // sandbox="" disables scripts, forms, navigation and same-origin access.
        <iframe
          title="preview"
          sandbox=""
          srcDoc={previewDoc(lang, code)}
          className="h-72 w-full bg-white"
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">{children}</pre>
      )}
      {expanded && <LiveFrameOverlay html={code} onClose={() => setExpanded(false)} />}
    </div>
  );
}

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode}>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^(https?|mailto):/i.test(href)) void openUrl(href);
      }}
      className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600 dark:text-indigo-400 dark:decoration-indigo-700"
    >
      {children}
    </a>
  ),
  // Never fetch remote images from chat content; show them as links instead.
  img: ({ src, alt }) => (
    <span className="text-zinc-500">
      [image: {alt || "untitled"}
      {typeof src === "string" && /^https?:/i.test(src) ? ` — ${src}` : ""}]
    </span>
  ),
};

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <div className="md">
      <LiveContext.Provider value={live}>
        <ReactMarkdown
          skipHtml
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </LiveContext.Provider>
    </div>
  );
});
