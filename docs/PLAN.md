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
          summary TEXT,                       -- conversation summary of older messages
          summary_upto_seq INTEGER,           -- seq of the last message it covers (0 = none)
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
| `set_room_summary` | `room_id, summary, upto_seq` | any member; stores the room's shared summary covering messages up to `upto_seq` — only accepted when it is newer than the stored one and doesn't point past the room's last message → `room_summary` |
| `react` | `room_id, message_id, emoji, on` | add (`on` true) or remove a reaction; any member, any message; ≤ 20 distinct emoji per message |
| `typing` | `room_id, typing` | live "I'm typing" state; members only, relayed as `typing` and never stored; the relay passes at most one `typing: true` per second per connection, and a `typing: false` only when it ends a relayed `true` and no other device of that user is still typing there |
| `edit_message` | `room_id, message_id, content` | edit your own human message; same empty/length rule as `send_message` → `message_updated` |
| `delete_message` | `room_id, message_id` | soft-delete your own message (human, or an AI reply you generated; not while streaming) → `message_updated` |
| `share_profiles` | `profiles: SharedProfile[], mcp_servers?: SharedMcpServer[], remote_control?` | this connection's profiles the user's other devices may generate with (≤ 50; label/model clipped like names), and whether they may control it; its servers (≤ 50) are dropped unless `remote_control` is true; broadcast as a refreshed `devices` to the user's connections |
| `request_ai` | `request_id, room_id, anchor_id, device_id, profile_id` | ask one of the user's own devices to reply to `anchor_id` with its local profile → `ai_requested` there (or `error` with the request_id); the sender must be in the room, the anchor a non-deleted human message of that room, the target an online connection of the same user's device that is in the room and not the sender's own connection; nothing is stored |
| `ai_request_failed` | `request_id, to_device_id, message` | the target's answer when it can't; relayed to the asking device's connections of the same user as `error` with the request_id (message clipped like `ai_error`) |
| `device_command` | `request_id, device_id, command: DeviceCommand` | for one of the user's own devices → `device_command` there (or `error` with the request_id); the target is another online connection of the same user's device, the command at most 64 KiB; nothing is stored |
| `device_reply` | `request_id, to_device_id, error?` | the target's answer; relayed to the asking device's connections of the same user as `device_reply`, or as `error` with the request_id when `error` is set |
| `create_link_code` | `request_id, secret` | → `link_code` (8 characters); one live code per user, valid 10 min, single use; `secret` must be the account's (it's handed to the redeeming device) |
| `redeem_link_code` | `request_id, code` | → `linked` with the code owner's `user_id` and `display_name`; max 5 failed tries per connection |
| `search_messages` | `request_id, room_id, query` | full-text search of that room's messages (prefix match on the last word, ≤ 200 chars); → `search_results`; members only |
| `lend_tools` | `room_id, servers: LentServer[]` | replaces what this connection lends in that room (empty = stops lending there); requires membership; ≤ 20 servers, ≤ 100 tools in total, ≤ 256 KiB serialized, names clipped like other names, else `error`; only tool names, descriptions and input schemas ever leave the lender → broadcast as `room_tools` |
| `call_lent_tool` | `request_id, room_id, device_id, server_id, tool, args` | a room member's AI calls a tool of a connection of a room member's `device_id` that currently lends `server_id` containing `tool` there; `args` ≤ 64 KiB, at most 4 outstanding per calling connection → `lent_tool_call` to the lender only (or `error` with the request_id, e.g. "That tool isn't shared here anymore"); never stored |
| `lent_tool_result` | `request_id, content, is_error, images: LentImage[]` | the lender's answer; accepted only from the lender connection recorded for that `request_id`; content clipped to 200,000 chars, ≤ 4 images of png/jpeg/webp/gif and ≤ the attachment size cap (others dropped) → `lent_tool_result` to the caller only, and the pending entry is removed |
| `cancel_lent_tool` | `request_id` | the caller gives up; accepted only from the caller connection → `lent_tool_cancelled` to the lender, pending entry removed |

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
| `room_summary` | `room_id, summary, upto_seq, updated_by` (the summary moved forward; every member's AI uses it) |
| `reactions` | `room_id, message_id, reactions: Reaction[]` (the message's full current list) |
| `message_updated` | `room_id, message: Message` (the full row after an edit or delete) |
| `ai_requested` | `request_id, room_id, anchor_id, profile_id, from_device_id` (answers `request_ai`; delivered to the target device's first matching connection only, never stored) |
| `device_command` | `request_id, from_device_id, command: DeviceCommand` (delivered to the target device's newest connection only, never stored) |
| `device_reply` | `request_id` (the target did what a `device_command` asked) |
| `link_code` | `request_id, code, expires_in_secs` |
| `linked` | `request_id, user_id, display_name, secret` (the account's secret) |
| `devices` | `devices: Device[]` (sent after hello and whenever one of the user's devices goes on- or offline, or shares profiles) |
| `room_tools` | `room_id, user_id, display_name, device_id, servers: LentServer[]` (what one connection lends there: on every `lend_tools`, one per other lending connection when a connection joins or opens the room, and empty `servers` when that connection stops lending — on `lend_tools` with an empty list, leaving, or disconnecting) |
| `lent_tool_call` | `request_id, room_id, from_user_id, from_name, server_id, tool, args` (delivered to the lender connection only; `from_user_id`/`from_name` are stamped by the relay, never taken from the caller; never stored) |
| `lent_tool_result` | `request_id, content, is_error, images: LentImage[]` (delivered to the caller connection only) |
| `lent_tool_cancelled` | `request_id` (the caller gave up; delivered to the lender connection only) |
| `error` | `request_id?, message` |

`RoomInfo = {id, name, invite_code, system_prompt, summary, summary_upto_seq, members: Member[]}`
`Member = {user_id, display_name, online}`
`Device = {device_id, device_name, platform, profiles: SharedProfile[], mcp_servers: SharedMcpServer[], remote_control}` (empty and false unless that device sent `share_profiles`)
`SharedProfile = {id, label, model, enabled}`
`SharedMcpServer = {id, name, default_mode, room_modes: {room_id: mode}}` (modes are `off`, `ask` or `auto`; a server with any other default isn't listed, and any other room mode is dropped)
`LentServer = {id, name, tools: LentTool[]}`, `LentTool = {name, description, input_schema}` (a member's
real tool names, descriptions and input schemas; never the server's command, URL, env or headers)
`LentImage = {mime, data}` (base64; png, jpeg, webp or gif)
`DeviceCommand` is tagged by `kind`: `set_mcp_mode {room_id, server_id, mode}`, `set_profile_enabled {profile_id, enabled}`, `tool_approval {room_id, message_id, call_id, server, tool, args}`, `answer_tool {message_id, call_id, approved}`
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
device list or `request_ai`. A new account must set its secret on first connect (a `hello` without one is refused); an account
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
frame on the asking device. A delegated generation runs **without MCP tools** unless the
desktop allows remote control (below).

### Remote control (device linking, phase 3)

A linked device can turn the desktop's profiles on or off, switch its MCP servers per room
and approve tool calls in the replies it asked for. All of it travels as `device_command`,
which the relay forwards only between connections of one account and never stores.

The commands come through the relay, and proving the account doesn't prove the user is
behind them: whoever runs a relay sees account secrets in `hello`, so a hostile relay could
forge a command. So the receiving device decides what happens, within these limits:

- **Off by default.** "Let linked devices control this computer" (`remote_control`) is only
  set at the desktop itself. Until then commands are refused, no server names are shared
  and delegated replies get no tools. The backend checks the setting as it acts on each
  command, under the lock that changes it, so turning it off stops them at once. A reply
  already running keeps its prompts on the desktop, and its arguments stop going out.
- **Never Auto.** A linked device can set a server to Off or Ask only.
- **Every delegated call is approved,** even on a server set to Auto at the desktop
  (`Config::mcp_for_reply`). The desktop shows the same prompt, and the first answer wins;
  an unanswered call is denied after 10 minutes.
- **Only the device that asked** can answer, and only for a reply it asked for. A reply
  started at the desktop can't be answered from elsewhere.
  This stops devices answering each other's prompts by mistake, but it isn't a security
  boundary: a device's id is self-reported and all linked devices share one account secret,
  so with remote control on, one of them could claim another's id, read that device's waiting
  tool arguments and answer the call. It could already ask for its own reply and approve
  that, so the new exposure is those arguments and that one answer. Authenticating each
  device, with approvals bound to that identity, would close this; it isn't built yet.

A forged command can still turn profiles and servers off or back to Ask, and a forged
approval can run a tool of a server that's on, so remote control trusts the relay more
than the rest of the app does; the setting says what it allows.

To approve, a device needs the tool's arguments, so `tool_approval` carries them (cut to
16,000 characters). They go to that one device through the relay's memory and are never
stored or sent to the room. Results stay on the desktop, as for any other reply. A waiting
approval is offered again on every `devices` frame, so a phone that dropped off gets it
back when it signs in, even if its old connection hadn't closed yet.

### Lending tools to a room

An MCP server only works for replies generated on the computer that has it. Lending
lets a room member's AI use another member's server: the **lender**'s device publishes
the server's tool names, descriptions and input schemas with `lend_tools`; the
**borrower**'s model sees those tools among its own, and when it calls one the call
travels as `call_lent_tool` → `lent_tool_call` to the lender, runs there, and the result
comes back as `lent_tool_result` (twice: lender → relay → caller). The lender's API key
and MCP secrets are never involved; only tool metadata and results cross, and nothing
is stored by the relay.

- **Off by default, per room and per server, and only set at the lender's own desktop**
  (a Tauri command, never through `device_command`, never from the relay). `lend_tools`
  with an empty list stops lending in that room.
- **Every lent call is approved at the lender's desktop**, unless the lender turned on
  **Auto for that one person** (user id) on that server in that room — which always
  asks a warning confirmation first, because that person's AI can then run any of the
  server's tools, as often as it wants, without the lender seeing the request. Auto
  per person also trusts the relay's report of who is asking: the relay stamps
  `from_user_id`/`from_name` itself, but whoever runs the relay could forge them, so
  Auto is only for someone who already trusts the relay's operator.
- The lender's Rust backend re-checks the config **under the settings lock** for every
  call (`Config::lend_mode`), right before asking and again before running — never the
  webview's cached copy. Turning lending off stops calls at once; a call that was
  waiting on an approval is then refused.
- **Only tool names, descriptions and input schemas leave the lender.** A server's
  command, URL, env vars and headers never do; `lent_tools` reads them from a live
  MCP connection, and a server that fails to connect simply isn't lent.
- The relay stores nothing of this: it forwards between members of the room only,
  caps what crosses (≤ 20 servers, ≤ 100 tools, ≤ 256 KiB per `lend_tools`; ≤ 64 KiB
  args and ≤ 4 outstanding calls per caller; results clipped to 200,000 chars and
  ≤ 4 images of png/jpeg/webp/gif), and answers a caller whose lender went offline
  with an error result.
- A borrower picks which lent servers to use per room ("Shared with you"), off by
  default; a delegated reply (one this desktop makes for the user's phone) gets no
  borrowed tools in this version.

## Context building (Rust, `app/src-tauri/src/context.rs`)

1. History = room messages in `seq` order up to and including the anchor and after the
   summary boundary; human messages (incl. human-only) and *complete* AI messages.
2. Human → `user` `"[Name]: text"`; AI → `assistant` (whoever generated it).
3. System prompt = group-chat preamble + optional room prompt + the room's shared
   summary of the messages before the boundary, if any.
4. Trim oldest until `estimate(system) + Σ estimate(msg) + output_reserve ≤ max_context`
   (estimate ≈ chars/4 + 4). The anchor message is always kept.
5. Drop leading `assistant` messages, merge consecutive same-role messages.

### Summaries

Instead of silently dropping the oldest messages when a room's history no longer fits
the profile's context, the replying device first asks its model to summarize them
(keeping the newest 6 messages verbatim). The summary is shared with the room through
the relay (`set_room_summary`, ≤ 12,000 chars), so every member's AI replies from the
same summary, and the room stores it (`rooms.summary`,
`rooms.summary_upto_seq` = the `seq` of the last message it covers). The relay accepts
a summary only when `upto_seq` is newer than the stored one and not past the room's
last message — one compare-and-set, so concurrent writers can't regress it, and only
the writer that advanced it broadcasts `room_summary`. If summarizing fails, the reply
falls back to trimming, as before.

The boundary never passes a message the summary didn't see:
- **Prefix only.** The summary request carries the oldest folded messages that fit the
  input budget. `upto_seq` is the last one it really carried, and the rest stay in the
  reply's history. A message too long for one request is summarized in
  parts and counts as covered only after its last part.
  The boundary also moves back so the reply's history starts with a human message,
  because a leading AI reply would otherwise be dropped from the prompt. After a
  summary, `build` also keeps a leading AI reply behind a short user turn.
- **No gaps.** The device only summarizes when its loaded messages reach back to the
  boundary (or, with no summary yet, to the start of the room). Otherwise the reply waits while `load_older` fills the gap page by page.
  Past 10,000 loaded messages it replies without summarizing instead.
- **No unfinished replies.** Folding stops before an earlier AI reply that is still
  streaming.

A device shows its own summary at once, and a `room_summary` at the same boundary
replaces it, so every member ends up with the copy the relay accepted.

## Provider trait

```rust
#[async_trait]
trait Provider { async fn stream_chat(&self, req: &ChatRequest) -> Result<DeltaStream, ProviderError>; }
```

Implementations: `OpenAiCompatible` (`POST {base}/chat/completions`, SSE) and
`Anthropic` (`POST {base}/v1/messages`, `anthropic-version: 2026-10-21`, SSE; no sampling
params since that version rejects them). Errors are sanitized: key, base URL and host are
redacted and the text is truncated.

## Notifications

System notifications for new messages while the app is running but not in front
(the window minimized or behind others, or a phone in the background with its relay
connection still alive). Per room, the user picks **All messages**, **Mentions only**
(the default) or **Off** — from the bell button in the room header on desktop, or the
room's ⋯ menu on a phone. The choice lives in `config.json` as `notify_by_room`
(room id → mode, no entry meaning "mentions") and is removed when the room is left.

What notifies (in the store's `message` handling):

- Only other people's human messages and *finished* AI replies (on `ai_complete`,
  with the final text) — never this user's own messages from any of their devices,
  deleted messages, or history/paging frames.
- Only when the app isn't showing that room: the window hidden or unfocused
  (`document.visibilityState`/`document.hasFocus()`), or another room is open.
- Mentions: a message that @-names this user, or an AI reply whose anchor is this
  user's message. All: every such message. Off: never (no text leaves the app).
- At most one notification per room per 5 s; ones held back are counted, and the
  next says "N new messages". Body: "Author: first 120 chars" ("AI for <name>: …").
- The first notification checks the OS permission (asked once per run; if denied, a
  one-time toast says so and nothing further is tried until restart). Where the
  plugin reports clicks (desktop), clicking one focuses the window and opens the room.

Phase 2 is true push — notifications when the phone app is suspended or closed,
where phase 1 stops once the OS freezes the app. The relay would have to send push
messages through **FCM** (Android) and **APNs** (iOS):

- Per-device push tokens, registered with the relay over the authenticated
  connection (the relay already knows each connection's device).
- A relay-side push sender with server keys the owner has to create: a Firebase
  project for Android, and an Apple push key for iOS.
- Payloads without message text (or encrypted), since they pass through Google's
  and Apple's servers — just "new message in #room", letting the app fetch the rest.

Android also allows keeping a foreground service alive instead, which would keep the
phase-1 connection (and so notifications) running indefinitely — at the cost of a
permanent notification the user can't miss.
