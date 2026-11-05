# Multichat — design plan

Group chat where every AI reply is generated with the API profile of the human whose
message triggered it. The relay server never sees keys or endpoints.

```
┌──────────── client A (Tauri) ────────────┐        ┌──── relay (axum) ────┐
│ webview (React)  ── invoke/Channel ──► Rust│◄─ws──►│ rooms, members,      │◄─ws─► client B
│  WS to relay                   LLM calls ─┼──►LLM │ messages (SQLite)    │
└──────────────────────────────────────────┘        └──────────────────────┘
```

* The webview owns the WebSocket to the relay.
* The Rust side owns profiles, the OS keychain and **all** LLM HTTP calls. It streams
  batched deltas (~100 ms) back to the webview over a `tauri::ipc::Channel`; the webview
  forwards them to the relay as `ai_delta`.

## Data models

### Server (SQLite)

```sql
users    (id TEXT PK, display_name TEXT, updated_at INTEGER)
rooms    (id TEXT PK, name TEXT, invite_code TEXT UNIQUE, system_prompt TEXT,
          created_by TEXT, created_at INTEGER)
members  (room_id TEXT, user_id TEXT, joined_at INTEGER, PRIMARY KEY(room_id, user_id))
messages (seq INTEGER PK AUTOINCREMENT,      -- global ordering
          id TEXT UNIQUE,                    -- client-generated UUID
          room_id TEXT, kind TEXT,           -- 'human' | 'ai'
          author_id TEXT, author_name TEXT,  -- human: author. ai: triggering user
          content TEXT,
          reasoning TEXT,                    -- ai: streamed reasoning, if any
          tools TEXT,                        -- ai: JSON [{call_id, server, tool, status}]
          ai_requested INTEGER,              -- human: did it ask for an AI reply
          anchor_id TEXT,                    -- ai: triggering human message id
          model TEXT,                        -- ai: model name (never base URL / key)
          reply_to TEXT,                     -- human: message id this one replies to
          status TEXT,                       -- 'complete'|'streaming'|'error'|'interrupted'
          error TEXT, created_at INTEGER,
          edited_at INTEGER,                 -- set when the text was edited
          deleted INTEGER DEFAULT 0)         -- soft delete: content blanked, row kept
attachments (id TEXT PK, message_id TEXT, room_id TEXT, mime TEXT,
             call_id TEXT, width INTEGER, height INTEGER,
             data TEXT,                      -- base64 image
             created_at INTEGER)        -- source of truth for a reply's images,
                                        -- written at upload so they survive disconnects
reactions (message_id TEXT, room_id TEXT, user_id TEXT, emoji TEXT,
            created_at INTEGER, PRIMARY KEY(message_id, user_id, emoji))  -- emoji reactions
messages_fts                               -- FTS5 full-text index over messages.content
                                              (external content, synced by triggers; built
                                              once at startup, then maintained on insert,
                                              edit and delete)
```

On startup any leftover `streaming` rows become `interrupted`.
Partial text of in-flight streams is kept in memory so late joiners see it.

### Client (local, per instance)

`<app config dir>/<instance>/config.json` (instance = `MULTICHAT_INSTANCE` env var,
default `default`, so several clients can run on one machine):

```jsonc
{
  "user_id": "uuid", "display_name": "Alice",
  "server_url": "ws://127.0.0.1:8787/ws",
  "last_profile_by_room": { "<room_id>": "<profile_id>" },
  "profiles": [{
    "id": "uuid", "label": "Claude", "provider": "anthropic" | "openai",
    "base_url": "https://api.anthropic.com", "model": "claude-opus-5-5",
    "max_context_tokens": 100000, "temperature": null
  }]
}
```

API keys: OS keychain via `keyring`, service `multichat-bot`, account `profile:<id>`.

## WebSocket protocol

JSON text frames, `{"type": "...", ...}` (snake_case). One socket per client carries
all rooms. The first client frame must be `hello`.

### Client → server

| type | fields | notes |
|---|---|---|
| `hello` | `user_id, display_name, device_id?, device_name?, platform?, secret` | also used to rename; optional fields identify the device for linking; `secret` signs in to the account (see Accounts) |
| `create_room` | `request_id, name` | → `room_joined` |
| `join_room` | `request_id, invite_code` | → `room_joined` |
| `leave_room` | `room_id` | |
| `open_room` | `room_id` | → `room_history` (the newest 200 messages) |
| `load_older` | `room_id, before_seq, until_seq?` | → `older_messages`: the next 100 messages older than `before_seq`, oldest first; with `until_seq` (a search jump target) the page reaches back to include that message plus context, capped at 2000 rows — the client asks again from there; members only |
| `send_message` | `room_id, id, content, ai_requested, reply_to?` | human message; `reply_to` must be a non-deleted message in the room |
| `ai_start` | `room_id, id, anchor_id, model` | anchor = human msg in room |
| `ai_delta` | `room_id, id, delta` | only from the stream's owner connection |
| `ai_reasoning` | `room_id, id, delta` | reasoning text, same rules as `ai_delta` |
| `ai_tool` | `room_id, id, activity: {call_id, server, tool, status}` | MCP tool status; no arguments or results |
| `ai_attachment` | `room_id, id, attachment: {attachment_id, mime, call_id, width, height}, data` | tool image (base64, ≤ ~4.5 MB, png/jpeg/webp/gif), max 8 per reply |
| `get_attachment` | `attachment_id` | → `attachment`; only for members of the image's room |
| `ai_complete` | `room_id, id, content` | full final text, persisted with reasoning, tool activity and attachments |
| `ai_error` | `room_id, id, error` | short, sanitized reason |
| `set_room_prompt` | `room_id, system_prompt` | any member |
| `react` | `room_id, message_id, emoji, on` | add (`on` true) or remove a reaction; any member, any message; ≤ 20 distinct emoji per message |
| `typing` | `room_id, typing` | live "I'm typing" state; members only, relayed as `typing` and never stored; the relay passes at most one `typing: true` per second per connection, and a `typing: false` only when it ends a relayed `true` and no other device of that user is still typing there |
| `edit_message` | `room_id, message_id, content` | edit your own human message; same empty/length rule as `send_message` → `message_updated` |
| `delete_message` | `room_id, message_id` | soft-delete your own message (human, or an AI reply you generated; not while streaming) → `message_updated` |
| `share_profiles` | `profiles: SharedProfile[]` | this connection's profiles the user's other devices may generate with (≤ 50; label/model clipped like names); broadcast as a refreshed `devices` to the user's connections |
| `request_ai` | `request_id, room_id, anchor_id, device_id, profile_id` | ask one of the user's own devices to reply to `anchor_id` with its local profile → `ai_requested` there (or `error` with the request_id); the sender must be in the room, the anchor a non-deleted human message of that room, the target an online connection of the same user's device that is in the room and not the sender's own connection; nothing is stored |
| `ai_request_failed` | `request_id, to_device_id, message` | the target's answer when it can't; relayed to the asking device's connections of the same user as `error` with the request_id (message clipped like `ai_error`) |
| `create_link_code` | `request_id, secret` | → `link_code`; one live code per user, valid 10 min, single use; `secret` must be the account's (it's handed to the redeeming device) |
| `redeem_link_code` | `request_id, code` | → `linked` with the code owner's `user_id` and `display_name`; max 5 failed tries per connection |
| `search_messages` | `request_id, room_id, query` | full-text search of that room's messages (prefix match on the last word, ≤ 200 chars); → `search_results`; members only |

### Server → client

| type | fields |
|---|---|
| `welcome` | `user_id, rooms: RoomInfo[]` |
| `room_joined` | `request_id?, room: RoomInfo` (also sent, without a request id, to the account's other connections) |
| `room_left` | `room_id` |
| `room_history` | `room_id, messages: Message[], has_more` (newest 200; `has_more` true when older messages exist) |
| `older_messages` | `room_id, messages: Message[], has_more` (answers `load_older`; page of 100, oldest first — or the stretch reaching to `until_seq`) |
| `search_results` | `request_id, room_id, hits: SearchHit[]` (answers `search_messages`; newest first, max 50) |
| `message` | `room_id, message: Message` (human, or AI on `ai_start` with status `streaming`) |
| `ai_delta` | `room_id, id, delta` |
| `ai_reasoning` | `room_id, id, delta` |
| `ai_tool` | `room_id, id, activity` |
| `ai_attachment` | `room_id, id, attachment` (metadata only) |
| `attachment` | `attachment_id, mime, data` |
| `ai_complete` | `room_id, id, content` |
| `ai_error` | `room_id, id, error` |
| `ai_interrupted` | `room_id, id, content` (partial) |
| `member_joined` / `member_updated` | `room_id, member: Member` |
| `member_left` | `room_id, user_id` |
| `presence` | `room_id, user_id, online` |
| `typing` | `room_id, user_id, display_name, typing` (ephemeral; never persisted) |
| `room_updated` | `room_id, system_prompt, updated_by` |
| `reactions` | `room_id, message_id, reactions: Reaction[]` (the message's full current list) |
| `message_updated` | `room_id, message: Message` (the full row after an edit or delete) |
| `ai_requested` | `request_id, room_id, anchor_id, profile_id, from_device_id` (answers `request_ai`; delivered to the target device's first matching connection only, never stored) |
| `link_code` | `request_id, code, expires_in_secs` |
| `linked` | `request_id, user_id, display_name, secret` (the account's secret) |
| `devices` | `devices: Device[]` (sent after hello and whenever one of the user's devices goes on- or offline, or shares profiles) |
| `error` | `request_id?, message` |

`RoomInfo = {id, name, invite_code, system_prompt, members: Member[]}`
`Member = {user_id, display_name, online}`
`Device = {device_id, device_name, platform, profiles: SharedProfile[]}` (empty unless that device sent `share_profiles`)
`SharedProfile = {id, label, model}`
`Reaction = {emoji, user_ids}` (grouped per emoji, in first-use order)
`Message = {id, room_id, seq, kind, author_id, author_name, content, reasoning, tools,
            attachments, reactions, ai_requested, anchor_id, model, reply_to, status, error,
            created_at, edited_at, deleted}`
`SearchHit = {id, seq, kind, author_name, created_at, snippet}` — the snippet's matched
words are wrapped in STX/ETX control characters (\u0002 / \u0003) for highlighting.

### AI reply lifecycle

```
sender client                  relay                         others
send_message ───────────────►  persist, broadcast `message` ──►
ai_start ───────────────────►  insert streaming row, broadcast `message`(streaming)
   (Rust streams provider, flushes every ~100ms)
ai_delta × n ───────────────►  append in-memory buffer, broadcast ──►
ai_complete ────────────────►  persist final text, broadcast ──►
   or ai_error ─────────────►  persist status=error, broadcast ──►
socket closes mid-stream  ──►  status=interrupted (partial kept), broadcast ai_interrupted
```

### Accounts

A user id is visible to every member of a room, so it can't prove who's connecting. Each
account also has a secret (64 random hex characters, made by the app and kept in the OS
keychain, or the app's private file store on Android). `hello` sends it; the relay keeps
only its SHA-256 (`users.secret_hash`) and refuses a `hello` whose secret doesn't match
("This device isn't signed in to that account"), so an impostor gets no rooms, history,
device list or `request_ai`. A new account sets its secret on first connect; an account
from before secrets claims one on its next connect (trust on first use), and until then a
client too old to send one is still let in. A link code carries the account's secret (in
the relay's memory, for the code's ten minutes) to the device that redeems it; unlinking
deletes it from that device.

### Delegated replies (device linking, phase 2)

Linked devices share one account, so a phone with no API keys can still get AI replies:
the desktop client publishes its profiles' `{id, label, model}` with `share_profiles`
(desktop platforms only; phones share nothing), and the relay lists them in that user's
`devices` frame. The phone picks one as `remote:<device_id>:<profile_id>` and, once its
message echoes back, sends `request_ai` instead of `ai_start`. The relay forwards it as
`ai_requested` to that device — same user, in the room, not the asking connection — and
the desktop generates the reply exactly like a local one (`ai_start` → `ai_delta` → …),
so the reply is authored by the same account either way. Keys, base URLs and MCP secrets
never leave the desktop; only id/label/model are shared, and nothing about the request is
stored. If the desktop can't comply (profile gone, room not loadable, anchor beyond the
loaded history) it answers `ai_request_failed`, which the relay turns into an `error`
frame on the asking device. A delegated generation runs **without MCP tools**: nobody is
at the desktop to approve them, and the relay identifies a user only by the id sent in
`hello`, so it can't yet prove a request came from the user's own device. Tools come back
for delegated replies once connections are authenticated, with approvals on the phone
(phase 3).

## Context building (Rust, `app/src-tauri/src/context.rs`)

1. History = room messages in `seq` order up to and including the anchor; human messages
   (incl. human-only) and *complete* AI messages.
2. Human → `user` `"[Name]: text"`; AI → `assistant` (whoever generated it).
3. System prompt = group-chat preamble + optional room prompt.
4. Trim oldest until `estimate(system) + Σ estimate(msg) + output_reserve ≤ max_context`
   (estimate ≈ chars/4 + 4). The anchor message is always kept.
5. Drop leading `assistant` messages, merge consecutive same-role messages.

## Provider trait

```rust
#[async_trait]
trait Provider { async fn stream_chat(&self, req: &ChatRequest) -> Result<DeltaStream, ProviderError>; }
```

Implementations: `OpenAiCompatible` (`POST {base}/chat/completions`, SSE) and
`Anthropic` (`POST {base}/v1/messages`, `anthropic-version: 2026-10-21`, SSE; no sampling
params since that version rejects them). Errors are sanitized: key, base URL and host are
redacted and the text is truncated.
