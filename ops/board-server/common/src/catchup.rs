//! Catch-up history members: `draw_events` is scored by block time, so two draws in the same
//! block (same millisecond) tie on score — and Valkey orders ties lexicographically by member.
//! Prefixing the member with the event's zero-padded `position` makes that order the applied
//! order, without changing what a WebSocket client receives.

/// Member of `draw_events` for one broadcast message.
///
/// `position` is `QueuedEvent::position()` (`block_height * 1_000_000 + seq`), so members sort
/// by block and then by place in the block.
pub fn catchup_member(position: u64, message: &str) -> String {
    format!("{position:020}:{message}")
}

/// The message inside a `draw_events` member, i.e. what a client is sent.
///
/// A member is `digits:json`; anything without the prefix is returned unchanged, so a member
/// written before this scheme still reaches the client intact.
pub fn catchup_payload(member: &str) -> &str {
    match member.split_once(':') {
        Some((prefix, rest))
            if prefix.len() == 20 && prefix.bytes().all(|b| b.is_ascii_digit()) =>
        {
            rest
        }
        _ => member,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_with_the_same_score_sort_by_position() {
        // Two draws in one block: same timestamp (score), so the member text decides.
        let first = catchup_member(223_122_000_000_000_000, r#"{"receipt_id":"a"}"#);
        let second = catchup_member(223_122_000_000_000_001, r#"{"receipt_id":"b"}"#);
        assert!(first < second, "position order must survive a score tie");
        // And a later block always sorts after an earlier one, even with a smaller seq.
        let next_block = catchup_member(223_122_000_001_000_000, r#"{"receipt_id":"c"}"#);
        assert!(second < next_block);
    }

    #[test]
    fn the_payload_is_the_message_and_old_members_still_parse() {
        let message = r#"{"type":"draw","receipt_id":"a"}"#;
        let member = catchup_member(42, message);
        assert_eq!(catchup_payload(&member), message);
        // A member written before the prefix (or plain junk) comes back untouched.
        assert_eq!(catchup_payload(message), message);
        assert_eq!(catchup_payload(""), "");
    }

    #[test]
    fn a_message_that_starts_with_digits_is_not_mistaken_for_a_prefix() {
        let message = r#"{"receipt_id":"7:30"}"#;
        let member = catchup_member(7, message);
        assert_eq!(catchup_payload(&member), message);
    }
}
