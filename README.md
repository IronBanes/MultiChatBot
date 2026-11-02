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
| `start.cmd`, `start.ps1`, `start.sh` | One-step setup and launch for Windows, macOS and Linux. |
| `tools/mock-llm.mjs` | Fake OpenAI and Anthropic streaming server (reasoning, tool calls, model list) for testing without API keys. |
| `tools/mock-mcp.mjs` | Tiny MCP server over stdio with `echo`, `add` and `now` tools. |
| `branding/` | Logo concepts. |

## Quick start (one script per OS)

The start scripts check for everything the app needs and offer to install anything
missing. They then build the app (only when the code has changed) and run it.

| OS | Run |
|---|---|
| Windows | Double-click `start.cmd`, or run `.\start.cmd` in a terminal |
| macOS / Linux | `./start.sh` |

What they check and install:

| | Windows | macOS | Linux |
|---|---|---|---|
| Compiler | Visual Studio C++ Build Tools (winget) | Xcode Command Line Tools | `build-essential` / Development Tools |
| System libraries | WebView2 Runtime (winget) | built in | WebKitGTK 4.1, librsvg, appindicator, OpenSSL, D-Bus (apt, dnf or pacman, via sudo) |
| Rust 1.88+ | rustup (winget) | rustup | rustup |
| Node.js 22+ | Node LTS (winget) | Homebrew, or nvm | nvm (installed in your home folder) |

The scripts ask before installing anything. Add `--yes` to skip the questions. The first
build takes a few minutes; after that the app starts right away.

Options (the same on every OS):

```bash
./start.sh --server              # also host the relay for friends (prints the address to share)
./start.sh --server --port 9000  # host on a different port
./start.sh --instance bob        # a second local identity, for testing on one machine
```

With `--server`, the relay runs until you close the app window. On Windows, allow it
through the firewall on private networks when asked.

### Playing with a friend

1. **Host:** run `start.cmd --server` or `./start.sh --server`.
2. **Friend:** gets the project folder (zip or `git clone`) and runs the start script
   without `--server`.
3. **Connect:** in the app, each of you sets the relay server address on first launch,
   or later in **Settings → General**.
   - **Host:** `ws://127.0.0.1:8787/ws`
   - **Friend on the same Wi-Fi:** the `ws://192.168.x.x:8787/ws` address the host's
     terminal printed.
   - **Friend elsewhere:** the host runs a tunnel such as
     `cloudflared tunnel --url http://localhost:8787`. The friend uses the printed URL
     with `wss://` instead of `https://` and `/ws` added at the end, for example
     `wss://random-words.trycloudflare.com/ws`. Tailscale works too.
4. **Chat:** the host clicks **New** and shares the invite code. The friend clicks
   **Join**. Each of you adds your own AI profile in **Settings → AI profiles**.

## Prerequisites (manual setup)

- Rust (stable) and the [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS. Windows needs the WebView2 runtime, which ships with Windows 11.
  On Linux you also need the D-Bus development package (`libdbus-1-dev`) for the keychain.
- Node.js 22 or newer.

## Run it for development (server and two clients)

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

The mock also lists three models (try **Fetch models**), streams reasoning, and calls a
tool when MCP tools are enabled and your message contains the word "tool". For a test MCP
server, add one in **Settings → MCP servers** with command `node` and the full path to
`tools/mock-mcp.mjs` as the argument.

### Automated checks

```bash
cd server && cargo run                      # in one terminal
node tools/smoke-test.mjs                   # relay protocol test with two clients
cd app/src-tauri && cargo test              # context building, trimming, error sanitizing
```

## Profiles

A profile is a label, provider type, base URL, model, API key, max context tokens, an
optional temperature, and reasoning settings.

- **Fetch models** lists the models your key can use, with context size and whether they
  support reasoning and tools. Picking one fills in its context limit.
- **NanoGPT** has a preset (`https://nano-gpt.com/api/v1`). Its model list includes context
  lengths and capabilities, and for subscription accounts it only shows the models your
  subscription covers.
- **Show reasoning** displays the model's thinking in a collapsible section above the reply.
  OpenAI-compatible providers show it when the model streams `reasoning` or
  `reasoning_content`. For Anthropic it requests summarized thinking, which needs Claude 4.6
  or newer; turn it off for older models. **Reasoning effort** is sent as `reasoning_effort`
  (OpenAI-compatible) or `output_config.effort` (Anthropic).

- **OpenAI-compatible** (`{base}/chat/completions`) covers OpenAI, OpenRouter, Groq,
  Ollama, LM Studio and others. Presets are built in.
- **Anthropic Messages** (`{base}/v1/messages`, API version `2026-10-21`). That API
  version rejects `temperature`, so it is not sent for Anthropic profiles.

Keys are stored in the OS keychain (Windows Credential Manager, macOS Keychain or the
Linux Secret Service) under the service `multichat-bot`. The other profile fields are
stored in `<app config dir>/instances/<instance>/config.json`, together with your user
id, display name, server URL and the last-used profile for each room.

## MCP tools

Add MCP servers in **Settings → MCP servers**: a **local command** (stdio, e.g. `npx -y
@modelcontextprotocol/server-filesystem <folder>`) or a **remote URL** (Streamable HTTP).
Env vars and headers, which often hold tokens, are stored in the OS keychain.
**Test & list tools** connects and shows what the server offers.

Each server has a mode for each chat, set from the **Tools** button in the composer:

| Mode | What happens |
|---|---|
| **Off** | The AI can't use the server in this chat. |
| **Ask** | The AI may call a tool, and you see the arguments and **Allow** or **Deny** each call. |
| **Auto** | Tool calls run without asking. |

A server's **Default in chats** setting applies to chats where you haven't picked a mode.
Tools only run for replies generated with **your** profile, on **your** computer. The room
sees which tool ran and whether it succeeded, never its arguments or results. You can
click a tool chip on your own replies to see those details.

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
   relays text as `ai_delta` and reasoning as `ai_reasoning`. When the model calls MCP
   tools, Rust runs them (asking you first in **Ask** mode), reports each call's status
   as `ai_tool`, and continues the reply with the results. Finally your client sends
   `ai_complete` with the full text (the relay persists it with the reasoning and tool
   activity) or `ai_error` with a short, sanitized reason.
4. If you disconnect mid-stream, the relay marks the reply as **interrupted** and keeps
   the partial text.

Several replies can stream at once, and each is anchored to its triggering message.
**Regenerate with my profile** on any AI reply creates a sibling reply to the same
message, generated with your own model.

## Security notes

- Message content is rendered as Markdown with raw HTML disabled. `javascript:` links
  are neutralized, links open in the system browser, and remote images are never loaded.
- MCP tool arguments and results never leave your machine; the relay only stores tool
  names and statuses. Use **Ask** mode for servers that can change files or send data.
- The HTML, SVG and CSS preview runs in an `<iframe sandbox="">`, so scripts, forms and
  same-origin access are all disabled.
- Error text from providers has the key, the base URL and the host, plus anything that
  looks like a key or URL, removed before it is shown or broadcast.
- v1 has no accounts. Anyone with an invite code can join that room, and a user id is
  just a locally generated UUID. Run the relay only where you trust the network, or put
  it behind TLS (`wss://`) and a reverse proxy.
