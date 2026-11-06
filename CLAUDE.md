# Multichat

A group chat where everyone brings their own AI. Tauri desktop and mobile app (React + Rust) talking to an axum WebSocket relay with SQLite.

## Where things are

- `app/src/store.ts`: client state and the handling of every relay message.
- `app/src/components/`: UI. `RoomView.tsx` and `Settings.tsx` are large, so search them and read only the part you need.
- `app/src-tauri/src/`: Rust client (`lib.rs` commands, `generate.rs` AI replies and tool rounds, `mcp.rs` MCP client, `config.rs`, `secrets.rs`, `context.rs`, `host.rs` in-app relay, providers).
- `server/src/`: relay (`hub.rs` handlers, `db.rs`, `protocol.rs`).
- `docs/PLAN.md`: data models, WebSocket protocol, accounts, delegated replies, remote control, notifications. Check it before changing the protocol, and update it when you do.
- `tools/`: `smoke-test.mjs` (relay protocol test), `mock-llm.mjs` and `mock-mcp.mjs` (no real keys needed).

Roadmap: GitHub issue #22.

## Checks

Run the ones that cover what you changed. Each line starts from the repo root, and the commands are for Git Bash, so on Windows `VAR=value cmd` won't work in PowerShell.

```bash
(cd app && npm run build)
(cd app/src-tauri && cargo check && cargo clippy && cargo test)
(cd server && cargo test)
```

`cargo clippy` already reports 7 style warnings in code that predates this guide. Fix new warnings only.

For protocol changes, start a separate relay on its own port and throwaway database and leave it running, because the smoke test leaves its rooms and messages behind:

```bash
(cd server && mkdir -p target && MULTICHAT_ADDR=127.0.0.1:8788 MULTICHAT_DB=target/smoke-test.db cargo run)
```

Then, from the repo root in a second terminal (Node 22+):

```bash
node tools/smoke-test.mjs ws://127.0.0.1:8788/ws
```

Delete `server/target/smoke-test.db*` after stopping the relay. If the files are locked, the relay is still running: stop the process listening on port 8788.

Android and iOS builds run in GitHub Actions on manual dispatch and `v*` tag pushes. On pull requests they run only when `app/**` or their own workflow file changes, so other pull requests get no mobile build.

For changes the smoke test can't reach, such as anything between two linked devices, drive real app instances:

1. On a clean checkout, install the frontend dependencies (`(cd app && npm ci)`). Build the debug app (`(cd app/src-tauri && cargo build)`). Then run Vite on port 1420 (`(cd app && npx vite --port 1420 --strictPort)`), a throwaway relay and `node tools/mock-llm.mjs <port>`. Debug builds load the UI from Vite.
2. Start `app/src-tauri/target/debug/multichat.exe` once per device, each with its own `WEBVIEW2_USER_DATA_FOLDER`, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` (Windows only) and `MULTICHAT_INSTANCE`. Pick an unused name of 1 to 32 ASCII letters, digits, `-` or `_`, and confirm `%APPDATA%\com.multichat.app\instances\<name>` doesn't exist first. An existing name loads that instance's real settings, and other characters are stripped, so `bob!` opens `bob`.
3. From a Node script, connect to the target listed at `http://localhost:<port>/json/list` and use `Runtime.evaluate`. `await import('/src/store.ts')` gives the live store, and `window.__TAURI_INTERNALS__.invoke` calls backend commands. New instances use the relay on port 8787, so call the store's `saveIdentity(name, url)` with the throwaway relay's URL, which must end in `/ws`. New instances have no profiles, so create one with the `save_profile` command, using base URL `http://127.0.0.1:<port>/v1` for the mock LLM, then call the store's `refreshClient()` so linked devices see it. To ask another device for a reply, select it with `chooseProfile(roomId, 'remote:<device id>:<profile id>')`.
4. Clean up afterwards. Note the test ids during the run, then remove their keychain entries: `profile:<id>`, `mcp:<id>` if created, and `account:<instance>:<user id>` for every account an instance used, including the one it linked to. Targets end in `.multichat-bot`. Then delete only the instance folders this run created.

Stop test processes by exact port or PID, and delete keys by their exact test id. Never match on a name like `multichat`: that can hit the user's own app and secrets.

## Rules

- Work on a branch from up-to-date `origin/main` and open a pull request. Don't commit to `main`. CodeRabbit reviews pull requests.
- Add new Tauri commands to the handler list in `lib.rs`.
- On phones, inputs use `text-base` (16px) and tappable rows are at least 44px tall.
- Keep message rows memoized. Logic that reacts to relay messages belongs in the store, not in components.
- Secrets live in the OS keychain, never in config files or logs. Android is the exception: it has no keychain here, so `secrets.rs` keeps them in an app-private `secrets.json`. The relay stores only a hash of each account secret.
- A key is stored with the endpoint it belongs to. Never send a key to a different endpoint.
- Relay changes that touch accounts or shared state must keep the existing locks (`auth_lock`, `updates_lock`).
- Remote control: the relay can forge commands, so the receiving desktop enforces the limits. It's off by default and only set at the desktop, a linked device can never set Auto, and every tool call in a delegated reply needs approval. Check the setting in Rust under the settings lock as each command runs (`Config::allow_remote`), never from the app's cached copy. See `docs/PLAN.md`.
- Document user-facing changes in `README.md`.
