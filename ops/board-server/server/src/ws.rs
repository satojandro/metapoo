//! WebSocket: every applied event is pushed to every socket; `catch_up` replays the stored
//! history since a timestamp. Port of Berry Fast's `server/src/ws.rs`.

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use redis::AsyncCommands;
use tokio::sync::mpsc;

use crate::api::AppState;

/// Catch-up replies are capped so one client cannot make the server send its whole history.
const MAX_CATCH_UP: isize = 5_000;

/// Counts one open socket for as long as it lives, so the indexer knows someone is watching.
struct Viewer(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Viewer {
    /// Count the socket. True when it is the only one: nobody was watching before it.
    fn new(count: &std::sync::Arc<std::sync::atomic::AtomicUsize>) -> (Self, bool) {
        let before = count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        (Viewer(count.clone()), before == 0)
    }
}

/// A viewer came to a server that had none: raise the viewers flag now (the heartbeat would
/// take up to `VIEWER_REFRESH_MS`) and tell the indexer to catch up at once. Without this,
/// the first visitor after a quiet spell met a mirror minutes behind: their wall's first trust
/// check failed and the tab walked the chain (seen in production, 7 Nov).
async fn announce_arrival(mut valkey: redis::aio::ConnectionManager) {
    let now = crate::consumer::now_ms();
    let mut pipe = redis::pipe();
    pipe.set(
        common::keys::VIEWERS_UNTIL_MS,
        now + common::demand::VIEWER_TTL_MS,
    )
    .ignore()
    .set(common::keys::VIEWER_ARRIVED_MS, now)
    .ignore();
    let write = pipe.query_async::<()>(&mut valkey);
    match tokio::time::timeout(std::time::Duration::from_millis(500), write).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("could not announce a viewer: {e}"),
        Err(_) => tracing::warn!("could not announce a viewer: Valkey did not answer"),
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

pub async fn handle_socket(socket: WebSocket, state: AppState) {
    let (_viewer, first) = Viewer::new(&state.viewers);
    if first {
        tokio::spawn(announce_arrival(state.valkey.clone()));
    }
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let mut live = state.broadcast_tx.subscribe();

    let forward_tx = tx.clone();
    let forward = tokio::spawn(async move {
        // A client too slow to keep up (`Lagged`) has a gap: end the socket so it reconnects
        // and catches up from its last timestamp.
        while let Ok(msg) = live.recv().await {
            if forward_tx.send(msg).await.is_err() {
                break;
            }
        }
    });
    let send = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });
    let valkey = state.valkey.clone();
    let recv = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                handle_client_message(&text, valkey.clone(), &tx).await;
            }
        }
    });
    tokio::select! {
        _ = forward => {},
        _ = send => {},
        _ = recv => {},
    }
}

async fn handle_client_message(
    text: &str,
    mut valkey: redis::aio::ConnectionManager,
    sender: &mpsc::Sender<String>,
) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    if msg.get("type").and_then(|t| t.as_str()) != Some("catch_up") {
        return;
    }
    let Some(since) = msg.get("since_timestamp_ms").and_then(|t| t.as_f64()) else {
        return;
    };
    let events: Vec<String> = valkey
        .zrangebyscore_limit(
            common::keys::DRAW_EVENTS_ZSET,
            since as u64,
            "+inf",
            0,
            MAX_CATCH_UP,
        )
        .await
        .unwrap_or_default();
    for event in events {
        // The member carries the position prefix that keeps same-millisecond draws in applied
        // order; the client gets the message itself.
        if sender
            .send(common::catchup_payload(&event).to_owned())
            .await
            .is_err()
        {
            break;
        }
    }
}
