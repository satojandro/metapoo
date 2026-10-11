/**
 * Seam between the page and the NEAR game contract.
 *
 * Overwrite policy: Open wall (accepted in docs/00-shared-decisions.md).
 */

/** How wide the wall is, in pixels. Column 0 is the left edge. */
export const BOARD_WIDTH = 128;

/** How tall the wall is, in pixels. Row 0 is the top edge. */
export const BOARD_HEIGHT = 128;

/**
 * Where this board thinks it is running.
 * "mock" is practice data in the browser. It is not a NEAR network.
 */
export type NetworkId = "mock" | "localnet" | "testnet" | "mainnet";

export const NETWORK_LABEL: Record<NetworkId, string> = {
  mock: "mock (practice only, not a NEAR network)",
  localnet: "localnet (a NEAR network on this computer)",
  testnet: "testnet",
  mainnet: "mainnet",
};

/**
 * Who is allowed to paint over a pixel.
 * `open_wall` is the accepted product rule.
 * `unresolved` remains only so old blockers can still be named in tests.
 */
export type OverwritePolicy = "open_wall" | "unresolved";

/** One named paint color. The contract stores `index`, not the hex. */
export interface PaletteColor {
  index: number;
  name: string;
  /** Browser-only paint. People also see `name`, so color is not the only signal. */
  hex: string;
}

/** What the page knows about one pixel. `null` means "no successful write yet". */
export interface PixelView {
  x: number;
  y: number;
  colorIndex: number | null;
  /** Latest successful writer. Credit on the wall, not legal ownership of art. */
  artistAccountId: string | null;
  /**
   * NEAR block time in nanoseconds, as digits in a string.
   * A JavaScript number cannot safely hold every nanosecond value.
   */
  lastWriteTimestampNs: string | null;
}

/**
 * One page from the contract `get_pixels` view (after mapping to page types).
 * Only currently painted cells appear; overwrites keep a single latest entry.
 */
export interface PixelsPageView {
  pixels: PixelView[];
  fromIndex: number;
  limit: number;
  total: number;
  /** Next `from_index` for the contract, or null when finished. */
  nextFromIndex: number | null;
}

export interface BoardMetadata {
  width: number;
  height: number;
  paletteSize: number;
  networkId: NetworkId;
  /** Account id of the game contract. Null until one is deployed. */
  contractId: string | null;
  /**
   * Gas sponsorship stays off. The only legal value is false, so turning it
   * on requires a deliberate type change after the security review.
   */
  sponsorshipEnabled: false;
  overwritePolicy: OverwritePolicy;
}

/** The one drawing action. One pixel, one palette index. */
export interface DrawRequest {
  x: number;
  y: number;
  colorIndex: number;
}

export type DrawErrorCode =
  | "COORDINATE_OUT_OF_RANGE"
  | "COLOR_OUT_OF_RANGE"
  | "OWNERSHIP_RULE_UNRESOLVED"
  | "WALLET_NOT_CONNECTED"
  | "NETWORK_MISMATCH"
  | "CONTRACT_NOT_CONFIGURED";

/** A problem explained in a sentence a visitor can read. */
export interface DrawError {
  code: DrawErrorCode;
  message: string;
}

/**
 * Results of a draw attempt. `success` requires an observed transaction
 * and a fresh board read. Do not invent a success in the browser alone.
 */
export type DrawResult =
  | { status: "rejected"; error: DrawError; transactionId: null }
  | { status: "pending"; transactionId: string }
  | {
      status: "success";
      transactionId: string;
      pixel: PixelView;
    }
  | { status: "failed"; transactionId: string | null; error: DrawError };

export interface WalletSession {
  connected: boolean;
  /** A practice label, or later a real NEAR account id. */
  accountId: string | null;
  networkId: NetworkId;
}
