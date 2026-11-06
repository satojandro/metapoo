import { JsonRpcProvider } from "@near-js/providers";
import type { BlockReference, BlockResult } from "@near-js/types";

/**
 * A provider that never signs against an optimistic block.
 *
 * near-api-js takes every transaction's `block_hash` from
 * `viewBlock({ finality: "optimistic" })`. On mainnet that hash can name a block the
 * node which receives the broadcast has not stored yet, and the send comes back
 * `UNKNOWN_BLOCK: DB Not Found Error: BLOCK_HEIGHT: <height>` — after signing, so the
 * paint is left "possibly broadcast" and the wall stops (observed 2026-11-06 on the
 * testing board, `rpc.mainnet.fastnear.com`). A finalized block is always inside the
 * transaction's validity window and always one the answering node already has.
 *
 * Reads keep their own finality: only the block a signature is anchored to is forced.
 */
export class FinalBlockJsonRpcProvider extends JsonRpcProvider {
  override async viewBlock(blockQuery: BlockReference): Promise<BlockResult> {
    const asked = blockQuery as { finality?: string } | null;
    if (asked && asked.finality === "optimistic") {
      return super.viewBlock({ finality: "final" });
    }
    return super.viewBlock(blockQuery);
  }
}

/**
 * A final-block provider that reads the signing block once and reuses it.
 *
 * One stroke signs up to four transactions in a row. Each one used to fetch a fresh
 * final block (~430 ms on FastNEAR) only to take its hash. A finalized hash stays
 * inside a transaction's validity window for many hours, so every chunk of one
 * stroke can share it. Make one instance per stroke and let it go afterwards: the
 * pin must never outlive the gesture it was made for.
 *
 * A failed read is not remembered, so the next chunk asks again.
 */
export class PinnedFinalBlockJsonRpcProvider extends FinalBlockJsonRpcProvider {
  private pinned: Promise<BlockResult> | null = null;

  override async viewBlock(blockQuery: BlockReference): Promise<BlockResult> {
    const asked = blockQuery as { finality?: string } | null;
    if (!asked || (asked.finality !== "optimistic" && asked.finality !== "final")) {
      return super.viewBlock(blockQuery);
    }
    if (!this.pinned) {
      const read = super.viewBlock({ finality: "final" });
      this.pinned = read;
      read.catch(() => {
        if (this.pinned === read) this.pinned = null;
      });
    }
    return this.pinned;
  }
}
