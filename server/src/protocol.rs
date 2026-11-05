//! WebSocket wire protocol. See docs/PLAN.md for the full table.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        user_id: String,
        display_name: String,
        /// Identifies the physical device so several can share one account.
        #[serde(default)]
        device_id: String,
        #[serde(default)]
        device_name: String,
        #[serde(default)]
        platform: String,
    },
    CreateRoom {
        request_id: String,
        name: String,
    },
    JoinRoom {
        request_id: String,
        invite_code: String,
    },
    LeaveRoom {
        room_id: String,
    },
    OpenRoom {
        room_id: String,
    },
    /// Asks for the next page of history older than `before_seq`. With
    /// `until_seq`, the page reaches back far enough to include that message
    /// (capped; the client asks again from there if it still isn't included).
    LoadOlder {
        room_id: String,
        before_seq: i64,
        #[serde(default)]
        until_seq: Option<i64>,
    },
    SendMessage {
        room_id: String,
        id: String,
        content: String,
        ai_requested: bool,
        /// Message this one replies to, when sending a reply.
        #[serde(default)]
        reply_to: Option<String>,
    },
    AiStart {
        room_id: String,
        id: String,
        anchor_id: String,
        model: String,
    },
    AiDelta {
        room_id: String,
        id: String,
        delta: String,
    },
    AiReasoning {
        room_id: String,
        id: String,
        delta: String,
    },
    AiTool {
        room_id: String,
        id: String,
        activity: ToolActivity,
    },
    /// An image a tool produced; the relay stores it and shares only its metadata.
    AiAttachment {
        room_id: String,
        id: String,
        attachment: Attachment,
        /// Base64-encoded image bytes.
        data: String,
    },
    GetAttachment {
        attachment_id: String,
    },
    AiComplete {
        room_id: String,
        id: String,
        content: String,
    },
    AiError {
        room_id: String,
        id: String,
        error: String,
    },
    SetRoomPrompt {
        room_id: String,
        system_prompt: String,
    },
    React {
        room_id: String,
        message_id: String,
        emoji: String,
        /// true adds the reaction, false removes it.
        on: bool,
    },
    /// Live "I'm typing" state; relayed to the room and never stored.
    Typing {
        room_id: String,
        typing: bool,
    },
    EditMessage {
        room_id: String,
        message_id: String,
        content: String,
    },
    DeleteMessage {
        room_id: String,
        message_id: String,
    },
    /// This connection's profiles that the user's other devices may generate with
    /// (id, label and model only; keys never leave the device).
    ShareProfiles {
        profiles: Vec<SharedProfile>,
    },
    /// Asks one of the user's own devices to reply to `anchor_id` with its profile
    /// (delegated generation; the target answers `ai_requested` or `ai_request_failed`).
    RequestAi {
        request_id: String,
        room_id: String,
        anchor_id: String,
        device_id: String,
        profile_id: String,
    },
    /// The target device's answer when it can't fulfil an `ai_requested`.
    AiRequestFailed {
        request_id: String,
        to_device_id: String,
        message: String,
    },
    CreateLinkCode {
        request_id: String,
    },
    RedeemLinkCode {
        request_id: String,
        code: String,
    },
    /// Full-text search over one room's message text.
    SearchMessages {
        request_id: String,
        room_id: String,
        query: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        user_id: String,
        rooms: Vec<RoomInfo>,
    },
    RoomJoined {
        request_id: Option<String>,
        room: RoomInfo,
    },
    RoomLeft {
        room_id: String,
    },
    RoomHistory {
        room_id: String,
        messages: Vec<Message>,
        /// True when older messages exist before the first one sent.
        has_more: bool,
    },
    /// One page of older messages, answering `load_older`.
    OlderMessages {
        room_id: String,
        messages: Vec<Message>,
        has_more: bool,
    },
    /// Answers `search_messages`: the room's hits, newest first.
    SearchResults {
        request_id: String,
        room_id: String,
        hits: Vec<SearchHit>,
    },
    Message {
        room_id: String,
        message: Message,
    },
    AiDelta {
        room_id: String,
        id: String,
        delta: String,
    },
    AiReasoning {
        room_id: String,
        id: String,
        delta: String,
    },
    AiTool {
        room_id: String,
        id: String,
        activity: ToolActivity,
    },
    AiAttachment {
        room_id: String,
        id: String,
        attachment: Attachment,
    },
    Attachment {
        attachment_id: String,
        mime: String,
        data: String,
    },
    AiComplete {
        room_id: String,
        id: String,
        content: String,
    },
    AiError {
        room_id: String,
        id: String,
        error: String,
    },
    AiInterrupted {
        room_id: String,
        id: String,
        content: String,
    },
    MemberJoined {
        room_id: String,
        member: Member,
    },
    MemberUpdated {
        room_id: String,
        member: Member,
    },
    MemberLeft {
        room_id: String,
        user_id: String,
    },
    Presence {
        room_id: String,
        user_id: String,
        online: bool,
    },
    /// Who is typing right now; ephemeral, relayed live and never persisted.
    Typing {
        room_id: String,
        user_id: String,
        display_name: String,
        typing: bool,
    },
    RoomUpdated {
        room_id: String,
        system_prompt: String,
        updated_by: String,
    },
    /// The message's full current reaction list; clients just replace.
    Reactions {
        room_id: String,
        message_id: String,
        reactions: Vec<Reaction>,
    },
    /// A message after an edit or a delete; carries the full current row.
    MessageUpdated {
        room_id: String,
        message: Message,
    },
    /// Answers `request_ai`: delivered to the target device only, never stored.
    AiRequested {
        request_id: String,
        room_id: String,
        anchor_id: String,
        profile_id: String,
        from_device_id: String,
    },
    LinkCode {
        request_id: String,
        code: String,
        expires_in_secs: u64,
    },
    Linked {
        request_id: String,
        user_id: String,
        display_name: String,
    },
    Devices {
        devices: Vec<Device>,
    },
    Error {
        request_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub invite_code: String,
    pub system_prompt: String,
    pub members: Vec<Member>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Member {
    pub user_id: String,
    pub display_name: String,
    pub online: bool,
}

/// One of the user's devices that is online right now.
#[derive(Debug, Clone, Serialize)]
pub struct Device {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    /// Profiles this device shares with the user's other devices (empty unless it
    /// sent `share_profiles` on this connection).
    #[serde(default)]
    pub profiles: Vec<SharedProfile>,
}

/// A profile another of the user's devices may generate with. Only id, label and
/// model cross the wire — never the key, provider or base URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedProfile {
    pub id: String,
    pub label: String,
    pub model: String,
}

/// An MCP tool call made while generating an AI reply. Only names and status
/// are shared; arguments and results stay on the sender's machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolActivity {
    pub call_id: String,
    pub server: String,
    pub tool: String,
    /// "awaiting_approval" | "running" | "done" | "error" | "denied"
    pub status: String,
}

/// Metadata of an image attached to an AI reply. The bytes are fetched
/// separately with `get_attachment`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub attachment_id: String,
    pub mime: String,
    /// The tool call that produced it, if any.
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

/// One emoji and everyone who used it on a message, in reaction order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: String,
    pub user_ids: Vec<String>,
}

/// One full-text search hit. The `snippet` carries a fragment of the message
/// text with the matched words wrapped in STX/ETX control characters, so
/// clients can highlight them without parsing HTML.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SearchHit {
    pub id: String,
    pub seq: i64,
    pub kind: String,
    pub author_name: String,
    pub created_at: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Message {
    pub id: String,
    pub room_id: String,
    pub seq: i64,
    pub kind: String,
    pub author_id: String,
    pub author_name: String,
    pub content: String,
    pub reasoning: String,
    #[sqlx(json)]
    pub tools: Vec<ToolActivity>,
    #[sqlx(json)]
    pub attachments: Vec<Attachment>,
    #[sqlx(json)]
    pub reactions: Vec<Reaction>,
    pub ai_requested: bool,
    pub anchor_id: Option<String>,
    pub model: Option<String>,
    pub reply_to: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    /// Set when the text was edited; clients show "(edited)".
    pub edited_at: Option<i64>,
    /// Soft delete: the row stays, but the content is gone for everyone.
    pub deleted: bool,
}
