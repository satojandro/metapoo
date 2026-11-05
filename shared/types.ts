/**
 * Seam between the page and the NEAR game contract.
 *
 * Overwrite policy: Open wall (accepted in docs/00-shared-decisions.md).
 *
 * Board geometry and view shapes shared by the free (schema 2) and paid
 * (schema 4) boards. Paid credit and price reads are typed in `web/src`.
 */

/**
 * The largest the square wall can grow to (the paid board's `MAX_SIDE`), and the
 * size of the free board and of paid boards deployed before the wall could grow.
 */
export const MAX_BOARD_SIDE = 128;

/**
 * How wide the wall is, in pixels. Column 0 is the left edge.
 *
 * A live binding, not a constant: a paid board starts at 64 × 64 and the owner can
 * grow it (`expand_board`), so the page takes the size `get_board` reports via
 * `setBoardSide`. Read it at call time; never copy it into a module-level constant.
 */
export let BOARD_WIDTH = MAX_BOARD_SIDE;

/** How tall the wall is, in pixels. Row 0 is the top edge. Live, like `BOARD_WIDTH`. */
export let BOARD_HEIGHT = MAX_BOARD_SIDE;

/** True when `side` is a square size this page can draw: a whole number, 1 through 128. */
export function isValidBoardSide(side: unknown): side is number {
  return Number.isInteger(side) && (side as number) >= 1 && (side as number) <= MAX_BOARD_SIDE;
}

/** Set the square wall size. Returns true when it changed. Ignores invalid sizes. */
export function setBoardSide(side: number): boolean {
  if (!isValidBoardSide(side) || (side === BOARD_WIDTH && side === BOARD_HEIGHT)) return false;
  BOARD_WIDTH = side;
  BOARD_HEIGHT = side;
  return true;
}

/** Every tile the wall holds at its current size. */
export function wallTiles(): number {
  return BOARD_WIDTH * BOARD_HEIGHT;
}

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
