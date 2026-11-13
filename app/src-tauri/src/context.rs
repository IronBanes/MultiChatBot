//! Turns room history into a provider-neutral prompt: system text plus an
//! alternating user/assistant message list, trimmed to the profile's budget —
//! and, instead of trimming, the oldest messages can be folded into a summary
//! the whole room shares (see `plan_summary` / `summary_request`).

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
    /// The room message's `seq`; 0 when missing. Where the summary boundary is.
    #[serde(default)]
    pub seq: i64,
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

pub fn system_prompt(room_prompt: &str, summary: &str) -> String {
    let room_prompt = room_prompt.trim();
    let mut prompt = if room_prompt.is_empty() {
        BASE_SYSTEM_PROMPT.to_string()
    } else {
        format!("{BASE_SYSTEM_PROMPT}\n\nRoom instructions (set by the members of this room):\n{room_prompt}")
    };
    let summary = summary.trim();
    if !summary.is_empty() {
        prompt.push_str("\n\nSummary of the earlier conversation (those messages are not shown):\n");
        prompt.push_str(summary);
    }
    prompt
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

/// How many of the newest history items are always kept verbatim when the rest
/// is summarized.
const KEEP_RECENT: usize = 6;

/// How many of the oldest history items should be folded into the room summary
/// instead of trimmed away. None while the prompt still fits comfortably or the
/// history is too short to be worth a summary.
pub fn plan_summary(
    history: &[HistoryItem],
    room_prompt: &str,
    summary: &str,
    max_context_tokens: u32,
) -> Option<usize> {
    if history.len() <= KEEP_RECENT {
        return None;
    }
    let budget = max_context_tokens.saturating_sub(output_reserve(max_context_tokens));
    // The summary is part of the system text, so the budget already accounts for it.
    let total = estimate_tokens(&system_prompt(room_prompt, summary))
        + history
            .iter()
            .filter(|h| !h.content.trim().is_empty())
            .map(|h| estimate_tokens(&h.content))
            .sum::<usize>();
    if total > (budget as f64 * 0.8) as usize {
        Some(history.len() - KEEP_RECENT)
    } else {
        None
    }
}

/// The request that asks the model to write (or extend) the room summary from
/// `items`, the oldest history entries to fold in. Returns the system text, the
/// single user message, and how many of `items` (from the front) it covers.
///
/// Coverage is always a prefix: the oldest items that fit the input budget go in
/// and the rest stay out, so the room's summary boundary (the last covered `seq`)
/// never claims a message the model didn't see. An oldest message too long to fit
/// on its own goes in cut short, so coverage still moves. 0 means even that
/// doesn't fit (the previous summary fills the budget). Rendered once, in one pass.
pub fn summary_request(
    previous: &str,
    items: &[HistoryItem],
    max_context_tokens: u32,
) -> (String, Vec<ChatMessage>, usize) {
    let system = "You maintain a running summary of a group chat. Keep who said what (names), decisions that were made, open questions, facts people shared and what the AI was asked to do. Write plain prose under about 400 words, no preamble.";

    let budget = (max_context_tokens.saturating_sub(output_reserve(max_context_tokens)) as usize)
        .saturating_sub(estimate_tokens(system));
    // estimate_tokens(text) = ceil(chars / 4) + 4, so this many characters fit.
    let max_chars = budget.saturating_sub(4) * 4;

    let mut text = String::new();
    let previous = previous.trim();
    if !previous.is_empty() {
        text.push_str("Current summary:
");
        text.push_str(previous);
        text.push_str("

New messages to fold in:
");
    }
    let mut chars = text.chars().count();
    let mut covered = 0;
    let mut any = false;
    for h in items {
        if h.content.trim().is_empty() {
            // Nothing to summarize, but it's inside the covered prefix.
            covered += 1;
            continue;
        }
        let name = match h.kind {
            Kind::Human => h.author_name.as_str(),
            Kind::Ai => "AI",
        };
        let line = format!("[{name}]: {}
", h.content);
        let len = line.chars().count();
        if chars + len > max_chars {
            const CUT: &str = " [...]
";
            let room = max_chars.saturating_sub(chars + CUT.len());
            // The oldest message alone is too long: send its start rather than
            // never moving past it. Only when a useful part of it fits.
            if !any && room >= 64 {
                text.extend(line.chars().take(room));
                text.push_str(CUT);
                covered += 1;
                any = true;
            }
            break;
        }
        text.push_str(&line);
        chars += len;
        covered += 1;
        any = true;
    }
    if !any {
        covered = 0;
    }
    (system.to_string(), vec![ChatMessage { role: Role::User, content: text }], covered)
}

pub fn build(history: &[HistoryItem], room_prompt: &str, summary: &str, max_context_tokens: u32) -> Prompt {
    let system = system_prompt(room_prompt, summary);
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
        HistoryItem { kind: Kind::Human, author_name: name.into(), content: text.into(), seq: 0 }
    }
    fn ai(text: &str) -> HistoryItem {
        HistoryItem { kind: Kind::Ai, author_name: "x".into(), content: text.into(), seq: 0 }
    }

    #[test]
    fn prefixes_names_and_merges_same_role() {
        let p = build(
            &[human("Alice", "hi"), human("Bob", "yo"), ai("hello both"), ai("more"), human("Alice", "square?")],
            "",
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
        let p = build(&[human("A", "x")], "Talk like a pirate", "", 1000);
        assert!(p.system.starts_with(BASE_SYSTEM_PROMPT));
        assert!(p.system.ends_with("Talk like a pirate"));
    }

    #[test]
    fn summary_appears_in_the_system_prompt() {
        let p = build(&[human("A", "x")], "", "They agreed to meet Friday.", 1000);
        assert!(p.system.ends_with("They agreed to meet Friday."));
        assert!(p.system.contains("Summary of the earlier conversation"));
        // Whitespace-only summaries are treated as empty.
        let p = build(&[human("A", "x")], "", "  \n ", 1000);
        assert!(!p.system.contains("Summary of the earlier conversation"));
    }

    #[test]
    fn plan_summary_returns_none_under_the_threshold() {
        // Five short messages: below both the 80% budget and the KEEP_RECENT count.
        let history: Vec<_> = (0..5).map(|i| human(&format!("A{i}"), "hello")).collect();
        assert_eq!(plan_summary(&history, "", "", 100_000), None);
        // Seven short messages still fit well under 80% of the budget.
        let history: Vec<_> = (0..7).map(|i| human(&format!("A{i}"), "hello")).collect();
        assert_eq!(plan_summary(&history, "", "", 100_000), None);
    }

    #[test]
    fn plan_summary_folds_all_but_the_recent_items() {
        let long = "x".repeat(4000); // ~1004 tokens per message
        let history: Vec<_> = (0..10).map(|i| human(&format!("A{i}"), &long)).collect();
        assert_eq!(plan_summary(&history, "", "", 2000), Some(10 - KEEP_RECENT));
    }

    #[test]
    fn plan_summary_needs_more_than_the_kept_items() {
        // Over budget, but with only KEEP_RECENT items there is nothing to fold.
        let long = "x".repeat(4000);
        let history: Vec<_> = (0..KEEP_RECENT).map(|i| human(&format!("A{i}"), &long)).collect();
        assert_eq!(plan_summary(&history, "", "", 2000), None);
    }

    #[test]
    fn summary_request_carries_previous_summary_and_fits_budget() {
        let items: Vec<_> = (0..5).map(|i| human(&format!("A{i}"), &format!("note {i}"))).collect();
        let (system, messages, covered) = summary_request("They discussed the budget.", &items, 100_000);
        assert_eq!(covered, 5);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, Role::User);
        assert!(messages[0].content.contains("They discussed the budget."));
        assert!(messages[0].content.contains("[A0]: note 0"));
        assert!(messages[0].content.contains("[A4]: note 4"));
        assert!(system.contains("running summary"));
        // Oversized: the oldest items that fit go in and coverage stops there, so
        // the boundary never claims a message the model didn't see.
        let long = "y".repeat(1000);
        let items: Vec<_> = (0..8).map(|i| human(&format!("A{i}"), &long)).collect();
        let (system, messages, covered) = summary_request("", &items, 2000);
        assert!(covered >= 1 && covered < items.len());
        assert!(messages[0].content.contains("[A0]: "));
        assert!(messages[0].content.contains(&format!("[A{}]: ", covered - 1)));
        assert!(!messages[0].content.contains(&format!("[A{covered}]: ")));
        let budget = 2000 - output_reserve(2000) as usize;
        assert!(estimate_tokens(&system) + estimate_tokens(&messages[0].content) <= budget);
        // A single message too long to fit is cut, but still covered.
        let huge = "z".repeat(40_000);
        let (_, messages, covered) = summary_request("", &[human("A", &huge), human("B", "x")], 2000);
        assert_eq!(covered, 1);
        assert!(messages[0].content.ends_with(" [...]
"));
        assert!(estimate_tokens(&messages[0].content) <= budget);
    }

    #[test]
    fn trims_oldest_but_keeps_trigger() {
        let long = "x".repeat(4000); // ~1004 tokens
        let history = vec![human("A", &long), ai(&long), human("B", &long), ai(&long), human("C", "last")];
        // 2000 context - 500 reserve - ~system => room for roughly one long message.
        let p = build(&history, "", "", 2000);
        assert!(p.trimmed >= 3);
        assert_eq!(p.messages.last().unwrap().content, "[C]: last");
        assert_eq!(p.messages.first().unwrap().role, Role::User);
    }

    #[test]
    fn trigger_kept_even_if_over_budget() {
        let huge = "y".repeat(100_000);
        let p = build(&[human("A", "old"), human("B", &huge)], "", "", 1000);
        assert_eq!(p.messages.len(), 1);
        assert!(p.messages[0].content.starts_with("[B]: "));
    }

    #[test]
    fn drops_leading_assistant_after_trim() {
        let long = "z".repeat(2400);
        let p = build(&[human("A", &long), ai("short reply"), human("B", "q")], "", "", 1300);
        assert_eq!(p.messages[0].role, Role::User);
    }
}
