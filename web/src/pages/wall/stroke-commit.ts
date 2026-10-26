import { chunkCells, MAX_STROKE_CELLS, type StrokeState } from "./stroke-paint";
import type { LocalStrokeResult } from "../../local-draw";

export function planStrokeCommit(stroke: StrokeState, sessionActive: boolean) {
  if (!sessionActive) return { kind: "wallet_approval" as const };
  if (stroke.cells.length === 1) return { kind: "draw" as const, cell: stroke.cells[0] };
  return { kind: "draw_many" as const, chunks: chunkCells(stroke.cells) };
}

export const WALLET_STROKE_COPY = "Authorize a drawing session for drag painting, or select a cell and use Place paint with wallet approval.";
export const TRUNCATED_STROKE_COPY = `Stroke limited to ${MAX_STROKE_CELLS} cells. The rest of the drag was not submitted.`;

export function strokeResultCopy(stroke: StrokeState, result: LocalStrokeResult): string {
  const text = result.status === "confirmed"
    ? `${result.confirmedChunks} of ${result.totalChunks} batches confirmed. Each batch records one artist and one timestamp for its cells.`
    : `${result.confirmedChunks} of ${result.totalChunks} batches confirmed. Batch ${(result.failingChunk?.index ?? result.confirmedChunks) + 1} ${result.failingChunk?.mayHaveBroadcast ? "may already have been broadcast" : "was not broadcast"}. Remaining batches were not submitted. No automatic retry. ${result.failingChunk?.message ?? ""}`;
  return stroke.truncated ? `${text} ${TRUNCATED_STROKE_COPY}` : text;
}
