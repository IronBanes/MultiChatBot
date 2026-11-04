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
| `hello` | `user_id, display_name, device_id?, device_name?, platform?` | also used to rename; optional fields identify the device for linking |
| `create_room` | `request_id, name` | → `room_joined` |
| `join_room` | `request_id, invite_code` | → `room_joined` |
| `leave_room` | `room_id` | |
| `open_room` | `room_id` | → `room_history` |
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
| `create_link_code` | `request_id` | → `link_code`; one live code per user, valid 10 min, single use |
| `redeem_link_code` | `request_id, code` | → `linked` with the code owner's `user_id` and `display_name`; max 5 failed tries per connection |

### Server → client

| type | fields |
|---|---|
| `welcome` | `user_id, rooms: RoomInfo[]` |
| `room_joined` | `request_id?, room: RoomInfo` |
| `room_left` | `room_id` |
| `room_history` | `room_id, messages: Message[]` |
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
| `link_code` | `request_id, code, expires_in_secs` |
| `linked` | `request_id, user_id, display_name` |
| `devices` | `devices: Device[]` (sent after hello and whenever one of the user's devices goes on- or offline) |
| `error` | `request_id?, message` |

`RoomInfo = {id, name, invite_code, system_prompt, members: Member[]}`
`Member = {user_id, display_name, online}`
`Device = {device_id, device_name, platform}`
`Reaction = {emoji, user_ids}` (grouped per emoji, in first-use order)
`Message = {id, room_id, seq, kind, author_id, author_name, content, reasoning, tools,
            attachments, reactions, ai_requested, anchor_id, model, reply_to, status, error,
            created_at, edited_at, deleted}`

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
