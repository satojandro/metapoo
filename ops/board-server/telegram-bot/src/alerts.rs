//! The alerts: at most one message per account per hour, built from the cover events after
//! that account's cursor (`common::telegram::AlertState`).
//!
//! **Order of writes.** The cursor and the send time are stored *after* Telegram accepts the
//! message. A crash between the two repeats one alert on restart; storing first would lose
//! one instead. A repeat is the smaller harm, and the window is one Valkey write wide.

use std::collections::HashMap;

use common::history::{summarize, CoverSummary};
use common::telegram::{self, AlertState};
use redis::aio::ConnectionManager;

use crate::tg::{Button, Outgoing, Telegram, TgError};

#[derive(Debug, Clone)]
pub struct AlertConfig {
    /// The wall's address, e.g. `https://metapoo.example/wall`. `None`: alerts go out
    /// without the button.
    pub wall_url: Option<String>,
    /// The least time between two alerts for one account.
    pub min_gap_ms: u64,
    /// How long after the first new cover to wait, so that a stroke (several transactions
    /// over a few seconds) is one message and not "1 tile" now and the rest in an hour.
    pub settle_ms: u64,
    /// How long to leave an account alone after a send failed for a reason other than a
    /// block or a rate limit.
    pub retry_ms: u64,
}

impl Default for AlertConfig {
    fn default() -> Self {
        AlertConfig {
            wall_url: None,
            min_gap_ms: 60 * 60 * 1000,
            settle_ms: 2 * 60 * 1000,
            retry_ms: 5 * 60 * 1000,
        }
    }
}

/// What the bot remembers between ticks that need not survive a restart.
#[derive(Debug, Default)]
pub struct Pacer {
    /// Telegram said 429: send nothing until then.
    pub paused_until_ms: u64,
    /// Per account: do not retry a failed send before this.
    pub retry_at_ms: HashMap<String, u64>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct TickReport {
    pub sent: usize,
    pub unlinked: usize,
    pub failed: usize,
}

/// A 64-hex implicit id as `fcd66acf…3076f59e`; a named account as it is. The same rule as
/// the web's `shortAccount`.
pub fn short_account(account: &str) -> String {
    let implicit = account.len() == 64 && account.bytes().all(|b| b.is_ascii_hexdigit());
    if implicit {
        format!("{}…{}", &account[..8], &account[56..])
    } else {
        account.to_string()
    }
}

/// The alert's words. Counts are tiles; nothing here is a balance or a price.
/// `named`: say whose tiles, for a chat that follows more than one account.
pub fn alert_text(account: &str, summary: &CoverSummary, named: bool) -> String {
    let count = summary.count;
    let whose = if named {
        format!("{}: {count} of your tiles", short_account(account))
    } else {
        format!("{count} of your tiles")
    };
    let verb = if count == 1 { "was" } else { "were" };
    let whose = if count == 1 {
        whose.replace("1 of your tiles", "One of your tiles")
    } else {
        whose
    };
    match summary.by.as_slice() {
        [] => format!("{whose} {verb} covered."),
        [only] => format!(
            "{whose} {verb} covered by {}.",
            short_account(&only.account)
        ),
        [top, rest @ ..] => format!(
            "{whose} {verb} covered, {} by {} and the rest by {} other{}.",
            top.tiles,
            short_account(&top.account),
            rest.len(),
            if rest.len() == 1 { "" } else { "s" }
        ),
    }
}

/// `/wall?x=&y=&zoom=` at the first covered tile (the web's `wall-link.ts`).
pub fn wall_link(wall_url: &str, summary: &CoverSummary) -> String {
    match &summary.first {
        Some(tile) => {
            let join = if wall_url.contains('?') { '&' } else { '?' };
            format!("{wall_url}{join}x={}&y={}&zoom=8", tile.x, tile.y)
        }
        None => wall_url.to_string(),
    }
}

/// Look at every linked account once and send what is due.
pub async fn tick<T: Telegram>(
    con: &mut ConnectionManager,
    tg: &T,
    config: &AlertConfig,
    pacer: &mut Pacer,
    now_ms: u64,
) -> redis::RedisResult<TickReport> {
    let mut report = TickReport::default();
    for (account, chat) in telegram::links(con).await? {
        if now_ms < pacer.paused_until_ms {
            break;
        }
        if pacer
            .retry_at_ms
            .get(&account)
            .is_some_and(|at| now_ms < *at)
        {
            continue;
        }
        // A link without a state (it was written by hand, or the state was lost) starts now:
        // never from the beginning of the set.
        let Some(state) = telegram::alert_state(con, &account).await? else {
            telegram::commit_alert_state(con, &account, chat, &AlertState::linked_at(now_ms))
                .await?;
            continue;
        };
        if state.last_sent_ms != 0 && now_ms.saturating_sub(state.last_sent_ms) < config.min_gap_ms
        {
            continue;
        }
        let covers = telegram::covers_after(con, &account, &state).await?;
        let (Some(first), Some(last)) = (covers.first(), covers.last()) else {
            continue;
        };
        if now_ms.saturating_sub(first.record.at_ms) < config.settle_ms {
            continue;
        }
        let next = AlertState {
            cursor_ms: last.record.at_ms,
            cursor_member: last.member.clone(),
            last_sent_ms: now_ms,
            ..state.clone()
        };
        // Covers from before the link are stepped over, never reported.
        let summary = summarize(
            covers
                .iter()
                .filter(|c| c.record.at_ms >= state.linked_at_ms)
                .map(|c| c.record.clone()),
        );
        if summary.count == 0 {
            telegram::commit_alert_state(
                con,
                &account,
                chat,
                &AlertState {
                    last_sent_ms: state.last_sent_ms,
                    ..next
                },
            )
            .await?;
            continue;
        }
        let named = telegram::accounts_of(con, chat).await?.len() > 1;
        let message = Outgoing {
            text: alert_text(&account, &summary, named),
            button: config.wall_url.as_deref().map(|url| Button {
                text: "Open the wall".into(),
                url: wall_link(url, &summary),
            }),
        };
        match tg.send_message(chat, &message).await {
            Ok(()) => {
                telegram::commit_alert_state(con, &account, chat, &next).await?;
                pacer.retry_at_ms.remove(&account);
                report.sent += 1;
            }
            Err(TgError::Forbidden) => {
                // Blocked: forget the chat, as `/stop` would.
                report.unlinked += telegram::unlink_chat(con, chat).await?.len();
            }
            Err(TgError::RetryAfter(seconds)) => {
                pacer.paused_until_ms = now_ms + seconds.max(1) * 1000;
                tracing::warn!("Telegram rate limit: pausing sends for {seconds} s");
                break;
            }
            Err(e) => {
                tracing::warn!("alert not sent: {e:?}");
                pacer
                    .retry_at_ms
                    .insert(account.clone(), now_ms + config.retry_ms);
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::history::CoverRecord;

    fn covers(spec: &[(u32, u32, &str)]) -> CoverSummary {
        summarize(spec.iter().map(|&(x, y, by)| CoverRecord {
            x,
            y,
            by: by.into(),
            at_ms: 1,
        }))
    }

    #[test]
    fn the_text_counts_tiles_names_who_and_shortens_implicit_ids() {
        let implicit = "fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e";
        let nine: Vec<_> = (0..9).map(|x| (x, 0, "misfits-validator.near")).collect();
        assert_eq!(
            alert_text("me.near", &covers(&nine), false),
            "9 of your tiles were covered by misfits-validator.near."
        );
        assert_eq!(
            alert_text("me.near", &covers(&[(1, 1, implicit)]), false),
            "One of your tiles was covered by fcd66acf…3076f59e."
        );
        assert_eq!(
            alert_text(
                "me.near",
                &covers(&[
                    (1, 1, "a.near"),
                    (2, 1, "a.near"),
                    (3, 1, "b.near"),
                    (4, 1, "c.near")
                ]),
                false
            ),
            "4 of your tiles were covered, 2 by a.near and the rest by 2 others."
        );
        // A chat that follows two accounts is told which one.
        assert_eq!(
            alert_text(
                implicit,
                &covers(&[(1, 1, "a.near"), (2, 1, "a.near")]),
                true
            ),
            "fcd66acf…3076f59e: 2 of your tiles were covered by a.near."
        );
        assert_eq!(short_account("alice.near"), "alice.near");
    }

    #[test]
    fn the_button_opens_the_wall_at_the_first_covered_tile() {
        let summary = covers(&[(40, 7, "a.near"), (41, 7, "a.near")]);
        assert_eq!(
            wall_link("https://metapoo.example/wall", &summary),
            "https://metapoo.example/wall?x=40&y=7&zoom=8"
        );
        assert_eq!(
            wall_link("https://metapoo.example/wall?board=b", &summary),
            "https://metapoo.example/wall?board=b&x=40&y=7&zoom=8"
        );
    }
}
