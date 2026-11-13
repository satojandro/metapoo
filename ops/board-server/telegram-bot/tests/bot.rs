//! The bot against a real Valkey and a fake Telegram. Skipped unless `TEST_VALKEY_URL` is set
//! (see `server/tests/valkey.rs`). The database is flushed.

use std::collections::HashMap;
use std::sync::Mutex;

use common::history::{add_covers, Cover};
use common::keys;
use common::telegram::{self, Action, Attached, Half};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use telegram_bot::alerts::{tick, AlertConfig, Pacer, TickReport};
use telegram_bot::bot::{drain_notices, poll_once};
use telegram_bot::tg::{Chat, Message, Outgoing, Telegram, TgError, Update};

const HOUR: u64 = 60 * 60 * 1000;
const MINUTE: u64 = 60 * 1000;
/// A fixed "now" for the alert clock; cover times are relative to it.
const T0: u64 = 1_800_000_000_000;
const ALICE: &str = "alice.near";
const CHAT: i64 = 4242;

async fn connect() -> Option<ConnectionManager> {
    let url = std::env::var("TEST_VALKEY_URL").ok()?;
    let mut con = common::valkey::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_VALKEY_URL={url} is set but unreachable: {e}"));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    Some(con)
}

/// Telegram, as far as the bot can tell: it records what was sent, hands out queued updates,
/// and fails a chat's next sends on request.
#[derive(Default)]
struct FakeTelegram {
    sent: Mutex<Vec<(i64, Outgoing)>>,
    fail: Mutex<HashMap<i64, Vec<TgError>>>,
    updates: Mutex<Vec<Update>>,
    offsets: Mutex<Vec<i64>>,
}

impl FakeTelegram {
    fn fail_next(&self, chat: i64, error: TgError) {
        self.fail
            .lock()
            .unwrap()
            .entry(chat)
            .or_default()
            .push(error);
    }

    fn sent_to(&self, chat: i64) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(to, _)| *to == chat)
            .map(|(_, m)| m.text.clone())
            .collect()
    }

    fn says(&self, update_id: i64, chat: i64, kind: &str, text: &str) {
        self.updates.lock().unwrap().push(Update {
            update_id,
            message: Some(Message {
                chat: Chat {
                    id: chat,
                    kind: kind.into(),
                },
                text: Some(text.into()),
            }),
        });
    }
}

impl Telegram for FakeTelegram {
    async fn get_updates(&self, offset: i64, _timeout_s: u64) -> Result<Vec<Update>, TgError> {
        self.offsets.lock().unwrap().push(offset);
        let mut updates = self.updates.lock().unwrap();
        // Asking from an offset confirms everything before it, as Telegram does.
        updates.retain(|u| u.update_id >= offset);
        Ok(updates.clone())
    }

    async fn send_message(&self, chat: i64, message: &Outgoing) -> Result<(), TgError> {
        if let Some(errors) = self.fail.lock().unwrap().get_mut(&chat) {
            if !errors.is_empty() {
                return Err(errors.remove(0));
            }
        }
        self.sent.lock().unwrap().push((chat, message.clone()));
        Ok(())
    }
}

/// Link `account` to `chat` at `at_ms`, as a signature and a code together do.
async fn link(con: &mut ConnectionManager, account: &str, chat: i64, at_ms: u64) {
    let challenge = telegram::create_challenge(con, account, Action::Link, at_ms)
        .await
        .unwrap();
    telegram::attach(con, &challenge.code, Half::Signed, at_ms)
        .await
        .unwrap();
    let attached = telegram::attach(con, &challenge.code, Half::Chat(chat), at_ms)
        .await
        .unwrap();
    assert!(matches!(attached, Attached::Linked { .. }), "{attached:?}");
}

/// Write covers of `victim`'s tiles the way the consumer does. `n` tiles in a row at `y`.
async fn cover(con: &mut ConnectionManager, victim: &str, by: &str, y: u32, n: u32, at_ms: u64) {
    let covers: Vec<Cover> = (0..n)
        .map(|x| Cover {
            victim: victim.into(),
            by: by.into(),
            x,
            y,
            at_ms,
            position: at_ms * 1000 + u64::from(y),
            index: x,
        })
        .collect();
    let mut pipe = redis::pipe();
    pipe.atomic();
    add_covers(&mut pipe, &covers, at_ms, at_ms);
    let _: () = pipe.query_async(con).await.unwrap();
}

fn config() -> AlertConfig {
    AlertConfig {
        wall_url: Some("https://metapoo.example/wall".into()),
        ..AlertConfig::default()
    }
}

#[tokio::test]
async fn covers_within_the_hour_are_one_message_and_the_next_waits_for_the_hour() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    let mut pacer = Pacer::default();
    link(&mut con, ALICE, CHAT, T0).await;

    // Nothing covered: nothing sent.
    assert_eq!(
        tick(&mut con, &tg, &config(), &mut pacer, T0 + MINUTE)
            .await
            .unwrap(),
        TickReport::default()
    );

    // A stroke lands: held back while it settles, then one message for all of it.
    cover(&mut con, ALICE, "bob.near", 0, 5, T0 + 2 * MINUTE).await;
    tick(
        &mut con,
        &tg,
        &config(),
        &mut pacer,
        T0 + 2 * MINUTE + 30_000,
    )
    .await
    .unwrap();
    assert!(
        tg.sent_to(CHAT).is_empty(),
        "sent before the stroke settled"
    );
    cover(&mut con, ALICE, "bob.near", 1, 4, T0 + 3 * MINUTE).await;
    let report = tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE)
        .await
        .unwrap();
    assert_eq!(report.sent, 1);
    assert_eq!(
        tg.sent_to(CHAT),
        ["9 of your tiles were covered by bob.near."]
    );
    let button = tg.sent.lock().unwrap()[0].1.button.clone().unwrap();
    assert_eq!(button.text, "Open the wall");
    assert_eq!(button.url, "https://metapoo.example/wall?x=0&y=0&zoom=8");

    // More covers through the hour: counted, not sent, however often the bot looks.
    cover(&mut con, ALICE, "carol.near", 2, 3, T0 + 10 * MINUTE).await;
    cover(&mut con, ALICE, "bob.near", 3, 1, T0 + 40 * MINUTE).await;
    for minutes in [11, 30, 45, 64] {
        tick(&mut con, &tg, &config(), &mut pacer, T0 + minutes * MINUTE)
            .await
            .unwrap();
    }
    assert_eq!(
        tg.sent_to(CHAT).len(),
        1,
        "a second message inside the hour"
    );

    // One hour after the first: one message for everything since.
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE + HOUR)
        .await
        .unwrap();
    assert_eq!(
        tg.sent_to(CHAT)[1..],
        ["4 of your tiles were covered, 3 by carol.near and the rest by 1 other."]
    );
    // And then silence until something new is covered.
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * HOUR)
        .await
        .unwrap();
    assert_eq!(tg.sent_to(CHAT).len(), 2);
    // No message ever carried a balance or a price.
    for text in tg.sent_to(CHAT) {
        assert!(!text.contains("NEAR") && !text.contains("TOILET") && !text.contains("credit"));
    }
}

#[tokio::test]
async fn a_first_link_does_not_report_the_covers_already_there() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    let mut pacer = Pacer::default();
    // Three weeks of covers, the last one a minute before the link.
    for days in [20, 9, 1] {
        cover(
            &mut con,
            ALICE,
            "bob.near",
            days,
            6,
            T0 - days as u64 * 24 * HOUR,
        )
        .await;
    }
    cover(&mut con, ALICE, "bob.near", 30, 2, T0 - MINUTE).await;
    link(&mut con, ALICE, CHAT, T0).await;
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 10 * MINUTE)
        .await
        .unwrap();
    assert!(tg.sent_to(CHAT).is_empty(), "{:?}", tg.sent_to(CHAT));

    // Only what is covered from now on.
    cover(&mut con, ALICE, "bob.near", 40, 2, T0 + 11 * MINUTE).await;
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 20 * MINUTE)
        .await
        .unwrap();
    assert_eq!(
        tg.sent_to(CHAT),
        ["2 of your tiles were covered by bob.near."]
    );

    // Linking again later starts again from then: the covers in between are not replayed.
    cover(&mut con, ALICE, "bob.near", 41, 7, T0 + 2 * HOUR).await;
    link(&mut con, ALICE, 999, T0 + 3 * HOUR).await;
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 4 * HOUR)
        .await
        .unwrap();
    assert!(tg.sent_to(999).is_empty());
    assert_eq!(
        tg.sent_to(CHAT).len(),
        1,
        "the old chat is no longer written to"
    );
}

#[tokio::test]
async fn a_restart_neither_repeats_old_covers_nor_drops_new_ones() {
    let Some(mut con) = connect().await else {
        return;
    };
    link(&mut con, ALICE, CHAT, T0).await;
    cover(&mut con, ALICE, "bob.near", 0, 3, T0 + MINUTE).await;
    {
        let tg = FakeTelegram::default();
        let mut pacer = Pacer::default();
        tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE)
            .await
            .unwrap();
        assert_eq!(tg.sent_to(CHAT).len(), 1);
    }
    // Covered while the bot is down. One of them shares a millisecond with the last cover
    // already reported: a cursor that was only a time would lose it or resend its neighbours.
    cover(&mut con, ALICE, "carol.near", 1, 2, T0 + MINUTE).await;
    cover(&mut con, ALICE, "carol.near", 2, 2, T0 + 30 * MINUTE).await;

    // A new process: nothing in memory, a new Valkey connection, only what Valkey kept.
    let mut con = common::valkey::connect(&std::env::var("TEST_VALKEY_URL").unwrap())
        .await
        .unwrap();
    let tg = FakeTelegram::default();
    let mut pacer = Pacer::default();
    // Still inside the hour of the alert the old process sent: the gate survived too.
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 40 * MINUTE)
        .await
        .unwrap();
    assert!(tg.sent_to(CHAT).is_empty(), "the hour gate was forgotten");
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE + HOUR)
        .await
        .unwrap();
    assert_eq!(
        tg.sent_to(CHAT),
        ["4 of your tiles were covered by carol.near."],
        "exactly the covers the old process had not reported"
    );
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 9 * HOUR)
        .await
        .unwrap();
    assert_eq!(tg.sent_to(CHAT).len(), 1);
}

#[tokio::test]
async fn a_failed_send_keeps_the_covers_for_the_next_try() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    let mut pacer = Pacer::default();
    link(&mut con, ALICE, CHAT, T0).await;
    link(&mut con, "bob.near", 77, T0).await;
    cover(&mut con, ALICE, "carol.near", 0, 3, T0 + MINUTE).await;
    cover(&mut con, "bob.near", "carol.near", 5, 1, T0 + MINUTE).await;

    // 429: stop sending to everyone until Telegram's retry_after has passed.
    tg.fail_next(CHAT, TgError::RetryAfter(30));
    let report = tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE)
        .await
        .unwrap();
    assert_eq!(report, TickReport::default());
    assert_eq!(pacer.paused_until_ms, T0 + 5 * MINUTE + 30_000);
    tick(
        &mut con,
        &tg,
        &config(),
        &mut pacer,
        T0 + 5 * MINUTE + 20_000,
    )
    .await
    .unwrap();
    assert!(
        tg.sent.lock().unwrap().is_empty(),
        "sent during the back-off"
    );
    tick(
        &mut con,
        &tg,
        &config(),
        &mut pacer,
        T0 + 5 * MINUTE + 31_000,
    )
    .await
    .unwrap();
    assert_eq!(
        tg.sent_to(CHAT),
        ["3 of your tiles were covered by carol.near."]
    );
    assert_eq!(
        tg.sent_to(77),
        ["One of your tiles was covered by carol.near."]
    );

    // Another failure (network, 5xx): that account waits a few minutes; nothing is lost.
    cover(&mut con, ALICE, "carol.near", 1, 2, T0 + 2 * HOUR).await;
    tg.fail_next(CHAT, TgError::Other("timeout".into()));
    let report = tick(&mut con, &tg, &config(), &mut pacer, T0 + 3 * HOUR)
        .await
        .unwrap();
    assert_eq!(report.failed, 1);
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 3 * HOUR + MINUTE)
        .await
        .unwrap();
    assert_eq!(tg.sent_to(CHAT).len(), 1, "retried at once");
    tick(
        &mut con,
        &tg,
        &config(),
        &mut pacer,
        T0 + 3 * HOUR + 6 * MINUTE,
    )
    .await
    .unwrap();
    assert_eq!(
        tg.sent_to(CHAT)[1..],
        ["2 of your tiles were covered by carol.near."]
    );
}

#[tokio::test]
async fn a_user_who_blocked_the_bot_is_unlinked() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    let mut pacer = Pacer::default();
    link(&mut con, ALICE, CHAT, T0).await;
    link(&mut con, "bob.near", 77, T0).await;
    cover(&mut con, ALICE, "carol.near", 0, 3, T0 + MINUTE).await;
    cover(&mut con, "bob.near", "carol.near", 5, 2, T0 + MINUTE).await;
    tg.fail_next(CHAT, TgError::Forbidden);
    let report = tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE)
        .await
        .unwrap();
    assert_eq!((report.sent, report.unlinked), (1, 1));
    assert_eq!(telegram::chat_of(&mut con, ALICE).await.unwrap(), None);
    assert_eq!(telegram::alert_state(&mut con, ALICE).await.unwrap(), None);
    assert_eq!(
        telegram::chat_of(&mut con, "bob.near").await.unwrap(),
        Some(77)
    );
    // Never written to again.
    cover(&mut con, ALICE, "carol.near", 1, 3, T0 + 2 * HOUR).await;
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 3 * HOUR)
        .await
        .unwrap();
    assert!(tg.sent_to(CHAT).is_empty());
}

#[tokio::test]
async fn start_with_a_code_links_and_start_without_one_explains() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    let wall = Some("https://metapoo.example/wall");
    let now = || T0;

    // No code, a made-up code, and small talk: the same explanation, and nothing is stored.
    tg.says(1, CHAT, "private", "/start");
    tg.says(2, CHAT, "private", "/start ABCDEFGHJK");
    tg.says(3, CHAT, "private", "hello?");
    assert_eq!(poll_once(&mut con, &tg, wall, now).await, Ok(3));
    let replies = tg.sent_to(CHAT);
    assert_eq!(replies.len(), 3);
    for reply in &replies {
        assert!(reply.contains("Get alerts on Telegram"), "{reply}");
        assert!(reply.contains("https://metapoo.example/wall"), "{reply}");
    }
    assert!(replies[1].contains("not valid any more"));
    assert!(telegram::links(&mut con).await.unwrap().is_empty());

    // The page's link, before the wallet has signed: the code waits for the signature.
    let challenge = telegram::create_challenge(&mut con, ALICE, Action::Link, T0)
        .await
        .unwrap();
    tg.says(4, CHAT, "private", &format!("/start {}", challenge.code));
    poll_once(&mut con, &tg, wall, now).await.unwrap();
    assert!(tg.sent_to(CHAT)[3].contains("approve the signature request"));
    assert_eq!(
        telegram::chat_of(&mut con, ALICE).await.unwrap(),
        None,
        "a code alone links nothing"
    );
    // The server verifies the signature and completes the link; the bot confirms it.
    telegram::attach(&mut con, &challenge.code, Half::Signed, T0)
        .await
        .unwrap();
    assert_eq!(
        telegram::chat_of(&mut con, ALICE).await.unwrap(),
        Some(CHAT)
    );
    assert_eq!(drain_notices(&mut con, &tg).await.unwrap(), 1);
    assert!(tg.sent_to(CHAT)[4].starts_with("Linked."));

    // Signed first, then the code typed by hand in lower case: linked on the spot.
    let challenge = telegram::create_challenge(&mut con, "bob.near", Action::Link, T0)
        .await
        .unwrap();
    telegram::attach(&mut con, &challenge.code, Half::Signed, T0)
        .await
        .unwrap();
    tg.says(5, 77, "private", &challenge.code.to_lowercase());
    poll_once(&mut con, &tg, wall, now).await.unwrap();
    assert_eq!(
        telegram::chat_of(&mut con, "bob.near").await.unwrap(),
        Some(77)
    );
    assert!(tg.sent_to(77)[0].starts_with("Linked."));

    // A code sent in a group is ignored: a link is between one person and the bot.
    let challenge = telegram::create_challenge(&mut con, "carol.near", Action::Link, T0)
        .await
        .unwrap();
    telegram::attach(&mut con, &challenge.code, Half::Signed, T0)
        .await
        .unwrap();
    tg.says(
        6,
        -100,
        "supergroup",
        &format!("/start@MetaPooBot {}", challenge.code),
    );
    // An unlink code is not a link code.
    let unlink = telegram::create_challenge(&mut con, "carol.near", Action::Unlink, T0)
        .await
        .unwrap();
    tg.says(7, 88, "private", &format!("/start {}", unlink.code));
    poll_once(&mut con, &tg, wall, now).await.unwrap();
    assert!(tg.sent_to(-100).is_empty());
    assert_eq!(
        telegram::chat_of(&mut con, "carol.near").await.unwrap(),
        None
    );
}

#[tokio::test]
async fn stop_unlinks_every_account_of_the_chat_and_only_that_chat() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    let mut pacer = Pacer::default();
    link(&mut con, ALICE, CHAT, T0).await;
    link(&mut con, "alice2.near", CHAT, T0).await;
    link(&mut con, "bob.near", 77, T0).await;
    cover(&mut con, ALICE, "carol.near", 0, 2, T0 + MINUTE).await;

    // Two accounts in one chat: the alert says which.
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 5 * MINUTE)
        .await
        .unwrap();
    assert_eq!(
        tg.sent_to(CHAT),
        ["alice.near: 2 of your tiles were covered by carol.near."]
    );

    tg.says(1, CHAT, "private", "/stop");
    poll_once(&mut con, &tg, None, || T0 + 6 * MINUTE)
        .await
        .unwrap();
    assert!(tg.sent_to(CHAT)[1].starts_with("Alerts are off for alice.near, alice2.near."));
    assert_eq!(
        telegram::links(&mut con).await.unwrap(),
        [("bob.near".to_string(), 77)]
    );
    // Everything about the chat is gone: the link, the reverse index, the cursor.
    let left: Vec<String> = redis::cmd("KEYS")
        .arg("telegram:*")
        .query_async(&mut con)
        .await
        .unwrap();
    let mut left: Vec<&str> = left
        .iter()
        .map(String::as_str)
        .filter(|k| *k != keys::TELEGRAM_UPDATE_OFFSET)
        .collect();
    left.sort();
    assert_eq!(
        left,
        ["telegram:alert_state", "telegram:chat:77", "telegram:links"]
    );
    let states: HashMap<String, String> = con.hgetall(keys::TELEGRAM_ALERT_STATE).await.unwrap();
    assert_eq!(states.keys().collect::<Vec<_>>(), ["bob.near"]);

    // No alert after /stop, and a second /stop has nothing to do.
    cover(&mut con, ALICE, "carol.near", 1, 2, T0 + 2 * HOUR).await;
    tick(&mut con, &tg, &config(), &mut pacer, T0 + 3 * HOUR)
        .await
        .unwrap();
    tg.says(2, CHAT, "private", "/stop");
    poll_once(&mut con, &tg, None, || T0 + 3 * HOUR)
        .await
        .unwrap();
    let replies = tg.sent_to(CHAT);
    assert_eq!(replies.len(), 3);
    assert!(replies[2].starts_with("No account is linked"));
}

#[tokio::test]
async fn the_update_offset_survives_a_restart() {
    let Some(mut con) = connect().await else {
        return;
    };
    let tg = FakeTelegram::default();
    tg.says(41, CHAT, "private", "/start");
    tg.says(42, CHAT, "private", "/start");
    poll_once(&mut con, &tg, None, || T0).await.unwrap();
    // A new process asks from after the last update it handled, so nothing is answered twice.
    let again = FakeTelegram::default();
    again.says(42, CHAT, "private", "/start");
    again.says(43, CHAT, "private", "/stop");
    assert_eq!(poll_once(&mut con, &again, None, || T0).await, Ok(1));
    assert_eq!(*tg.offsets.lock().unwrap(), [0]);
    assert_eq!(*again.offsets.lock().unwrap(), [43]);
    assert_eq!(again.sent_to(CHAT).len(), 1);
}
