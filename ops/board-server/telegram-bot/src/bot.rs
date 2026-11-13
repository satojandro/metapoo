//! What the bot does with a message someone sent it: take a link code, `/stop`, or explain.

use common::telegram::{self, Attached, Half};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;

use crate::alerts::short_account;
use crate::tg::{Outgoing, Telegram, TgError, Update};

/// Long-poll wait, in seconds. One request per this long while nobody writes to the bot.
pub const POLL_TIMEOUT_S: u64 = 25;

pub fn how_to_link(wall_url: Option<&str>) -> String {
    let wall = wall_url.map(|url| format!(" ({url})")).unwrap_or_default();
    format!(
        "I send you a message when your Meta Poo tiles are covered: at most one an hour.\n\n\
         To link your account, open the wall{wall}, open your account panel and choose \
         \"Get alerts on Telegram\". It gives you a link that brings you back here with a \
         one-time code.\n\n/stop turns alerts off."
    )
}

fn linked_text(account: &str) -> String {
    format!(
        "Linked. I'll message you here when tiles of {} are covered, at most once an hour. \
         Send /stop to turn alerts off.",
        short_account(account)
    )
}

/// The command and its argument: `/start@SomeBot CODE` → `("/start", "CODE")`.
fn split_command(text: &str) -> (String, &str) {
    let text = text.trim();
    let (head, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let command = head.split('@').next().unwrap_or(head).to_ascii_lowercase();
    (command, rest.trim())
}

/// The reply to `text` sent from private chat `chat`, after doing what it asks.
pub async fn reply_to(
    con: &mut ConnectionManager,
    chat: i64,
    text: &str,
    wall_url: Option<&str>,
    now_ms: u64,
) -> redis::RedisResult<String> {
    let (command, argument) = split_command(text);
    if command == "/stop" {
        let accounts = telegram::unlink_chat(con, chat).await?;
        return Ok(if accounts.is_empty() {
            "No account is linked to this chat, so there is nothing to stop.".into()
        } else {
            let names: Vec<_> = accounts.iter().map(|a| short_account(a)).collect();
            format!(
                "Alerts are off for {}. I've forgotten this chat. You can link again from the \
                 wall any time.",
                names.join(", ")
            )
        });
    }
    // A code arrives as `/start CODE` (the page's link) or typed on its own.
    let code = if command == "/start" { argument } else { text };
    let Some(code) = telegram::normalize_code(code) else {
        return Ok(how_to_link(wall_url));
    };
    Ok(
        match telegram::attach(con, &code, Half::Chat(chat), now_ms).await? {
            Attached::Linked { account, .. } => linked_text(&account),
            Attached::Waiting { account } => format!(
                "Got the code for {}. Now approve the signature request in your wallet on the \
                 Meta Poo page. It is a signature only: no transaction, no fee.",
                short_account(&account)
            ),
            Attached::Taken => {
                "That code was already sent from another chat. Get a new one from the wall.".into()
            }
            Attached::Missing | Attached::Used => format!(
                "That code is not valid any more (codes last ten minutes and work once).\n\n{}",
                how_to_link(wall_url)
            ),
        },
    )
}

/// Handle one update. Only private text messages are acted on.
pub async fn handle_update<T: Telegram>(
    con: &mut ConnectionManager,
    tg: &T,
    update: &Update,
    wall_url: Option<&str>,
    now_ms: u64,
) -> redis::RedisResult<()> {
    let Some(message) = &update.message else {
        return Ok(());
    };
    let (Some(text), "private") = (&message.text, message.chat.kind.as_str()) else {
        return Ok(());
    };
    let reply = reply_to(con, message.chat.id, text, wall_url, now_ms).await?;
    if let Err(e) = tg
        .send_message(message.chat.id, &Outgoing::text(reply))
        .await
    {
        tracing::warn!("could not reply: {e:?}");
    }
    Ok(())
}

/// One long poll: fetch updates after the stored offset, handle them, store the new offset.
///
/// The offset is stored after each update, so a restart resumes after the last one handled;
/// Telegram itself forgets an update once a later offset is asked for. An update whose
/// Valkey work fails is left for the next poll.
pub async fn poll_once<T: Telegram>(
    con: &mut ConnectionManager,
    tg: &T,
    wall_url: Option<&str>,
    now_ms: impl Fn() -> u64,
) -> Result<usize, TgError> {
    let valkey = |e: redis::RedisError| TgError::Other(format!("valkey: {e}"));
    let offset: Option<i64> = con
        .get(common::keys::TELEGRAM_UPDATE_OFFSET)
        .await
        .map_err(valkey)?;
    let updates = tg.get_updates(offset.unwrap_or(0), POLL_TIMEOUT_S).await?;
    for update in &updates {
        handle_update(con, tg, update, wall_url, now_ms())
            .await
            .map_err(valkey)?;
        let _: () = con
            .set(common::keys::TELEGRAM_UPDATE_OFFSET, update.update_id + 1)
            .await
            .map_err(valkey)?;
    }
    Ok(updates.len())
}

/// Deliver the "you are linked" notices the server left (it completed a link whose code the
/// bot already had, and cannot talk to Telegram itself).
pub async fn drain_notices<T: Telegram>(
    con: &mut ConnectionManager,
    tg: &T,
) -> redis::RedisResult<usize> {
    let mut sent = 0;
    while let Some(notice) = telegram::pop_notice(con).await? {
        let (Ok(chat), "linked") = (notice.chat.parse::<i64>(), notice.kind.as_str()) else {
            continue;
        };
        // A confirmation, not an alert: if it cannot be sent it is dropped, not retried.
        match tg
            .send_message(chat, &Outgoing::text(linked_text(&notice.account)))
            .await
        {
            Ok(()) => sent += 1,
            Err(TgError::Forbidden) => {
                telegram::unlink_chat(con, chat).await?;
            }
            Err(e) => tracing::warn!("could not confirm a link: {e:?}"),
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_split_from_their_argument() {
        assert_eq!(
            split_command("/start ABCDEFGHJK"),
            ("/start".into(), "ABCDEFGHJK")
        );
        assert_eq!(
            split_command(" /START@MetaPooBot  abc "),
            ("/start".into(), "abc")
        );
        assert_eq!(split_command("/stop"), ("/stop".into(), ""));
        assert_eq!(split_command("hello there"), ("hello".into(), "there"));
    }
}
