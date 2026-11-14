//! AWAY-B: the link routes against a real Valkey, with a fake chain. Skipped unless
//! `TEST_VALKEY_URL` is set (see `tests/valkey.rs`). The database is flushed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use base64::Engine;
use common::telegram::{self, Half};
use common::{keys, nep413};
use ed25519_dalek::{Signer, SigningKey};
use futures::future::BoxFuture;
use redis::AsyncCommands;
use serde_json::{json, Value};
use server::telegram_api::{self, AccessKeys, KeyPermission, Limiter, TelegramState};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const RECIPIENT: &str = "metapoo.example";
const CHAT: i64 = 4242;

async fn connect() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("TEST_VALKEY_URL").ok()?;
    let mut con = server::valkey::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_VALKEY_URL={url} is set but unreachable: {e}"));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    Some(con)
}

/// The chain, as far as these tests go: what each `(account, public key)` is, and how often
/// it was asked.
#[derive(Default)]
struct FakeChain {
    keys: Mutex<HashMap<(String, String), KeyPermission>>,
    down: Mutex<bool>,
    asked: AtomicUsize,
}

impl FakeChain {
    fn set(&self, account: &str, key: &SigningKey, permission: KeyPermission) {
        self.keys
            .lock()
            .unwrap()
            .insert((account.to_string(), public_key(key)), permission);
    }
}

impl AccessKeys for FakeChain {
    fn permission<'a>(
        &'a self,
        account: &'a str,
        public_key: &'a str,
    ) -> BoxFuture<'a, Result<KeyPermission, String>> {
        Box::pin(async move {
            self.asked.fetch_add(1, Ordering::SeqCst);
            if *self.down.lock().unwrap() {
                return Err("rpc down".into());
            }
            Ok(self
                .keys
                .lock()
                .unwrap()
                .get(&(account.to_string(), public_key.to_string()))
                .copied()
                .unwrap_or(KeyPermission::Missing))
        })
    }
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key(key: &SigningKey) -> String {
    format!(
        "ed25519:{}",
        bs58::encode(key.verifying_key().as_bytes()).into_string()
    )
}

/// What a wallet does: sign sha256 of the NEP-413 payload.
fn sign(key: &SigningKey, message: &str, nonce_b64: &str, recipient: &str) -> String {
    let nonce: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64)
        .unwrap()
        .try_into()
        .unwrap();
    let hash = Sha256::digest(nep413::payload_bytes(message, &nonce, recipient, None));
    base64::engine::general_purpose::STANDARD.encode(key.sign(&hash).to_bytes())
}

struct Harness {
    app: axum::Router,
    con: redis::aio::ConnectionManager,
    chain: Arc<FakeChain>,
}

async fn harness() -> Option<Harness> {
    let con = connect().await?;
    let chain = Arc::new(FakeChain::default());
    let app = telegram_api::router(TelegramState {
        valkey: con.clone(),
        keys: chain.clone(),
        recipient: RECIPIENT.into(),
        limiter: Arc::new(Limiter::default()),
    });
    Some(Harness { app, con, chain })
}

impl Harness {
    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::post(path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn challenge(&self, account: &str, action: &str) -> Value {
        let (status, body) = self
            .post(
                "/api/telegram/challenge",
                json!({"account": account, "action": action}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// A correctly signed body for `challenge`, by `key`.
    fn signed(&self, account: &str, challenge: &Value, key: &SigningKey) -> Value {
        json!({
            "account": account,
            "code": challenge["code"],
            "public_key": public_key(key),
            "signature": sign(
                key,
                challenge["message"].as_str().unwrap(),
                challenge["nonce"].as_str().unwrap(),
                challenge["recipient"].as_str().unwrap(),
            ),
        })
    }

    async fn linked_chat(&mut self, account: &str) -> Option<i64> {
        telegram::chat_of(&mut self.con, account).await.unwrap()
    }

    /// Link `account` to `chat` the whole way: challenge, the bot's half, the signature.
    async fn link(&mut self, account: &str, key: &SigningKey, chat: i64) -> String {
        self.chain.set(account, key, KeyPermission::FullAccess);
        let challenge = self.challenge(account, "link").await;
        let code = challenge["code"].as_str().unwrap().to_string();
        telegram::attach(&mut self.con, &code, Half::Chat(chat), now())
            .await
            .unwrap();
        let (status, body) = self
            .post("/api/telegram/link", self.signed(account, &challenge, key))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "linked");
        body["token"].as_str().unwrap().to_string()
    }
}

fn now() -> u64 {
    server::consumer::now_ms()
}

#[tokio::test]
async fn a_full_access_signature_links_once_the_bot_has_the_code_in_either_order() {
    let Some(mut h) = harness().await else { return };
    let alice = key(1);
    h.chain.set("alice.near", &alice, KeyPermission::FullAccess);

    // Signature first: nothing is linked until the chat arrives.
    let challenge = h.challenge("alice.near", "link").await;
    assert_eq!(challenge["recipient"], RECIPIENT);
    assert!(challenge["message"]
        .as_str()
        .unwrap()
        .contains("alice.near"));
    let code = challenge["code"].as_str().unwrap().to_string();
    let (status, body) = h
        .post(
            "/api/telegram/link",
            h.signed("alice.near", &challenge, &alice),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "waiting_for_telegram");
    let token = body["token"].as_str().unwrap().to_string();
    assert_eq!(h.linked_chat("alice.near").await, None);
    let (_, waiting) = h
        .post(
            "/api/telegram/status",
            json!({"account": "alice.near", "token": token}),
        )
        .await;
    assert_eq!(waiting, json!({"linked": false}));

    let attached = telegram::attach(&mut h.con, &code, Half::Chat(CHAT), now())
        .await
        .unwrap();
    assert_eq!(
        attached,
        telegram::Attached::Linked {
            account: "alice.near".into(),
            chat: CHAT
        }
    );
    assert_eq!(h.linked_chat("alice.near").await, Some(CHAT));
    let (_, linked) = h
        .post(
            "/api/telegram/status",
            json!({"account": "alice.near", "token": token}),
        )
        .await;
    assert_eq!(linked, json!({"linked": true}));

    // Chat first: the signature completes it, and leaves the bot a notice to confirm.
    let bob = key(2);
    h.link("bob.near", &bob, 77).await;
    assert_eq!(h.linked_chat("bob.near").await, Some(77));
    let notice = telegram::pop_notice(&mut h.con).await.unwrap().unwrap();
    assert_eq!(
        (
            notice.kind.as_str(),
            notice.chat.as_str(),
            notice.account.as_str()
        ),
        ("linked", "77", "bob.near")
    );
    // The first link was completed by the bot, which answers in the chat itself: no notice.
    assert_eq!(telegram::pop_notice(&mut h.con).await.unwrap(), None);
}

#[tokio::test]
async fn a_function_call_key_or_a_key_of_another_account_cannot_link() {
    let Some(mut h) = harness().await else { return };
    let painting_key = key(3);
    let stranger = key(4);
    h.chain
        .set("alice.near", &painting_key, KeyPermission::FunctionCall);
    // A full-access key, but of someone else's account.
    h.chain
        .set("mallory.near", &stranger, KeyPermission::FullAccess);

    for signer in [&painting_key, &stranger] {
        let challenge = h.challenge("alice.near", "link").await;
        let code = challenge["code"].as_str().unwrap().to_string();
        telegram::attach(&mut h.con, &code, Half::Chat(CHAT), now())
            .await
            .unwrap();
        let (status, body) = h
            .post(
                "/api/telegram/link",
                h.signed("alice.near", &challenge, signer),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.get("token").is_none());
    }
    assert_eq!(h.linked_chat("alice.near").await, None);
    assert_eq!(h.chain.asked.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_signature_over_anything_but_this_challenge_is_refused_before_the_chain_is_asked() {
    let Some(mut h) = harness().await else { return };
    let alice = key(1);
    h.chain.set("alice.near", &alice, KeyPermission::FullAccess);
    h.chain.set("bob.near", &alice, KeyPermission::FullAccess);
    let challenge = h.challenge("alice.near", "link").await;
    let message = challenge["message"].as_str().unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    let other_nonce = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let other_challenge = h.challenge("alice.near", "link").await;

    let with = |signature: String| {
        json!({"account": "alice.near", "code": challenge["code"],
               "public_key": public_key(&alice), "signature": signature})
    };
    let cases = [
        (
            "another message",
            with(sign(&alice, "Send me everything", nonce, RECIPIENT)),
        ),
        (
            "another nonce",
            with(sign(&alice, message, &other_nonce, RECIPIENT)),
        ),
        (
            "another recipient",
            with(sign(&alice, message, nonce, "evil.example")),
        ),
        (
            "the unlink text",
            with(sign(
                &alice,
                &telegram::message_for(
                    telegram::Action::Unlink,
                    "alice.near",
                    challenge["code"].as_str().unwrap(),
                ),
                nonce,
                RECIPIENT,
            )),
        ),
        (
            "a signature for another code",
            with(sign(
                &alice,
                other_challenge["message"].as_str().unwrap(),
                other_challenge["nonce"].as_str().unwrap(),
                RECIPIENT,
            )),
        ),
        (
            "no signature",
            json!({"account": "alice.near", "code": challenge["code"]}),
        ),
        (
            "a key that did not sign",
            json!({"account": "alice.near", "code": challenge["code"],
                   "public_key": public_key(&key(9)),
                   "signature": sign(&alice, message, nonce, RECIPIENT)}),
        ),
    ];
    for (what, body) in cases {
        let (status, answer) = h.post("/api/telegram/link", body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{what}: {answer}");
    }
    // The right signature, posted for another account: that account has no such code.
    let mut for_bob = h.signed("alice.near", &challenge, &alice);
    for_bob["account"] = json!("bob.near");
    let (status, _) = h.post("/api/telegram/link", for_bob).await;
    assert_eq!(status, StatusCode::GONE);

    assert_eq!(h.chain.asked.load(Ordering::SeqCst), 0);
    assert_eq!(h.linked_chat("alice.near").await, None);
    assert_eq!(h.linked_chat("bob.near").await, None);
}

#[tokio::test]
async fn a_code_is_single_use_and_expires() {
    let Some(mut h) = harness().await else { return };
    let alice = key(1);
    h.chain.set("alice.near", &alice, KeyPermission::FullAccess);

    // Replay of an accepted signature, before the bot has the code and after.
    let challenge = h.challenge("alice.near", "link").await;
    let code = challenge["code"].as_str().unwrap().to_string();
    let body = h.signed("alice.near", &challenge, &alice);
    assert_eq!(
        h.post("/api/telegram/link", body.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        h.post("/api/telegram/link", body.clone()).await.0,
        StatusCode::CONFLICT
    );
    telegram::attach(&mut h.con, &code, Half::Chat(CHAT), now())
        .await
        .unwrap();
    assert_eq!(h.post("/api/telegram/link", body).await.0, StatusCode::GONE);
    // And the bot cannot use a completed code for a second chat.
    assert_eq!(
        telegram::attach(&mut h.con, &code, Half::Chat(999), now())
            .await
            .unwrap(),
        telegram::Attached::Missing
    );
    assert_eq!(h.linked_chat("alice.near").await, Some(CHAT));

    // Two chats race for one code: the first keeps it.
    let challenge = h.challenge("alice.near", "link").await;
    let code = challenge["code"].as_str().unwrap().to_string();
    telegram::attach(&mut h.con, &code, Half::Chat(1), now())
        .await
        .unwrap();
    assert_eq!(
        telegram::attach(&mut h.con, &code, Half::Chat(2), now())
            .await
            .unwrap(),
        telegram::Attached::Taken
    );

    // Expiry: the stored deadline is enforced even if the key has not been evicted yet,
    // and Valkey evicts it on its own after that.
    let challenge = h.challenge("alice.near", "link").await;
    let code = challenge["code"].as_str().unwrap().to_string();
    let ttl: i64 = h.con.pttl(telegram::challenge_key(&code)).await.unwrap();
    assert!(ttl > 0 && ttl <= telegram::CODE_TTL_MS as i64, "ttl {ttl}");
    let late = now() + telegram::CODE_TTL_MS + 1;
    assert_eq!(
        telegram::read_challenge(&mut h.con, &code, late)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        telegram::attach(&mut h.con, &code, Half::Chat(CHAT), late)
            .await
            .unwrap(),
        telegram::Attached::Missing
    );
    let _: () = h
        .con
        .hset(telegram::challenge_key(&code), "expires_at_ms", now() - 1)
        .await
        .unwrap();
    let (status, _) = h
        .post(
            "/api/telegram/link",
            h.signed("alice.near", &challenge, &alice),
        )
        .await;
    assert_eq!(status, StatusCode::GONE);
    // A code nobody issued.
    let mut unknown = h.signed("alice.near", &challenge, &alice);
    unknown["code"] = json!("ABCDEFGHJK");
    assert_eq!(
        h.post("/api/telegram/link", unknown).await.0,
        StatusCode::GONE
    );
}

#[tokio::test]
async fn unlink_needs_a_full_access_signature_and_refuses_everything_else() {
    let Some(mut h) = harness().await else { return };
    let alice = key(1);
    let painting_key = key(3);
    let token = h.link("alice.near", &alice, CHAT).await;
    h.chain
        .set("alice.near", &painting_key, KeyPermission::FunctionCall);

    let challenge = h.challenge("alice.near", "unlink").await;
    let unsigned = [
        json!({"account": "alice.near"}),
        json!({"account": "alice.near", "code": challenge["code"]}),
        json!({"account": "alice.near", "code": challenge["code"], "token": token}),
        json!({"account": "alice.near", "code": challenge["code"],
               "public_key": public_key(&alice), "signature": ""}),
    ];
    for body in unsigned {
        let (status, answer) = h.post("/api/telegram/unlink", body.clone()).await;
        assert!(
            status == StatusCode::UNAUTHORIZED || status == StatusCode::GONE,
            "{body} -> {status} {answer}"
        );
    }
    // A link signature is not an unlink signature.
    let link_challenge = h.challenge("alice.near", "link").await;
    let (status, _) = h
        .post(
            "/api/telegram/unlink",
            h.signed("alice.near", &link_challenge, &alice),
        )
        .await;
    assert_eq!(status, StatusCode::GONE);
    // Nor is the painting key's.
    let (status, _) = h
        .post(
            "/api/telegram/unlink",
            h.signed("alice.near", &challenge, &painting_key),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(h.linked_chat("alice.near").await, Some(CHAT));

    // The owner's signature unlinks, once.
    let body = h.signed("alice.near", &challenge, &alice);
    let (status, answer) = h.post("/api/telegram/unlink", body.clone()).await;
    assert_eq!(
        (status, answer),
        (StatusCode::OK, json!({"status": "unlinked"}))
    );
    assert_eq!(h.linked_chat("alice.near").await, None);
    assert_eq!(
        telegram::accounts_of(&mut h.con, CHAT).await.unwrap().len(),
        0
    );
    assert_eq!(
        telegram::alert_state(&mut h.con, "alice.near")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        h.post("/api/telegram/unlink", body).await.0,
        StatusCode::GONE
    );
    // The browser's token died with the link.
    let (status, _) = h
        .post(
            "/api/telegram/status",
            json!({"account": "alice.near", "token": token}),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn nobody_learns_whether_an_account_is_linked_without_its_token() {
    let Some(mut h) = harness().await else { return };
    let token = h.link("alice.near", &key(1), CHAT).await;
    let bob_token = h.link("bob.near", &key(2), 77).await;

    // The same answer for a linked account and one that has never been seen.
    let mut answers = Vec::new();
    for account in ["alice.near", "nobody.near"] {
        for token in ["", "guess", bob_token.as_str()] {
            answers.push(
                h.post(
                    "/api/telegram/status",
                    json!({"account": account, "token": token}),
                )
                .await,
            );
        }
    }
    assert!(
        answers
            .iter()
            .all(|a| *a == (StatusCode::UNAUTHORIZED, json!({"error": "unknown token"}))),
        "{answers:?}"
    );
    // A challenge reads nothing about the account either: same shape, same status.
    for account in ["alice.near", "nobody.near"] {
        for action in ["link", "unlink"] {
            let body = h.challenge(account, action).await;
            let mut fields: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
            fields.sort();
            assert_eq!(
                fields,
                ["code", "expires_at_ms", "message", "nonce", "recipient"]
            );
        }
    }
    // The owner's token still works, and no answer anywhere carries the chat id.
    let (status, body) = h
        .post(
            "/api/telegram/status",
            json!({"account": "alice.near", "token": token}),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({"linked": true})));
    // Only the token's hash is stored.
    let stored: Vec<String> = h
        .con
        .smembers(format!("{}alice.near", keys::TELEGRAM_TOKENS_PREFIX))
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_ne!(stored[0], token);
}

#[tokio::test]
async fn an_rpc_outage_is_a_503_that_leaves_the_code_usable() {
    let Some(mut h) = harness().await else { return };
    let alice = key(1);
    h.chain.set("alice.near", &alice, KeyPermission::FullAccess);
    let challenge = h.challenge("alice.near", "link").await;
    let body = h.signed("alice.near", &challenge, &alice);
    *h.chain.down.lock().unwrap() = true;
    assert_eq!(
        h.post("/api/telegram/link", body.clone()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(h.linked_chat("alice.near").await, None);
    *h.chain.down.lock().unwrap() = false;
    assert_eq!(h.post("/api/telegram/link", body).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_routes_are_rate_limited_and_bad_input_is_a_400() {
    let Some(h) = harness().await else { return };
    for (body, why) in [
        (
            json!({"account": "covers:alice", "action": "link"}),
            "account",
        ),
        (json!({"account": "alice.near", "action": "peek"}), "action"),
        (json!({}), "empty"),
    ] {
        let (status, _) = h.post("/api/telegram/challenge", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}");
    }
    let mut last = StatusCode::OK;
    for _ in 0..telegram_api::WRITES_PER_CLIENT {
        last = h
            .post(
                "/api/telegram/challenge",
                json!({"account": "alice.near", "action": "link"}),
            )
            .await
            .0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}
