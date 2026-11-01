import { useState } from "react";
import { backend, errorText } from "../lib/backend";
import type { Profile, ProfileView, ProviderKind } from "../lib/types";
import { useChat } from "../store";
import { useTheme, type Theme } from "../theme";
import { Button, Field, Icon, inputCls, Modal } from "./ui";

interface Preset {
  name: string;
  provider: ProviderKind;
  base_url: string;
  model: string;
  max_context_tokens: number;
  needsKey: boolean;
}

const PRESETS: Preset[] = [
  { name: "Anthropic", provider: "anthropic", base_url: "https://api.anthropic.com", model: "claude-opus-5-5", max_context_tokens: 200000, needsKey: true },
  { name: "OpenAI", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", max_context_tokens: 128000, needsKey: true },
  { name: "OpenRouter", provider: "openai", base_url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", max_context_tokens: 128000, needsKey: true },
  { name: "Groq", provider: "openai", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", max_context_tokens: 32000, needsKey: true },
  { name: "Ollama", provider: "openai", base_url: "http://localhost:11434/v1", model: "llama3.2", max_context_tokens: 8192, needsKey: false },
  { name: "LM Studio", provider: "openai", base_url: "http://localhost:1234/v1", model: "local-model", max_context_tokens: 8192, needsKey: false },
];

function blankProfile(): Profile {
  const p = PRESETS[0];
  return { id: "", label: p.name, provider: p.provider, base_url: p.base_url, model: p.model, max_context_tokens: p.max_context_tokens, temperature: null };
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
      <div className="grid grid-cols-2 gap-3">
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
      <Field label="Model">
        <input className={inputCls} value={p.model} onChange={(e) => upd({ model: e.target.value })} spellCheck={false} />
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max context tokens">
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
      {result && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            result.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
              : "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
          }`}
        >
          {result.text}
        </div>
      )}
      <div className="flex items-center justify-between pt-1">
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

function ProfilesPanel() {
  const client = useChat((s) => s.client)!;
  const refreshClient = useChat((s) => s.refreshClient);
  const [editing, setEditing] = useState<ProfileView | "new" | null>(client.profiles.length === 0 ? "new" : null);

  if (editing) {
    return <ProfileEditor initial={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;
  }

  const remove = async (p: ProfileView) => {
    if (!window.confirm(`Delete profile "${p.label}" and its stored key?`)) return;
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
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            <Icon name="sparkle" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{p.label}</div>
            <div className="truncate text-xs text-zinc-500">
              {p.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"} · {p.model} · {p.has_key ? "key stored" : "no key"}
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

function GeneralPanel() {
  const client = useChat((s) => s.client)!;
  const saveIdentity = useChat((s) => s.saveIdentity);
  const [name, setName] = useState(client.display_name);
  const [url, setUrl] = useState(client.server_url);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [theme, setTheme] = useTheme();

  const save = async () => {
    try {
      await saveIdentity(name, url);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  return (
    <div className="space-y-4">
      <Field label="Display name">
        <input className={inputCls} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Relay server" hint="WebSocket URL of the relay, e.g. ws://192.168.1.20:8787/ws">
        <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Theme">
        <div className="flex gap-1.5">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={`rounded-lg border px-3 py-1.5 text-sm capitalize ${
                theme === t ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" : "border-zinc-300 dark:border-zinc-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </Field>
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          Instance: <code>{client.instance}</code> · User id: <code>{client.user_id.slice(0, 8)}</code>
        </span>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</span>}
          <Button onClick={save}>Save</Button>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog({ onClose, tab: initialTab = "general" }: { onClose: () => void; tab?: "general" | "profiles" }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="mb-5 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/60">
        {(
          [
            ["general", "General"],
            ["profiles", "AI profiles"],
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
      {tab === "general" ? <GeneralPanel /> : <ProfilesPanel />}
    </Modal>
  );
}
