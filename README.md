# Multichat — a group chat where everyone brings their own AI

Real people chat together in rooms, and an AI takes part in the conversation. Every AI
reply is generated with the **API profile of the person whose message triggered it**
(their provider, endpoint, model and key). To the room it looks like one shared AI
participant, but the model behind it can change from message to message.

```
Alice: Let's generate a square.          → AI · via Alice · gpt-4o-mini
Bob:   What if it had rounded edges?     → AI · via Bob · claude-opus-5-5   (sees the whole history)
```

**API keys stay with you.** They're stored in your OS keychain and only sent to your own
AI provider when the app calls it. The Rust side of the app makes every LLM call and then
broadcasts the resulting text to the room through the relay. The relay server never sees
keys or endpoints.

You can edit or delete your own messages (deleting leaves a "Message deleted" placeholder
for everyone) and reply to any message, with a quote that jumps back to the original.
While someone is writing, the chat shows who is typing. Rooms open at their newest
messages, and scrolling up loads earlier history page by page. Each room also has a
search box that finds messages by their text and jumps straight to them.

## Layout

| Path | What |
|---|---|
| `server/` | Relay: Rust, axum, tokio, WebSockets, SQLite (sqlx). Syncs rooms, members, presence and messages. |
| `app/` | Desktop, iOS and Android client: Tauri v2, React, TypeScript, Vite, Tailwind. |
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

You can also host from inside the desktop app: **Settings → General → Host a relay →
Start hosting**. The app lists the addresses to share (this computer, same Wi-Fi,
Tailscale) and keeps hosting on every launch until you press **Stop**. **Restart**
restarts the relay; everyone reconnects on their own. Phones can't host, because iOS
suspends apps in the background, but they connect to a hosted relay like any desktop.

While the app isn't connected, the sidebar shows why, for example "Nothing is listening at
192.168.1.49:8787", with a **Retry** button that reconnects right away.

To use your phone as the same person as your computer, link them. On the computer, open
**Settings → General → Devices → Create code**. On the phone, enter that code under
**Link to another device**. The phone then shows the computer's rooms, and its messages
count as yours. Codes work once and expire after 10 minutes. **Unlink** returns the phone
to its own account and rooms. AI profiles and MCP servers stay on each device for now.

### Playing with a friend

1. **Host:** run `start.cmd --server` or `./start.sh --server`, or turn on **Host a
   relay** in Settings → General.
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
node tools/smoke-test.mjs                    # relay protocol test with two clients
cd app/src-tauri && cargo test              # context building, trimming, error sanitizing
```

## iOS

The same `app/` builds for iOS as a second Tauri target: the React frontend runs in a
WKWebView and the Rust backend still makes every LLM call. **API keys are stored in the
iOS Keychain** (under the same `multichat-bot` service) and are only sent to your own AI
provider, never to the chat relay.

What works on iOS: everything the desktop app does, except **local command (stdio) MCP
servers**, which iOS cannot support because it forbids spawning child processes. Remote
URL (Streamable HTTP) MCP servers work fully, including **Ask** approvals and tool image
sharing; the settings UI simply hides the Local command option. Run your stdio servers on
your desktop and HTTP servers on either.

On a phone (or any window narrower than 760px) the app switches to a phone layout:
- It opens on a full-screen room list with last-message previews and unread counts.
- A room slides in over the list. The back button, or a swipe from the left edge, returns.
- Messages are chat bubbles: yours on the right, everyone else's on the left, AI replies
  tinted. The newest message sits at the bottom.
- The keyboard shrinks the chat instead of pushing the app up, so the last message, or
  wherever you'd scrolled to, stays in view.
- The **+** next to the message box opens the AI reply, profile and tool options.

iOS builds require macOS with Xcode — a Windows or Linux machine cannot produce them. There
are two supported paths:

### Building on a Mac

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cd app
npm run tauri ios init          # once: generates src-tauri/gen/apple (Xcode project)
npm run tauri icon ../branding/logo.svg   # once, after init: puts the app icon in the Xcode project
npm run tauri ios dev           # run in the iOS Simulator
npm run tauri ios build         # .ipa for a real device
```

- **Simulator**: run the relay on any machine as `MULTICHAT_ADDR=0.0.0.0:8787 cargo run`
  (in `server/`), then join `ws://<that machine's LAN IP>:8787/ws` from the app. The
  simulator uses your Mac's network, so a LAN IP (or `127.0.0.1` from the same Mac) works.
- **Real device**: free Apple account works for development — open
  `app/src-tauri/gen/apple` in Xcode, set your personal team as the signing identity, and
  run on a USB-connected iPhone. Free-account installs expire after 7 days and need a
  re-install; a paid Apple Developer account ($99/yr) unlocks TestFlight and App Store
  distribution.
- **Local network prompt**: the first time the app connects to a LAN relay (e.g.
  `ws://192.168.x.x:8787/ws`), iOS asks for local-network permission once — that's the
  `NSLocalNetworkUsageDescription` in `src-tauri/Info.ios.plist`.
- **`ws://` and `wss://`**: the relay connection is opened by the app's Rust side
  (`tauri-plugin-websocket`), not the webview, so iOS's block on insecure connections from
  secure pages doesn't apply and a `ws://` relay on your LAN works. For friends over the
  internet, keep using the `wss://` tunnels (cloudflared/Tailscale) described above. On
  the phone, plain `ws://` is only accepted for local-network addresses (including
  `.local` names); Tailscale addresses need `wss://`, for example via `tailscale serve`.

### Building with GitHub Actions (no Mac needed)

`.github/workflows/ios.yml` builds the app on a GitHub-hosted macOS runner:

- **build-simulator** — unsigned simulator `.app`, needs **no secrets and no Apple
  account**; it exists to prove every push compiles for iOS. Install the artifact with
  `xcrun simctl install booted <app>` on a Mac.
- **build-unsigned-ipa** — unsigned real-device `.ipa` (artifact `multichat-ios-unsigned`,
  file `multichat-unsigned.ipa`), also with **no secrets**. Sideload it from Windows as
  described below.
- **build-device** — signed `.ipa`, runs on manual dispatch or `v*` tags when the repo has
  these secrets: `IOS_CERTIFICATE` (base64 `.p12`), `IOS_CERTIFICATE_PASSWORD` and
  `IOS_MOBILE_PROVISION` (base64). Without them the job prints a notice and skips, leaving
  the simulator build as the artifact. Side-load the `.ipa` via Xcode → Devices, or upload
  it to TestFlight with Transporter once you have a paid account.

### Sideloading from Windows (no Mac, free Apple ID)

[Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io) can install the
unsigned `.ipa` on a real iPhone; they re-sign it with your Apple ID.

1. Install **iTunes and iCloud from apple.com**, not the Microsoft Store versions —
   Sideloadly and AltServer need the non-Store builds to talk to the phone.
2. Download `multichat-ios-unsigned` from a green run of the **iOS build** workflow
   (Actions tab) and unzip it to get `multichat-unsigned.ipa`.
3. Connect the iPhone over USB, open the `.ipa` in Sideloadly (or AltStore → My Apps →
   `+`), and sign in with a **free Apple ID**.
4. On the phone, turn on **Developer Mode** (Settings → Privacy & Security → Developer
   Mode, then restart), and trust your Apple ID under Settings → General → VPN & Device
   Management.

Free-account installs **expire after 7 days**; re-sign by repeating step 3 (AltStore can
refresh automatically over Wi-Fi). The relay must be reachable from the phone: a
`ws://<LAN IP>:8787/ws` relay on the same Wi-Fi, otherwise a `wss://` tunnel.

## Android

The same `app/` also builds for Android, and it works like the iOS app: the phone
layout, no local command (stdio) MCP servers, and every LLM call made by the Rust
backend. Android has no keychain the app can use, so **API keys and MCP secrets are
kept in `secrets.json` in the app's private storage**, which other apps can't read.

On Android 17 the app asks to find and connect to **nearby devices** the first time it
opens. That's Android's local-network permission, and it's needed to reach a relay on
your home network (for example one hosted from the desktop app). The app connects as
soon as you allow it. Plain `ws://` relays are allowed.

### Getting the APK (no Android tools needed)

The **Android build** GitHub Action builds `multichat.apk` for 64-bit ARM phones
(artifact `multichat-android`) on every pull request that touches `app/`, on `v*` tags
and on manual runs. Copy it to the phone and open it; Android asks you to allow
installs from that app once.

**Set up a signing key before sharing builds.** Android only installs an update signed
with the same key as the installed app. Add two repo secrets: `ANDROID_KEYSTORE` (a
`.jks` keystore, base64-encoded) and `ANDROID_KEYSTORE_PASSWORD`. If the keystore holds
several keys, or the key has its own password, also add `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`. Keep a backup of the keystore and password: without them, no
future build can update the app.

Without those secrets, each run signs with a throwaway key, so an update only installs
after uninstalling the old build. **Uninstalling deletes the app's data**: your name,
profiles, saved API keys and MCP secrets. Note them down first.

### Building locally

You need Android Studio (for the SDK, an emulator and its bundled Java), the NDK
(SDK Manager → SDK Tools → NDK), `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` set, and
`rustup target add aarch64-linux-android x86_64-linux-android`. Then, from `app/`:

```bash
npm run tauri android dev                                  # run on an emulator or phone
npm run tauri android build -- --apk --target aarch64      # release APK for phones
```

On Windows, Tauri links the built library into the Gradle project with a symlink, which
needs **Developer Mode** (Settings → System → For developers).

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
Local command servers are **desktop-only** — iOS forbids spawning child processes, so on a
phone only remote URL servers can be added. Env vars and headers, which often hold tokens,
are stored in the OS keychain. **Test & list tools** connects and shows what the server
offers.

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

Two per-server settings matter for creative tools:

- **Share images with the room** (off by default). Images a tool returns, and fresh image
  files it points to (saved in the last 15 minutes, up to 25 MB), are shown in the chat
  for everyone. They're scaled to at most 1600px and stored by the relay. Turn this on for
  ComfyUI, Blender or Unity screenshots; leave it off for servers that can see private files.
- **Tool timeout** (120 s by default, up to 3600 s). Raise it for slow tools such as image
  generation or renders.

### Example setups

These match common setups; use the paths from your own machine (for example, from your
Claude Desktop or Claude Code MCP config).

| Server | Type | Command / URL | Arguments (one per line) | Env vars | Suggested |
|---|---|---|---|---|---|
| ComfyUI (`comfy-mcp`) | Local command | `…\Python314\Scripts\comfy-mcp.exe` | — | `COMFY_BIN` = path to `comfy.exe`, `COMFY_LOCAL_URL` = `http://127.0.0.1:8188` | Share images on, timeout 600 |
| Unity (built into the Unity CLI) | Local command | `…\Unity\bin\unity.exe` | `mcp`, `--project-path`, `<project folder>` | — | Timeout 300 |
| Unity (MCP for Unity, stdio) | Local command | `…\Scripts\uvx.exe` | `--from`, `mcpforunityserver==10.0.0`, `mcp-for-unity`, `--transport`, `stdio` | — | Timeout 300 |
| Unity (MCP for Unity, HTTP) | Remote URL | `http://127.0.0.1:8080/mcp` | — | — | Timeout 300 |
| Blender (`blender-mcp`) | Local command | `uvx` | `blender-mcp` | — | Share images on, timeout 300 |

ComfyUI must be running, Unity needs the project open (or the CLI to open it), and
Blender needs its MCP add-on enabled with Blender running. Each runs on the computer of
whoever sends the message, so your friends need their own setups to use them.

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
- MCP tool arguments and results are never sent to the relay (only to the MCP server
  itself); the relay only stores tool names and statuses. Use **Ask** mode for servers that can change files or send data.
- The HTML, SVG and CSS preview runs in an `<iframe sandbox="">`, so scripts, forms and
  same-origin access are all disabled.
- Error text from providers has the key, the base URL and the host, plus anything that
  looks like a key or URL, removed before it is shown or broadcast.
- On iOS the same guarantees hold: keys live in the iOS Keychain and every LLM/MCP call is
  made by the Rust backend inside the app, never by the relay.
- On Android keys are not in a hardware-backed keystore: they sit in plain JSON in the
  app's private storage. Other apps can't read that, but a rooted phone or a debug build
  can.
- v1 has no accounts. Anyone with an invite code can join that room, and a user id is
  just a locally generated UUID. Run the relay only where you trust the network, or put
  it behind TLS (`wss://`) and a reverse proxy.
