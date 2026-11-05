//! Connection registry, room fan-out and the message handlers.

use crate::db::{self, Db, NewMessage};
use crate::db::AiResult;
use crate::protocol::{Attachment, ClientMsg, Device, Member, RoomInfo, ServerMsg, ToolActivity};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

const MAX_NAME: usize = 40;
const MAX_ROOM_NAME: usize = 80;
const MAX_CONTENT: usize = 200_000;
const MAX_PROMPT: usize = 8_000;
const MAX_ERROR: usize = 300;
/// Messages sent in one `room_history` when a room is opened.
const HISTORY_PAGE: i64 = 200;
/// Messages sent in one `older_messages` page answering `load_older`.
const OLDER_PAGE: i64 = 100;
const MAX_TOOL_CALLS: usize = 100;
const MAX_ATTACHMENTS: usize = 8;
/// Distinct emoji one message accepts across all members.
const MAX_REACTION_EMOJI: usize = 20;
/// Reaction emoji length cap; single emoji are a few chars of UTF-16.
const MAX_EMOJI: usize = 16;
/// Base64 length cap (~4.5 MB of image); clients downscale before sending.
const MAX_ATTACHMENT_B64: usize = 6_000_000;
/// Reported image dimensions outside 1..=this are rejected as bogus metadata.
const MAX_IMAGE_SIDE: u32 = 16_384;
const IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/// How long a device-link code stays valid.
const LINK_CODE_TTL: Duration = Duration::from_secs(10 * 60);
/// Failed link-code redeems allowed per connection before further tries are refused.
const MAX_FAILED_REDEEMS: u32 = 5;
/// Minimum gap between two accepted `typing: true` frames from one connection.
const TYPING_MIN_INTERVAL: Duration = Duration::from_secs(1);

pub type ConnId = u64;

struct Conn {
    user_id: Option<String>,
    display_name: String,
    device_id: String,
    device_name: String,
    platform: String,
    failed_redeems: u32,
    /// When this connection last had a `typing: true` accepted (server-side throttle).
    last_typing: Option<Instant>,
    /// Rooms where this connection's last broadcast typing state was `true`, so a
    /// `typing: false` is only relayed when it changes something.
    typing_rooms: HashSet<String>,
    tx: UnboundedSender<String>,
    rooms: HashSet<String>,
}

/// An AI reply that is currently being streamed by one connection.
struct Stream {
    room_id: String,
    conn_id: ConnId,
    content: String,
    reasoning: String,
    tools: Vec<ToolActivity>,
    attachments: Vec<Attachment>,
}

/// A device-linking code: whoever redeems it joins the issuing user's account.
struct LinkCode {
    user_id: String,
    display_name: String,
    expires: Instant,
}

#[derive(Default)]
struct Hub {
    next_id: ConnId,
    conns: HashMap<ConnId, Conn>,
    streams: HashMap<String, Stream>,
    link_codes: HashMap<String, LinkCode>,
}

impl Hub {
    fn is_online(&self, user_id: &str, room_id: &str) -> bool {
        self.conns
            .values()
            .any(|c| c.user_id.as_deref() == Some(user_id) && c.rooms.contains(room_id))
    }

    fn send(&self, conn_id: ConnId, msg: &ServerMsg) {
        if let Some(c) = self.conns.get(&conn_id) {
            let _ = c.tx.send(serde_json::to_string(msg).expect("serializable"));
        }
    }

    fn broadcast(&self, room_id: &str, msg: &ServerMsg) {
        let text = serde_json::to_string(msg).expect("serializable");
        for c in self.conns.values().filter(|c| c.rooms.contains(room_id)) {
            let _ = c.tx.send(text.clone());
        }
    }

    /// Sends the user's currently online devices to every one of their connections.
    fn send_devices(&self, user_id: &str) {
        let mut seen = HashSet::new();
        let mut devices: Vec<Device> = self
            .conns
            .values()
            .filter(|c| c.user_id.as_deref() == Some(user_id) && !c.device_id.is_empty())
            .filter(|c| seen.insert(c.device_id.clone()))
            .map(|c| Device {
                device_id: c.device_id.clone(),
                device_name: c.device_name.clone(),
                platform: c.platform.clone(),
            })
            .collect();
        devices.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        let text = serde_json::to_string(&ServerMsg::Devices { devices }).expect("serializable");
        for c in self.conns.values().filter(|c| c.user_id.as_deref() == Some(user_id)) {
            let _ = c.tx.send(text.clone());
        }
    }
}

#[derive(Clone)]
pub struct State {
    pub db: Db,
    hub: Arc<Mutex<Hub>>,
    /// Held across a reaction, edit or delete (check, write, re-read, broadcast) and
    /// across a room-history read and send. Sends are queued in order, so updates reach
    /// every client in the order they were written, and a history snapshot read before
    /// an update is always delivered before it, never after.
    updates_lock: Arc<tokio::sync::Mutex<()>>,
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn err(request_id: Option<String>, message: impl Into<String>) -> ServerMsg {
    ServerMsg::Error { request_id, message: message.into() }
}

impl State {
    pub fn new(db: Db) -> Self {
        Self { db, hub: Arc::new(Mutex::new(Hub::default())), updates_lock: Default::default() }
    }

    fn hub(&self) -> std::sync::MutexGuard<'_, Hub> {
        self.hub.lock().expect("hub mutex poisoned")
    }

    pub fn register(&self, tx: UnboundedSender<String>) -> ConnId {
        let mut hub = self.hub();
        hub.next_id += 1;
        let id = hub.next_id;
        hub.conns.insert(
            id,
            Conn {
                user_id: None,
                display_name: String::new(),
                device_id: String::new(),
                device_name: String::new(),
                platform: String::new(),
                failed_redeems: 0,
                last_typing: None,
                typing_rooms: HashSet::new(),
                tx,
                rooms: HashSet::new(),
            },
        );
        id
    }

    pub fn send(&self, conn: ConnId, msg: ServerMsg) {
        self.hub().send(conn, &msg);
    }

    fn broadcast(&self, room_id: &str, msg: ServerMsg) {
        self.hub().broadcast(room_id, &msg);
    }

    /// (user_id, display_name) once `hello` has been received.
    fn identity(&self, conn: ConnId) -> Option<(String, String)> {
        let hub = self.hub();
        let c = hub.conns.get(&conn)?;
        Some((c.user_id.clone()?, c.display_name.clone()))
    }

    fn in_room(&self, conn: ConnId, room_id: &str) -> bool {
        self.hub().conns.get(&conn).is_some_and(|c| c.rooms.contains(room_id))
    }

    async fn room_info(&self, room_id: &str) -> sqlx::Result<Option<RoomInfo>> {
        let Some(row) = db::room(&self.db, room_id).await? else { return Ok(None) };
        let hub = self.hub();
        let members = row
            .members
            .into_iter()
            .map(|(user_id, display_name)| Member {
                online: hub.is_online(&user_id, room_id),
                user_id,
                display_name,
            })
            .collect();
        Ok(Some(RoomInfo {
            id: row.id,
            name: row.name,
            invite_code: row.invite_code,
            system_prompt: row.system_prompt,
            members,
        }))
    }

    /// Subscribes every connection of `user_id` to `room_id` and announces presence.
    fn subscribe_user(&self, user_id: &str, room_id: &str) {
        let mut hub = self.hub();
        let was_online = hub.is_online(user_id, room_id);
        for c in hub.conns.values_mut().filter(|c| c.user_id.as_deref() == Some(user_id)) {
            c.rooms.insert(room_id.to_string());
        }
        if !was_online {
            let msg = ServerMsg::Presence {
                room_id: room_id.into(),
                user_id: user_id.into(),
                online: true,
            };
            hub.broadcast(room_id, &msg);
        }
    }

    pub async fn handle(&self, conn: ConnId, msg: ClientMsg) {
        if let Err(e) = self.dispatch(conn, msg).await {
            tracing::error!("handler error: {e}");
            self.send(conn, err(None, "Internal server error"));
        }
    }

    async fn dispatch(&self, conn: ConnId, msg: ClientMsg) -> sqlx::Result<()> {
        if let ClientMsg::Hello { user_id, display_name, device_id, device_name, platform } = msg {
            return self.hello(conn, user_id, display_name, device_id, device_name, platform).await;
        }
        let Some((user_id, display_name)) = self.identity(conn) else {
            self.send(conn, err(None, "Send hello first"));
            return Ok(());
        };

        match msg {
            ClientMsg::Hello { .. } => unreachable!(),

            ClientMsg::CreateRoom { request_id, name } => {
                let name = clip(&name, MAX_ROOM_NAME);
                if name.is_empty() {
                    self.send(conn, err(Some(request_id), "Room name is required"));
                    return Ok(());
                }
                let room_id = db::create_room(&self.db, &name, &user_id).await?;
                self.subscribe_user(&user_id, &room_id);
                if let Some(room) = self.room_info(&room_id).await? {
                    self.send(conn, ServerMsg::RoomJoined { request_id: Some(request_id), room });
                }
            }

            ClientMsg::JoinRoom { request_id, invite_code } => {
                let code = invite_code.trim().to_uppercase();
                let Some(room_id) = db::room_id_by_code(&self.db, &code).await? else {
                    self.send(conn, err(Some(request_id), "No room with that invite code"));
                    return Ok(());
                };
                let added = db::add_member(&self.db, &room_id, &user_id).await?;
                if added {
                    self.broadcast(
                        &room_id,
                        ServerMsg::MemberJoined {
                            room_id: room_id.clone(),
                            member: Member {
                                user_id: user_id.clone(),
                                display_name: display_name.clone(),
                                online: true,
                            },
                        },
                    );
                }
                self.subscribe_user(&user_id, &room_id);
                if let Some(room) = self.room_info(&room_id).await? {
                    self.send(conn, ServerMsg::RoomJoined { request_id: Some(request_id), room });
                }
            }

            ClientMsg::LeaveRoom { room_id } => {
                if !self.in_room(conn, &room_id) {
                    return Ok(());
                }
                db::remove_member(&self.db, &room_id, &user_id).await?;
                let mut hub = self.hub();
                let mine: Vec<ConnId> = hub
                    .conns
                    .iter()
                    .filter(|(_, c)| c.user_id.as_deref() == Some(user_id.as_str()))
                    .map(|(id, _)| *id)
                    .collect();
                for id in &mine {
                    hub.send(*id, &ServerMsg::RoomLeft { room_id: room_id.clone() });
                    if let Some(c) = hub.conns.get_mut(id) {
                        c.rooms.remove(&room_id);
                        c.typing_rooms.remove(&room_id);
                    }
                }
                hub.broadcast(
                    &room_id,
                    &ServerMsg::MemberLeft { room_id: room_id.clone(), user_id: user_id.clone() },
                );
            }

            ClientMsg::OpenRoom { room_id } => {
                if !self.in_room(conn, &room_id) {
                    self.send(conn, err(None, "Not a member of that room"));
                    return Ok(());
                }
                // Read and send under the updates lock, so an edit, delete or reaction
                // can't be overtaken by this older snapshot.
                let _ordered = self.updates_lock.lock().await;
                // One row past the page answers whether older messages exist. Both
                // queries return oldest first, so the extra probe row is at the front.
                let mut messages = db::recent_messages(&self.db, &room_id, HISTORY_PAGE + 1).await?;
                let has_more = messages.len() > HISTORY_PAGE as usize;
                if has_more {
                    messages.remove(0);
                }
                {
                    // Late joiners get the partial text of in-flight streams.
                    let hub = self.hub();
                    for m in messages.iter_mut().filter(|m| m.status == "streaming") {
                        if let Some(s) = hub.streams.get(&m.id) {
                            m.content = s.content.clone();
                            m.reasoning = s.reasoning.clone();
                            m.tools = s.tools.clone();
                        }
                    }
                }
                self.send(conn, ServerMsg::RoomHistory { room_id, messages, has_more });
            }

            ClientMsg::LoadOlder { room_id, before_seq } => {
                if !self.in_room(conn, &room_id) {
                    self.send(conn, err(None, "Not a member of that room"));
                    return Ok(());
                }
                // Like OpenRoom: read and send under the updates lock, so an edit,
                // delete or reaction can't be overtaken by this older snapshot. The
                // page isn't streamed, only the newest messages are.
                let _ordered = self.updates_lock.lock().await;
                let mut messages =
                    db::messages_before(&self.db, &room_id, before_seq, OLDER_PAGE + 1).await?;
                let has_more = messages.len() > OLDER_PAGE as usize;
                if has_more {
                    messages.remove(0);
                }
                self.send(conn, ServerMsg::OlderMessages { room_id, messages, has_more });
            }

            ClientMsg::SendMessage { room_id, id, content, ai_requested, reply_to } => {
                if !self.in_room(conn, &room_id) {
                    self.send(conn, err(None, "Not a member of that room"));
                    return Ok(());
                }
                if uuid::Uuid::parse_str(&id).is_err() {
                    self.send(conn, err(None, "Invalid message id"));
                    return Ok(());
                }
                if content.trim().is_empty() || content.len() > MAX_CONTENT {
                    self.send(conn, err(None, "Message is empty or too long"));
                    return Ok(());
                }
                // From the reply check through the broadcast: a delete can't slip in
                // between, so clients never get the deletion before the message itself.
                let _ordered = self.updates_lock.lock().await;
                if let Some(reply_to) = reply_to.as_deref() {
                    let target = db::message(&self.db, reply_to).await?;
                    if !target.is_some_and(|t| t.room_id == room_id && !t.deleted) {
                        self.send(conn, err(None, "Can't reply to that message"));
                        return Ok(());
                    }
                }
                let res = db::insert_message(
                    &self.db,
                    NewMessage {
                        id: &id,
                        room_id: &room_id,
                        kind: "human",
                        author_id: &user_id,
                        author_name: &display_name,
                        content: &content,
                        ai_requested,
                        anchor_id: None,
                        model: None,
                        reply_to: reply_to.as_deref(),
                        status: "complete",
                    },
                )
                .await;
                match res {
                    Ok(message) => self.broadcast(&room_id, ServerMsg::Message { room_id: room_id.clone(), message }),
                    Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                        self.send(conn, err(None, "Duplicate message id"));
                    }
                    Err(e) => return Err(e),
                }
            }

            ClientMsg::AiStart { room_id, id, anchor_id, model } => {
                if !self.in_room(conn, &room_id) || uuid::Uuid::parse_str(&id).is_err() {
                    self.send(conn, err(None, "Cannot start AI reply"));
                    return Ok(());
                }
                let anchor = db::message(&self.db, &anchor_id).await?;
                if !anchor.is_some_and(|a| a.room_id == room_id && a.kind == "human") {
                    self.send(conn, err(None, "AI reply must be anchored to a human message in the room"));
                    return Ok(());
                }
                let model = clip(&model, 120);
                let res = db::insert_message(
                    &self.db,
                    NewMessage {
                        id: &id,
                        room_id: &room_id,
                        kind: "ai",
                        author_id: &user_id,
                        author_name: &display_name,
                        content: "",
                        ai_requested: false,
                        anchor_id: Some(&anchor_id),
                        model: Some(&model),
                        reply_to: None,
                        status: "streaming",
                    },
                )
                .await;
                let message = match res {
                    Ok(m) => m,
                    Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                        self.send(conn, err(None, "Duplicate message id"));
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                };
                let mut hub = self.hub();
                hub.streams.insert(
                    id,
                    Stream {
                        room_id: room_id.clone(),
                        conn_id: conn,
                        content: String::new(),
                        reasoning: String::new(),
                        tools: Vec::new(),
                        attachments: Vec::new(),
                    },
                );
                hub.broadcast(&room_id, &ServerMsg::Message { room_id: room_id.clone(), message });
            }

            ClientMsg::AiDelta { room_id, id, delta } => {
                let mut hub = self.hub();
                let Some(s) = hub.streams.get_mut(&id) else { return Ok(()) };
                if s.conn_id != conn || s.room_id != room_id || s.content.len() + delta.len() > MAX_CONTENT {
                    return Ok(());
                }
                s.content.push_str(&delta);
                hub.broadcast(&room_id, &ServerMsg::AiDelta { room_id: room_id.clone(), id, delta });
            }

            ClientMsg::AiReasoning { room_id, id, delta } => {
                let mut hub = self.hub();
                let Some(s) = hub.streams.get_mut(&id) else { return Ok(()) };
                if s.conn_id != conn || s.room_id != room_id || s.reasoning.len() + delta.len() > MAX_CONTENT {
                    return Ok(());
                }
                s.reasoning.push_str(&delta);
                hub.broadcast(&room_id, &ServerMsg::AiReasoning { room_id: room_id.clone(), id, delta });
            }

            ClientMsg::AiTool { room_id, id, activity } => {
                const STATUSES: [&str; 5] = ["awaiting_approval", "running", "done", "error", "denied"];
                if !STATUSES.contains(&activity.status.as_str()) {
                    return Ok(());
                }
                let activity = ToolActivity {
                    call_id: clip(&activity.call_id, 100),
                    server: clip(&activity.server, 80),
                    tool: clip(&activity.tool, 100),
                    status: activity.status,
                };
                let mut hub = self.hub();
                let Some(s) = hub.streams.get_mut(&id) else { return Ok(()) };
                if s.conn_id != conn || s.room_id != room_id {
                    return Ok(());
                }
                if let Some(i) = s.tools.iter().position(|t| t.call_id == activity.call_id) {
                    s.tools[i] = activity.clone();
                } else if s.tools.len() < MAX_TOOL_CALLS {
                    s.tools.push(activity.clone());
                } else {
                    return Ok(());
                }
                hub.broadcast(&room_id, &ServerMsg::AiTool { room_id: room_id.clone(), id, activity });
            }

            ClientMsg::AiAttachment { room_id, id, attachment, data } => {
                let ok_shape = uuid::Uuid::parse_str(&attachment.attachment_id).is_ok()
                    && IMAGE_MIMES.contains(&attachment.mime.as_str())
                    && !data.is_empty()
                    && data.len() <= MAX_ATTACHMENT_B64
                    && data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
                    && [attachment.width, attachment.height]
                        .iter()
                        .all(|d| d.is_none_or(|d| (1..=MAX_IMAGE_SIDE).contains(&d)));
                let owned = {
                    let hub = self.hub();
                    hub.streams.get(&id).is_some_and(|s| {
                        s.conn_id == conn && s.room_id == room_id && s.attachments.len() < MAX_ATTACHMENTS
                    })
                };
                if !ok_shape || !owned {
                    self.send(conn, err(None, "Image rejected (unsupported type, too large, or too many)"));
                    return Ok(());
                }
                let attachment = Attachment {
                    call_id: attachment.call_id.map(|c| clip(&c, 100)),
                    ..attachment
                };
                db::insert_attachment(&self.db, &attachment, &id, &room_id, &data).await?;
                let mut hub = self.hub();
                let Some(s) = hub.streams.get_mut(&id) else { return Ok(()) };
                s.attachments.push(attachment.clone());
                hub.broadcast(&room_id, &ServerMsg::AiAttachment { room_id: room_id.clone(), id, attachment });
            }

            ClientMsg::GetAttachment { attachment_id } => {
                let Some((room_id, mime, data)) = db::attachment(&self.db, &attachment_id).await? else {
                    return Ok(());
                };
                if self.in_room(conn, &room_id) {
                    self.send(conn, ServerMsg::Attachment { attachment_id, mime, data });
                }
            }

            ClientMsg::AiComplete { room_id, id, content } => {
                // Ordered with deletes: the finished row can't be deleted and announced
                // before this completion goes out.
                let _ordered = self.updates_lock.lock().await;
                let Some(stream) = self.take_stream(conn, &room_id, &id) else { return Ok(()) };
                let content: String = content.chars().take(MAX_CONTENT).collect();
                let result = AiResult {
                    content: &content,
                    reasoning: &stream.reasoning,
                    tools: &stream.tools,
                    status: "complete",
                    error: None,
                };
                db::finish_ai(&self.db, &id, result).await?;
                self.broadcast(&room_id, ServerMsg::AiComplete { room_id: room_id.clone(), id, content });
            }

            ClientMsg::AiError { room_id, id, error } => {
                let _ordered = self.updates_lock.lock().await;
                let Some(stream) = self.take_stream(conn, &room_id, &id) else { return Ok(()) };
                let error = clip(&error, MAX_ERROR);
                let result = AiResult {
                    content: &stream.content,
                    reasoning: &stream.reasoning,
                    tools: &stream.tools,
                    status: "error",
                    error: Some(&error),
                };
                db::finish_ai(&self.db, &id, result).await?;
                self.broadcast(&room_id, ServerMsg::AiError { room_id: room_id.clone(), id, error });
            }

            ClientMsg::SetRoomPrompt { room_id, system_prompt } => {
                if !self.in_room(conn, &room_id) {
                    return Ok(());
                }
                let prompt: String = system_prompt.trim().chars().take(MAX_PROMPT).collect();
                db::set_room_prompt(&self.db, &room_id, &prompt).await?;
                self.broadcast(
                    &room_id,
                    ServerMsg::RoomUpdated { room_id: room_id.clone(), system_prompt: prompt, updated_by: user_id },
                );
            }

            ClientMsg::React { room_id, message_id, emoji, on } => {
                if !self.in_room(conn, &room_id) {
                    return Ok(());
                }
                // Held from the read through the broadcast: a delete takes it too, so a
                // reaction can't land on a message while it's being deleted.
                let _ordered = self.updates_lock.lock().await;
                let Some(message) = db::message(&self.db, &message_id).await? else {
                    self.send(conn, err(None, "That message isn't in this room"));
                    return Ok(());
                };
                if message.room_id != room_id {
                    self.send(conn, err(None, "That message isn't in this room"));
                    return Ok(());
                }
                if message.deleted {
                    self.send(conn, err(None, "That message was deleted"));
                    return Ok(());
                }
                let emoji = emoji.trim();
                let ok_emoji = (1..=MAX_EMOJI).contains(&emoji.chars().count())
                    && emoji.chars().all(|c| !c.is_whitespace() && !c.is_alphanumeric());
                if !ok_emoji {
                    self.send(conn, err(None, "Not a valid reaction"));
                    return Ok(());
                }
                match db::set_reaction(&self.db, &room_id, &message_id, &user_id, emoji, on, MAX_REACTION_EMOJI).await? {
                    Ok(()) => {}
                    Err(db::ReactionRefused::TooMany) => {
                        self.send(conn, err(None, "Too many different reactions on this message"));
                        return Ok(());
                    }
                    Err(db::ReactionRefused::NotMember) => {
                        self.send(conn, err(None, "You're not in that room"));
                        return Ok(());
                    }
                }
                let reactions = db::reactions(&self.db, &message_id).await?;
                self.broadcast(
                    &room_id,
                    ServerMsg::Reactions { room_id: room_id.clone(), message_id, reactions },
                );
            }

            ClientMsg::Typing { room_id, typing } => {
                // Live state only: nothing touches the database, and a frame from a
                // non-member is dropped silently (it's sent often, so no error frame).
                let mut hub = self.hub();
                let Some(c) = hub.conns.get_mut(&conn) else { return Ok(()) };
                if !c.rooms.contains(&room_id) {
                    return Ok(());
                }
                // Sent on every keystroke, so throttle: one `true` broadcast per second
                // per connection. A `false` passes only when it ends a `true` this
                // connection broadcast in that room, so repeated `false`s can't flood it.
                if typing {
                    if c.last_typing.is_some_and(|t| t.elapsed() < TYPING_MIN_INTERVAL) {
                        return Ok(());
                    }
                    c.last_typing = Some(Instant::now());
                    c.typing_rooms.insert(room_id.clone());
                } else {
                    if !c.typing_rooms.remove(&room_id) {
                        return Ok(());
                    }
                    // Others see typing per account: while another device of this user
                    // is still typing here, this one stopping changes nothing for them.
                    let still_typing = hub.conns.values().any(|o| {
                        o.user_id.as_deref() == Some(user_id.as_str()) && o.typing_rooms.contains(&room_id)
                    });
                    if still_typing {
                        return Ok(());
                    }
                }
                hub.broadcast(
                    &room_id,
                    &ServerMsg::Typing {
                        room_id: room_id.clone(),
                        user_id: user_id.clone(),
                        display_name: display_name.clone(),
                        typing,
                    },
                );
            }

            ClientMsg::EditMessage { room_id, message_id, content } => {
                if !self.in_room(conn, &room_id) {
                    self.send(conn, err(None, "Not a member of that room"));
                    return Ok(());
                }
                // From the check through the broadcast, so an edit and a delete of the
                // same message can't broadcast out of order.
                let _ordered = self.updates_lock.lock().await;
                let Some(m) = db::message(&self.db, &message_id).await? else {
                    self.send(conn, err(None, "That message isn't in this room"));
                    return Ok(());
                };
                if m.room_id != room_id {
                    self.send(conn, err(None, "That message isn't in this room"));
                    return Ok(());
                }
                if m.deleted {
                    self.send(conn, err(None, "That message was deleted"));
                    return Ok(());
                }
                // Human messages only: AI replies belong to whoever ran the model.
                if m.kind != "human" || m.author_id != user_id {
                    self.send(conn, err(None, "You can only edit your own messages"));
                    return Ok(());
                }
                if content.trim().is_empty() || content.len() > MAX_CONTENT {
                    self.send(conn, err(None, "Message is empty or too long"));
                    return Ok(());
                }
                db::edit_message(&self.db, &message_id, &content).await?;
                let message = db::message(&self.db, &message_id).await?.expect("row still there");
                self.broadcast(&room_id, ServerMsg::MessageUpdated { room_id: room_id.clone(), message });
            }

            ClientMsg::DeleteMessage { room_id, message_id } => {
                if !self.in_room(conn, &room_id) {
                    self.send(conn, err(None, "Not a member of that room"));
                    return Ok(());
                }
                let _ordered = self.updates_lock.lock().await;
                let Some(m) = db::message(&self.db, &message_id).await? else {
                    self.send(conn, err(None, "That message isn't in this room"));
                    return Ok(());
                };
                if m.room_id != room_id {
                    self.send(conn, err(None, "That message isn't in this room"));
                    return Ok(());
                }
                if m.deleted {
                    self.send(conn, err(None, "That message was deleted"));
                    return Ok(());
                }
                // Both human messages and AI replies count as the author's own: an AI
                // reply's author_id is the member whose profile generated it.
                if m.author_id != user_id {
                    self.send(conn, err(None, "You can only delete your own messages"));
                    return Ok(());
                }
                // A streaming reply is still being written; deleting it mid-stream would
                // race the finish that follows. (Rows left "streaming" by a crash are
                // marked interrupted at startup.)
                if m.status == "streaming" || self.hub().streams.contains_key(&message_id) {
                    self.send(conn, err(None, "Stop the reply first"));
                    return Ok(());
                }
                db::delete_message(&self.db, &message_id).await?;
                let message = db::message(&self.db, &message_id).await?.expect("row still there");
                self.broadcast(&room_id, ServerMsg::MessageUpdated { room_id: room_id.clone(), message });
            }

            ClientMsg::CreateLinkCode { request_id } => {
                let mut hub = self.hub();
                hub.link_codes.retain(|_, c| c.expires > Instant::now());
                // One live code per user: a fresh code replaces the previous one.
                hub.link_codes.retain(|_, c| c.user_id != user_id);
                let code = db::invite_code();
                hub.link_codes.insert(
                    code.clone(),
                    LinkCode {
                        user_id: user_id.clone(),
                        display_name: display_name.clone(),
                        expires: Instant::now() + LINK_CODE_TTL,
                    },
                );
                let msg = ServerMsg::LinkCode {
                    request_id,
                    code,
                    expires_in_secs: LINK_CODE_TTL.as_secs(),
                };
                hub.send(conn, &msg);
            }

            ClientMsg::RedeemLinkCode { request_id, code } => {
                let mut hub = self.hub();
                if hub.conns.get(&conn).is_some_and(|c| c.failed_redeems >= MAX_FAILED_REDEEMS) {
                    hub.send(
                        conn,
                        &err(Some(request_id), "Too many wrong codes. Close and reopen the app to try again"),
                    );
                    return Ok(());
                }
                hub.link_codes.retain(|_, c| c.expires > Instant::now());
                let code = code.trim().to_uppercase();
                let miss = |hub: &mut Hub| {
                    if let Some(c) = hub.conns.get_mut(&conn) {
                        c.failed_redeems += 1;
                    }
                };
                // Clone the owner out of the map so the else branch can mutably
                // borrow the hub (the map borrow ends with this statement).
                let link =
                    hub.link_codes.get(&code).map(|l| (l.user_id.clone(), l.display_name.clone()));
                let Some((owner_id, owner_name)) = link else {
                    miss(&mut hub);
                    hub.send(
                        conn,
                        &err(Some(request_id), "That link code is wrong or has expired"),
                    );
                    return Ok(());
                };
                if owner_id == user_id {
                    miss(&mut hub);
                    hub.send(conn, &err(Some(request_id), "This device is already on that account"));
                    return Ok(());
                }
                // A code works once: consume it on the successful redeem.
                hub.link_codes.remove(&code);
                let msg = ServerMsg::Linked {
                    request_id,
                    user_id: owner_id,
                    display_name: owner_name,
                };
                hub.send(conn, &msg);
            }
        }
        Ok(())
    }

    /// Removes and returns a stream if `conn` owns it.
    fn take_stream(&self, conn: ConnId, room_id: &str, id: &str) -> Option<Stream> {
        let mut hub = self.hub();
        match hub.streams.get(id) {
            Some(s) if s.conn_id == conn && s.room_id == room_id => hub.streams.remove(id),
            _ => None,
        }
    }

    async fn hello(
        &self,
        conn: ConnId,
        user_id: String,
        display_name: String,
        device_id: String,
        device_name: String,
        platform: String,
    ) -> sqlx::Result<()> {
        let display_name = clip(&display_name, MAX_NAME);
        let device_name = clip(&device_name, MAX_NAME);
        let platform = clip(&platform, 16);
        let device_id = clip(&device_id, 64);
        if uuid::Uuid::parse_str(&user_id).is_err() || display_name.is_empty() {
            self.send(conn, err(None, "hello needs a UUID user_id and a display name"));
            return Ok(());
        }
        if let Some((existing, _)) = self.identity(conn) {
            if existing != user_id {
                self.send(conn, err(None, "Cannot change user on an open connection"));
                return Ok(());
            }
        }
        let prev_name = db::upsert_user(&self.db, &user_id, &display_name).await?;
        let room_ids = db::user_room_ids(&self.db, &user_id).await?;

        let newly_online: Vec<String> = {
            let mut hub = self.hub();
            let newly: Vec<String> =
                room_ids.iter().filter(|r| !hub.is_online(&user_id, r)).cloned().collect();
            if let Some(c) = hub.conns.get_mut(&conn) {
                c.user_id = Some(user_id.clone());
                c.display_name = display_name.clone();
                c.device_id = device_id;
                c.device_name = device_name;
                c.platform = platform;
                c.rooms = room_ids.iter().cloned().collect();
            }
            // Keep the name current on this user's other connections too.
            for c in hub.conns.values_mut().filter(|c| c.user_id.as_deref() == Some(user_id.as_str())) {
                c.display_name = display_name.clone();
            }
            newly
        };

        let renamed = prev_name.is_some_and(|p| p != display_name);
        {
            let hub = self.hub();
            for room_id in &room_ids {
                if renamed {
                    let member = Member {
                        user_id: user_id.clone(),
                        display_name: display_name.clone(),
                        online: true,
                    };
                    hub.broadcast(room_id, &ServerMsg::MemberUpdated { room_id: room_id.clone(), member });
                }
                if newly_online.contains(room_id) {
                    let msg = ServerMsg::Presence {
                        room_id: room_id.clone(),
                        user_id: user_id.clone(),
                        online: true,
                    };
                    hub.broadcast(room_id, &msg);
                }
            }
        }

        let mut rooms = Vec::with_capacity(room_ids.len());
        for id in &room_ids {
            if let Some(info) = self.room_info(id).await? {
                rooms.push(info);
            }
        }
        self.send(conn, ServerMsg::Welcome { user_id: user_id.clone(), rooms });
        let hub = self.hub();
        hub.send_devices(&user_id);
        Ok(())
    }

    pub async fn disconnect(&self, conn: ConnId) {
        let (orphaned, user_id, rooms) = {
            let mut hub = self.hub();
            let Some(c) = hub.conns.remove(&conn) else { return };
            let ids: Vec<String> =
                hub.streams.iter().filter(|(_, s)| s.conn_id == conn).map(|(id, _)| id.clone()).collect();
            let orphaned: Vec<(String, Stream)> =
                ids.into_iter().filter_map(|id| hub.streams.remove(&id).map(|s| (id, s))).collect();
            (orphaned, c.user_id, c.rooms)
        };

        for (id, s) in orphaned {
            // Like AiComplete: a delete can't be announced between the write and this.
            let _ordered = self.updates_lock.lock().await;
            if let Err(e) = db::finish_ai(
                &self.db,
                &id,
                AiResult {
                    content: &s.content,
                    reasoning: &s.reasoning,
                    tools: &s.tools,
                    status: "interrupted",
                    error: None,
                },
            )
            .await {
                tracing::error!("failed to mark {id} interrupted: {e}");
            }
            self.broadcast(
                &s.room_id,
                ServerMsg::AiInterrupted { room_id: s.room_id.clone(), id, content: s.content },
            );
        }

        if let Some(user_id) = user_id {
            let hub = self.hub();
            for room_id in rooms.iter().filter(|r| !hub.is_online(&user_id, r)) {
                let msg = ServerMsg::Presence {
                    room_id: room_id.clone(),
                    user_id: user_id.clone(),
                    online: false,
                };
                hub.broadcast(room_id, &msg);
            }
            hub.send_devices(&user_id);
        }
    }
}
