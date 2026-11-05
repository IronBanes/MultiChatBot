//! SQLite persistence for users, rooms, members and messages.

use anyhow::Context;
use crate::protocol::{Attachment, Message, Reaction, SearchHit, ToolActivity};
use rand::Rng;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use std::collections::HashMap;
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
    ai_requested INTEGER NOT NULL DEFAULT 0,
    anchor_id TEXT,
    model TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
-- Source of truth for a reply's images: a row is the image *and* its listing on
-- the message, so an image stored mid-stream survives disconnects and restarts.
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    call_id TEXT,
    width INTEGER,
    height INTEGER,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS reactions_message ON reactions(message_id);
"#;

/// Full-text index of message text: an external-content FTS5 table over
/// `messages.content`, kept in sync by triggers. Deleting means issuing FTS5's
/// special 'delete' command with the old row, because the content table (not the
/// index) is the source of truth.
///
/// One statement per entry, run with `sqlx::query` inside a transaction: `raw_sql`
/// on a transaction makes `connect()`'s future non-`Send`, which the desktop app's
/// relay host needs.
const FTS_SCHEMA: [&str; 4] = [
    "CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, content='messages', content_rowid='seq',
        tokenize='unicode61 remove_diacritics 2'
    )",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
    END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
    END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
    END",
];

/// Opens (or creates) the database at `path`: applies the schema and later column
/// additions, creates the search index on first use (indexing existing messages),
/// and marks replies left streaming by a previous run as interrupted.
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
        "ALTER TABLE messages ADD COLUMN edited_at INTEGER",
        "ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN reply_to TEXT",
        "ALTER TABLE attachments ADD COLUMN call_id TEXT",
        "ALTER TABLE attachments ADD COLUMN width INTEGER",
        "ALTER TABLE attachments ADD COLUMN height INTEGER",
        "ALTER TABLE users ADD COLUMN secret_hash TEXT",
    ] {
        if let Err(e) = sqlx::query(ddl).execute(&pool).await {
            if !e.to_string().contains("duplicate column") {
                return Err(e.into());
            }
        }
    }
    // The search index: created once; a database from before search gets its
    // existing messages indexed in one rebuild.
    let fts_existed: Option<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'",
    )
    .fetch_optional(&pool)
    .await?;
    if fts_existed.is_none() {
        // One transaction: if the rebuild fails, the table isn't left behind empty
        // (which would make the next start skip indexing the old messages).
        let mut tx = pool.begin().await?;
        for ddl in FTS_SCHEMA {
            sqlx::query(ddl)
                .execute(&mut *tx)
                .await
                .context("creating messages_fts failed: this SQLite build lacks FTS5 (full-text search)")?;
        }
        sqlx::query("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
            .execute(&mut *tx)
            .await
            .context("indexing existing messages into messages_fts")?;
        tx.commit().await?;
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

/// How `hello`'s secret compares with what the relay knows about the account.
#[derive(Debug, PartialEq, Eq)]
pub enum SecretCheck {
    /// The secret matches the account's (or the account didn't exist and now has it).
    Ok,
    /// An account from before authentication had no secret; this one is now its own.
    Claimed,
    /// No secret was sent and the account has none yet (a client older than
    /// authentication): allowed until the account claims one.
    Legacy,
    /// The account has a secret and this isn't it (or none was sent).
    Wrong,
}

/// Hex SHA-256 of an account secret: the relay never stores the secret itself.
pub fn secret_hash(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The stored secret hash of `user_id`: outer None when there's no such user,
/// inner None when the account has no secret yet.
pub async fn stored_secret_hash(db: &Db, user_id: &str) -> sqlx::Result<Option<Option<String>>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT secret_hash FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| r.0))
}

/// Checks `secret` against `user_id`'s stored hash. A new account is created with
/// it, and an existing one without a hash claims it (trust on first use).
pub async fn check_secret(db: &Db, user_id: &str, name: &str, secret: &str) -> sqlx::Result<SecretCheck> {
    match stored_secret_hash(db, user_id).await? {
        Some(Some(stored)) => {
            let ok = !secret.is_empty() && secret_hash(secret) == stored;
            Ok(if ok { SecretCheck::Ok } else { SecretCheck::Wrong })
        }
        Some(None) if secret.is_empty() => Ok(SecretCheck::Legacy),
        Some(None) => {
            // Only claim while still unclaimed, so two first connections can't both win.
            let done = sqlx::query("UPDATE users SET secret_hash = ? WHERE id = ? AND secret_hash IS NULL")
                .bind(secret_hash(secret))
                .bind(user_id)
                .execute(db)
                .await?;
            if done.rows_affected() == 1 {
                return Ok(SecretCheck::Claimed);
            }
            let again = stored_secret_hash(db, user_id).await?.flatten();
            Ok(if again == Some(secret_hash(secret)) { SecretCheck::Ok } else { SecretCheck::Wrong })
        }
        None if secret.is_empty() => Ok(SecretCheck::Legacy),
        None => {
            sqlx::query(
                "INSERT INTO users (id, display_name, updated_at, secret_hash) VALUES (?, ?, ?, ?)
                 ON CONFLICT(id) DO NOTHING",
            )
            .bind(user_id)
            .bind(name)
            .bind(now_ms())
            .bind(secret_hash(secret))
            .execute(db)
            .await?;
            // Whoever won a race of first connections, this one must match it.
            let now = stored_secret_hash(db, user_id).await?.flatten();
            Ok(if now == Some(secret_hash(secret)) { SecretCheck::Ok } else { SecretCheck::Wrong })
        }
    }
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

/// Short human-readable code used for room invites and device linking.
pub fn invite_code() -> String {
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

/// True when `user_id` is a member of `room_id`.
pub async fn is_member(db: &Db, room_id: &str, user_id: &str) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM members WHERE room_id = ? AND user_id = ?")
        .bind(room_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
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

// `attachments` and `reactions` are filled in by `with_attachments` / `with_reactions`.
const MESSAGE_COLS: &str = "id, room_id, seq, kind, author_id, author_name, content, reasoning, tools, '[]' AS attachments, \
                            '[]' AS reactions, ai_requested, anchor_id, model, status, error, created_at, edited_at, \
                            deleted, reply_to";

pub async fn recent_messages(db: &Db, room_id: &str, limit: i64) -> sqlx::Result<Vec<Message>> {
    let messages = sqlx::query_as(&format!(
        "SELECT * FROM (SELECT {MESSAGE_COLS} FROM messages WHERE room_id = ?
         ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
    ))
    .bind(room_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    with_reactions(db, with_attachments(db, messages).await?).await
}

/// The `limit` messages with `seq < before_seq` in the room, oldest first. Callers
/// pass `limit + 1` and drop the extra row, so one query answers both the page and
/// whether older messages still exist.
pub async fn messages_before(
    db: &Db,
    room_id: &str,
    before_seq: i64,
    limit: i64,
) -> sqlx::Result<Vec<Message>> {
    let messages = sqlx::query_as(&format!(
        "SELECT * FROM (SELECT {MESSAGE_COLS} FROM messages WHERE room_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
    ))
    .bind(room_id)
    .bind(before_seq)
    .bind(limit)
    .fetch_all(db)
    .await?;
    with_reactions(db, with_attachments(db, messages).await?).await
}

/// A page of messages older than `before_seq` that reaches back to `until_seq`
/// (the message a search jump targets) plus `context` older rows for context —
/// or, when that would exceed `max_rows`, the `max_rows` messages nearest the
/// page start, so the caller can ask again from there. Oldest first.
pub async fn messages_before_until(
    db: &Db,
    room_id: &str,
    before_seq: i64,
    until_seq: i64,
    context: i64,
    max_rows: i64,
) -> sqlx::Result<Vec<Message>> {
    // The seq of the `context`-th message older than the target: the page reaches
    // down to it, one unbroken stretch. None means the history runs out first.
    let floor: Option<(i64,)> = sqlx::query_as(
        "SELECT seq FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
    )
    .bind(room_id)
    .bind(until_seq)
    .bind((context - 1).max(0))
    .fetch_optional(db)
    .await?;
    let floor = match floor {
        Some((f,)) => f,
        None if context > 0 => i64::MIN,
        None => until_seq,
    };
    let messages = sqlx::query_as(&format!(
        "SELECT * FROM (SELECT {MESSAGE_COLS} FROM messages
         WHERE room_id = ? AND seq < ? AND seq >= ?
         ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
    ))
    .bind(room_id)
    .bind(before_seq)
    .bind(floor)
    .bind(max_rows)
    .fetch_all(db)
    .await?;
    with_reactions(db, with_attachments(db, messages).await?).await
}

/// True when the room has messages older than `seq` (`has_more` for a page).
pub async fn has_messages_before(db: &Db, room_id: &str, seq: i64) -> sqlx::Result<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM messages WHERE room_id = ? AND seq < ? LIMIT 1")
            .bind(room_id)
            .bind(seq)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

pub async fn message(db: &Db, id: &str) -> sqlx::Result<Option<Message>> {
    let m: Option<Message> = sqlx::query_as(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(match m {
        Some(m) => with_reactions(db, with_attachments(db, vec![m]).await?).await?.pop(),
        None => None,
    })
}

/// Turns the text a user typed into a safe FTS5 query: each whitespace-separated
/// token is quoted (doubling inner quotes, so nothing can be parsed as FTS5
/// syntax), the last one gets `*` for prefix matching, and all are required.
/// Returns None when nothing queryable is left.
fn fts_query(query: &str) -> Option<String> {
    let mut tokens: Vec<String> =
        query.split_whitespace().map(|t| format!("\"{}\"", t.replace('"', "\"\""))).collect();
    tokens.last_mut()?.push('*');
    Some(tokens.join(" "))
}

/// Full-text search over one room's message text, newest first. Each hit's
/// `snippet` marks the matched words with STX/ETX control characters, so the
/// app can highlight them without parsing HTML.
pub async fn search_messages(
    db: &Db,
    room_id: &str,
    query: &str,
    limit: i64,
) -> sqlx::Result<Vec<SearchHit>> {
    let Some(query) = fts_query(query) else { return Ok(Vec::new()) };
    sqlx::query_as(
        "SELECT m.id, m.seq, m.kind, m.author_name, m.created_at,
                snippet(messages_fts, 0, '\u{2}', '\u{3}', '…', 12) AS snippet
         FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid
         WHERE m.room_id = ? AND m.deleted = 0 AND messages_fts MATCH ?
         ORDER BY m.seq DESC LIMIT ?",
    )
    .bind(room_id)
    .bind(query)
    .bind(limit)
    .fetch_all(db)
    .await
}

type AttachmentRow = (String, String, String, Option<String>, Option<i64>, Option<i64>);

/// Lists each AI message's stored images, in upload order.
async fn with_attachments(db: &Db, mut messages: Vec<Message>) -> sqlx::Result<Vec<Message>> {
    let ids: Vec<&str> = messages.iter().filter(|m| m.kind == "ai").map(|m| m.id.as_str()).collect();
    if ids.is_empty() {
        return Ok(messages);
    }
    let sql = format!(
        "SELECT id, message_id, mime, call_id, width, height FROM attachments
         WHERE message_id IN ({}) ORDER BY created_at, rowid",
        vec!["?"; ids.len()].join(", ")
    );
    let mut query = sqlx::query_as::<_, AttachmentRow>(&sql);
    for id in &ids {
        query = query.bind(*id);
    }
    let mut by_message: HashMap<String, Vec<Attachment>> = HashMap::new();
    for (attachment_id, message_id, mime, call_id, width, height) in query.fetch_all(db).await? {
        by_message.entry(message_id).or_default().push(Attachment {
            attachment_id,
            mime,
            call_id,
            width: width.and_then(|w| u32::try_from(w).ok()),
            height: height.and_then(|h| u32::try_from(h).ok()),
        });
    }
    for m in &mut messages {
        if let Some(list) = by_message.remove(&m.id) {
            m.attachments = list;
        }
    }
    Ok(messages)
}

/// Why a reaction wasn't added.
#[derive(Debug, PartialEq, Eq)]
pub enum ReactionRefused {
    /// The user isn't (or is no longer) a member of the room.
    NotMember,
    /// The emoji is new to the message and it already has `max_emoji` distinct ones.
    TooMany,
}

/// Adds or removes one user's reaction. Adding one that already exists is a no-op.
/// The membership and cap checks run inside the insert, so a concurrent leave or a
/// concurrent new emoji can't slip past them.
pub async fn set_reaction(
    db: &Db,
    room_id: &str,
    message_id: &str,
    user_id: &str,
    emoji: &str,
    on: bool,
    max_emoji: usize,
) -> sqlx::Result<Result<(), ReactionRefused>> {
    if on {
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO reactions (message_id, room_id, user_id, emoji, created_at)
             SELECT ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM members WHERE room_id = ? AND user_id = ?)
               AND (EXISTS (SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?)
                    OR (SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = ?) < ?)",
        )
        .bind(message_id)
        .bind(room_id)
        .bind(user_id)
        .bind(emoji)
        .bind(now_ms())
        .bind(room_id)
        .bind(user_id)
        .bind(message_id)
        .bind(emoji)
        .bind(message_id)
        .bind(max_emoji as i64)
        .execute(db)
        .await?
        .rows_affected();
        if inserted == 0 {
            // Nothing written: not a member, already had this reaction (fine), or the
            // emoji is new to the message and the cap stopped it.
            let (member, present): (bool, bool) = sqlx::query_as(
                "SELECT EXISTS (SELECT 1 FROM members WHERE room_id = ? AND user_id = ?),
                        EXISTS (SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?)",
            )
            .bind(room_id)
            .bind(user_id)
            .bind(message_id)
            .bind(emoji)
            .fetch_one(db)
            .await?;
            return Ok(if !member {
                Err(ReactionRefused::NotMember)
            } else if present {
                Ok(())
            } else {
                Err(ReactionRefused::TooMany)
            });
        }
    } else {
        sqlx::query("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
            .bind(message_id)
            .bind(user_id)
            .bind(emoji)
            .execute(db)
            .await?;
    }
    Ok(Ok(()))
}

/// A message's reactions grouped by emoji, every message kind included.
pub async fn reactions(db: &Db, message_id: &str) -> sqlx::Result<Vec<Reaction>> {
    let mut groups: Vec<Reaction> = Vec::new();
    for (user_id, emoji) in
        sqlx::query_as::<_, (String, String)>(
            "SELECT user_id, emoji FROM reactions WHERE message_id = ? ORDER BY created_at, rowid",
        )
        .bind(message_id)
        .fetch_all(db)
        .await?
    {
        push_reaction(&mut groups, emoji, user_id);
    }
    Ok(groups)
}

/// Appends to a reaction group, creating it where the emoji first appears.
fn push_reaction(groups: &mut Vec<Reaction>, emoji: String, user_id: String) {
    match groups.iter_mut().find(|r| r.emoji == emoji) {
        Some(r) => r.user_ids.push(user_id),
        None => groups.push(Reaction { emoji, user_ids: vec![user_id] }),
    }
}

/// Fills `reactions` for all messages in one query, ordered per emoji by first use.
async fn with_reactions(db: &Db, mut messages: Vec<Message>) -> sqlx::Result<Vec<Message>> {
    let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    if ids.is_empty() {
        return Ok(messages);
    }
    let sql = format!(
        "SELECT message_id, user_id, emoji FROM reactions
         WHERE message_id IN ({}) ORDER BY created_at, rowid",
        vec!["?"; ids.len()].join(", ")
    );
    let mut query = sqlx::query_as::<_, (String, String, String)>(&sql);
    for id in &ids {
        query = query.bind(*id);
    }
    let mut by_message: HashMap<String, Vec<Reaction>> = HashMap::new();
    for (message_id, user_id, emoji) in query.fetch_all(db).await? {
        push_reaction(by_message.entry(message_id).or_default(), emoji, user_id);
    }
    for m in &mut messages {
        if let Some(list) = by_message.remove(&m.id) {
            m.reactions = list;
        }
    }
    Ok(messages)
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
    pub reply_to: Option<&'a str>,
    pub status: &'a str,
}

pub async fn insert_message(db: &Db, m: NewMessage<'_>) -> sqlx::Result<Message> {
    sqlx::query(
        "INSERT INTO messages (id, room_id, kind, author_id, author_name, content, ai_requested,
                               anchor_id, model, reply_to, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(m.reply_to)
    .bind(m.status)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(message(db, m.id).await?.expect("row just inserted"))
}

/// Rewrites a message's text and stamps `edited_at`, so clients can show "(edited)".
/// A message deleted in the meantime stays deleted.
pub async fn edit_message(db: &Db, id: &str, content: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND deleted = 0")
        .bind(content)
        .bind(now_ms())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Soft-deletes a message: the row stays (AI anchors and replies still resolve) but
/// the text, reasoning, tools, images and reactions are gone. One transaction, so a
/// failed cleanup can't leave a "deleted" message whose images are still served.
pub async fn delete_message(db: &Db, id: &str) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query(
        "UPDATE messages SET content = '', reasoning = '', tools = '[]', error = NULL, deleted = 1 \
         WHERE id = ?",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    for sql in [
        "DELETE FROM reactions WHERE message_id = ?",
        "DELETE FROM attachments WHERE message_id = ?",
    ] {
        sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await
}

pub struct AiResult<'a> {
    pub content: &'a str,
    pub reasoning: &'a str,
    pub tools: &'a [ToolActivity],
    pub status: &'a str,
    pub error: Option<&'a str>,
}

pub async fn finish_ai(db: &Db, id: &str, r: AiResult<'_>) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE messages SET content = ?, reasoning = ?, tools = ?, status = ?, error = ? WHERE id = ?",
    )
        .bind(r.content)
        .bind(r.reasoning)
        .bind(serde_json::to_string(r.tools).unwrap_or_else(|_| "[]".into()))
        .bind(r.status)
        .bind(r.error)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn insert_attachment(db: &Db, a: &Attachment, message_id: &str, room_id: &str, data: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO attachments (id, message_id, room_id, mime, call_id, width, height, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
        .bind(&a.attachment_id)
        .bind(message_id)
        .bind(room_id)
        .bind(&a.mime)
        .bind(&a.call_id)
        .bind(a.width)
        .bind(a.height)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reaction_cap_holds_but_existing_emoji_still_join() {
        let dir = std::env::temp_dir().join(format!("mc-react-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0), ('b', 'B', 0), ('c', 'C', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES ('r', 'R', 'X', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0), ('r', 'b', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        let set = |u: &'static str, e: &'static str, on: bool| set_reaction(&db, "r", "m", u, e, on, 2);
        let emoji = ["😀", "😁", "😂"];
        for e in &emoji[..2] {
            assert_eq!(set("a", e, true).await.unwrap(), Ok(()));
        }
        // A third distinct emoji is over the cap of 2.
        assert_eq!(set("b", emoji[2], true).await.unwrap(), Err(ReactionRefused::TooMany));
        // Joining an emoji that is already there, or repeating your own, still works.
        assert_eq!(set("b", emoji[0], true).await.unwrap(), Ok(()));
        assert_eq!(set("b", emoji[0], true).await.unwrap(), Ok(()));
        // Someone outside the room can't react, even with an existing emoji.
        assert_eq!(set("c", emoji[0], true).await.unwrap(), Err(ReactionRefused::NotMember));
        // Removing one frees a slot.
        assert_eq!(set("a", emoji[1], false).await.unwrap(), Ok(()));
        assert_eq!(set("b", emoji[2], true).await.unwrap(), Ok(()));
        let got: Vec<_> = reactions(&db, "m").await.unwrap().into_iter().map(|r| (r.emoji, r.user_ids.len())).collect();
        assert_eq!(got, vec![("😀".to_string(), 2), ("😂".to_string(), 1)]);
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_message_rewrites_content_and_stamps_edited_at() {
        let dir = std::env::temp_dir().join(format!("mc-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES ('r', 'R', 'X', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        insert_message(
            &db,
            NewMessage {
                id: "m1",
                room_id: "r",
                kind: "human",
                author_id: "a",
                author_name: "A",
                content: "first take",
                ai_requested: false,
                anchor_id: None,
                model: None,
                reply_to: None,
                status: "complete",
            },
        )
        .await
        .unwrap();
        assert_eq!(message(&db, "m1").await.unwrap().unwrap().edited_at, None);
        edit_message(&db, "m1", "second take").await.unwrap();
        let m = message(&db, "m1").await.unwrap().unwrap();
        assert_eq!(m.content, "second take");
        assert!(m.edited_at.is_some_and(|t| t > 0));
        assert!(!m.deleted);
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn delete_message_clears_content_and_reactions_but_keeps_the_row() {
        let dir = std::env::temp_dir().join(format!("mc-del-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0), ('b', 'B', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES ('r', 'R', 'X', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0), ('r', 'b', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        insert_message(
            &db,
            NewMessage {
                id: "m1",
                room_id: "r",
                kind: "human",
                author_id: "a",
                author_name: "A",
                content: "vanishing",
                ai_requested: false,
                anchor_id: None,
                model: None,
                reply_to: None,
                status: "complete",
            },
        )
        .await
        .unwrap();
        set_reaction(&db, "r", "m1", "b", "😀", true, 20).await.unwrap().unwrap();
        delete_message(&db, "m1").await.unwrap();
        let m = message(&db, "m1").await.unwrap().unwrap();
        assert_eq!(m.content, "");
        assert_eq!(m.reasoning, "");
        assert!(m.tools.is_empty());
        assert!(m.deleted);
        // Reactions were removed with the content; the row itself stays.
        assert!(reactions(&db, "m1").await.unwrap().is_empty());
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn message_returns_reply_to_and_message_round_trips_it() {
        let dir = std::env::temp_dir().join(format!("mc-reply-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES ('r', 'R', 'X', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        for (id, reply_to) in [("m1", None), ("m2", Some("m1"))] {
            insert_message(
                &db,
                NewMessage {
                    id,
                    room_id: "r",
                    kind: "human",
                    author_id: "a",
                    author_name: "A",
                    content: "text",
                    ai_requested: false,
                    anchor_id: None,
                    model: None,
                    reply_to,
                    status: "complete",
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(message(&db, "m1").await.unwrap().unwrap().reply_to, None);
        assert_eq!(message(&db, "m2").await.unwrap().unwrap().reply_to.as_deref(), Some("m1"));
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn messages_before_pages_older_messages_oldest_first() {
        let dir = std::env::temp_dir().join(format!("mc-older-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES ('r', 'R', 'X', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        let ids = ["m1", "m2", "m3", "m4", "m5"];
        for id in ids {
            insert_message(
                &db,
                NewMessage {
                    id,
                    room_id: "r",
                    kind: "human",
                    author_id: "a",
                    author_name: "A",
                    content: "text",
                    ai_requested: false,
                    anchor_id: None,
                    model: None,
                    reply_to: None,
                    status: "complete",
                },
            )
            .await
            .unwrap();
        }
        let all = recent_messages(&db, "r", 10).await.unwrap();
        let seqs: Vec<i64> = all.iter().map(|m| m.seq).collect();
        let before = all[3].seq; // the 4th message
        let page = messages_before(&db, "r", before, 2).await.unwrap();
        assert_eq!(page.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["m2", "m3"]);
        assert_eq!(page.iter().map(|m| m.seq).collect::<Vec<_>>(), seqs[1..3]);
        // One extra row answers whether older messages still exist: 3 fetched, 2 kept.
        let probe = messages_before(&db, "r", before, 3).await.unwrap();
        assert_eq!(probe.len(), 3);
        // Before the oldest message there is nothing, not even with a page size left over.
        assert!(messages_before(&db, "r", all[0].seq, 2).await.unwrap().is_empty());
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn messages_before_until_reaches_a_far_back_target() {
        let dir = std::env::temp_dir().join(format!("mc-until-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at) VALUES ('r', 'R', 'X', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        for id in ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"] {
            insert_message(
                &db,
                NewMessage {
                    id,
                    room_id: "r",
                    kind: "human",
                    author_id: "a",
                    author_name: "A",
                    content: "text",
                    ai_requested: false,
                    anchor_id: None,
                    model: None,
                    reply_to: None,
                    status: "complete",
                },
            )
            .await
            .unwrap();
        }
        let all = recent_messages(&db, "r", 20).await.unwrap();
        let seq = |id: &str| all.iter().find(|m| m.id == id).unwrap().seq;
        // The stretch: everything down to the target m3, plus two rows of context.
        let page = messages_before_until(&db, "r", seq("m8"), seq("m3"), 2, 100).await.unwrap();
        assert_eq!(
            page.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2", "m3", "m4", "m5", "m6", "m7"]
        );
        assert!(!has_messages_before(&db, "r", page[0].seq).await.unwrap());
        // Capped at four rows: the four nearest the page start come back.
        let capped = messages_before_until(&db, "r", seq("m8"), seq("m3"), 2, 4).await.unwrap();
        assert_eq!(
            capped.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m4", "m5", "m6", "m7"]
        );
        assert!(has_messages_before(&db, "r", capped[0].seq).await.unwrap());
        // Wider context: one unbroken stretch from three rows below the target (m6)
        // up to the page start, with no gap between the context and the target.
        let wide = messages_before_until(&db, "r", seq("m10"), seq("m6"), 3, 100).await.unwrap();
        assert_eq!(
            wide.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m3", "m4", "m5", "m6", "m7", "m8", "m9"]
        );
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rooms "r" and "r2" with member "a"; r gets hello world / Hello there /
    /// goodbye, r2 gets hello. Returns (db, dir) for the caller to clean up.
    async fn search_fixture(suffix: &str) -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mc-search-{suffix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO users (id, display_name, updated_at) VALUES ('a', 'A', 0);
             INSERT INTO rooms (id, name, invite_code, created_by, created_at)
             VALUES ('r', 'R', 'X', 'a', 0), ('r2', 'R2', 'Y', 'a', 0);
             INSERT INTO members VALUES ('r', 'a', 0);",
        )
        .execute(&db)
        .await
        .unwrap();
        (db, dir)
    }

    #[tokio::test]
    async fn search_matches_prefixes_in_one_room_newest_first() {
        let (db, dir) = search_fixture("hits").await;
        for (id, room, text) in
            [("m1", "r", "hello world"), ("m2", "r", "Hello there"), ("m3", "r", "goodbye"), ("m4", "r2", "hello")]
        {
            insert_message(
                &db,
                NewMessage {
                    id,
                    room_id: room,
                    kind: "human",
                    author_id: "a",
                    author_name: "A",
                    content: text,
                    ai_requested: false,
                    anchor_id: None,
                    model: None,
                    reply_to: None,
                    status: "complete",
                },
            )
            .await
            .unwrap();
        }
        // "hel": prefix match, case-insensitive, this room only, newest first.
        let hits = search_messages(&db, "r", "hel", 10).await.unwrap();
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), vec!["m2", "m1"]);
        for h in &hits {
            assert_eq!(h.kind, "human");
            assert_eq!(h.author_name, "A");
            assert!(h.created_at > 0);
            assert!(h.snippet.contains('\u{2}') && h.snippet.contains('\u{3}'));
        }
        assert!(hits[0].snippet.to_lowercase().contains("hello"));
        // The limit holds.
        assert_eq!(search_messages(&db, "r", "hel", 1).await.unwrap().len(), 1);
        // Only whitespace, or quote characters, is nothing to search for.
        assert!(search_messages(&db, "r", "   ", 10).await.unwrap().is_empty());
        assert!(search_messages(&db, "r", "\" \"", 10).await.unwrap().is_empty());
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn search_follows_edits_and_deletes() {
        let (db, dir) = search_fixture("writes").await;
        for (id, text) in [("m1", "hello world"), ("m2", "Hello there")] {
            insert_message(
                &db,
                NewMessage {
                    id,
                    room_id: "r",
                    kind: "human",
                    author_id: "a",
                    author_name: "A",
                    content: text,
                    ai_requested: false,
                    anchor_id: None,
                    model: None,
                    reply_to: None,
                    status: "complete",
                },
            )
            .await
            .unwrap();
        }
        // Editing m2 away from the word: the old text stops matching, the new starts.
        edit_message(&db, "m2", "rephrased entirely").await.unwrap();
        let hits = search_messages(&db, "r", "hel", 10).await.unwrap();
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), vec!["m1"]);
        let rephrased = search_messages(&db, "r", "rephras", 10).await.unwrap();
        assert_eq!(rephrased.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), vec!["m2"]);
        // Deleting a message takes it out of the results.
        delete_message(&db, "m1").await.unwrap();
        assert!(search_messages(&db, "r", "hel", 10).await.unwrap().is_empty());
        assert!(search_messages(&db, "r", "rephras", 10).await.unwrap().len() == 1);
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[tokio::test]
    async fn account_secrets_are_checked_claimed_and_never_stored() {
        let dir = std::env::temp_dir().join(format!("mc-secret-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        // A new account takes the secret it first connects with; only its hash is kept.
        assert_eq!(check_secret(&db, "u1", "A", "s3cret").await.unwrap(), SecretCheck::Ok);
        let stored = stored_secret_hash(&db, "u1").await.unwrap().flatten().unwrap();
        assert_ne!(stored, "s3cret");
        assert_eq!(stored, secret_hash("s3cret"));
        assert_eq!(check_secret(&db, "u1", "A", "s3cret").await.unwrap(), SecretCheck::Ok);
        assert_eq!(check_secret(&db, "u1", "A", "other").await.unwrap(), SecretCheck::Wrong);
        assert_eq!(check_secret(&db, "u1", "A", "").await.unwrap(), SecretCheck::Wrong);
        // An account from before secrets: an old client still gets in, the first
        // secret claims it, and from then on only that secret works.
        upsert_user(&db, "u2", "B").await.unwrap();
        assert_eq!(check_secret(&db, "u2", "B", "").await.unwrap(), SecretCheck::Legacy);
        assert_eq!(check_secret(&db, "u2", "B", "mine").await.unwrap(), SecretCheck::Claimed);
        assert_eq!(check_secret(&db, "u2", "B", "theirs").await.unwrap(), SecretCheck::Wrong);
        assert_eq!(check_secret(&db, "u2", "B", "").await.unwrap(), SecretCheck::Wrong);
        assert_eq!(check_secret(&db, "u2", "B", "mine").await.unwrap(), SecretCheck::Ok);
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
