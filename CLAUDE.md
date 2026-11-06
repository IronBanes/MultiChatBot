# Multichat

A group chat where everyone brings their own AI. Tauri desktop and mobile app (React + Rust) talking to an axum WebSocket relay with SQLite.

## Where things are

- `app/src/store.ts`: client state and the handling of every relay message.
- `app/src/components/`: UI. `RoomView.tsx` and `Settings.tsx` are large, so search them and read only the part you need.
- `app/src-tauri/src/`: Rust client (`lib.rs` commands, `config.rs`, `secrets.rs`, `context.rs`, providers).
- `server/src/`: relay (`hub.rs` handlers, `db.rs`, `protocol.rs`).
- `docs/PLAN.md`: data models, WebSocket protocol, accounts, delegated replies, notifications. Check it before changing the protocol, and update it when you do.
- `tools/`: `smoke-test.mjs` (relay protocol test), `mock-llm.mjs` and `mock-mcp.mjs` (no real keys needed).

Roadmap: GitHub issue #22.

## Checks

Run the ones that cover what you changed. Each line starts from the repo root.

```bash
(cd app && npm run build)
(cd app/src-tauri && cargo check && cargo clippy && cargo test)
(cd server && cargo test)
```

For protocol changes, start the relay on a throwaway database and leave it running, because the smoke test leaves its rooms and messages behind:

```bash
(cd server && MULTICHAT_DB=target/smoke-test.db cargo run)
```

Then run `node tools/smoke-test.mjs` (Node 22+) from the repo root in a second terminal. Delete `server/target/smoke-test.db*` after stopping the relay.

Android and iOS builds run in GitHub Actions on manual dispatch and `v*` tag pushes. On pull requests they run only when `app/**` or their own workflow file changes, so other pull requests get no mobile build.

## Rules

- Work on a branch from up-to-date `origin/main` and open a pull request. Don't commit to `main`. CodeRabbit reviews pull requests.
- Add new Tauri commands to the handler list in `lib.rs`.
- On phones, inputs use `text-base` (16px) and tappable rows are at least 44px tall.
- Keep message rows memoized. Logic that reacts to relay messages belongs in the store, not in components.
- Secrets live in the OS keychain, never in config files or logs. Android is the exception: it has no keychain here, so `secrets.rs` keeps them in an app-private `secrets.json`. The relay stores only a hash of each account secret.
- A key is stored with the endpoint it belongs to. Never send a key to a different endpoint.
- Relay changes that touch accounts or shared state must keep the existing locks (`auth_lock`, `updates_lock`).
- Document user-facing changes in `README.md`.
