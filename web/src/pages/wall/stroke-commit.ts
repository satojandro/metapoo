import { chunkCells, MAX_STROKE_CELLS, type StrokeState } from "./stroke-paint";
import type { LocalStrokeResult } from "../../local-draw";

export function planStrokeCommit(stroke: StrokeState, sessionActive: boolean) {
  if (!sessionActive) return { kind: "wallet_approval" as const };
  if (stroke.cells.length === 1) return { kind: "draw" as const, cell: stroke.cells[0] };
  return { kind: "draw_many" as const, chunks: chunkCells(stroke.cells) };
}

export const WALLET_STROKE_COPY = "Authorize a drawing session for drag painting, or select a cell and use Paint this tile with wallet approval.";
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
  // Asked last: the toggle is only shown once a drawing key exists, so naming it
  // before the missing wallet, colour or approval pointed at a control nobody could see.
  if (!gate.directPaint) {
    return "Dragging moves the board. Tick \"Drag to paint strokes\" in the dock to paint with a drag.";
  }
  if (gate.drawInFlight || gate.queueBusy) {
    return "Paint still confirming — drag painting resumes when it lands.";
  }
  return null;
}

/**
 * What happened to a stroke, batch by batch. Batches are sent together, so a
 * failure in the middle does not stop the ones after it: name each one that did
 * not confirm instead of assuming everything after it was skipped.
 */
export function strokeResultCopy(stroke: StrokeState, result: LocalStrokeResult): string {
  let text: string;
  if (result.status === "confirmed") {
    text = `${result.confirmedChunks} of ${result.totalChunks} batches confirmed. Each batch records one artist and one timestamp for its cells.`;
  } else {
    const parts = [`${result.confirmedChunks} of ${result.totalChunks} batches confirmed.`];
    const notSent: number[] = [];
    let notSentReason: string | null = null;
    for (const chunk of result.chunks) {
      const label = `Batch ${chunk.index + 1}`;
      const detail = chunk.message ? ` ${sentence(chunk.message)}` : "";
      if (chunk.state === "failed") parts.push(`${label} was not painted.${detail}`);
      else if (chunk.state === "uncertain") parts.push(`${label} may already have been broadcast.${detail}`);
      else if (chunk.state === "not_sent") {
        notSent.push(chunk.index + 1);
        notSentReason ??= chunk.message;
      }
    }
    if (notSent.length) {
      const which = notSent.length === 1 ? `Batch ${notSent[0]} was` : `Batches ${notSent.join(", ")} were`;
      parts.push(`${which} not sent.${notSentReason ? ` ${sentence(notSentReason)}` : ""}`);
    }
    parts.push("No automatic retry.");
    text = parts.join(" ");
  }
  return stroke.truncated ? `${text} ${TRUNCATED_STROKE_COPY}` : text;
}

/** A chain or node message as one sentence, so the copy after it does not run on. */
function sentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
