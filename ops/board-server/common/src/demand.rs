//! When the indexer may spend a request.
//!
//! Berry Fast's indexer reads every block forever. On mainnet that is ~6,200 requests an hour
//! whether or not anyone paints or looks (measured on the owner's dashboard on 7 Nov). Here the
//! indexer reads only when it is useful, and nobody watching costs nothing:
//!
//! - **someone is watching** (the server has a WebSocket client): poll every `poll_ms`;
//! - **someone just painted** (a hint): poll now, and a few more times while the index catches
//!   up, because the index trails the chain by a couple of seconds;
//! - **otherwise**: no requests. A viewer who arrives later triggers a catch-up poll, and that
//!   poll reads only the board's transactions since the watermark.

/// How long one server heartbeat keeps the viewers flag up. The server refreshes it every
/// [`VIEWER_REFRESH_MS`], so the flag drops within this long after the last socket closes.
pub const VIEWER_TTL_MS: u64 = 20_000;
pub const VIEWER_REFRESH_MS: u64 = 5_000;

/// After a hint, poll at least this often until the hint expires or the paint is seen.
pub const HINT_POLL_MS: u64 = 2_000;
/// How long a hint keeps the fast polling going. The index usually lags 2 s.
pub const HINT_WINDOW_MS: u64 = 12_000;
/// The server accepts at most one hint per this many ms, so a script cannot turn the hint into
/// a request pump: at worst ~1,800 polls an hour, and only while hints keep arriving.
pub const HINT_MIN_GAP_MS: u64 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signals {
    pub now_ms: u64,
    /// `VIEWERS_UNTIL_MS`, 0 when absent.
    pub viewers_until_ms: u64,
    /// `HINT_AT_MS`, 0 when absent.
    pub hint_at_ms: u64,
    /// When the indexer last polled, 0 if never.
    pub last_poll_ms: u64,
    /// When the indexer last queued an event, 0 if never.
    pub last_event_ms: u64,
    /// `VIEWER_ARRIVED_MS`, 0 when absent: a viewer came to a server that had none.
    pub viewer_arrived_ms: u64,
}

/// Should the indexer poll right now?
pub fn should_poll(s: Signals, poll_ms: u64) -> bool {
    let since_poll = s.now_ms.saturating_sub(s.last_poll_ms);
    // A hint that is fresh and not yet answered by a queued event.
    let hint_open = s.hint_at_ms > 0
        && s.now_ms.saturating_sub(s.hint_at_ms) <= HINT_WINDOW_MS
        && s.last_event_ms < s.hint_at_ms;
    if hint_open && (s.last_poll_ms < s.hint_at_ms || since_poll >= HINT_POLL_MS) {
        return true;
    }
    let watched = s.now_ms < s.viewers_until_ms;
    // Someone just arrived after a quiet spell: catch up now, not at the next interval. Their
    // wall's first trust check compares the mirror with the chain within seconds of opening.
    let arrived = s.viewer_arrived_ms > s.last_poll_ms;
    // `last_poll_ms == 0`: the first poll after a start happens as soon as anyone watches.
    watched && (arrived || s.last_poll_ms == 0 || since_poll >= poll_ms)
}

/// How often an HTTP read refreshes the viewers flag. One Valkey write per window, so a busy
/// page cannot turn reads into a write pump.
pub const READER_TOUCH_MS: u64 = 10_000;

/// An HTTP read is a viewer too.
///
/// Returns `None` when the flag was refreshed too recently to bother, else `Some(arrived)`,
/// where `arrived` says this reader is the first after a quiet spell and the indexer should
/// catch up now rather than at the next interval.
///
/// Why this exists: the socket was the only thing that raised the viewers flag, and the wall
/// pauses its socket when the tab is idle or hidden. A mirror the indexer may not refresh makes
/// the wall's trust check fail, and the wall then walks the chain — the expensive path this
/// design exists to avoid. A read is proof that somebody is looking.
pub fn reader_touch(now_ms: u64, last_touch_ms: u64) -> Option<bool> {
    // Nothing refreshed the flag yet in this process: treat the first read as an arrival.
    if last_touch_ms == 0 {
        return Some(true);
    }
    let quiet = now_ms.saturating_sub(last_touch_ms);
    if quiet < READER_TOUCH_MS {
        None
    } else {
        Some(quiet >= VIEWER_TTL_MS)
    }
}

/// Should the server accept a hint now, given when it last accepted one?
pub fn accept_hint(now_ms: u64, last_hint_ms: u64) -> bool {
    last_hint_ms == 0 || now_ms.saturating_sub(last_hint_ms) >= HINT_MIN_GAP_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLL: u64 = 30_000;

    #[test]
    fn a_read_counts_as_a_viewer_but_not_as_a_write_pump() {
        // Two reads inside the window: the second writes nothing.
        assert_eq!(reader_touch(1_000, 0), Some(true));
        assert_eq!(reader_touch(1_000 + READER_TOUCH_MS - 1, 1_000), None);
        // Past the window but inside the viewers TTL: keep the flag up, no catch-up needed.
        assert_eq!(reader_touch(1_000 + READER_TOUCH_MS, 1_000), Some(false));
        // After a quiet spell: refresh the flag and ask the indexer to catch up now.
        assert_eq!(reader_touch(1_000 + VIEWER_TTL_MS, 1_000), Some(true));
    }

    fn at(now_ms: u64) -> Signals {
        Signals {
            now_ms,
            viewers_until_ms: 0,
            hint_at_ms: 0,
            last_poll_ms: 0,
            last_event_ms: 0,
            viewer_arrived_ms: 0,
        }
    }

    #[test]
    fn nobody_watching_and_no_hint_costs_nothing_forever() {
        // A day of ticks, one a second: not one poll.
        let polls = (1..=86_400u64)
            .filter(|t| {
                should_poll(
                    Signals {
                        last_poll_ms: 1,
                        ..at(t * 1000)
                    },
                    POLL,
                )
            })
            .count();
        assert_eq!(polls, 0);
    }

    #[test]
    fn a_viewer_gets_a_first_poll_at_once_then_one_per_interval() {
        let watched = Signals {
            viewers_until_ms: 1_000_000,
            ..at(100_000)
        };
        assert!(should_poll(watched, POLL), "first poll right away");
        assert!(!should_poll(
            Signals {
                last_poll_ms: 90_000,
                ..watched
            },
            POLL
        ));
        assert!(should_poll(
            Signals {
                last_poll_ms: 70_000,
                ..watched
            },
            POLL
        ));
    }

    #[test]
    fn a_viewer_arriving_after_a_quiet_spell_gets_a_poll_at_once() {
        // The last poll was 10 s ago (a previous viewer); the interval is 30 s.
        let s = Signals {
            viewers_until_ms: 200_000,
            last_poll_ms: 90_000,
            ..at(100_000)
        };
        assert!(
            !should_poll(s, POLL),
            "without an arrival, wait for the interval"
        );
        let arrived = Signals {
            viewer_arrived_ms: 99_500,
            ..s
        };
        assert!(should_poll(arrived, POLL), "an arrival polls now");
        // Answered by that poll: no second one until the interval.
        let after = Signals {
            last_poll_ms: 100_000,
            ..arrived
        };
        assert!(!should_poll(
            Signals {
                now_ms: 101_000,
                ..after
            },
            POLL
        ));
    }

    #[test]
    fn the_viewer_flag_expires() {
        let s = Signals {
            viewers_until_ms: 100_000,
            last_poll_ms: 1,
            ..at(100_000)
        };
        assert!(!should_poll(s, POLL));
    }

    #[test]
    fn a_hint_polls_now_then_every_two_seconds_until_answered_or_expired() {
        let hint = Signals {
            hint_at_ms: 100_000,
            last_poll_ms: 99_000,
            ..at(100_100)
        };
        assert!(
            should_poll(hint, POLL),
            "poll at once: the last poll predates the hint"
        );
        let after = Signals {
            last_poll_ms: 100_100,
            ..hint
        };
        assert!(!should_poll(
            Signals {
                now_ms: 101_000,
                ..after
            },
            POLL
        ));
        assert!(should_poll(
            Signals {
                now_ms: 102_200,
                ..after
            },
            POLL
        ));
        // Answered: an event was queued after the hint.
        assert!(!should_poll(
            Signals {
                now_ms: 104_000,
                last_event_ms: 103_000,
                ..after
            },
            POLL
        ));
        // Expired.
        assert!(!should_poll(
            Signals {
                now_ms: 100_000 + HINT_WINDOW_MS + 1,
                ..after
            },
            POLL
        ));
    }

    #[test]
    fn hints_are_rate_limited() {
        assert!(accept_hint(10_000, 0));
        assert!(!accept_hint(10_500, 9_000));
        assert!(accept_hint(11_000, 9_000));
    }
}
