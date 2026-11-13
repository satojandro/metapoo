//! Pulls Meta Poo board events out of NEAR Data blocks. Port of Berry Fast's
//! `backend/indexer/src/processor.rs`; the one real change is what it reads (spec §3): the
//! board's `EVENT_JSON` log from a successful outcome executed by the board, not the call args.

use common::{parse_log, ParseOutcome, QueuedEvent};
use fastnear_primitives::block_with_tx_hash::BlockWithTxHashes;
use fastnear_primitives::near_primitives::views::ExecutionStatusView;

pub mod backfill;
pub mod txindex;

/// Board events in `block`, in chain order: shard order, then outcome order, then log order.
/// Also returns warnings for logs that claim to be `mpoo_board` but do not parse.
pub fn extract_events(block: &BlockWithTxHashes, board: &str) -> (Vec<QueuedEvent>, Vec<String>) {
    let block_height = block.block.header.height;
    let block_timestamp_ms = block.block.header.timestamp_nanosec / 1_000_000;
    let mut events = Vec::new();
    let mut warnings = Vec::new();
    let mut seq: u32 = 0;

    for shard in &block.shards {
        for outcome in &shard.receipt_execution_outcomes {
            let execution = &outcome.execution_outcome.outcome;
            // Only the board's own execution. Any contract can log text shaped like our event.
            if outcome.receipt.receiver_id.as_str() != board
                || execution.executor_id.as_str() != board
            {
                continue;
            }
            // A failed receipt rolled its writes back; whatever it logged was not stored.
            if !matches!(
                execution.status,
                ExecutionStatusView::SuccessValue(_) | ExecutionStatusView::SuccessReceiptId(_)
            ) {
                continue;
            }
            for line in &execution.logs {
                match parse_log(line) {
                    ParseOutcome::Skip => {}
                    ParseOutcome::Malformed(why) => warnings.push(format!(
                        "block {block_height} receipt {}: {why}",
                        outcome.execution_outcome.id
                    )),
                    ParseOutcome::Event(event) => {
                        events.push(QueuedEvent {
                            block_height,
                            block_timestamp_ms,
                            seq,
                            receipt_id: outcome.execution_outcome.id.to_string(),
                            predecessor_id: outcome.receipt.predecessor_id.to_string(),
                            event,
                        });
                        seq += 1;
                    }
                }
            }
        }
    }
    (events, warnings)
}
