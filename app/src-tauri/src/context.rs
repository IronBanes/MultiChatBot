//! Turns room history into a provider-neutral prompt: system text plus an
//! alternating user/assistant message list, trimmed to the profile's budget.

use serde::Deserialize;

const BASE_SYSTEM_PROMPT: &str = "\
You are an AI participant in a group chat with multiple people.
Each human message is prefixed with the author's display name in square brackets, \
for example \"[Alice]: hello\". Several messages from different people may be combined into one turn.
Earlier assistant turns were written by you (possibly running on different models for different people).
Respond to the most recent message, using the whole conversation as context. \
Address people by name when it helps. Do not prefix your own reply with a name tag.\n\
When a visual or interactive result helps (a chart, a diagram, a small demo), you may include one \
self-contained ```html code block; it runs in a sandbox with no network access except scripts from \
cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com, and has no access to the chat.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Human,
    Ai,
}

/// One message from the room, as sent by the webview (already filtered to
/// history up to and including the triggering message).
#[derive(Debug, Clone, Deserialize)]
pub struct HistoryItem {
    pub kind: Kind,
    pub author_name: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct Prompt {
    pub system: String,
    pub messages: Vec<ChatMessage>,
    /// How many history items were dropped to fit the budget.
    pub trimmed: usize,
}

/// Rough token estimate: ~4 characters per token plus per-message overhead.
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().count().div_ceil(4) + 4
}

/// Tokens reserved for the model's reply.
pub fn output_reserve(max_context_tokens: u32) -> u32 {
    (max_context_tokens / 4).clamp(256, 16_000)
}

pub fn system_prompt(room_prompt: &str) -> String {
    let room_prompt = room_prompt.trim();
    if room_prompt.is_empty() {
        BASE_SYSTEM_PROMPT.to_string()
    } else {
        format!("{BASE_SYSTEM_PROMPT}\n\nRoom instructions (set by the members of this room):\n{room_prompt}")
    }
}

fn to_message(item: &HistoryItem) -> ChatMessage {
    match item.kind {
        Kind::Human => ChatMessage {
            role: Role::User,
            content: format!("[{}]: {}", item.author_name, item.content),
        },
        Kind::Ai => ChatMessage { role: Role::Assistant, content: item.content.clone() },
    }
}

pub fn build(history: &[HistoryItem], room_prompt: &str, max_context_tokens: u32) -> Prompt {
    let system = system_prompt(room_prompt);
    let converted: Vec<ChatMessage> = history
        .iter()
        .filter(|h| !h.content.trim().is_empty())
        .map(to_message)
        .collect();

    // Walk backwards, always keeping the newest (triggering) message.
    let budget = (max_context_tokens.saturating_sub(output_reserve(max_context_tokens)) as usize)
        .saturating_sub(estimate_tokens(&system));
    let mut used = 0usize;
    let mut start = converted.len();
    for (i, m) in converted.iter().enumerate().rev() {
        let cost = estimate_tokens(&m.content);
        if start != converted.len() && used + cost > budget {
            break;
        }
        used += cost;
        start = i;
    }
    let trimmed = start;

    // Providers (notably Anthropic) need the first turn to be from the user.
    let kept = converted[start..].iter().skip_while(|m| m.role == Role::Assistant);

    let mut messages: Vec<ChatMessage> = Vec::new();
    for m in kept {
        match messages.last_mut() {
            Some(last) if last.role == m.role => {
                last.content.push_str("\n\n");
                last.content.push_str(&m.content);
            }
            _ => messages.push(m.clone()),
        }
    }

    Prompt { system, messages, trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn human(name: &str, text: &str) -> HistoryItem {
        HistoryItem { kind: Kind::Human, author_name: name.into(), content: text.into() }
    }
    fn ai(text: &str) -> HistoryItem {
        HistoryItem { kind: Kind::Ai, author_name: "x".into(), content: text.into() }
    }

    #[test]
    fn prefixes_names_and_merges_same_role() {
        let p = build(
            &[human("Alice", "hi"), human("Bob", "yo"), ai("hello both"), ai("more"), human("Alice", "square?")],
            "",
            100_000,
        );
        assert_eq!(p.messages.len(), 3);
        assert_eq!(p.messages[0].content, "[Alice]: hi\n\n[Bob]: yo");
        assert_eq!(p.messages[1], ChatMessage { role: Role::Assistant, content: "hello both\n\nmore".into() });
        assert_eq!(p.messages[2].content, "[Alice]: square?");
        assert_eq!(p.trimmed, 0);
    }

    #[test]
    fn room_prompt_is_appended() {
        let p = build(&[human("A", "x")], "Talk like a pirate", 1000);
        assert!(p.system.starts_with(BASE_SYSTEM_PROMPT));
        assert!(p.system.ends_with("Talk like a pirate"));
    }

    #[test]
    fn trims_oldest_but_keeps_trigger() {
        let long = "x".repeat(4000); // ~1004 tokens
        let history = vec![human("A", &long), ai(&long), human("B", &long), ai(&long), human("C", "last")];
        // 2000 context - 500 reserve - ~system => room for roughly one long message.
        let p = build(&history, "", 2000);
        assert!(p.trimmed >= 3);
        assert_eq!(p.messages.last().unwrap().content, "[C]: last");
        assert_eq!(p.messages.first().unwrap().role, Role::User);
    }

    #[test]
    fn trigger_kept_even_if_over_budget() {
        let huge = "y".repeat(100_000);
        let p = build(&[human("A", "old"), human("B", &huge)], "", 1000);
        assert_eq!(p.messages.len(), 1);
        assert!(p.messages[0].content.starts_with("[B]: "));
    }

    #[test]
    fn drops_leading_assistant_after_trim() {
        let long = "z".repeat(2400);
        let p = build(&[human("A", &long), ai("short reply"), human("B", "q")], "", 1300);
        assert_eq!(p.messages[0].role, Role::User);
    }
}
