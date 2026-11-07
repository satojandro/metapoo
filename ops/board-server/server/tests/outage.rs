//! A Valkey outage in the middle of a run: the consumer must pick up again by itself once
//! Valkey is back, with no restart of the server.
//!
//! Starts and SIGKILLs its own Valkey on a free port of its own (not `TEST_VALKEY_URL`): a
//! `valkey-server` / `redis-server` on PATH, else a `valkey/valkey:8` container through Docker.
//! With neither it is skipped, unless `REQUIRE_OUTAGE_TEST` is set (CI sets it), in which
//! case it fails rather than pass without having run.

use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{keys, BoardEvent, BoardState, DrawEntry, QueuedEvent};
use redis::AsyncCommands;
use server::consumer::{self, Health};
use tokio::sync::{broadcast, RwLock};

#[derive(Clone, Copy)]
enum Backend {
    Binary(&'static str),
    Docker,
}

fn runs(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn backend() -> Option<Backend> {
    if let Some(bin) = ["valkey-server", "redis-server"]
        .into_iter()
        .find(|bin| runs(bin, &["--version"]))
    {
        return Some(Backend::Binary(bin));
    }
    runs("docker", &["info"]).then_some(Backend::Docker)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

enum Valkey {
    Process(Child),
    Container(String),
}

impl Valkey {
    fn start(backend: Backend, port: u16) -> Self {
        let valkey = match backend {
            Backend::Binary(bin) => Valkey::Process(
                Command::new(bin)
                    .args([
                        "--port",
                        &port.to_string(),
                        "--save",
                        "",
                        "--appendonly",
                        "no",
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            ),
            Backend::Docker => {
                let out = Command::new("docker")
                    .args(["run", "-d", "--rm", "-p"])
                    .arg(format!("127.0.0.1:{port}:6379"))
                    .args(["valkey/valkey:8", "valkey-server", "--save", ""])
                    .output()
                    .unwrap();
                assert!(out.status.success(), "docker run: {out:?}");
                Valkey::Container(String::from_utf8(out.stdout).unwrap().trim().to_string())
            }
        };
        // Up means it answers PING, not just that the port is open (Docker's proxy accepts early).
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let pong = redis::Client::open(format!("redis://127.0.0.1:{port}"))
                .and_then(|c| c.get_connection())
                .and_then(|mut c| redis::cmd("PING").query::<String>(&mut c));
            if pong.is_ok() {
                return valkey;
            }
            assert!(Instant::now() < deadline, "Valkey did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// SIGKILL: the worst case, no goodbye on the socket.
    fn kill(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        match self {
            Valkey::Process(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Valkey::Container(id) => {
                let _ = runs("docker", &["kill", id]);
            }
        }
    }
}

impl Drop for Valkey {
    fn drop(&mut self) {
        self.stop();
    }
}

fn draw(block_height: u64, x: u32) -> String {
    serde_json::to_string(&QueuedEvent {
        block_height,
        block_timestamp_ms: block_height * 1000,
        seq: 0,
        receipt_id: format!("r{block_height}"),
        predecessor_id: "alice.near".into(),
        event: BoardEvent::Draw {
            method: "draw".into(),
            entries: vec![DrawEntry {
                x,
                y: 0,
                color: 1,
                artist: Some("alice.near".into()),
                written_at_ns: Some(block_height),
                credits: 1,
                free: false,
            }],
        },
    })
    .unwrap()
}

/// Push with a fresh client of its own, retrying while Valkey comes up.
async fn push(url: &str, raw: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let attempt = async {
            let mut con = redis::Client::open(url)?
                .get_multiplexed_async_connection()
                .await?;
            con.lpush::<_, _, ()>(keys::DRAW_QUEUE, raw).await
        };
        match attempt.await {
            Ok(()) => return,
            Err(e) => {
                assert!(Instant::now() < deadline, "push failed: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn wait_for(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_consumer_resumes_by_itself_after_valkey_comes_back() {
    let Some(backend) = backend() else {
        assert!(
            std::env::var_os("REQUIRE_OUTAGE_TEST").is_none(),
            "REQUIRE_OUTAGE_TEST is set but there is no valkey-server, redis-server or docker"
        );
        eprintln!("skipped: no valkey-server, redis-server or docker");
        return;
    };
    let port = free_port();
    let url = format!("redis://127.0.0.1:{port}");
    let valkey = Valkey::start(backend, port);

    let con = server::valkey::connect(&url).await.unwrap();
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    let (tx, _rx) = broadcast::channel(16);
    let health = Health::default();
    tokio::spawn(consumer::run(
        con,
        state.clone(),
        tx,
        7_200_000,
        health.clone(),
    ));

    push(&url, &draw(100, 1)).await;
    let s = state.clone();
    wait_for("the first event", Duration::from_secs(5), move || {
        s.try_read()
            .is_ok_and(|b| b.pixel(1, 0).is_some_and(|p| !p.is_empty()))
    })
    .await;

    // Outage: long enough for the consumer to notice and fail at least once.
    valkey.kill();
    let h = health.clone();
    wait_for(
        "the consumer to see the outage",
        Duration::from_secs(10),
        move || h.snapshot().failures > 0,
    )
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Valkey is back (empty: it kept nothing). A new event must be applied without a restart.
    let _valkey = Valkey::start(backend, port);
    push(&url, &draw(101, 2)).await;
    let s = state.clone();
    wait_for(
        "the first event after the outage",
        Duration::from_secs(20),
        move || {
            s.try_read()
                .is_ok_and(|b| b.pixel(2, 0).is_some_and(|p| !p.is_empty()))
        },
    )
    .await;
    let h = health.clone();
    wait_for("health to clear", Duration::from_secs(5), move || {
        consumer::status(consumer::now_ms(), h.snapshot()) == "ok"
    })
    .await;
}
