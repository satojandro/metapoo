/**
 * Snapshot registry and numbered print editions.
 * Public series and bounty collector series are separate; public mint must
 * never consume a bounty entitlement.
 */

import type { CropRect } from "./bounties.ts";
import type { SnapshotManifest } from "./history.ts";

export type PrintSeriesKind = "public" | "bounty";

export interface PrintArtwork {
  printId: string;
  snapshotId: string;
  stateHash: string;
  crop: CropRect;
  manifest: SnapshotManifest;
}

export interface PrintEdition {
  tokenId: string;
  printId: string;
  seriesId: string;
  seriesKind: PrintSeriesKind;
  editionNumber: number;
  mintRecipient: string;
  currentOwner: string | null;
  ownerSourceFreshness: "confirmed" | "stale" | "unknown";
  operationId: string;
  mintedAtNs: string;
  sourceBountyId: string | null;
}

export type PrintOperationStatus =
  | "pending"
  | "querying_entitlement"
  | "minted"
  | "failed"
  | "conflict";

export interface PrintOperation {
  caller: string;
  operationId: string;
  status: PrintOperationStatus;
  printId: string | null;
  tokenId: string | null;
  seriesId: string | null;
  editionNumber: number | null;
  errorCode: string | null;
}

export interface MintPrintArgs {
  snapshotId: string;
  crop: CropRect;
  recipient: string;
  operationId: string;
}

export interface MintBountyPrintArgs {
  bountyContract: string;
  bountyId: string;
  operationId: string;
}

/** Proposed R1 public series cap; launch may reconfigure before create. */
export const PUBLIC_SERIES_ID = "public-v1";
export const PROPOSED_PUBLIC_SERIES_CAP = 100;

/**
 * Domain prefix for bounty series id hashing (see history-and-prints.md).
 * Actual series_id = "bounty-" + hex(SHA256(domain || genesis || escrow || bountyId)).
 */
export const BOUNTY_SERIES_DOMAIN = "MPOO_BOUNTY_SERIES_V1";

export function printTokenId(
  printId: string,
  seriesId: string,
  editionNumber: number,
): string {
  return `${printId}:${seriesId}:${editionNumber}`;
}
