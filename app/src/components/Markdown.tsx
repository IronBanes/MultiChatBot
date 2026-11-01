// Sanitized markdown: raw HTML is dropped (skipHtml), URLs go through react-markdown's
// default safe transform, remote images are never loaded, links open in the system browser.

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";

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

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const code = hastText(node).replace(/\n$/, "");
  const lang = codeLanguage(node);
  const canPreview = !!lang && PREVIEWABLE.has(lang) && (lang !== "xml" || code.includes("<svg"));

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
          {canPreview && (
            <button
              onClick={() => setPreview((p) => !p)}
              className="rounded px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {preview ? "Code" : "Preview"}
            </button>
          )}
          <button onClick={copy} className="rounded px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-100">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {preview && lang ? (
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
