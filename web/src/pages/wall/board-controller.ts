import { PALETTE } from "@shared/palette.ts";
import type { PixelView } from "@shared/types.ts";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixelAtBlock,
  replaceCacheAtBlock,
  type CachedPixel,
} from "../../board-cache";
import {
  beginBoardLoad,
  createBoardSyncState,
  formatFreshness,
  markBoardLoadApplied,
  markBoardLoadFailed,
  nextPollDelayMs,
  shouldApplyBoardLoad,
  shouldPollNow,
  type BoardSyncState,
} from "../../board-sync";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import {
  fetchAllPaintedPixels,
  getBoard,
  getPixelWithBlock,
  isContractConfigured,
} from "../../contract";
import { validateContractMetadata, type ContractMetaIssue } from "../../contract-meta";
import type { Cell } from "../../selection";
import type { SponsorshipStatus } from "../../sponsorship";
import type { WallScope } from "./wall-scope";

export type BoardLoadReason = "manual" | "poll" | "visible" | "reconnect" | "after_draw";

export interface BoardControllerDeps {
  scope: WallScope;
  evidence: HTMLElement;
  contractLine: HTMLElement;
  boardLoadStatus: HTMLElement;
  boardFreshness: HTMLElement;
  refreshButton: HTMLButtonElement;
  sponsorNote: HTMLElement;
  sponsorship: SponsorshipStatus;
  /** A route link already wrote its own status line (`/wall?x=…`). */
  routeFocusesCell: boolean;
  selected(): Cell | null;
  /** Show a titled message in the result block. */
  fillResult(title: string, message: string): void;
  render(): void;
  showSelection(): void;
  updateCompactStatus(): void;
  updateDirectPaintAvailability(): void;
  applyRoutePaintingContext(): void;
  /** Confirmed pixels arrived; clear pending marks they settle. */
  reconcilePending(pixels: PixelView[]): void;
  /** A full snapshot was applied, so cell ages (and quoted prices) moved. */
  onBoardUpdated(): void;
  /** The remembered board schema changed (paid vs free). */
  onSchemaChanged(): void;
  /** Refresh was pressed while metadata is valid. */
  onManualRefresh(): void;
  /**
   * The board's palette size is known: 8 or 16 from a matching `get_board`, or the
   * whole shared palette on the local mock board. Not called when metadata fails.
   */
  onPaletteChanged(paletteLength: number): void;
}

export interface BoardController {
  contractMetaOk(): boolean;
  contractMetaIssue(): ContractMetaIssue | null;
  /** Schema from the last successful get_board. 4 means paid credits. */
  boardSchema(): number | null;
  syncState(): Readonly<BoardSyncState>;
  cachedPixel(cell: Cell): CachedPixel | undefined;
  paintedPixels(): PixelView[];
  rememberPixel(pixel: PixelView, blockHeight: number): void;
  bootstrap(): Promise<void>;
  refreshBoardFromContract(options?: { reason?: BoardLoadReason }): Promise<void>;
  refreshSelectedPixel(cell?: Cell | null): Promise<void>;
  scheduleBoardPoll(): void;
  clearBoardPoll(): void;
  revalidateContractMeta(): Promise<boolean>;
  dispose(): void;
}

/**
 * Board load, polling, freshness and contract metadata. Owns the pixel cache
 * and everything that decides whether the picture is current.
 */
export function createBoardController(deps: BoardControllerDeps): BoardController {
  const {
    scope,
    evidence,
    contractLine,
    boardLoadStatus,
    boardFreshness,
    refreshButton,
    sponsorNote,
    sponsorship,
  } = deps;

  const pixelCache = createPixelCache();
  const boardSync = createBoardSyncState();
  let boardLoadInFlight = false;
  /** False until get_board metadata matches shared constants (or mock mode). */
  let contractMetaOk = !isContractConfigured();
  /** Schema from the last successful get_board. 4 means paid credits. */
  let boardSchema: number | null = null;
  // A failed *read* and a real metadata *mismatch* both leave contractMetaOk
  // false, and the draw path used to report both as "did not match the shared
  // schema". They need different advice: one is "try again", the other is
  // "this contract is not this board".
  let contractMetaIssue: ContractMetaIssue | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const loadAbort: AbortController = new AbortController();

  scope.listen(document, "visibilitychange", () => {
    if (scope.isDisposed()) return;
    if (document.visibilityState === "visible") {
      void refreshBoardFromContract({ reason: "visible" });
      scheduleBoardPoll();
    } else {
      clearBoardPoll();
    }
  });

  scope.listen(window, "online", () => {
    if (scope.isDisposed()) return;
    void refreshBoardFromContract({ reason: "reconnect" });
    scheduleBoardPoll();
  });

  scope.listen(refreshButton, "click", () => {
    // A transient read failure at load used to block drawing until a full page
    // reload, because nothing re-ran the metadata check. Refresh now does.
    if (!contractMetaOk) {
      void revalidateContractMeta();
    } else {
      deps.onManualRefresh();
    }
    void refreshBoardFromContract();
  });

  refreshButton.disabled = !isContractConfigured();
  refreshButton.title = isContractConfigured()
    ? "Reload every painted cell from the contract"
    : "Configure VITE_CONTRACT_ID to load chain state";

  function showBoardFreshness(): void {
    if (boardSync.lastAppliedAtMs === null) {
      boardFreshness.textContent = boardSync.consecutiveFailures > 0
        ? "Couldn't read the wall yet. Retrying."
        : "Reading the wall…";
      return;
    }
    const age = plainAge(Date.now() - boardSync.lastAppliedAtMs);
    boardFreshness.textContent = boardSync.consecutiveFailures > 0
      ? `Wall updated ${age}. The latest refresh failed; retrying.`
      : `Wall updated ${age}`;
  }

  function rememberBoardSchema(schema: number | null): void {
    boardSchema = schema;
    deps.onSchemaChanged();
  }

  /**
   * Re-run the `get_board` comparison after a failed load.
   *
   * The boot path validates metadata once. When that read threw — RPC hiccup, rate
   * limit, offline — drawing stayed disabled until the page was reloaded, and the
   * only explanation offered was a metadata mismatch that never happened. This
   * lets "Refresh board" recover without a reload.
   */
  async function revalidateContractMeta(): Promise<boolean> {
    if (!isContractConfigured()) {
      contractMetaOk = true;
      contractMetaIssue = null;
      rememberBoardSchema(null);
      deps.onPaletteChanged(PALETTE.length);
      deps.updateDirectPaintAvailability();
      return true;
    }
    try {
      const board = await getBoard();
      const meta = validateContractMetadata(board);
      contractMetaOk = meta.ok;
      contractMetaIssue = meta.ok ? null : { kind: "mismatch", detail: meta.message };
      rememberBoardSchema(meta.ok ? board.schema_version : null);
      if (meta.ok) {
        deps.onPaletteChanged(meta.paletteLength);
        contractLine.textContent =
          `Every square is stored on the NEAR ${PAGE_NETWORK} contract ${CONTRACT_ID}. ` +
          `Painting a square replaces the colour that was there, and the contract ` +
          `records which account painted it and when.`;
      } else {
        deps.fillResult(meta.title, meta.message);
      }
      return meta.ok;
    } catch (error) {
      contractMetaOk = false;
      const detail = error instanceof Error ? error.message : "Unknown read error";
      contractMetaIssue = { kind: "read", detail };
      rememberBoardSchema(null);
      return false;
    } finally {
      deps.updateDirectPaintAvailability();
    }
  }

  async function bootstrap(): Promise<void> {
    if (!isContractConfigured()) {
      contractMetaOk = true;
      rememberBoardSchema(null);
      // The local mock board accepts every shared colour.
      deps.onPaletteChanged(PALETTE.length);
      evidence.textContent =
        "Evidence: local mock. This picture is an empty board drawn in your browser. It is not testnet or mainnet state. Set VITE_CONTRACT_ID to read a real contract.";
      contractLine.textContent =
        "This is a local demo board. Nothing here is on a blockchain."
      if (!deps.routeFocusesCell) {
        boardLoadStatus.textContent =
          "Board load: mock only (no contract id). Refresh stays disabled.";
      }
      deps.updateCompactStatus();
      deps.updateDirectPaintAvailability();
      deps.applyRoutePaintingContext();
      return;
    }

    evidence.textContent = `Evidence: reading contract ${CONTRACT_ID} on ${PAGE_NETWORK}. Validating metadata, then loading painted cells…`;
    try {
      const board = await getBoard();
      const meta = validateContractMetadata(board);
      contractMetaOk = meta.ok;
      contractMetaIssue = meta.ok ? null : { kind: "mismatch", detail: meta.message };
      rememberBoardSchema(meta.ok ? board.schema_version : null);
      if (!meta.ok) {
        evidence.textContent = `Evidence: contract ${CONTRACT_ID} on ${PAGE_NETWORK} failed metadata checks — ${meta.message}`;
        deps.fillResult(meta.title, meta.message);
        boardLoadStatus.textContent = `Board metadata rejected: ${meta.title}`;
        deps.updateCompactStatus();
        deps.updateDirectPaintAvailability();
        return;
      }
      deps.onPaletteChanged(meta.paletteLength);
      if (board.sponsorship_enabled && !sponsorship.flagEnabled) {
        sponsorNote.textContent = `${sponsorship.message} (Contract reported sponsorship_enabled=true; this page still does not offer a sponsored submit path.)`;
      }
      evidence.textContent = `Evidence: contract ${CONTRACT_ID} on ${PAGE_NETWORK}. ${meta.summary} sponsorship_enabled=${board.sponsorship_enabled}.`;
      // One sentence a non-crypto visitor can repeat. Everything here is enforced
      // by the contract (`overwrite_rule: open_wall`), not by this page.
      contractLine.textContent =
        `Every square is stored on the NEAR ${PAGE_NETWORK} contract ${CONTRACT_ID}. ` +
        `Painting a square replaces the colour that was there, and the contract ` +
        `records which account painted it and when.`;
      await refreshBoardFromContract();
      deps.applyRoutePaintingContext();
    } catch (error) {
      contractMetaOk = false;
      const detail = error instanceof Error ? error.message : "Unknown read error";
      contractMetaIssue = { kind: "read", detail };
      rememberBoardSchema(null);
      evidence.textContent = `Evidence: contract id is set (${CONTRACT_ID}), but the initial board read failed: ${detail}. You can still look at the local empty picture and try Refresh. Drawing stays blocked until metadata validates.`;
      contractLine.textContent =
        "The board contract could not be read, so nothing here is confirmed chain state.";
      boardLoadStatus.textContent = `Board load failed: ${detail}`;
      deps.updateCompactStatus();
    } finally {
      deps.updateDirectPaintAvailability();
    }
  }

  /**
   * Replace the local picture from a full paginated walk of `get_pixels`,
   * pinned to one block. Safe without a wallet. Does not invent pixels from clicks.
   * Older snapshots are ignored so a slow refresh cannot overwrite a newer one.
   */
  async function refreshBoardFromContract(options?: {
    reason?: BoardLoadReason;
  }): Promise<void> {
    if (scope.isDisposed() || !isContractConfigured() || boardLoadInFlight) {
      return;
    }
    const loadId = beginBoardLoad(boardSync);
    boardLoadInFlight = true;
    refreshButton.disabled = true;
    const reason = options?.reason ?? "manual";
    boardLoadStatus.textContent = `Board load (${reason}): fetching painted pages at one block…`;
    try {
      const snapshot = await fetchAllPaintedPixels();
      if (!shouldApplyBoardLoad(boardSync, loadId, snapshot.blockHeight)) {
        boardLoadStatus.textContent = `Board load skipped stale snapshot (block ${snapshot.blockHeight}). ${formatFreshness(boardSync, Date.now())}`;
        return;
      }
      replaceCacheAtBlock(pixelCache, snapshot.pixels, snapshot.blockHeight);
      deps.reconcilePending(snapshot.pixels);
      markBoardLoadApplied(boardSync, loadId, snapshot.blockHeight, Date.now());
      showBoardFreshness();
      deps.render();
      // A refresh can change how old a cell is, so the last quoted price is stale.
      deps.onBoardUpdated();
      deps.showSelection();
      boardLoadStatus.textContent = `Board load: ${snapshot.pixels.length} painted cell${
        snapshot.pixels.length === 1 ? "" : "s"
      } at block ${snapshot.blockHeight}. ${formatFreshness(boardSync, Date.now())}`;
    } catch (error) {
      markBoardLoadFailed(boardSync);
      showBoardFreshness();
      const detail = error instanceof Error ? error.message : "Unknown read error";
      boardLoadStatus.textContent = `Board load failed: ${detail}. ${formatFreshness(boardSync, Date.now())}`;
    } finally {
      boardLoadInFlight = false;
      refreshButton.disabled = !isContractConfigured();
      deps.updateCompactStatus();
      scheduleBoardPoll();
    }
  }

  async function refreshSelectedPixel(cell = deps.selected()): Promise<void> {
    if (!cell || !isContractConfigured()) {
      deps.showSelection();
      return;
    }
    const loadId = beginBoardLoad(boardSync);
    try {
      const { pixel, blockHeight } = await getPixelWithBlock(cell.x, cell.y);
      // A cell response is board evidence too.  Do not let it replace a newer
      // full snapshot (or another cell read), including after unmount.
      if (
        scope.isDisposed() ||
        loadAbort.signal.aborted ||
        !shouldApplyBoardLoad(boardSync, loadId, blockHeight)
      ) {
        return;
      }
      rememberPixelAtBlock(pixelCache, pixel, blockHeight);
      deps.reconcilePending([pixel]);
      markBoardLoadApplied(boardSync, loadId, blockHeight, Date.now());
      showBoardFreshness();
      deps.render();
      deps.showSelection();
    } catch {
      // Keep the last cached view; selection text still works offline.
      deps.showSelection();
    }
  }

  function clearBoardPoll(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleBoardPoll(): void {
    clearBoardPoll();
    if (
      scope.isDisposed() ||
      !isContractConfigured() ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    // Healthy visible tabs poll every 4s (BOARD_POLL_BASE_MS), keeping the
    // expected cross-session update window auditable at roughly 3–5 seconds.
    // Read failures back off through nextPollDelayMs; hidden tabs schedule none.
    const delay = nextPollDelayMs(boardSync.consecutiveFailures);
    pollTimer = setTimeout(() => {
      void runBoardPoll();
    }, delay);
  }

  async function runBoardPoll(): Promise<void> {
    if (
      !shouldPollNow({
        contractConfigured: isContractConfigured(),
        documentHidden: document.visibilityState === "hidden",
        loadInFlight: boardLoadInFlight,
      })
    ) {
      scheduleBoardPoll();
      return;
    }
    await refreshBoardFromContract({ reason: "poll" });
  }

  return {
    contractMetaOk: () => contractMetaOk,
    contractMetaIssue: () => contractMetaIssue,
    boardSchema: () => boardSchema,
    syncState: () => boardSync,
    cachedPixel: (cell) => getCachedPixel(pixelCache, cell.x, cell.y),
    paintedPixels: () => paintedPixels(pixelCache),
    rememberPixel: (pixel, blockHeight) => {
      rememberPixelAtBlock(pixelCache, pixel, blockHeight);
    },
    bootstrap,
    refreshBoardFromContract,
    refreshSelectedPixel,
    scheduleBoardPoll,
    clearBoardPoll,
    revalidateContractMeta,
    dispose() {
      clearBoardPoll();
      loadAbort.abort();
    },
  };
}

/** "just now", "12 s ago", "3 min ago": no block heights in the main UI. */
export function plainAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
