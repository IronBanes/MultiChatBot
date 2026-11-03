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
    SendMessage {
        room_id: String,
        id: String,
        content: String,
        ai_requested: bool,
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
    CreateLinkCode {
        request_id: String,
    },
    RedeemLinkCode {
        request_id: String,
        code: String,
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
    RoomUpdated {
        room_id: String,
        system_prompt: String,
        updated_by: String,
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
    pub ai_requested: bool,
    pub anchor_id: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}
