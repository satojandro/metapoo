//! AWAY-B (return-and-growth spec §1.3): the HTTP half of linking a NEAR account to a Telegram
//! chat. The bot has no public endpoint (owner decision, 13 Nov), so the page posts the
//! wallet's signed message here; this verifies it and writes the link the bot reads.
//!
//! | route | who may call | answers |
//! |---|---|---|
//! | `POST /api/telegram/challenge` `{account, action}` | anyone | `{code, nonce, message, recipient, expires_at_ms}`, identical whether or not the account is linked |
//! | `POST /api/telegram/link` `{account, code, public_key, signature}` | a full-access key of `account` | `{status: "linked" \| "waiting_for_telegram", token}` |
//! | `POST /api/telegram/unlink` `{account, code, public_key, signature}` | a full-access key of `account` | `{status: "unlinked"}` |
//! | `POST /api/telegram/status` `{account, token}` | a browser that linked `account` | `{linked}`; 401 for any other token, linked or not |
//!
//! A signature is accepted only if **all** of these hold:
//!
//! 1. the code is one this server issued for this account and this action, and has not expired;
//! 2. it is an ed25519 signature over the NEP-413 payload of the stored text, the stored
//!    nonce and this server's recipient (`common::nep413`);
//! 3. the chain says the public key is a **full-access** key of the account
//!    (`view_access_key`): a signature proves a key signed, not whose key it is, and a
//!    function-call key, such as the painting key in a browser, must not bind alerts;
//! 4. the code has not been signed for before (one Lua script in `common::telegram`).
//!
//! No route returns a chat id, and none tells a caller without a status token whether an
//! account is linked.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use common::account::normalize_account;
use common::nep413;
use common::telegram::{self, Action, Attached, Challenge, Half};
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::consumer::now_ms;

/// What the chain says about a public key on an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPermission {
    FullAccess,
    FunctionCall,
    /// No such key on the account, or no such account.
    Missing,
}

/// Asks the chain about an access key. A trait so the tests can answer without a network.
pub trait AccessKeys: Send + Sync {
    /// `Err` means "could not find out" (RPC down), never "no".
    fn permission<'a>(
        &'a self,
        account: &'a str,
        public_key: &'a str,
    ) -> BoxFuture<'a, Result<KeyPermission, String>>;
}

/// Reads a `view_access_key` JSON-RPC answer. Anything that is not a clear yes or a clear no
/// is an error: an outage must not be read as "not your key", nor as permission.
pub fn permission_from_rpc(body: &Value) -> Result<KeyPermission, String> {
    if let Some(result) = body.get("result") {
        return match result.get("permission") {
            Some(Value::String(p)) if p == "FullAccess" => Ok(KeyPermission::FullAccess),
            Some(Value::Object(p)) if p.contains_key("FunctionCall") => {
                Ok(KeyPermission::FunctionCall)
            }
            // Older nodes answer a missing key with a `result.error` string.
            None if result
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|e| e.contains("does not exist")) =>
            {
                Ok(KeyPermission::Missing)
            }
            _ => Err("unrecognised view_access_key result".into()),
        };
    }
    match body.pointer("/error/cause/name").and_then(Value::as_str) {
        Some("UNKNOWN_ACCESS_KEY" | "UNKNOWN_ACCOUNT" | "INVALID_ACCOUNT") => {
            Ok(KeyPermission::Missing)
        }
        other => Err(format!("view_access_key failed: {other:?}")),
    }
}

/// `view_access_key` over JSON-RPC, at final finality.
pub struct RpcAccessKeys {
    url: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl RpcAccessKeys {
    pub fn new(url: &str, api_key: Option<String>) -> anyhow::Result<Self> {
        Ok(Self {
            url: url.to_string(),
            api_key,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .user_agent("metapoo-board-server")
                .build()?,
        })
    }
}

impl AccessKeys for RpcAccessKeys {
    fn permission<'a>(
        &'a self,
        account: &'a str,
        public_key: &'a str,
    ) -> BoxFuture<'a, Result<KeyPermission, String>> {
        Box::pin(async move {
            let request = self.http.post(&self.url).json(&json!({
                "jsonrpc": "2.0",
                "id": "telegram-link",
                "method": "query",
                "params": {
                    "request_type": "view_access_key",
                    "finality": "final",
                    "account_id": account,
                    "public_key": public_key,
                },
            }));
            let request = match &self.api_key {
                Some(key) => request.bearer_auth(key),
                None => request,
            };
            let response = request.send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("RPC HTTP {}", response.status()));
            }
            let body: Value = response.json().await.map_err(|e| e.to_string())?;
            permission_from_rpc(&body)
        })
    }
}

/// Fixed-window counters, in memory. Enough for one small server; a restart forgets them.
#[derive(Default)]
pub struct Limiter {
    windows: Mutex<HashMap<String, (u64, u32)>>,
}

impl Limiter {
    /// Count one request against `key`; `false` once more than `max` arrived in this window.
    pub fn allow(&self, key: &str, max: u32, window_ms: u64, now_ms: u64) -> bool {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        if windows.len() > 10_000 {
            windows.retain(|_, (start, _)| now_ms.saturating_sub(*start) < 3_600_000);
        }
        let entry = windows.entry(key.to_string()).or_insert((now_ms, 0));
        if now_ms.saturating_sub(entry.0) >= window_ms {
            *entry = (now_ms, 0);
        }
        entry.1 += 1;
        entry.1 <= max
    }
}

const MINUTE_MS: u64 = 60_000;
/// Per client address, per minute: challenge + link + unlink together. A real link is two
/// requests, an unlink two more.
pub const WRITES_PER_CLIENT: u32 = 12;
/// Per client address, per minute: status reads (the page polls while it waits for the bot).
pub const STATUS_PER_CLIENT: u32 = 60;
/// Everyone together, per minute. Each challenge is a small key that lives ten minutes.
pub const WRITES_GLOBAL: u32 = 240;
/// Everyone together, per minute: `view_access_key` calls. Anyone can make a throwaway key
/// and a valid signature, so this is the request an outsider can make us spend.
pub const RPC_GLOBAL: u32 = 60;

#[derive(Clone)]
pub struct TelegramState {
    pub valkey: redis::aio::ConnectionManager,
    pub keys: Arc<dyn AccessKeys>,
    /// NEP-413 `recipient`: who the wallet says is asking. The site's host name.
    pub recipient: String,
    pub limiter: Arc<Limiter>,
}

pub fn router(state: TelegramState) -> Router {
    Router::new()
        .route("/api/telegram/challenge", post(challenge))
        .route("/api/telegram/link", post(link))
        .route("/api/telegram/unlink", post(unlink))
        .route("/api/telegram/status", post(status))
        .layer(DefaultBodyLimit::max(4 * 1024))
        .with_state(state)
}

/// The NEP-413 recipient for a wall at `wall_url`: its host name, else `metapoo`.
pub fn recipient_for(wall_url: &str) -> String {
    wall_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .filter(|host| !host.is_empty())
        .unwrap_or("metapoo")
        .to_string()
}

/// The routes, if the box is configured for Telegram alerts (`TELEGRAM_BOT_TOKEN` is set;
/// only its presence is read here, the server never talks to Telegram). `None` leaves the
/// server exactly as it was.
pub fn from_env(valkey: redis::aio::ConnectionManager) -> anyhow::Result<Option<Router>> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    if var("TELEGRAM_BOT_TOKEN").is_none() {
        return Ok(None);
    }
    let rpc_url = var("NEAR_RPC_URL").unwrap_or_else(|| {
        match var("CHAIN_ID").as_deref() {
            Some("testnet") => "https://rpc.testnet.fastnear.com",
            _ => "https://rpc.mainnet.fastnear.com",
        }
        .to_string()
    });
    let recipient = var("TELEGRAM_LINK_RECIPIENT")
        .unwrap_or_else(|| recipient_for(&var("WALL_URL").unwrap_or_default()));
    tracing::info!("telegram link routes on; recipient {recipient:?}, key checks at {rpc_url}");
    Ok(Some(router(TelegramState {
        valkey,
        keys: Arc::new(RpcAccessKeys::new(&rpc_url, var("NEAR_RPC_API_KEY"))?),
        recipient,
        limiter: Arc::new(Limiter::default()),
    })))
}

fn refuse(status: StatusCode, why: &str) -> Response {
    (status, Json(json!({ "error": why }))).into_response()
}

fn unavailable() -> Response {
    refuse(StatusCode::SERVICE_UNAVAILABLE, "try again in a moment")
}

/// The caller's address as the reverse proxy reports it: the **last** `X-Forwarded-For`
/// entry, the one the proxy itself appended (earlier entries are whatever the client sent).
/// The server listens on 127.0.0.1 behind that proxy; with no proxy every caller shares one
/// bucket and only the global limits bind.
fn client(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .map(|ip| ip.trim().to_string())
        .filter(|ip| !ip.is_empty() && ip.len() <= 64)
        .unwrap_or_else(|| "direct".into())
}

fn write_allowed(state: &TelegramState, headers: &HeaderMap) -> bool {
    let now = now_ms();
    state.limiter.allow(
        &format!("w:{}", client(headers)),
        WRITES_PER_CLIENT,
        MINUTE_MS,
        now,
    ) && state.limiter.allow("w:*", WRITES_GLOBAL, MINUTE_MS, now)
}

const VALKEY_TIMEOUT: Duration = Duration::from_secs(2);

/// One Valkey call, bounded: a `ConnectionManager` blocks while it reconnects.
async fn valkey<T>(call: impl std::future::Future<Output = redis::RedisResult<T>>) -> Option<T> {
    tokio::time::timeout(VALKEY_TIMEOUT, call).await.ok()?.ok()
}

#[derive(Deserialize)]
struct ChallengeBody {
    #[serde(default)]
    account: String,
    #[serde(default)]
    action: String,
}

async fn challenge(
    State(state): State<TelegramState>,
    headers: HeaderMap,
    Json(body): Json<ChallengeBody>,
) -> Response {
    if !write_allowed(&state, &headers) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "too many requests");
    }
    let Some(account) = normalize_account(&body.account) else {
        return refuse(StatusCode::BAD_REQUEST, "account must be a NEAR account id");
    };
    let Some(action) = Action::parse(&body.action) else {
        return refuse(StatusCode::BAD_REQUEST, "action must be link or unlink");
    };
    let mut con = state.valkey.clone();
    let Some(challenge) = valkey(telegram::create_challenge(
        &mut con,
        &account,
        action,
        now_ms(),
    ))
    .await
    else {
        return unavailable();
    };
    Json(json!({
        "code": challenge.code,
        "nonce": challenge.nonce_base64(),
        "message": challenge.message(),
        "recipient": state.recipient,
        "expires_at_ms": challenge.expires_at_ms,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SignedBody {
    #[serde(default)]
    account: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    public_key: String,
    #[serde(default)]
    signature: String,
    /// Only if the wallet signed with one (redirect wallets). Part of the signed payload.
    #[serde(default)]
    callback_url: Option<String>,
}

/// Steps 1–3 of the module comment. `Ok` carries the account and the challenge it proved.
// The refusal is the HTTP response itself, built once and returned as it is.
#[allow(clippy::result_large_err)]
async fn verified(
    state: &TelegramState,
    headers: &HeaderMap,
    body: &SignedBody,
    action: Action,
) -> Result<(String, Challenge), Response> {
    if !write_allowed(state, headers) {
        return Err(refuse(StatusCode::TOO_MANY_REQUESTS, "too many requests"));
    }
    let account = normalize_account(&body.account)
        .ok_or_else(|| refuse(StatusCode::BAD_REQUEST, "account must be a NEAR account id"))?;
    let gone = || refuse(StatusCode::GONE, "this code has expired; start again");
    let code = telegram::normalize_code(&body.code).ok_or_else(gone)?;
    let mut con = state.valkey.clone();
    let challenge = valkey(telegram::read_challenge(&mut con, &code, now_ms()))
        .await
        .ok_or_else(unavailable)?
        // A code for another account or the other action is answered like no code at all.
        .filter(|c| c.account == account && c.action == action)
        .ok_or_else(gone)?;
    let callback_url = body.callback_url.as_deref().filter(|url| url.len() <= 512);
    if body.callback_url.is_some() && callback_url.is_none() {
        return Err(refuse(StatusCode::BAD_REQUEST, "callback_url is too long"));
    }
    nep413::verify(
        &challenge.message(),
        &challenge.nonce,
        &state.recipient,
        callback_url,
        &body.public_key,
        &body.signature,
    )
    .map_err(|_| {
        refuse(
            StatusCode::UNAUTHORIZED,
            "the signature does not match this code",
        )
    })?;
    // Only now, with a valid signature in hand, is the chain asked.
    if !state
        .limiter
        .allow("rpc:*", RPC_GLOBAL, MINUTE_MS, now_ms())
    {
        return Err(refuse(StatusCode::TOO_MANY_REQUESTS, "too many requests"));
    }
    match state.keys.permission(&account, &body.public_key).await {
        Ok(KeyPermission::FullAccess) => Ok((account, challenge)),
        Ok(KeyPermission::FunctionCall | KeyPermission::Missing) => Err(refuse(
            StatusCode::FORBIDDEN,
            "sign with a full-access key of this account",
        )),
        Err(why) => {
            tracing::warn!("view_access_key: {why}");
            Err(unavailable())
        }
    }
}

async fn link(
    State(state): State<TelegramState>,
    headers: HeaderMap,
    Json(body): Json<SignedBody>,
) -> Response {
    let (account, challenge) = match verified(&state, &headers, &body, Action::Link).await {
        Ok(ok) => ok,
        Err(response) => return response,
    };
    let mut con = state.valkey.clone();
    let Some(attached) = valkey(telegram::attach(
        &mut con,
        &challenge.code,
        Half::Signed,
        now_ms(),
    ))
    .await
    else {
        return unavailable();
    };
    let status = match attached {
        Attached::Linked { .. } => "linked",
        Attached::Waiting { .. } => "waiting_for_telegram",
        Attached::Used => return refuse(StatusCode::CONFLICT, "this code was already signed for"),
        Attached::Missing | Attached::Taken => {
            return refuse(StatusCode::GONE, "this code has expired; start again")
        }
    };
    let Some(token) = valkey(telegram::issue_token(&mut con, &account)).await else {
        return unavailable();
    };
    Json(json!({ "status": status, "token": token })).into_response()
}

async fn unlink(
    State(state): State<TelegramState>,
    headers: HeaderMap,
    Json(body): Json<SignedBody>,
) -> Response {
    let (account, challenge) = match verified(&state, &headers, &body, Action::Unlink).await {
        Ok(ok) => ok,
        Err(response) => return response,
    };
    let mut con = state.valkey.clone();
    match valkey(telegram::consume_unlink(
        &mut con,
        &challenge.code,
        &account,
        now_ms(),
    ))
    .await
    {
        None => return unavailable(),
        Some(false) => return refuse(StatusCode::CONFLICT, "this code was already used"),
        Some(true) => {}
    }
    if valkey(telegram::unlink_account(&mut con, &account))
        .await
        .is_none()
    {
        return unavailable();
    }
    Json(json!({ "status": "unlinked" })).into_response()
}

#[derive(Deserialize)]
struct StatusBody {
    #[serde(default)]
    account: String,
    #[serde(default)]
    token: String,
}

async fn status(
    State(state): State<TelegramState>,
    headers: HeaderMap,
    Json(body): Json<StatusBody>,
) -> Response {
    if !state.limiter.allow(
        &format!("s:{}", client(&headers)),
        STATUS_PER_CLIENT,
        MINUTE_MS,
        now_ms(),
    ) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "too many requests");
    }
    // One answer for every request that does not carry a token of this account: a bad
    // account id, an unknown token, a linked account and an unlinked one all look the same.
    let unknown = || refuse(StatusCode::UNAUTHORIZED, "unknown token");
    let Some(account) = normalize_account(&body.account) else {
        return unknown();
    };
    if body.token.is_empty() || body.token.len() > 128 {
        return unknown();
    }
    let mut con = state.valkey.clone();
    match valkey(telegram::status(&mut con, &account, &body.token)).await {
        None => unavailable(),
        Some(None) => unknown(),
        Some(Some(linked)) => (
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Json(json!({ "linked": linked })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rpc_answer_is_read_as_full_access_function_call_missing_or_unknown() {
        // Shapes as nearcore answers `query` / `view_access_key`.
        let full = json!({"jsonrpc":"2.0","id":"x","result":{
            "block_hash":"h","block_height":1,"nonce":7,"permission":"FullAccess"}});
        assert_eq!(permission_from_rpc(&full), Ok(KeyPermission::FullAccess));
        let function_call = json!({"jsonrpc":"2.0","id":"x","result":{"nonce":7,"permission":{
            "FunctionCall":{"allowance":"250000000000000000000000",
            "receiver_id":"board.near","method_names":["draw","draw_many"]}}}});
        assert_eq!(
            permission_from_rpc(&function_call),
            Ok(KeyPermission::FunctionCall)
        );
        let unknown_key = json!({"jsonrpc":"2.0","id":"x","error":{
            "name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCESS_KEY","info":{}},
            "code":-32000,"message":"Server error"}});
        assert_eq!(
            permission_from_rpc(&unknown_key),
            Ok(KeyPermission::Missing)
        );
        let legacy = json!({"jsonrpc":"2.0","id":"x","result":{"block_height":1,
            "error":"access key ed25519:abc does not exist while viewing","logs":[]}});
        assert_eq!(permission_from_rpc(&legacy), Ok(KeyPermission::Missing));
        // Anything unclear is "could not find out", never a yes and never a no.
        for unclear in [
            json!({}),
            json!({"error":{"cause":{"name":"UNKNOWN_BLOCK"}}}),
            json!({"error":{"code":-429,"message":"rate limited"}}),
            json!({"result":{"permission":"SomethingNew"}}),
            json!({"result":{}}),
        ] {
            assert!(permission_from_rpc(&unclear).is_err(), "{unclear}");
        }
    }

    #[test]
    fn the_limiter_allows_max_per_window_and_then_recovers() {
        let limiter = Limiter::default();
        for _ in 0..3 {
            assert!(limiter.allow("a", 3, 1_000, 10));
        }
        assert!(!limiter.allow("a", 3, 1_000, 500));
        assert!(limiter.allow("b", 3, 1_000, 500), "keys are separate");
        assert!(limiter.allow("a", 3, 1_000, 1_010), "a new window");
    }

    #[test]
    fn the_client_is_the_address_the_proxy_appended() {
        let mut headers = HeaderMap::new();
        assert_eq!(client(&headers), "direct");
        headers.insert("x-forwarded-for", "6.6.6.6, 203.0.113.9".parse().unwrap());
        assert_eq!(client(&headers), "203.0.113.9");
    }

    #[test]
    fn the_recipient_is_the_walls_host() {
        assert_eq!(
            recipient_for("https://metapoo.example/wall"),
            "metapoo.example"
        );
        assert_eq!(recipient_for("https://metapoo.example"), "metapoo.example");
        assert_eq!(recipient_for(""), "metapoo");
    }
}
