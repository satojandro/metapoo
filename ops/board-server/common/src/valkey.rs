//! How the server and the indexer connect to Valkey.
//!
//! A `ConnectionManager` reconnects in the background, but with its defaults it has **no
//! timeouts**. When Valkey dies mid-command (SIGKILL, a host gone, a dropped NAT entry), the
//! command already in flight waits forever. The consumer is a single loop, so that one wait
//! froze the mirror for good: Valkey came back, and nothing was ever applied again
//! (`tests/outage.rs`, red before this). Bounding every reply and every connect attempt turns a
//! hang into an error. The consumer then retries, and the manager reconnects.

use std::time::Duration;

use redis::aio::{ConnectionManager, ConnectionManagerConfig};

/// The longest any one command may wait for its reply. Real replies take milliseconds, and the
/// largest write is a ~230 KB pipeline. Five seconds is far above that and still short enough
/// that an outage shows in `/api/health` within one consumer backoff step.
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

/// The longest one connect attempt may take.
pub const CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);

/// Longest wait between reconnect attempts, in ms.
pub const MAX_RECONNECT_DELAY_MS: u64 = 1_000;

pub fn config() -> ConnectionManagerConfig {
    ConnectionManagerConfig::new()
        .set_response_timeout(RESPONSE_TIMEOUT)
        .set_connection_timeout(CONNECTION_TIMEOUT)
        // redis 0.27's backoff multiplies each delay by `factor`, default **100**: 1 s, then
        // 100 s capped at 60 s, for six tries. Every command queues behind that reconnect, so
        // one outage blocked the consumer for minutes after Valkey was back (measured: back at
        // 155 s, first reply at 212 s). Double each delay instead, cap it at a second, and give
        // up after a few tries: the next command starts a fresh reconnect.
        .set_factor(2)
        .set_max_delay(MAX_RECONNECT_DELAY_MS)
        .set_number_of_retries(3)
}

/// Open the shared connection.
pub async fn connect(url: &str) -> redis::RedisResult<ConnectionManager> {
    redis::Client::open(url)?
        .get_connection_manager_with_config(config())
        .await
}
