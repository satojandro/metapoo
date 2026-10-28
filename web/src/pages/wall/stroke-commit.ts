import { chunkCells, MAX_STROKE_CELLS, type StrokeState } from "./stroke-paint";
import type { LocalStrokeResult } from "../../local-draw";

export function planStrokeCommit(stroke: StrokeState, sessionActive: boolean) {
  if (!sessionActive) return { kind: "wallet_approval" as const };
  if (stroke.cells.length === 1) return { kind: "draw" as const, cell: stroke.cells[0] };
  return { kind: "draw_many" as const, chunks: chunkCells(stroke.cells) };
}

export const WALLET_STROKE_COPY = "Authorize a drawing session for drag painting, or select a cell and use Place paint with wallet approval.";
export const TRUNCATED_STROKE_COPY = `Stroke limited to ${MAX_STROKE_CELLS} cells. The rest of the drag was not submitted.`;

/** Everything the pointer gate needs to know, minus the gesture itself. */
export interface StrokeGate {
  directPaint: boolean;
  accountId: string | null;
  colorIndex: number | null;
  contractOk: boolean;
  /** False when a schema-4 price read failed. Free boards leave this true. */
  priceOk: boolean;
  sessionActive: boolean;
  drawInFlight: boolean;
  queueBusy: boolean;
}

/**
 * The single reason drag painting is unavailable, or null when it is available.
 *
 * A drag that silently pans is indistinguishable from painting being broken —
 * that is what the first human test reported. This returns one actionable
 * sentence per missing precondition, ordered so the most likely and most
 * fixable comes first, instead of a single opaque "not available".
 */
export function strokeBlockedReason(gate: StrokeGate): string | null {
  if (!gate.directPaint) {
    return "Direct paint is off, so dragging moves the board. Turn it on in the dock to paint with a drag.";
  }
  if (!gate.accountId) {
    return "Connect a wallet to paint.";
  }
  if (gate.colorIndex === null) {
    return "Pick a colour first — drag painting needs one.";
  }
  if (!gate.contractOk) {
    return "The board's on-chain metadata does not match this page, so painting is disabled. See About / details.";
  }
  if (!gate.priceOk) {
    return "price unavailable. The repaint cost could not be read, so this stroke was not submitted.";
  }
  if (!gate.sessionActive) {
    return "Painting needs one approval first — press Unlock painting in the dock.";
  }
  if (gate.drawInFlight || gate.queueBusy) {
    return "Paint still confirming — drag painting resumes when it lands.";
  }
  return null;
}

export function strokeResultCopy(stroke: StrokeState, result: LocalStrokeResult): string {
  const text = result.status === "confirmed"
    ? `${result.confirmedChunks} of ${result.totalChunks} batches confirmed. Each batch records one artist and one timestamp for its cells.`
    : `${result.confirmedChunks} of ${result.totalChunks} batches confirmed. Batch ${(result.failingChunk?.index ?? result.confirmedChunks) + 1} ${result.failingChunk?.mayHaveBroadcast ? "may already have been broadcast" : "was not broadcast"}. Remaining batches were not submitted. No automatic retry. ${result.failingChunk?.message ?? ""}`;
  return stroke.truncated ? `${text} ${TRUNCATED_STROKE_COPY}` : text;
}
