//! AWAY-B (return-and-growth spec §1.3): what the Telegram alerts feature keeps in Valkey.
//! The server (which verifies the wallet's signature) and the bot (which talks to Telegram)
//! share nothing but these keys.
//!
//! **Linking.** The page asks the server for a *challenge*: a one-time code, a 32-byte nonce
//! and the exact text to sign. Two things then have to happen, in either order:
//!
//! - the player sends the code to the bot, which records the Telegram chat on the challenge;
//! - the wallet signs the text (NEP-413) and the page posts the signature to the server, which
//!   verifies it and marks the challenge signed.
//!
//! Whichever arrives second completes the link, inside one Lua script ([`attach`]), so the
//! two sides cannot both miss it and a signature cannot be used twice. A challenge lives
//! [`CODE_TTL_MS`] and is deleted when it completes.
//!
//! **What is stored.** `telegram:links` (account → chat id) and its reverse index
//! `telegram:chat:<chat id>` are the only personal data. No HTTP route returns either.
//!
//! **Alerts.** `telegram:alert_state` holds, per account, a cursor into `covers:<account>`
//! (the AWAY-A sorted set) and when the last alert went out. See [`AlertState`].

use std::collections::HashMap;

use base64::Engine;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::history::{cover_key, parse_cover_member, CoverRecord};
use crate::keys;

/// How long a code can be used. Long enough to open Telegram and approve a wallet prompt.
pub const CODE_TTL_MS: u64 = 10 * 60 * 1000;
pub const CODE_LEN: usize = 10;
/// 32 symbols, none of which reads as another (no I, O, 0, 1): 50 bits in ten characters.
/// All of them are allowed in a `t.me/<bot>?start=` parameter.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Status tokens are forgotten after this long without a new link from that account.
const TOKEN_TTL_MS: i64 = 400 * 24 * 60 * 60 * 1000;

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("the OS random source is available");
    bytes
}

pub fn new_code() -> String {
    random::<CODE_LEN>()
        .iter()
        .map(|b| CODE_ALPHABET[(b & 31) as usize] as char)
        .collect()
}

/// `raw` as a code would be stored, if it has a code's shape. Typed codes arrive in any case.
pub fn normalize_code(raw: &str) -> Option<String> {
    let code = raw.trim().to_ascii_uppercase();
    (code.len() == CODE_LEN && code.bytes().all(|b| CODE_ALPHABET.contains(&b))).then_some(code)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Link,
    Unlink,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Link => "link",
            Action::Unlink => "unlink",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "link" => Some(Action::Link),
            "unlink" => Some(Action::Unlink),
            _ => None,
        }
    }
}

/// The text the wallet shows and signs. The server builds it from the challenge it stored and
/// never takes it from the request, so a signature for one account, action or code is not a
/// signature for another.
pub fn message_for(action: Action, account: &str, code: &str) -> String {
    match action {
        Action::Link => format!(
            "Send Telegram alerts when tiles of {account} on Meta Poo are covered. Code: {code}"
        ),
        Action::Unlink => {
            format!("Stop Telegram alerts for {account} on Meta Poo. Code: {code}")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub code: String,
    pub account: String,
    pub action: Action,
    pub nonce: [u8; 32],
    pub expires_at_ms: u64,
}

impl Challenge {
    pub fn message(&self) -> String {
        message_for(self.action, &self.account, &self.code)
    }

    pub fn nonce_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.nonce)
    }
}

pub fn challenge_key(code: &str) -> String {
    format!("{}{code}", keys::TELEGRAM_CHALLENGE_PREFIX)
}

pub fn chat_key(chat: i64) -> String {
    format!("{}{chat}", keys::TELEGRAM_CHAT_PREFIX)
}

fn tokens_key(account: &str) -> String {
    format!("{}{account}", keys::TELEGRAM_TOKENS_PREFIX)
}

/// Store a new challenge for `account`. Nothing about the account is read: the answer is the
/// same whether or not it is linked.
pub async fn create_challenge(
    con: &mut ConnectionManager,
    account: &str,
    action: Action,
    now_ms: u64,
) -> redis::RedisResult<Challenge> {
    let challenge = Challenge {
        code: new_code(),
        account: account.to_string(),
        action,
        nonce: random::<32>(),
        expires_at_ms: now_ms + CODE_TTL_MS,
    };
    let key = challenge_key(&challenge.code);
    let _: () = redis::pipe()
        .atomic()
        .hset_multiple(
            &key,
            &[
                ("account", challenge.account.clone()),
                ("action", action.as_str().to_string()),
                ("nonce", challenge.nonce_base64()),
                ("expires_at_ms", challenge.expires_at_ms.to_string()),
            ],
        )
        .ignore()
        .pexpire(&key, CODE_TTL_MS as i64)
        .ignore()
        .query_async(con)
        .await?;
    Ok(challenge)
}

/// The challenge for `code`, unless it is unknown, used up, or past its time at `now_ms`.
pub async fn read_challenge(
    con: &mut ConnectionManager,
    code: &str,
    now_ms: u64,
) -> redis::RedisResult<Option<Challenge>> {
    let fields: HashMap<String, String> = con.hgetall(challenge_key(code)).await?;
    Ok((|| {
        let nonce = base64::engine::general_purpose::STANDARD
            .decode(fields.get("nonce")?)
            .ok()?;
        let challenge = Challenge {
            code: code.to_string(),
            account: fields.get("account")?.clone(),
            action: Action::parse(fields.get("action")?)?,
            nonce: nonce.try_into().ok()?,
            expires_at_ms: fields.get("expires_at_ms")?.parse().ok()?,
        };
        (challenge.expires_at_ms > now_ms).then_some(challenge)
    })())
}

/// Which half of a link is being added to a challenge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Half {
    /// The server verified the wallet's signature.
    Signed,
    /// The bot received the code from this Telegram chat.
    Chat(i64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attached {
    /// No such link code (unknown, expired, already completed, or an unlink code).
    Missing,
    /// This code's signature was already accepted once.
    Used,
    /// Another chat already sent this code.
    Taken,
    /// Recorded; the other half has not arrived yet.
    Waiting { account: String },
    /// Both halves are in: the account now alerts into the chat.
    Linked { account: String, chat: i64 },
}

/// Adds one half to a link challenge and, when both are present, writes the link, resets the
/// account's alert cursor to now, and deletes the challenge. All in one script, so:
/// a signature is accepted once; two chats cannot both claim a code; and the half that
/// arrives second always completes the link, whichever it is.
///
/// When the *server* completes it (the chat was there first), a notice is left in the outbox
/// for the bot, which is the only process that can talk to Telegram.
const ATTACH: &str = r#"
local key = KEYS[1]
local half, value, now = ARGV[1], ARGV[2], ARGV[3]
if redis.call('HGET', key, 'action') ~= 'link' then return {'missing'} end
if tonumber(redis.call('HGET', key, 'expires_at_ms')) <= tonumber(now) then return {'missing'} end
if half == 'signed' then
  if redis.call('HEXISTS', key, 'signed') == 1 then return {'used'} end
else
  local chat = redis.call('HGET', key, 'chat')
  if chat and chat ~= value then return {'taken'} end
end
redis.call('HSET', key, half, value)
local account = redis.call('HGET', key, 'account')
local chat = redis.call('HGET', key, 'chat')
if not chat or redis.call('HEXISTS', key, 'signed') == 0 then return {'waiting', account} end
local old = redis.call('HGET', KEYS[2], account)
if old and old ~= chat then redis.call('SREM', ARGV[4] .. old, account) end
redis.call('HSET', KEYS[2], account, chat)
redis.call('SADD', ARGV[4] .. chat, account)
redis.call('HSET', KEYS[3], account, ARGV[5])
redis.call('DEL', key)
if half == 'signed' then
  redis.call('RPUSH', KEYS[4], cjson.encode({kind = 'linked', chat = chat, account = account}))
end
return {'linked', account, chat}
"#;

pub async fn attach(
    con: &mut ConnectionManager,
    code: &str,
    half: Half,
    now_ms: u64,
) -> redis::RedisResult<Attached> {
    let (name, value) = match half {
        Half::Signed => ("signed", "1".to_string()),
        Half::Chat(chat) => ("chat", chat.to_string()),
    };
    let state = serde_json::to_string(&AlertState::linked_at(now_ms)).expect("serialises");
    let reply: Vec<String> = redis::Script::new(ATTACH)
        .key(challenge_key(code))
        .key(keys::TELEGRAM_LINKS)
        .key(keys::TELEGRAM_ALERT_STATE)
        .key(keys::TELEGRAM_OUTBOX)
        .arg(name)
        .arg(value)
        .arg(now_ms)
        .arg(keys::TELEGRAM_CHAT_PREFIX)
        .arg(state)
        .invoke_async(con)
        .await?;
    let field = |i: usize| reply.get(i).cloned().unwrap_or_default();
    Ok(match field(0).as_str() {
        "used" => Attached::Used,
        "taken" => Attached::Taken,
        "waiting" => Attached::Waiting { account: field(1) },
        "linked" => Attached::Linked {
            account: field(1),
            chat: field(2).parse().unwrap_or(0),
        },
        _ => Attached::Missing,
    })
}

/// Deletes an unlink challenge if it is `account`'s and still valid. `true` exactly once.
const CONSUME_UNLINK: &str = r#"
if redis.call('HGET', KEYS[1], 'action') ~= 'unlink' then return 0 end
if redis.call('HGET', KEYS[1], 'account') ~= ARGV[1] then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'expires_at_ms')) <= tonumber(ARGV[2]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
"#;

pub async fn consume_unlink(
    con: &mut ConnectionManager,
    code: &str,
    account: &str,
    now_ms: u64,
) -> redis::RedisResult<bool> {
    redis::Script::new(CONSUME_UNLINK)
        .key(challenge_key(code))
        .arg(account)
        .arg(now_ms)
        .invoke_async(con)
        .await
}

/// Forget `account`: its chat, its cursor and every status token issued for it.
const UNLINK_ACCOUNT: &str = r#"
local chat = redis.call('HGET', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', ARGV[3] .. ARGV[1])
if not chat then return 0 end
redis.call('SREM', ARGV[2] .. chat, ARGV[1])
return 1
"#;

/// `true` if the account was linked.
pub async fn unlink_account(
    con: &mut ConnectionManager,
    account: &str,
) -> redis::RedisResult<bool> {
    redis::Script::new(UNLINK_ACCOUNT)
        .key(keys::TELEGRAM_LINKS)
        .key(keys::TELEGRAM_ALERT_STATE)
        .arg(account)
        .arg(keys::TELEGRAM_CHAT_PREFIX)
        .arg(keys::TELEGRAM_TOKENS_PREFIX)
        .invoke_async(con)
        .await
}

/// Forget every account that alerts into `chat` (`/stop`, or the user blocked the bot). An
/// account that has since been linked to another chat is left alone.
const UNLINK_CHAT: &str = r#"
local chat_key = ARGV[2] .. ARGV[1]
local removed = {}
for _, account in ipairs(redis.call('SMEMBERS', chat_key)) do
  if redis.call('HGET', KEYS[1], account) == ARGV[1] then
    redis.call('HDEL', KEYS[1], account)
    redis.call('HDEL', KEYS[2], account)
    redis.call('DEL', ARGV[3] .. account)
    table.insert(removed, account)
  end
end
redis.call('DEL', chat_key)
return removed
"#;

/// The accounts that were unlinked.
pub async fn unlink_chat(
    con: &mut ConnectionManager,
    chat: i64,
) -> redis::RedisResult<Vec<String>> {
    redis::Script::new(UNLINK_CHAT)
        .key(keys::TELEGRAM_LINKS)
        .key(keys::TELEGRAM_ALERT_STATE)
        .arg(chat)
        .arg(keys::TELEGRAM_CHAT_PREFIX)
        .arg(keys::TELEGRAM_TOKENS_PREFIX)
        .invoke_async(con)
        .await
}

/// Every link, sorted by account.
pub async fn links(con: &mut ConnectionManager) -> redis::RedisResult<Vec<(String, i64)>> {
    let all: HashMap<String, i64> = con.hgetall(keys::TELEGRAM_LINKS).await?;
    let mut all: Vec<_> = all.into_iter().collect();
    all.sort();
    Ok(all)
}

pub async fn chat_of(
    con: &mut ConnectionManager,
    account: &str,
) -> redis::RedisResult<Option<i64>> {
    con.hget(keys::TELEGRAM_LINKS, account).await
}

pub async fn accounts_of(
    con: &mut ConnectionManager,
    chat: i64,
) -> redis::RedisResult<Vec<String>> {
    let mut accounts: Vec<String> = con.smembers(chat_key(chat)).await?;
    accounts.sort();
    Ok(accounts)
}

// ── Status tokens ────────────────────────────────────────────────────────────────────────
//
// The page has to show "alerts are on" without the server telling anyone who asks whether an
// account is linked, and without a wallet prompt every time the panel opens. So a verified
// signature also buys a random *status token*, kept in that browser. `status` answers only
// to a token issued for that account; anything else gets the same "no" whether or not the
// account is linked. Only the token's SHA-256 is stored, and unlinking deletes them all.

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A new status token for `account`. Call only after its signature has been verified.
pub async fn issue_token(con: &mut ConnectionManager, account: &str) -> redis::RedisResult<String> {
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random::<32>());
    let key = tokens_key(account);
    let _: () = redis::pipe()
        .atomic()
        .sadd(&key, token_hash(&token))
        .ignore()
        .pexpire(&key, TOKEN_TTL_MS)
        .ignore()
        .query_async(con)
        .await?;
    Ok(token)
}

/// `None`: the token is not one of `account`'s (say nothing more). `Some(linked)` otherwise.
pub async fn status(
    con: &mut ConnectionManager,
    account: &str,
    token: &str,
) -> redis::RedisResult<Option<bool>> {
    let known: bool = con
        .sismember(tokens_key(account), token_hash(token))
        .await?;
    if !known {
        return Ok(None);
    }
    Ok(Some(con.hexists(keys::TELEGRAM_LINKS, account).await?))
}

// ── Alerts ───────────────────────────────────────────────────────────────────────────────

/// Where the bot is in one account's cover events.
///
/// `covers:<account>` is ordered by `(at_ms, member)`, and the consumer applies events in
/// chain order, so that order only ever grows at the end. The cursor is the last cover that
/// was reported; everything after it is new. It is a *position*, not a time: the indexer only
/// polls while someone is watching the wall, so a cover can be written long after its block,
/// and a "since the last send" clock would skip it.
///
/// A link starts the cursor at the moment of linking, so a new link never reports the 30
/// days of covers already in the set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertState {
    pub linked_at_ms: u64,
    pub cursor_ms: u64,
    pub cursor_member: String,
    /// When the last alert was sent; 0 = never.
    pub last_sent_ms: u64,
}

impl AlertState {
    pub fn linked_at(now_ms: u64) -> Self {
        AlertState {
            linked_at_ms: now_ms,
            cursor_ms: now_ms,
            cursor_member: String::new(),
            last_sent_ms: 0,
        }
    }
}

pub async fn alert_state(
    con: &mut ConnectionManager,
    account: &str,
) -> redis::RedisResult<Option<AlertState>> {
    let raw: Option<String> = con.hget(keys::TELEGRAM_ALERT_STATE, account).await?;
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

/// One cover after the cursor, with its place in the set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCover {
    pub member: String,
    pub record: CoverRecord,
}

/// `account`'s covers after `state`'s cursor, oldest first.
pub async fn covers_after(
    con: &mut ConnectionManager,
    account: &str,
    state: &AlertState,
) -> redis::RedisResult<Vec<NewCover>> {
    let members: Vec<(String, f64)> = con
        .zrangebyscore_withscores(cover_key(account), state.cursor_ms, "+inf")
        .await?;
    Ok(members
        .into_iter()
        .filter(|(member, score)| {
            (*score as u64, member.as_str()) > (state.cursor_ms, state.cursor_member.as_str())
        })
        .filter_map(|(member, _)| {
            let record = parse_cover_member(&member)?;
            Some(NewCover { member, record })
        })
        .collect())
}

/// Stores `state` only while `account` still alerts into `chat`, so a send that finishes
/// after `/stop` does not bring the account's state back.
const COMMIT_STATE: &str = r#"
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return 1
"#;

pub async fn commit_alert_state(
    con: &mut ConnectionManager,
    account: &str,
    chat: i64,
    state: &AlertState,
) -> redis::RedisResult<bool> {
    redis::Script::new(COMMIT_STATE)
        .key(keys::TELEGRAM_LINKS)
        .key(keys::TELEGRAM_ALERT_STATE)
        .arg(account)
        .arg(chat)
        .arg(serde_json::to_string(state).expect("serialises"))
        .invoke_async(con)
        .await
}

/// A notice the server left for the bot to deliver.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Notice {
    pub kind: String,
    /// cjson writes the chat id as it was stored: a string.
    pub chat: String,
    pub account: String,
}

pub async fn pop_notice(con: &mut ConnectionManager) -> redis::RedisResult<Option<Notice>> {
    loop {
        let raw: Option<String> = con.lpop(keys::TELEGRAM_OUTBOX, None).await?;
        match raw {
            None => return Ok(None),
            Some(raw) => {
                if let Ok(notice) = serde_json::from_str(&raw) {
                    return Ok(Some(notice));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_ten_unambiguous_characters_and_differ() {
        let a = new_code();
        let b = new_code();
        assert_ne!(a, b);
        for code in [&a, &b] {
            assert_eq!(code.len(), CODE_LEN);
            assert_eq!(normalize_code(code).as_deref(), Some(code.as_str()));
            assert!(!code.contains(['I', 'O', '0', '1']));
        }
    }

    #[test]
    fn typed_codes_are_trimmed_and_uppercased_and_junk_is_refused() {
        assert_eq!(
            normalize_code("  abcdefghjk\n").as_deref(),
            Some("ABCDEFGHJK")
        );
        for bad in [
            "",
            "ABCDEFGHJ",
            "ABCDEFGHJKL",
            "ABCDEFGH1K",
            "ABCDE FGHJ",
            "ABCDEFGH:K",
        ] {
            assert_eq!(normalize_code(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_signed_text_names_the_account_the_action_and_the_code() {
        let link = message_for(Action::Link, "alice.near", "ABCDEFGHJK");
        let unlink = message_for(Action::Unlink, "alice.near", "ABCDEFGHJK");
        assert_ne!(link, unlink);
        assert!(link.contains("alice.near") && link.ends_with("Code: ABCDEFGHJK"));
        assert_ne!(link, message_for(Action::Link, "bob.near", "ABCDEFGHJK"));
        assert_ne!(link, message_for(Action::Link, "alice.near", "ABCDEFGHJM"));
    }
}
