//! Against a real mainnet block from NEAR Data: block 223113679, which executed the testing
//! board's first paint, `draw(10,10,3)` (tx `r6ug3VMNxUgaF6EgDxsuyXhkXN46drKoRcR7kAEojDM`,
//! docs/payments/mainnet-test-deployment-2026-11-05.md). Trimmed to the board's outcomes.

use common::{BoardEvent, QueuedEvent};
use fastnear_primitives::block_with_tx_hash::BlockWithTxHashes;
use fastnear_primitives::near_primitives::views::ExecutionStatusView;

const BOARD: &str = "fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e";

fn block() -> BlockWithTxHashes {
    serde_json::from_str(include_str!("fixtures/block-223113679-draw.json"))
        .expect("fixture parses")
}

fn only(events: Vec<QueuedEvent>) -> QueuedEvent {
    assert_eq!(events.len(), 1, "{events:?}");
    events.into_iter().next().unwrap()
}

#[test]
fn reads_the_first_mainnet_paint() {
    let (events, warnings) = indexer::extract_events(&block(), BOARD);
    assert!(warnings.is_empty());
    let event = only(events);
    assert_eq!(event.block_height, 223_113_679);
    assert_eq!(
        event.receipt_id,
        "6uNcgehTJ6BGqMXLKCo74k21udpKWeNLKx9y9G2Hx81a"
    );
    let BoardEvent::Draw { method, entries } = event.event else {
        panic!("not a draw")
    };
    assert_eq!(method, "draw");
    assert_eq!(
        (
            entries[0].x,
            entries[0].y,
            entries[0].color,
            entries[0].free
        ),
        (10, 10, 3, true)
    );
    assert_eq!(entries[0].artist.as_deref(), Some(BOARD));
}

#[test]
fn ignores_another_board() {
    let (events, _) = indexer::extract_events(&block(), "someone-else.near");
    assert!(events.is_empty());
}

#[test]
fn ignores_a_failed_outcome() {
    let mut block = block();
    for shard in &mut block.shards {
        for outcome in &mut shard.receipt_execution_outcomes {
            outcome.execution_outcome.outcome.status = ExecutionStatusView::Unknown;
        }
    }
    assert!(indexer::extract_events(&block, BOARD).0.is_empty());
}

#[test]
fn ignores_a_lookalike_event_executed_by_another_contract() {
    let mut block = block();
    for shard in &mut block.shards {
        for outcome in &mut shard.receipt_execution_outcomes {
            outcome.execution_outcome.outcome.executor_id = "fake-board.near".parse().unwrap();
        }
    }
    assert!(indexer::extract_events(&block, BOARD).0.is_empty());
}
