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

