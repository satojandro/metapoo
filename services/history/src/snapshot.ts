/**
 * Canonical state + snapshot encoding using shared/history encoders.
 * Do not invent alternate identity layouts.
 */

import {
  encodeAbsentCell,
  encodeCanonicalStateBytes,
  encodePresentCell,
  encodeSnapshotIdentityBytes,
} from "../../../shared/history/encode.ts";
import type { SnapshotManifest } from "../../../shared/protocol/history.ts";
import { cellIndex } from "./board-state.ts";
import { bytesToHex, sha256Hex } from "./hash.ts";
import { reconstructRevision } from "./reconstruct.ts";
import type { HistoryStore } from "./store.ts";
import type { PixelMap } from "./types.ts";

export interface EncodedState {
  stateBytes: Uint8Array;
  stateHash: string;
}

export interface EncodedSnapshot {
  snapshotBytes: Uint8Array;
  snapshotId: string;
  stateHash: string;
  revision: string;
  receiptId: string;
  finalizedBlockHash: string;
  finalizedBlockHeight: string;
  finalizedBlockTimestampNs: string;
}

export function encodePixelsAsState(
  store: HistoryStore,
  pixels: PixelMap,
): EncodedState {
  const { geometry } = store.baseline;
  const cells: Uint8Array[] = [];
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      const cell = pixels.get(cellIndex(x, y, geometry.width));
      if (!cell) {
        cells.push(encodeAbsentCell());
      } else {
        cells.push(
          encodePresentCell(cell.color, cell.artist, cell.writtenAtNs),
        );
      }
    }
  }
  const stateBytes = encodeCanonicalStateBytes({
    chainGenesisHash: geometry.chainGenesisHash,
    boardAccountId: store.baseline.board.boardAccountId,
    boardEpoch: store.baseline.board.boardEpoch,
    width: geometry.width,
    height: geometry.height,
    paletteVersion: geometry.paletteVersion,
    palette: geometry.palette,
    emptyRgba: geometry.emptyRgba,
    cells,
  });
  return { stateBytes, stateHash: sha256Hex(stateBytes) };
}

/**
 * Encode snapshot identity for a covered revision.
 * Intermediate revisions use the event's receipt/block even if later events
 * share the same block.
 */
export function encodeSnapshotAtRevision(
  store: HistoryStore,
  revision: string,
): EncodedSnapshot {
  const rebuilt = reconstructRevision(store, revision);
  const { stateHash, stateBytes: _ } = encodePixelsAsState(store, rebuilt.pixels);

  let receiptId = "";
  let finalizedBlockHash = store.baseline.finalizedBlockHash;
  let finalizedBlockHeight = store.baseline.finalizedBlockHeight;
  let finalizedBlockTimestampNs = store.baseline.finalizedBlockTimestampNs;

  if (revision !== "0") {
    const event = store.getEventByRevision(revision);
    if (!event) {
      throw new RangeError(`no event for revision ${revision}`);
    }
    receiptId = event.receiptId;
    finalizedBlockHash = event.blockHash;
    finalizedBlockHeight = event.blockHeight;
    finalizedBlockTimestampNs = event.blockTimestampNs;
  }

  const snapshotBytes = encodeSnapshotIdentityBytes({
    stateHashHex: stateHash,
    finalizedBlockHash,
    blockHeight: finalizedBlockHeight,
    blockTimestampNs: finalizedBlockTimestampNs,
    revision,
    receiptId,
  });

  return {
    snapshotBytes,
    snapshotId: sha256Hex(snapshotBytes),
    stateHash,
    revision,
    receiptId,
    finalizedBlockHash,
    finalizedBlockHeight,
    finalizedBlockTimestampNs,
  };
}

export function buildSnapshotManifest(
  store: HistoryStore,
  revision: string,
  opts: {
    attesterAccountId: string;
    manifestUri: string;
    mediaHash?: string | null;
  },
): SnapshotManifest & { stateBytesHex: string; snapshotBytesHex: string } {
  const encoded = encodeSnapshotAtRevision(store, revision);
  const rebuilt = reconstructRevision(store, revision);
  const { stateBytes } = encodePixelsAsState(store, rebuilt.pixels);
  const manifestBody = {
    snapshotId: encoded.snapshotId,
    stateHash: encoded.stateHash,
    board: { ...store.baseline.board },
    width: store.width,
    height: store.height,
    paletteVersion: store.baseline.geometry.paletteVersion,
    finalizedBlockHash: encoded.finalizedBlockHash,
    finalizedBlockHeight: encoded.finalizedBlockHeight,
    finalizedBlockTimestampNs: encoded.finalizedBlockTimestampNs,
    revision: encoded.revision,
    receiptId: encoded.receiptId,
    manifestUri: opts.manifestUri,
    attesterAccountId: opts.attesterAccountId,
    mediaHash: opts.mediaHash ?? null,
  };
  // manifestHash commits to the registered identity fields (not URI circular).
  const manifestHashPayload = new TextEncoder().encode(
    JSON.stringify({
      snapshotId: manifestBody.snapshotId,
      stateHash: manifestBody.stateHash,
      board: manifestBody.board,
      width: manifestBody.width,
      height: manifestBody.height,
      revision: manifestBody.revision,
      finalizedBlockHash: manifestBody.finalizedBlockHash,
    }),
  );
  const manifestHash = sha256Hex(manifestHashPayload);

  return {
    ...manifestBody,
    manifestHash,
    stateBytesHex: bytesToHex(stateBytes),
    snapshotBytesHex: bytesToHex(encoded.snapshotBytes),
  };
}
