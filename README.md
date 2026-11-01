# Multichat — a group chat where everyone brings their own AI

Real people chat together in rooms, and an AI takes part in the conversation. Every AI
reply is generated with the **API profile of the person whose message triggered it**
(their provider, endpoint, model and key). To the room it looks like one shared AI
participant, but the model behind it can change from message to message.

```
Alice: Let's generate a square.          → AI · via Alice · gpt-4o-mini
Bob:   What if it had rounded edges?     → AI · via Bob · claude-opus-5-5   (sees the whole history)
```

**API keys never leave your machine.** They live in your OS keychain. The Rust side of
the desktop app makes every LLM call and then broadcasts the resulting text to the room
through the relay. The relay server never sees keys or endpoints.

## Layout

| Path | What |
|---|---|
| `server/` | Relay: Rust, axum, tokio, WebSockets, SQLite (sqlx). Syncs rooms, members, presence and messages. |
| `app/` | Desktop client: Tauri v2, React, TypeScript, Vite, Tailwind. |
| `app/src-tauri/` | Rust backend: profiles, keychain, providers, context building, streaming. |
| `docs/PLAN.md` | WebSocket protocol, data models and context-building rules. |
| `tools/smoke-test.mjs` | Two scripted clients that exercise the relay protocol end to end. |
| `tools/mock-llm.mjs` | Fake OpenAI and Anthropic streaming server for testing without API keys. |

## Prerequisites

- Rust (stable) and the [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS. Windows needs the WebView2 runtime, which ships with Windows 11.
- Node.js 22 or newer.

## Run it locally (server and two clients)

**1. Start the relay**

```bash
cd server
cargo run
```

It listens on `ws://127.0.0.1:8787/ws` and stores data in `server/multichat.db`.
You can change this with `MULTICHAT_ADDR` (e.g. `0.0.0.0:8787` to allow other machines
on your LAN) and `MULTICHAT_DB`.

**2. Start the first client (Alice)**

```bash
cd app
npm install
npm run tauri dev
```

**3. Start a second client (Bob)** in another terminal, while the first one is running:

```bash
cd app
npm run instance -- bob
```

Each instance name (`MULTICHAT_INSTANCE`) has its own user id, display name, profiles
and settings, so one machine can act as several people. Add more with
`npm run instance -- carol`. The first window uses the instance `default`.

**4. Try it**

1. Pick a display name in each window.
2. Alice: **New**, then name the room. Copy the invite code from the room header.
3. Bob: **Join**, then paste the code.
4. Each person opens **Settings → AI profiles → Add profile** and clicks **Test connection**.
5. Send messages. The composer has a profile picker and an **AI reply on/off** toggle
   for messages meant only for the humans.

### Testing without API keys

```bash
node tools/mock-llm.mjs        # http://127.0.0.1:9999
```

Create profiles that point at it:

| Provider type | Base URL | Model | Key |
|---|---|---|---|
| OpenAI-compatible | `http://127.0.0.1:9999/v1` | any | any |
| Anthropic Messages | `http://127.0.0.1:9999` | any | any |

The key `bad` returns a 401, so you can see error handling. The key `slow` streams slowly,
so you can try **Stop**, concurrent replies, or closing a window mid-reply (the reply then
shows as *interrupted*). The mock prints the exact context it received for each request,
including the merged roles, trimming and the room instructions.

### Automated checks

```bash
cd server && cargo run                      # in one terminal
node tools/smoke-test.mjs                   # relay protocol test with two clients
cd app/src-tauri && cargo test              # context building, trimming, error sanitizing
```

## Profiles

A profile is a label, provider type, base URL, model, API key, max context tokens and an
optional temperature.

- **OpenAI-compatible** (`{base}/chat/completions`) covers OpenAI, OpenRouter, Groq,
  Ollama, LM Studio and others. Presets are built in.
- **Anthropic Messages** (`{base}/v1/messages`, API version `2026-10-21`). That API
  version rejects `temperature`, so it is not sent for Anthropic profiles.

Keys are stored in the OS keychain (Windows Credential Manager, macOS Keychain or the
Linux Secret Service) under the service `multichat-bot`. The other profile fields are
stored in `<app config dir>/instances/<instance>/config.json`, together with your user
id, display name, server URL and the last-used profile for each room.

To add a provider, implement the `Provider` trait in `app/src-tauri/src/providers/` and
add a `ProviderKind` variant.

## How a reply works

1. You send a message. The relay persists it and broadcasts it to the room.
2. When your client receives its own message back from the relay, it sends `ai_start`
   and asks the Rust side to generate a reply. Rust builds the context from the room
   history up to and including your message:
   - Human messages become `user` turns as `[Name]: text`, including human-only messages.
   - Completed AI replies become `assistant` turns, whichever profile generated them.
   - Consecutive same-role turns are merged so that roles alternate.
   - The oldest messages are trimmed to fit the profile's max context tokens, using a
     rough estimate of 4 characters per token. The system prompt and your message are
     always kept.
   - The group-chat system prompt is followed by the room's shared instructions, if any.
3. Rust streams from the provider and batches deltas about every 100 ms. Your client
   relays them as `ai_delta`, then sends `ai_complete` with the full text (which the
   relay persists) or `ai_error` with a short, sanitized reason.
4. If you disconnect mid-stream, the relay marks the reply as **interrupted** and keeps
   the partial text.

Several replies can stream at once, and each is anchored to its triggering message.
**Regenerate with my profile** on any AI reply creates a sibling reply to the same
message, generated with your own model.

## Security notes

- Message content is rendered as Markdown with raw HTML disabled. `javascript:` links
  are neutralized, links open in the system browser, and remote images are never loaded.
- The HTML, SVG and CSS preview runs in an `<iframe sandbox="">`, so scripts, forms and
  same-origin access are all disabled.
- Error text from providers has the key, the base URL and the host, plus anything that
  looks like a key or URL, removed before it is shown or broadcast.
- v1 has no accounts. Anyone with an invite code can join that room, and a user id is
  just a locally generated UUID. Run the relay only where you trust the network, or put
  it behind TLS (`wss://`) and a reverse proxy.
