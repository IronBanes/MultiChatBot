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
/// never claims a message the model didn't see. 0 means the oldest message doesn't
/// fit next to the previous summary (see `piece_request`). Rendered once, in one pass.
pub fn summary_request(
    previous: &str,
    items: &[HistoryItem],
    max_context_tokens: u32,
) -> (String, Vec<ChatMessage>, usize) {
    let system = SUMMARY_SYSTEM;
    let budget = (max_context_tokens.saturating_sub(output_reserve(max_context_tokens)) as usize)
        .saturating_sub(estimate_tokens(system));
    // estimate_tokens(text) = ceil(chars / 4) + 4, so this many characters fit.
    let max_chars = budget.saturating_sub(4) * 4;

    let mut text = String::new();
    let previous = previous.trim();
    if !previous.is_empty() {
        text.push_str("Current summary:\n");
        text.push_str(previous);
        text.push_str("\n\nNew messages to fold in:\n");
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
        let line = format!("[{}]: {}\n", speaker(h), h.content);
        let len = line.chars().count();
        if chars + len > max_chars {
            // An oldest message too long to fit on its own isn't cut here (its tail
            // would be lost): `piece_request` summarizes it in parts.
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

const SUMMARY_SYSTEM: &str = "\
You maintain a running summary of a group chat. \
Keep who said what (names), decisions that were made, open questions, facts people shared \
and what the AI was asked to do. \
Write plain prose under about 400 words, no preamble.";

const PIECE_SYSTEM: &str = "\
You maintain a running summary of a group chat. \
A message too long to read at once arrives in parts; fold this part into the summary. \
Keep who said what (names), decisions that were made, open questions, facts people shared \
and what the AI was asked to do. \
Write plain prose under about 400 words, no preamble.";

/// The name a summary request shows for a history item.
fn speaker(h: &HistoryItem) -> &str {
    match h.kind {
        Kind::Human => h.author_name.as_str(),
        Kind::Ai => "AI",
    }
}

/// For one message too long to summarize in a single request: the request that
/// folds its characters from `from` on, as many as fit, into `previous`. Returns
/// the request and where the next part starts (the message's length when this is
/// the last part), or None when not even a useful part fits.
pub fn piece_request(
    previous: &str,
    item: &HistoryItem,
    from: usize,
    max_context_tokens: u32,
) -> Option<(String, Vec<ChatMessage>, usize)> {
    let budget = (max_context_tokens.saturating_sub(output_reserve(max_context_tokens)) as usize)
        .saturating_sub(estimate_tokens(PIECE_SYSTEM));
    let max_chars = budget.saturating_sub(4) * 4;
    let total = item.content.chars().count();
    if from >= total {
        return None;
    }
    let mut text = String::new();
    let previous = previous.trim();
    if !previous.is_empty() {
        text.push_str("Current summary:\n");
        text.push_str(previous);
        text.push_str("\n\n");
    }
    // The header's length with the widest possible end, so the real one fits too.
    let header = |end: usize| format!("Part of a long message, characters {from} to {end} of {total}:\n[{}]: ", speaker(item));
    let room = max_chars.saturating_sub(text.chars().count() + header(total).chars().count() + 1);
    if room < 64 {
        return None;
    }
    let next = (from + room).min(total);
    text.push_str(&header(next));
    text.extend(item.content.chars().skip(from).take(next - from));
    text.push('\n');
    Some((PIECE_SYSTEM.to_string(), vec![ChatMessage { role: Role::User, content: text }], next))
}

/// `summary_request` for the oldest `n` items of `history`, with the boundary moved
/// back so the history left for the reply starts with a human message: `build`
/// drops leading assistant turns, so an AI reply right after the boundary would be
/// in neither the summary nor the prompt. Returns the request and how many items it
/// covers (0 = nothing can be folded).
pub fn fold_request(
    previous: &str,
    history: &[HistoryItem],
    n: usize,
    max_context_tokens: u32,
) -> (String, Vec<ChatMessage>, usize) {
    let starts_with_ai = |at: usize| history.get(at).is_some_and(|h| h.kind == Kind::Ai);
    let mut limit = n.min(history.len());
    loop {
        while limit > 0 && starts_with_ai(limit) {
            limit -= 1;
        }
        let (system, messages, covered) = summary_request(previous, &history[..limit], max_context_tokens);
        // Covered everything up to a human message (or nothing): done. Otherwise the
        // budget cut it short of an AI reply; try again from before that reply.
        if covered == 0 || !starts_with_ai(covered) {
            return (system, messages, covered);
        }
        limit = covered;
    }
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

    // Providers (notably Anthropic) need the first turn to be from the user. Right
    // after a summary, a leading AI reply is part of the conversation the summary
    // leads into, so it stays behind a short user turn instead of being dropped.
    let after_summary = !summary.trim().is_empty() && start == 0;
    let kept = converted[start..].iter().skip_while(|m| !after_summary && m.role == Role::Assistant);

    let mut messages: Vec<ChatMessage> = Vec::new();
    if after_summary && converted.first().is_some_and(|m| m.role == Role::Assistant) {
        messages.push(ChatMessage {
            role: Role::User,
            content: "(The conversation continues after the summary.)".into(),
        });
    }
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
        // A single message too long to fit isn't cut: nothing is covered, and
        // piece_request walks it in parts instead.
        let huge = format!("{}IMPORTANT TAIL", "z".repeat(40_000));
        let item = human("A", &huge);
        let (_, _, covered) = summary_request("", &[item.clone(), human("B", "x")], 2000);
        assert_eq!(covered, 0);
        let (mut from, mut parts, mut tail) = (0, 0, false);
        while let Some((_, m, next)) = piece_request("prev", &item, from, 2000) {
            assert!(next > from);
            assert!(estimate_tokens(&m[0].content) <= budget);
            tail |= m[0].content.contains("IMPORTANT TAIL");
            from = next;
            parts += 1;
        }
        assert_eq!(from, huge.chars().count());
        assert!(parts > 1 && tail);
    }

    #[test]
    fn fold_request_leaves_a_human_message_first() {
        let history = vec![human("A", "one"), ai("two"), human("B", "three"), ai("four"), human("C", "five")];
        // Folding 3 would leave "four" (AI) first: the boundary moves back to 2.
        let (_, messages, covered) = fold_request("", &history, 3, 100_000);
        assert_eq!(covered, 2);
        assert!(messages[0].content.contains("[A]: one"));
        assert!(!messages[0].content.contains("three"));
        // Folding 4 leaves "five" (human) first: unchanged.
        assert_eq!(fold_request("", &history, 4, 100_000).2, 4);
        // Folding 1 leaves "two" (AI) first, so nothing can be folded.
        assert_eq!(fold_request("", &history, 1, 100_000).2, 0);
    }

    #[test]
    fn leading_ai_reply_after_a_summary_is_kept() {
        let p = build(&[ai("earlier answer"), human("A", "q")], "", "They planned a picnic.", 100_000);
        assert_eq!(p.messages[0].role, Role::User);
        assert!(p.messages.iter().any(|m| m.content.contains("earlier answer")));
        // Without a summary it's dropped as before.
        let p = build(&[ai("earlier answer"), human("A", "q")], "", "", 100_000);
        assert!(!p.messages.iter().any(|m| m.content.contains("earlier answer")));
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
