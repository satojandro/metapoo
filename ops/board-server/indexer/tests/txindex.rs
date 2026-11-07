//! The transaction-index source against real index items from mainnet (fixture captured
//! 7 Nov from `tx.main.fastnear.com/v0/transactions`):
//! - `3JsRFfF4…`: a `draw_many` of one tile (55,26) by misfits-validator.near, executed at 223461199;
//! - `3DMmDAEG…`: a `claim_toilet`; the board's receipt logs a non-board event.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use common::BoardEvent;
use indexer::txindex::{events_from_tx, AccountPage, AccountRow, Cursor, TxIndex};
use serde_json::Value;

const BOARD: &str = "fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e";
const DRAW: &str = "3JsRFfF4DaNWKrwE9mYW2gver9XFyLE839RE2YcQUfhc";
const CLAIM: &str = "3DMmDAEGoDnrYnpFAuJABA5FPqwhriXEq8n35dbKrzop";

fn items() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/txindex-draw-and-claim.json")).unwrap()
}

fn item(hash: &str) -> Value {
    items()
        .into_iter()
        .find(|t| t["transaction"]["hash"] == hash)
        .unwrap()
}

#[test]
fn reads_a_real_draw_many_from_the_index() {
    let (events, warnings) = events_from_tx(&item(DRAW), BOARD);
    assert!(warnings.is_empty());
    let events = events.expect("final");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].block_height, 223_461_199);
    assert_eq!(events[0].predecessor_id, "misfits-validator.near");
    let BoardEvent::Draw { method, entries } = &events[0].event else {
        panic!()
    };
    assert_eq!(method, "draw_many");
    assert_eq!((entries[0].x, entries[0].y, entries[0].color), (55, 26, 13));
}

#[test]
fn a_claim_has_no_board_events() {
    assert_eq!(events_from_tx(&item(CLAIM), BOARD).0, Some(vec![]));
}

#[test]
fn another_board_failed_receipts_and_unfinished_txs_yield_nothing() {
    assert_eq!(events_from_tx(&item(DRAW), "other.near").0, Some(vec![]));

    let mut failed = item(DRAW);
    failed["receipts"][0]["execution_outcome"]["outcome"]["status"] =
        serde_json::json!({ "Failure": { "ActionError": {} } });
    assert_eq!(events_from_tx(&failed, BOARD).0, Some(vec![]));

    // The receipt the transaction created has not executed yet.
    let mut running = item(DRAW);
    running["receipts"] = serde_json::json!([]);
    assert_eq!(events_from_tx(&running, BOARD).0, None);
}

/// A scripted index: a head, rows (newest first), and items. Counts requests.
struct Fake {
    head: Mutex<u64>,
    rows: Mutex<Vec<AccountRow>>,
    items: Mutex<Vec<Value>>,
    requests: AtomicU32,
}

impl Fake {
    fn new(head: u64, rows: Vec<(&str, u64)>, items: Vec<Value>) -> Self {
        Fake {
            head: Mutex::new(head),
            rows: Mutex::new(
                rows.into_iter()
                    .map(|(h, b)| AccountRow {
                        hash: h.into(),
                        tx_block_height: b,
                    })
                    .collect(),
            ),
            items: Mutex::new(items),
            requests: AtomicU32::new(0),
        }
    }
}

impl TxIndex for Fake {
    async fn head(&self) -> anyhow::Result<u64> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        Ok(*self.head.lock().unwrap())
    }
    async fn account(&self, limit: usize, _resume: Option<&str>) -> anyhow::Result<AccountPage> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let rows = self.rows.lock().unwrap();
        Ok(AccountPage {
            rows: rows.iter().take(limit).cloned().collect(),
            txs_count: Some(rows.len() as u64),
            resume_token: None,
        })
    }
    async fn transactions(&self, hashes: &[String]) -> anyhow::Result<Vec<Value>> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let items = self.items.lock().unwrap();
        Ok(items
            .iter()
            .filter(|t| {
                hashes
                    .iter()
                    .any(|h| t["transaction"]["hash"] == h.as_str())
            })
            .cloned()
            .collect())
    }
}

#[tokio::test]
async fn cold_start_queues_history_then_an_idle_board_costs_two_requests_a_poll() {
    let index = Fake::new(
        223_516_000,
        vec![(CLAIM, 223_461_700), (DRAW, 223_461_198)],
        items(),
    );
    let mut cursor = Cursor::new(223_113_575);

    let first = cursor.poll(BOARD, &index).await.unwrap();
    assert_eq!(first.events.len(), 1, "the one draw, not the claim");
    assert_eq!(first.watermark, 223_516_000);
    // head + count probe + one listing page + one batch of two transactions.
    assert_eq!(first.requests, 4);

    // Nothing new: the watermark follows the head, nothing is queued, two requests.
    *index.head.lock().unwrap() = 223_516_050;
    let idle = cursor.poll(BOARD, &index).await.unwrap();
    assert!(idle.events.is_empty());
    assert_eq!(idle.watermark, 223_516_050);
    assert_eq!(idle.requests, 2);
}

#[tokio::test]
async fn an_unfinished_transaction_holds_the_watermark_below_it_and_is_queued_once_final() {
    let mut running = item(DRAW);
    let finished = running.clone();
    running["receipts"] = serde_json::json!([]);
    let index = Fake::new(223_461_300, vec![(DRAW, 223_461_198)], vec![running]);
    let mut cursor = Cursor::new(223_461_000);

    let waiting = cursor.poll(BOARD, &index).await.unwrap();
    assert!(waiting.events.is_empty());
    assert_eq!(
        waiting.watermark, 223_461_197,
        "held just below the unfinished transaction"
    );

    // It finishes; the same listing is re-read (nothing pending is trusted) and it is queued.
    *index.items.lock().unwrap() = vec![finished];
    let done = cursor.poll(BOARD, &index).await.unwrap();
    assert_eq!(done.events.len(), 1);
    assert_eq!(done.events[0].block_height, 223_461_199);
    assert_eq!(done.watermark, 223_461_300);

    // And it is never queued again.
    *index.head.lock().unwrap() = 223_461_400;
    index.rows.lock().unwrap().insert(
        0,
        AccountRow {
            hash: CLAIM.into(),
            tx_block_height: 223_461_350,
        },
    );
    *index.items.lock().unwrap() = items();
    let later = cursor.poll(BOARD, &index).await.unwrap();
    assert!(later.events.is_empty(), "{:?}", later.events);
}

#[tokio::test]
async fn a_transaction_listed_above_the_head_waits_for_the_next_poll() {
    let index = Fake::new(223_461_100, vec![(DRAW, 223_461_198)], items());
    let mut cursor = Cursor::new(223_461_000);
    let early = cursor.poll(BOARD, &index).await.unwrap();
    assert!(early.events.is_empty());
    assert_eq!(early.watermark, 223_461_100);

    *index.head.lock().unwrap() = 223_461_250;
    let caught = cursor.poll(BOARD, &index).await.unwrap();
    assert_eq!(caught.events.len(), 1);
}
