//! The four Bot API calls the bot makes (<https://core.telegram.org/bots/api>, read at Bot
//! API 10.4): `getMe`, `getUpdates`, `sendMessage`, and reading an error answer.

use std::future::Future;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TgError {
    /// 403: the user blocked the bot, or deleted their account. Stop writing to them.
    Forbidden,
    /// 429: wait this many seconds (`parameters.retry_after`).
    RetryAfter(u64),
    /// 409: a webhook is set, or another process is polling with the same token.
    Conflict,
    /// 401 / 404: the token is wrong.
    Unauthorized,
    /// Anything else, including the network. Never contains the token.
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Update {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<Message>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Message {
    pub chat: Chat,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Chat {
    pub id: i64,
    /// "private", "group", "supergroup" or "channel".
    #[serde(rename = "type")]
    pub kind: String,
}

/// A message to send: plain text (no parse mode, so an account id needs no escaping) and at
/// most one URL button under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub text: String,
    pub button: Option<Button>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub text: String,
    pub url: String,
}

impl Outgoing {
    pub fn text(text: impl Into<String>) -> Self {
        Outgoing {
            text: text.into(),
            button: None,
        }
    }

    /// The `sendMessage` body.
    pub fn body(&self, chat: i64) -> Value {
        let mut body = json!({
            "chat_id": chat,
            "text": self.text,
            "link_preview_options": { "is_disabled": true },
        });
        if let Some(button) = &self.button {
            body["reply_markup"] = json!({
                "inline_keyboard": [[{ "text": button.text, "url": button.url }]],
            });
        }
        body
    }
}

pub trait Telegram: Send + Sync {
    /// Updates from `offset` on; waits up to `timeout_s` for the first one.
    fn get_updates(
        &self,
        offset: i64,
        timeout_s: u64,
    ) -> impl Future<Output = Result<Vec<Update>, TgError>> + Send;

    fn send_message(
        &self,
        chat: i64,
        message: &Outgoing,
    ) -> impl Future<Output = Result<(), TgError>> + Send;
}

/// Reads a Bot API answer: `{ok: true, result}` or `{ok: false, error_code, description,
/// parameters?}`.
pub fn parse_response(body: &Value) -> Result<Value, TgError> {
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(body.get("result").cloned().unwrap_or(Value::Null));
    }
    let description = body
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("no description");
    Err(match body.get("error_code").and_then(Value::as_i64) {
        Some(403) => TgError::Forbidden,
        Some(429) => TgError::RetryAfter(
            body.pointer("/parameters/retry_after")
                .and_then(Value::as_u64)
                .unwrap_or(5),
        ),
        Some(409) => TgError::Conflict,
        Some(401 | 404) => TgError::Unauthorized,
        Some(code) => TgError::Other(format!("{code}: {description}")),
        None => TgError::Other("not a Bot API answer".into()),
    })
}

/// The real thing, over HTTPS.
pub struct HttpTelegram {
    base: String,
    http: reqwest::Client,
}

impl HttpTelegram {
    pub fn new(token: &str) -> anyhow::Result<Self> {
        Ok(Self {
            base: format!("https://api.telegram.org/bot{token}"),
            http: reqwest::Client::builder()
                .user_agent("metapoo-telegram-bot")
                .build()?,
        })
    }

    async fn call(&self, method: &str, body: Value, timeout: Duration) -> Result<Value, TgError> {
        // The token is part of the URL, and reqwest puts the URL in its errors: strip it.
        let network = |e: reqwest::Error| TgError::Other(e.without_url().to_string());
        let response = self
            .http
            .post(format!("{}/{method}", self.base))
            .timeout(timeout)
            .json(&body)
            .send()
            .await
            .map_err(network)?;
        // Errors come with a JSON body too, so read it whatever the HTTP status.
        let status = response.status();
        match response.json::<Value>().await {
            Ok(body) => parse_response(&body),
            Err(_) => Err(TgError::Other(format!("HTTP {status}, body not JSON"))),
        }
    }

    /// The bot's own username: proves the token works.
    pub async fn get_me(&self) -> Result<String, TgError> {
        let me = self
            .call("getMe", json!({}), Duration::from_secs(15))
            .await?;
        Ok(me
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string())
    }
}

impl Telegram for HttpTelegram {
    async fn get_updates(&self, offset: i64, timeout_s: u64) -> Result<Vec<Update>, TgError> {
        let result = self
            .call(
                "getUpdates",
                json!({ "offset": offset, "timeout": timeout_s, "allowed_updates": ["message"] }),
                Duration::from_secs(timeout_s + 15),
            )
            .await?;
        // One update this code cannot read must not block the ones after it.
        Ok(result
            .as_array()
            .map(|updates| {
                updates
                    .iter()
                    .filter_map(|u| {
                        serde_json::from_value(u.clone()).ok().or_else(|| {
                            Some(Update {
                                update_id: u.get("update_id")?.as_i64()?,
                                message: None,
                            })
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn send_message(&self, chat: i64, message: &Outgoing) -> Result<(), TgError> {
        self.call("sendMessage", message.body(chat), Duration::from_secs(15))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_answers_are_told_apart() {
        let ok = json!({"ok": true, "result": [{"update_id": 1}]});
        assert_eq!(parse_response(&ok), Ok(json!([{"update_id": 1}])));
        let blocked = json!({"ok": false, "error_code": 403,
            "description": "Forbidden: bot was blocked by the user"});
        assert_eq!(parse_response(&blocked), Err(TgError::Forbidden));
        let flood = json!({"ok": false, "error_code": 429,
            "description": "Too Many Requests: retry after 17",
            "parameters": {"retry_after": 17}});
        assert_eq!(parse_response(&flood), Err(TgError::RetryAfter(17)));
        let conflict = json!({"ok": false, "error_code": 409,
            "description": "Conflict: terminated by other getUpdates request"});
        assert_eq!(parse_response(&conflict), Err(TgError::Conflict));
        let bad_token = json!({"ok": false, "error_code": 401, "description": "Unauthorized"});
        assert_eq!(parse_response(&bad_token), Err(TgError::Unauthorized));
        let bad_request = json!({"ok": false, "error_code": 400,
            "description": "Bad Request: chat not found"});
        assert_eq!(
            parse_response(&bad_request),
            Err(TgError::Other("400: Bad Request: chat not found".into()))
        );
        assert!(matches!(
            parse_response(&json!("<html>")),
            Err(TgError::Other(_))
        ));
    }

    #[test]
    fn a_private_text_update_is_read_and_a_send_body_carries_one_url_button() {
        let update: Update = serde_json::from_value(json!({
            "update_id": 10,
            "message": {"message_id": 5, "date": 1,
                "from": {"id": 42, "is_bot": false, "first_name": "A"},
                "chat": {"id": 42, "type": "private", "first_name": "A"},
                "text": "/start ABCDEFGHJK",
                "entities": [{"type": "bot_command", "offset": 0, "length": 6}]}
        }))
        .unwrap();
        let message = update.message.unwrap();
        assert_eq!(
            (message.chat.id, message.chat.kind.as_str()),
            (42, "private")
        );
        assert_eq!(message.text.as_deref(), Some("/start ABCDEFGHJK"));

        let plain = Outgoing::text("hello").body(42);
        assert_eq!(plain["chat_id"], 42);
        assert!(plain.get("reply_markup").is_none() && plain.get("parse_mode").is_none());
        let with_button = Outgoing {
            text: "hello".into(),
            button: Some(Button {
                text: "Open the wall".into(),
                url: "https://metapoo.example/wall?x=1&y=2&zoom=8".into(),
            }),
        }
        .body(42);
        assert_eq!(
            with_button["reply_markup"]["inline_keyboard"],
            json!([[{"text": "Open the wall", "url": "https://metapoo.example/wall?x=1&y=2&zoom=8"}]])
        );
    }
}
