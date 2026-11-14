//! WebSocket wire protocol. See docs/PLAN.md for the full table.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
        /// The account's secret: proves this connection may act as `user_id`. The
        /// relay keeps only its hash. Empty from clients older than authentication.
        #[serde(default)]
        secret: String,
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
    /// Stores the room's shared summary of messages up to `upto_seq`. Only moves
    /// forward and never past the room's last message.
    SetRoomSummary {
        room_id: String,
        summary: String,
        upto_seq: i64,
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
        /// The device's MCP servers; ignored unless `remote_control` is on.
        #[serde(default)]
        mcp_servers: Vec<SharedMcpServer>,
        /// True when this device accepts `device_command`s from the user's other devices.
        #[serde(default)]
        remote_control: bool,
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
        /// This account's secret, handed to the device that redeems the code.
        #[serde(default)]
        secret: String,
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
    /// Something for another of the user's own devices to do or show. Forwarded to
    /// that device only and never stored.
    DeviceCommand {
        request_id: String,
        device_id: String,
        command: DeviceCommand,
    },
    /// The target device's answer to a `device_command`; `error` is `None` on success.
    DeviceReply {
        request_id: String,
        to_device_id: String,
        #[serde(default)]
        error: Option<String>,
    },
    /// Replaces what this connection lends to `room_id` (empty = stops lending
    /// there). Only tool names, descriptions and input schemas cross the wire;
    /// broadcast to the room as `room_tools`.
    LendTools {
        room_id: String,
        servers: Vec<LentServer>,
    },
    /// Asks a room member's device that lends `server_id` to run one tool.
    /// Forwarded to that lender only, as `lent_tool_call`; never stored.
    CallLentTool {
        request_id: String,
        room_id: String,
        device_id: String,
        server_id: String,
        tool: String,
        args: serde_json::Value,
    },
    /// The lender's answer to a `call_lent_tool`; accepted only from the
    /// lender connection recorded for that request. Forwarded to the caller.
    LentToolResult {
        request_id: String,
        content: String,
        is_error: bool,
        images: Vec<LentImage>,
    },
    /// The caller gives up on a pending `call_lent_tool`; forwarded to the
    /// lender as `lent_tool_cancelled`.
    CancelLentTool {
        request_id: String,
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
    /// A room's summary moved forward: every member's AI uses the same one.
    RoomSummary {
        room_id: String,
        summary: String,
        upto_seq: i64,
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
        /// The anchor's position, so the device can load back to it if it's older than
        /// what it has loaded (`load_older` with `until_seq`).
        anchor_seq: i64,
        profile_id: String,
        from_device_id: String,
    },
    /// Forwards `device_command`: delivered to the target device only, never stored.
    DeviceCommand {
        request_id: String,
        from_device_id: String,
        command: DeviceCommand,
    },
    /// What one connection currently lends in a room: sent on every change, on
    /// joining (one per other lending connection) and as an empty `servers`
    /// when that connection stops lending there.
    RoomTools {
        room_id: String,
        user_id: String,
        display_name: String,
        device_id: String,
        servers: Vec<LentServer>,
    },
    /// Forwards `call_lent_tool` to the lending connection only; never stored.
    LentToolCall {
        request_id: String,
        room_id: String,
        from_user_id: String,
        from_name: String,
        server_id: String,
        tool: String,
        args: serde_json::Value,
    },
    /// The lender's answer to a `lent_toolCall`: forwarded to the caller
    /// connection only, and the pending entry is removed.
    LentToolResult {
        request_id: String,
        content: String,
        is_error: bool,
        images: Vec<LentImage>,
    },
    /// The caller gave up on a pending lent tool call.
    LentToolCancelled {
        request_id: String,
    },
    /// The target device did what a `device_command` asked (failures arrive as `error`).
    DeviceReply {
        request_id: String,
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
        /// The account's secret, so the linked device can sign in as it.
        secret: String,
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
    /// Conversation summary of the messages up to `summary_upto_seq` ("" = none).
    pub summary: String,
    /// `seq` of the last message the summary covers; 0 = no summary.
    pub summary_upto_seq: i64,
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
    /// Its MCP servers, shared only while `remote_control` is on.
    #[serde(default)]
    pub mcp_servers: Vec<SharedMcpServer>,
    /// True when it accepts `device_command`s from the user's other devices.
    #[serde(default)]
    pub remote_control: bool,
}

/// A profile another of the user's devices may generate with. Only id, label, model
/// and whether it's on cross the wire — never the key, provider or base URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedProfile {
    pub id: String,
    pub label: String,
    pub model: String,
    /// Off profiles stay listed, so a linked device can turn them back on.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// A tool a room member's AI may call on the lender's computer. Only names,
/// descriptions and input schemas cross the wire — never the server's
/// command, URL, env or headers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LentTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// An MCP server one connection lends to a room.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LentServer {
    pub id: String,
    pub name: String,
    pub tools: Vec<LentTool>,
}

/// An image returned by a lent tool call (base64).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LentImage {
    pub mime: String,
    pub data: String,
}

/// An MCP server another of the user's devices may switch. Only its name and modes
/// cross the wire — never its command, URL or secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedMcpServer {
    pub id: String,
    pub name: String,
    /// "off" | "ask" | "auto"
    pub default_mode: String,
    /// room id → mode, for rooms that override `default_mode`.
    #[serde(default)]
    pub room_modes: HashMap<String, String>,
}

/// What one of the user's devices asks another to do or show. The relay only checks
/// the size and that both ends are the same account; the receiving device decides
/// whether to obey (see docs/PLAN.md, "Remote control").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceCommand {
    /// Switch an MCP server in one room. A device only accepts "off" or "ask".
    SetMcpMode { room_id: String, server_id: String, mode: String },
    /// Turn a profile on or off.
    SetProfileEnabled { profile_id: String, enabled: bool },
    /// A delegated reply wants to run a tool: goes to the device that asked for the
    /// reply. `args` is why this isn't a room frame; it stays between the two devices.
    ToolApproval { room_id: String, message_id: String, call_id: String, server: String, tool: String, args: String },
    /// The answer to a `tool_approval`.
    AnswerTool { message_id: String, call_id: String, approved: bool },
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
