//! SQLite persistence for users, rooms, members and messages.

use crate::protocol::{Attachment, Message, ToolActivity};
use rand::Rng;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use std::str::FromStr;

pub type Db = SqlitePool;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    system_prompt TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    kind TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    ai_requested INTEGER NOT NULL DEFAULT 0,
    anchor_id TEXT,
    model TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"#;

pub async fn connect(path: &str) -> anyhow::Result<Db> {
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    sqlx::raw_sql(SCHEMA).execute(&pool).await?;
    // Columns added after the first release; existing databases need them too.
    for ddl in [
        "ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE messages ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
    ] {
        if let Err(e) = sqlx::query(ddl).execute(&pool).await {
            if !e.to_string().contains("duplicate column") {
                return Err(e.into());
            }
        }
    }
    // Streams cannot survive a server restart.
    sqlx::query("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'")
        .execute(&pool)
        .await?;
    Ok(pool)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Upserts a user. Returns the previous display name, if the user existed.
pub async fn upsert_user(db: &Db, id: &str, name: &str) -> sqlx::Result<Option<String>> {
    let prev: Option<(String,)> = sqlx::query_as("SELECT display_name FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    sqlx::query(
        "INSERT INTO users (id, display_name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at",
    )
    .bind(id)
    .bind(name)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(prev.map(|p| p.0))
}

pub async fn user_room_ids(db: &Db, user_id: &str) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT m.room_id FROM members m JOIN rooms r ON r.id = m.room_id
         WHERE m.user_id = ? ORDER BY m.joined_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

pub struct RoomRow {
    pub id: String,
    pub name: String,
    pub invite_code: String,
    pub system_prompt: String,
    /// (user_id, display_name)
    pub members: Vec<(String, String)>,
}

pub async fn room(db: &Db, room_id: &str) -> sqlx::Result<Option<RoomRow>> {
    let row: Option<(String, String, String, String)> =
        sqlx::query_as("SELECT id, name, invite_code, system_prompt FROM rooms WHERE id = ?")
            .bind(room_id)
            .fetch_optional(db)
            .await?;
    let Some((id, name, invite_code, system_prompt)) = row else {
        return Ok(None);
    };
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT u.id, u.display_name FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.room_id = ? ORDER BY m.joined_at",
    )
    .bind(room_id)
    .fetch_all(db)
    .await?;
    Ok(Some(RoomRow { id, name, invite_code, system_prompt, members }))
}

fn invite_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..6).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

/// Creates a room and adds the creator as its first member. Returns the room id.
pub async fn create_room(db: &Db, name: &str, creator: &str) -> sqlx::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut tries = 0;
    loop {
        let res = sqlx::query(
            "INSERT INTO rooms (id, name, invite_code, system_prompt, created_by, created_at)
             VALUES (?, ?, ?, '', ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(invite_code())
        .bind(creator)
        .bind(now_ms())
        .execute(db)
        .await;
        match res {
            Ok(_) => break,
            // Invite code collision: try another one.
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() && tries < 5 => tries += 1,
            Err(e) => return Err(e),
        }
    }
    add_member(db, &id, creator).await?;
    Ok(id)
}

pub async fn room_id_by_code(db: &Db, code: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM rooms WHERE invite_code = ?")
        .bind(code)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| r.0))
}

/// Returns true if the user was newly added.
pub async fn add_member(db: &Db, room_id: &str, user_id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "INSERT INTO members (room_id, user_id, joined_at) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(room_id)
    .bind(user_id)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn remove_member(db: &Db, room_id: &str, user_id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM members WHERE room_id = ? AND user_id = ?")
        .bind(room_id)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn set_room_prompt(db: &Db, room_id: &str, prompt: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE rooms SET system_prompt = ? WHERE id = ?")
        .bind(prompt)
        .bind(room_id)
        .execute(db)
        .await?;
    Ok(())
}

const MESSAGE_COLS: &str = "id, room_id, seq, kind, author_id, author_name, content, reasoning, tools, attachments, ai_requested, \
                            anchor_id, model, status, error, created_at";

pub async fn recent_messages(db: &Db, room_id: &str, limit: i64) -> sqlx::Result<Vec<Message>> {
    sqlx::query_as(&format!(
        "SELECT * FROM (SELECT {MESSAGE_COLS} FROM messages WHERE room_id = ?
         ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
    ))
    .bind(room_id)
    .bind(limit)
    .fetch_all(db)
    .await
}

pub async fn message(db: &Db, id: &str) -> sqlx::Result<Option<Message>> {
    sqlx::query_as(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub struct NewMessage<'a> {
    pub id: &'a str,
    pub room_id: &'a str,
    pub kind: &'a str,
    pub author_id: &'a str,
    pub author_name: &'a str,
    pub content: &'a str,
    pub ai_requested: bool,
    pub anchor_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub status: &'a str,
}

pub async fn insert_message(db: &Db, m: NewMessage<'_>) -> sqlx::Result<Message> {
    sqlx::query(
        "INSERT INTO messages (id, room_id, kind, author_id, author_name, content, ai_requested,
                               anchor_id, model, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(m.id)
    .bind(m.room_id)
    .bind(m.kind)
    .bind(m.author_id)
    .bind(m.author_name)
    .bind(m.content)
    .bind(m.ai_requested)
    .bind(m.anchor_id)
    .bind(m.model)
    .bind(m.status)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(message(db, m.id).await?.expect("row just inserted"))
}

pub struct AiResult<'a> {
    pub content: &'a str,
    pub reasoning: &'a str,
    pub tools: &'a [ToolActivity],
    pub attachments: &'a [Attachment],
    pub status: &'a str,
    pub error: Option<&'a str>,
}

pub async fn finish_ai(db: &Db, id: &str, r: AiResult<'_>) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE messages SET content = ?, reasoning = ?, tools = ?, attachments = ?, status = ?, error = ? WHERE id = ?",
    )
        .bind(r.content)
        .bind(r.reasoning)
        .bind(serde_json::to_string(r.tools).unwrap_or_else(|_| "[]".into()))
        .bind(serde_json::to_string(r.attachments).unwrap_or_else(|_| "[]".into()))
        .bind(r.status)
        .bind(r.error)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn insert_attachment(db: &Db, a: &Attachment, message_id: &str, room_id: &str, data: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO attachments (id, message_id, room_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&a.attachment_id)
        .bind(message_id)
        .bind(room_id)
        .bind(&a.mime)
        .bind(data)
        .bind(now_ms())
        .execute(db)
        .await?;
    Ok(())
}

/// (room_id, mime, base64 data)
pub async fn attachment(db: &Db, id: &str) -> sqlx::Result<Option<(String, String, String)>> {
    sqlx::query_as("SELECT room_id, mime, data FROM attachments WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
}
