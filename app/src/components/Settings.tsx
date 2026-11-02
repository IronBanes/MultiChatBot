import { useEffect, useMemo, useRef, useState } from "react";
import { backend, errorText } from "../lib/backend";
import type {
  McpMode,
  McpServer,
  McpServerView,
  McpToolInfo,
  ModelInfo,
  Profile,
  ProfileView,
  ProviderKind,
  SecretEdit,
} from "../lib/types";
import { useChat } from "../store";
import { confirmAction } from "./Confirm";
import { PALETTES, useAppearance, type Mode } from "../theme";
import { Button, Field, Icon, inputCls, Modal, Segmented } from "./ui";

// ------------------------------------------------------------------ AI profiles

interface Preset {
  name: string;
  provider: ProviderKind;
  base_url: string;
  model: string;
  max_context_tokens: number;
}

const PRESETS: Preset[] = [
  { name: "Anthropic", provider: "anthropic", base_url: "https://api.anthropic.com", model: "claude-opus-5-5", max_context_tokens: 200000 },
  { name: "OpenAI", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", max_context_tokens: 128000 },
  { name: "NanoGPT", provider: "openai", base_url: "https://nano-gpt.com/api/v1", model: "", max_context_tokens: 128000 },
  { name: "OpenRouter", provider: "openai", base_url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", max_context_tokens: 128000 },
  { name: "Groq", provider: "openai", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", max_context_tokens: 32000 },
  { name: "Ollama", provider: "openai", base_url: "http://localhost:11434/v1", model: "llama3.2", max_context_tokens: 8192 },
  { name: "LM Studio", provider: "openai", base_url: "http://localhost:1234/v1", model: "local-model", max_context_tokens: 8192 },
];

const EFFORTS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

function blankProfile(): Profile {
  const p = PRESETS[0];
  return {
    id: "",
    label: p.name,
    provider: p.provider,
    base_url: p.base_url,
    model: p.model,
    max_context_tokens: p.max_context_tokens,
    temperature: null,
    show_reasoning: true,
    reasoning_effort: null,
  };
}

function formatTokens(n: number) {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </span>
  );
}

/** Model field with a "Fetch models" list from the provider. */
function ModelPicker({
  profile,
  apiKey,
  onPick,
  onType,
}: {
  profile: Profile;
  apiKey: string;
  onPick: (m: ModelInfo) => void;
  onType: (id: string) => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // A different endpoint means a different list.
  useEffect(() => {
    setModels(null);
    setError(null);
  }, [profile.base_url, profile.provider]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const fetchModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await backend.listModels(profile, apiKey || undefined);
      setModels(list);
      setQuery("");
      setOpen(true);
      if (list.length === 0) setError("The provider returned no models for this key.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
  }, [models, query]);

  return (
    <div ref={box} className="relative">
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={profile.model}
          placeholder={models ? "Type or pick a model" : "Model id, or fetch the list"}
          spellCheck={false}
          onFocus={() => models && setOpen(true)}
          onChange={(e) => {
            onType(e.target.value);
            setQuery(e.target.value);
            if (models) setOpen(true);
          }}
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={fetchModels} disabled={busy}>
          {busy ? "Loading…" : models ? "Refresh" : "Fetch models"}
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {models && !error && <p className="mt-1 text-xs text-zinc-500">{models.length} models available to this key</p>}
      {open && models && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {filtered.slice(0, 300).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onPick(m);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                m.id === profile.model ? "bg-indigo-50 dark:bg-indigo-950/50" : ""
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">{m.id}</span>
                {m.name && <span className="block truncate text-xs text-zinc-500">{m.name}</span>}
              </span>
              {m.context_length && <Badge>{formatTokens(m.context_length)}</Badge>}
              {m.reasoning && <Badge>reasoning</Badge>}
              {m.tools && <Badge>tools</Badge>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileEditor({ initial, onDone }: { initial: ProfileView | null; onDone: () => void }) {
  const refreshClient = useChat((s) => s.refreshClient);
  const [p, setP] = useState<Profile>(initial ?? blankProfile());
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = !!initial?.has_key && !removeKey;

  const upd = (patch: Partial<Profile>) => {
    setP((cur) => ({ ...cur, ...patch }));
    setResult(null);
  };

  const applyPreset = (name: string) => {
    const preset = PRESETS.find((x) => x.name === name);
    if (!preset) return;
    upd({
      provider: preset.provider,
      base_url: preset.base_url,
      model: preset.model,
      max_context_tokens: preset.max_context_tokens,
      label: p.label && !PRESETS.some((x) => x.name === p.label) ? p.label : preset.name,
    });
  };

  const save = async () => {
    setBusy("save");
    try {
      await backend.saveProfile(p, key ? key : removeKey ? "" : undefined);
      await refreshClient();
      onDone();
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      setResult({ ok: true, text: await backend.testProfile(p, key || undefined) });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Start from a preset</span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((x) => (
            <button
              key={x.name}
              onClick={() => applyPreset(x.name)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                p.base_url === x.base_url
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                  : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              }`}
            >
              {x.name}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <input className={inputCls} value={p.label} onChange={(e) => upd({ label: e.target.value })} />
        </Field>
        <Field label="Provider type">
          <select className={inputCls} value={p.provider} onChange={(e) => upd({ provider: e.target.value as ProviderKind })}>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </Field>
      </div>
      <Field label="Base URL" hint={p.provider === "openai" ? "Requests go to {base}/chat/completions" : "Requests go to {base}/v1/messages"}>
        <input className={inputCls} value={p.base_url} onChange={(e) => upd({ base_url: e.target.value })} spellCheck={false} />
      </Field>
      <Field
        label="API key"
        hint={
          hasKey ? (
            <>
              A key is stored in your OS keychain. Leave blank to keep it ·{" "}
              <button className="text-red-600 hover:underline dark:text-red-400" onClick={() => setRemoveKey(true)}>
                remove key
              </button>
            </>
          ) : (
            "Stored only in your OS keychain. Never sent to the chat server. Optional for local models."
          )
        }
      >
        <input
          className={inputCls}
          type="password"
          autoComplete="off"
          placeholder={hasKey ? "•••••••• (stored)" : "sk-..."}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setResult(null);
          }}
        />
      </Field>
      <div>
        <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Model</span>
        <ModelPicker
          profile={p}
          apiKey={key}
          onType={(model) => upd({ model })}
          onPick={(m) => upd({ model: m.id, ...(m.context_length ? { max_context_tokens: m.context_length } : {}) })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Max context tokens" hint="Filled in from the model list when known.">
          <input
            className={inputCls}
            type="number"
            min={512}
            value={p.max_context_tokens}
            onChange={(e) => upd({ max_context_tokens: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Temperature" hint={p.provider === "anthropic" ? "Not sent: the current Anthropic API rejects it." : "Blank = provider default"}>
          <input
            className={inputCls}
            type="number"
            step={0.1}
            min={0}
            max={2}
            disabled={p.provider === "anthropic"}
            value={p.temperature ?? ""}
            onChange={(e) => upd({ temperature: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-indigo-600"
            checked={p.show_reasoning}
            onChange={(e) => upd({ show_reasoning: e.target.checked })}
          />
          <span>
            <span className="block text-sm font-medium">Show reasoning</span>
            <span className="block text-xs text-zinc-500">
              {p.provider === "anthropic"
                ? "Requests summarized thinking (Claude 4.6 and newer) and shows it above the reply."
                : "Shows the model's reasoning above the reply when it streams any (NanoGPT, OpenRouter, DeepSeek and others)."}
            </span>
          </span>
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">Reasoning effort</span>
          <select
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            value={p.reasoning_effort ?? ""}
            onChange={(e) => upd({ reasoning_effort: e.target.value || null })}
          >
            {EFFORTS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">Not every model supports every level.</span>
        </div>
      </div>
      {result && <ResultBox ok={result.ok}>{result.text}</ResultBox>}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button variant="outline" onClick={test} disabled={busy !== null}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ResultBox({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        ok
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
      }`}
    >
      {children}
    </div>
  );
}

function ProfilesPanel() {
  const client = useChat((s) => s.client)!;
  const refreshClient = useChat((s) => s.refreshClient);
  const [editing, setEditing] = useState<ProfileView | "new" | null>(client.profiles.length === 0 ? "new" : null);

  if (editing) {
    return <ProfileEditor initial={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;
  }

  const remove = async (p: ProfileView) => {
    if (!(await confirmAction("Delete profile", `Delete "${p.label}" and its stored API key?`, "Delete"))) return;
    await backend.deleteProfile(p.id);
    await refreshClient();
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Profiles live on this computer. When you send a message, your chosen profile generates the AI reply that everyone in the room sees.
      </p>
      {client.profiles.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            <Icon name="sparkle" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{p.label}</div>
            <div className="truncate text-xs text-zinc-500">
              {p.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"} · {p.model} · {p.has_key ? "key stored" : "no key"}
              {p.show_reasoning ? " · reasoning" : ""}
            </div>
          </div>
          <Button variant="ghost" onClick={() => setEditing(p)}>
            Edit
          </Button>
          <Button variant="danger" onClick={() => remove(p)}>
            Delete
          </Button>
        </div>
      ))}
      <Button variant="outline" onClick={() => setEditing("new")} className="w-full">
        <Icon name="plus" size={16} /> Add profile
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ MCP servers

export const MODE_OPTIONS: { value: McpMode; label: string; title: string }[] = [
  { value: "off", label: "Off", title: "The AI can't use this server" },
  { value: "ask", label: "Ask", title: "The AI can use it, but asks you before each tool call" },
  { value: "auto", label: "Auto", title: "The AI uses it without asking" },
];

interface SecretRow {
  key: number;
  kind: "env" | "header";
  name: string;
  /** null: keep the stored value. */
  value: string | null;
}

let rowSeq = 0;

function blankServer(mobile: boolean): McpServer {
  return {
    id: "",
    name: "",
    // Mobile OSes can't spawn local commands, so Remote URL is the only type there.
    transport: mobile ? "http" : "stdio",
    command: mobile ? "" : "npx",
    args: [],
    url: "",
    default_mode: "ask",
    share_images: false,
    timeout_secs: 120,
  };
}

function SecretRows({
  rows,
  kind,
  onChange,
}: {
  rows: SecretRow[];
  kind: "env" | "header";
  onChange: (rows: SecretRow[]) => void;
}) {
  const mine = rows.filter((r) => r.kind === kind);
  const update = (key: number, patch: Partial<SecretRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {mine.map((r) => (
        <div key={r.key} className="flex gap-2">
          <input
            className={`${inputCls} w-2/5 font-mono text-xs`}
            placeholder={kind === "env" ? "NAME" : "Authorization"}
            value={r.name}
            spellCheck={false}
            onChange={(e) => update(r.key, { name: e.target.value })}
          />
          <input
            className={`${inputCls} font-mono text-xs`}
            type="password"
            autoComplete="off"
            placeholder={r.value === null ? "•••• (stored)" : kind === "env" ? "value" : "Bearer …"}
            value={r.value ?? ""}
            onChange={(e) => update(r.key, { value: e.target.value })}
          />
          <button
            type="button"
            className="shrink-0 rounded-md px-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
            aria-label="Remove"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        onClick={() => onChange([...rows, { key: ++rowSeq, kind, name: "", value: "" }])}
      >
        + Add {kind === "env" ? "environment variable" : "header"}
      </button>
    </div>
  );
}

function McpEditor({ initial, onDone }: { initial: McpServerView | null; onDone: () => void }) {
  const refreshClient = useChat((s) => s.refreshClient);
  const mobile = useChat((s) => s.client!.platform !== "desktop");
  const [s, setS] = useState<McpServer>(initial ?? blankServer(mobile));
  const [argsText, setArgsText] = useState((initial?.args ?? []).join("\n"));
  const [rows, setRows] = useState<SecretRow[]>(() => [
    ...(initial?.env_names ?? []).map((name) => ({ key: ++rowSeq, kind: "env" as const, name, value: null })),
    ...(initial?.header_names ?? []).map((name) => ({ key: ++rowSeq, kind: "header" as const, name, value: null })),
  ]);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upd = (patch: Partial<McpServer>) => {
    setS((cur) => ({ ...cur, ...patch }));
    setTools(null);
    setError(null);
  };

  const current = (): [McpServer, SecretEdit[]] => {
    // The field isn't clamped while typing; the backend needs a whole number in range.
    const timeout_secs = Math.min(3600, Math.max(5, Math.round(s.timeout_secs) || 120));
    const server = { ...s, timeout_secs, args: argsText.split("\n").map((a) => a.trim()).filter(Boolean) };
    const relevant = rows.filter((r) => r.kind === (s.transport === "stdio" ? "env" : "header"));
    return [server, relevant.map((r) => ({ kind: r.kind, name: r.name, value: r.value }))];
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    setTools(null);
    try {
      const [server, secrets] = current();
      setTools(await backend.testMcpServer(server, secrets));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const [server, secrets] = current();
      await backend.saveMcpServer(server, secrets);
      await refreshClient();
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="Shown in chat next to tool calls.">
          <input className={inputCls} value={s.name} placeholder="Files" onChange={(e) => upd({ name: e.target.value })} />
        </Field>
        <Field label="Type">
          <Segmented
            value={s.transport}
            onChange={(transport) => upd({ transport })}
            options={[
              // Local command servers spawn a process; desktop only.
              ...(mobile ? [] : [{ value: "stdio" as McpServer["transport"], label: "Local command" }]),
              { value: "http", label: "Remote URL" },
            ]}
          />
        </Field>
      </div>

      {s.transport === "stdio" ? (
        mobile ? (
          <ResultBox ok={false}>
            Local command (stdio) servers run on the desktop app only. On this device, add the server as a Remote URL instead.
          </ResultBox>
        ) : (
        <>
          <Field label="Command" hint="The program that starts the server, e.g. npx, uvx, node, python or a full path.">
            <input className={`${inputCls} font-mono`} value={s.command} spellCheck={false} onChange={(e) => upd({ command: e.target.value })} />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <textarea
              className={`${inputCls} font-mono text-xs`}
              rows={3}
              spellCheck={false}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents"}
              value={argsText}
              onChange={(e) => {
                setArgsText(e.target.value);
                setTools(null);
              }}
            />
          </Field>
          <div>
            <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Environment variables</span>
            <span className="mb-2 block text-xs text-zinc-500">Values are stored in your OS keychain.</span>
            <SecretRows rows={rows} kind="env" onChange={setRows} />
          </div>
        </>
        )
      ) : (
        <>
          <Field label="URL" hint="A Streamable HTTP MCP endpoint, e.g. https://example.com/mcp">
            <input className={`${inputCls} font-mono`} value={s.url} spellCheck={false} onChange={(e) => upd({ url: e.target.value })} />
          </Field>
          <div>
            <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Headers</span>
            <span className="mb-2 block text-xs text-zinc-500">For tokens such as Authorization. Stored in your OS keychain.</span>
            <SecretRows rows={rows} kind="header" onChange={setRows} />
          </div>
        </>
      )}

      <Field label="Default in chats" hint="You can change it per chat from the Tools button in the composer.">
        <Segmented value={s.default_mode} onChange={(default_mode) => upd({ default_mode })} options={MODE_OPTIONS} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-start gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-indigo-600"
            checked={s.share_images}
            onChange={(e) => upd({ share_images: e.target.checked })}
          />
          <span>
            <span className="block text-sm font-medium">Share images with the room</span>
            <span className="block text-xs text-zinc-500">
              Images the server returns, and fresh image files it points to (like ComfyUI renders or Blender screenshots), appear in the
              chat for everyone.
            </span>
          </span>
        </label>
        <Field label="Tool timeout (seconds)" hint="Raise it for slow tools such as image generation (e.g. 600).">
          <input
            className={inputCls}
            type="number"
            min={5}
            max={3600}
            value={s.timeout_secs}
            onChange={(e) => upd({ timeout_secs: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>

      {error && <ResultBox ok={false}>{error}</ResultBox>}
      {tools && (
        <ResultBox ok>
          <div className="font-medium">
            Connected · {tools.length} tool{tools.length === 1 ? "" : "s"}
          </div>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {tools.map((t) => (
              <li key={t.name}>
                <span className="font-mono">{t.name}</span>
                {t.description && <span className="opacity-75"> — {t.description.slice(0, 120)}</span>}
              </li>
            ))}
          </ul>
        </ResultBox>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button variant="outline" onClick={test} disabled={busy !== null}>
          {busy === "test" ? "Connecting…" : "Test & list tools"}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save server"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function McpPanel() {
  const client = useChat((s) => s.client)!;
  const refreshClient = useChat((s) => s.refreshClient);
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);

  if (editing) {
    return <McpEditor initial={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;
  }

  const remove = async (s: McpServerView) => {
    if (!(await confirmAction("Remove MCP server", `Remove "${s.name}" and its stored secrets?`, "Remove"))) return;
    await backend.deleteMcpServer(s.id);
    await refreshClient();
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        MCP servers give the AI tools, like reading files or searching the web. Local command servers run on this device; Remote URL
        servers run at their own address, and the tool calls are sent there. Either way they're only used for replies generated with your
        profiles. The room sees which tool ran, not its inputs or results, unless you let a server share its images.
      </p>
      {client.platform !== "desktop" && (
        <p className="text-sm text-zinc-500">
          On phones only <span className="font-medium">Remote URL</span> (HTTP) servers are available — local command servers run in the
          desktop app.
        </p>
      )}
      {client.mcp_servers.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No MCP servers yet.
        </div>
      )}
      {client.mcp_servers.map((s) => (
        <div key={s.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            <Icon name="server" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{s.name}</div>
            <div className="truncate font-mono text-xs text-zinc-500">
              {s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url.replace(/\?.*$/, "")}
            </div>
            <div className="text-xs text-zinc-500">
              Default in chats: {MODE_OPTIONS.find((m) => m.value === s.default_mode)?.label} · timeout {s.timeout_secs}s
              {s.share_images ? " · shares images" : ""}
            </div>
          </div>
          <Button variant="ghost" onClick={() => setEditing(s)}>
            Edit
          </Button>
          <Button variant="danger" onClick={() => remove(s)}>
            Remove
          </Button>
        </div>
      ))}
      <Button variant="outline" onClick={() => setEditing("new")} className="w-full">
        <Icon name="plus" size={16} /> Add MCP server
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ General

function GeneralPanel() {
  const client = useChat((s) => s.client)!;
  const saveIdentity = useChat((s) => s.saveIdentity);
  const [name, setName] = useState(client.display_name);
  const [url, setUrl] = useState(client.server_url);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [appearance, setAppearance] = useAppearance();

  const save = async () => {
    try {
      await saveIdentity(name, url);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <Field label="Display name">
          <input className={inputCls} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Relay server" hint="WebSocket URL of the relay, e.g. ws://192.168.1.20:8787/ws">
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-zinc-500">
            Instance: <code>{client.instance}</code> · User id: <code>{client.user_id.slice(0, 8)}</code>
          </span>
          <div className="flex items-center gap-3">
            {msg && <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</span>}
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      </div>

      <div className="space-y-3 border-t border-zinc-200 pt-5 dark:border-zinc-800">
        <h3 className="text-sm font-semibold">Appearance</h3>
        <Field label="Mode">
          <Segmented
            value={appearance.mode}
            onChange={(mode: Mode) => setAppearance({ mode })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Theme</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                onClick={() => setAppearance({ palette: p.id })}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                  appearance.palette === p.id
                    ? "border-indigo-500 ring-2 ring-indigo-500/20"
                    : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
                }`}
              >
                <span className="flex -space-x-1">
                  <span className="h-4 w-4 rounded-full ring-2 ring-white dark:ring-zinc-900" style={{ background: p.swatch[0] }} />
                  <span className="h-4 w-4 rounded-full ring-2 ring-white dark:ring-zinc-900" style={{ background: p.swatch[1] }} />
                </span>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export type SettingsTab = "general" | "profiles" | "mcp";

export function SettingsDialog({ onClose, tab: initialTab = "general" }: { onClose: () => void; tab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="mb-5 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/60">
        {(
          [
            ["general", "General"],
            ["profiles", "AI profiles"],
            ["mcp", "MCP servers"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === id ? "bg-white shadow-sm dark:bg-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "general" ? <GeneralPanel /> : tab === "profiles" ? <ProfilesPanel /> : <McpPanel />}
    </Modal>
  );
}
