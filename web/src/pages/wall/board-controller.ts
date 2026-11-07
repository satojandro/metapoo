import { setBoardSide } from "@shared/types.ts";
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
  BOARD_IDLE_PAUSE_MS,
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
  WalkCancelled,
  getBoard,
  getPixelWithBlock,
  isContractConfigured,
  readBoardVersion,
} from "../../contract";
import type { BoardServerClient, ServerBoardExpanded, ServerDraw } from "../../board-server/client";
import { validateContractMetadata, type ContractMetaIssue } from "../../contract-meta";
import type { Cell } from "../../selection";
import type { SponsorshipStatus } from "../../sponsorship";
import type { WallScope } from "./wall-scope";

/** While the board server is live, one `get_board_version` read a minute checks it. */
export const SERVER_TRUST_CHECK_MS = 60_000;
/** The server may trail the chain by this many blocks (about a minute) before the page polls again. */
export const SERVER_MAX_LAG_BLOCKS = 60;
/** The version moved and the server said nothing for this long: suspect it missed a write. */
export const SERVER_SILENCE_MS = 60_000;
/**
 * The server keeps this much draw history for `catch_up` (`CATCHUP_RETENTION_MS`, default 2 h).
 * A socket paused for longer than this, less a margin, may have missed draws catch-up no longer
 * has, so the wall re-checks `/api/regions` (and reloads the blob if newer) before trusting it.
 */
export const SERVER_CATCH_UP_SAFE_MS = 90 * 60_000;
/**
 * After a deliberate pause the wall waits this long for the reopened socket and its trust check
 * before it falls back to chain polling. Without the wait, every return to the tab would cost a
 * chain walk even when the server is fine.
 */
export const SERVER_RESUME_GRACE_MS = 10_000;

export type BoardLoadReason = "manual" | "poll" | "visible" | "reconnect" | "after_draw" | "resume";

/**
 * Reasons that may stop at "the board has not changed". A first load and Refresh
 * always re-read every cell: Refresh is the visitor saying they do not trust the copy.
 */
const VERSION_CHECKED: ReadonlySet<BoardLoadReason> = new Set(["poll", "visible", "reconnect", "after_draw", "resume"]);

/** Input that means someone is at the page. Scrolling the wall is `wheel`. */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

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
  /** The contract reported a different board size; refit and redraw at the new size. */
  onBoardSizeChanged(): void;
  /**
   * The board server (`VITE_BOARD_SERVER_URL`). Absent: today's chain polling, unchanged.
   * Present: the wall loads from it and takes live draws over its WebSocket; while that
   * socket is open and the server keeps up, the 4 s poll and `get_pixels` walks stop.
   */
  boardServer?: BoardServerClient;
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
  /** True while board state comes from the server's socket and chain polling is off. */
  serverLive(): boolean;
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
  /** `get_board_version` of the copy in `pixelCache`; null = unknown, or a board without the view. */
  let cachedVersion: number | null = null;
  /** Last input on the page. Polling stops after `BOARD_IDLE_PAUSE_MS` without any. */
  let lastActivityMs = Date.now();
  let idlePaused = false;

  // Board server state. All of it stays at its initial value without `deps.boardServer`.
  const server = deps.boardServer ?? null;
  let socketOpen = false;
  /** The last trust check passed: `/api/health` answered and the server keeps up with the chain. */
  let serverHealthy = false;
  /** The chain's version moved and the server never sent the write. Cleared by a fresh socket. */
  let serverDistrusted = false;
  let live = false;
  let trustTimer: ReturnType<typeof setTimeout> | null = null;
  let trustInFlight = false;
  let lastServerMessageMs = 0;
  let lastTrustVersion: number | null = null;
  /** When an unexplained version change was first seen; a server message clears it. */
  let suspectSinceMs: number | null = null;
  /**
   * The socket is closed on purpose: the tab is hidden or nobody has touched it for
   * BOARD_IDLE_PAUSE_MS. The server counts open sockets as viewers and stops reading the
   * chain without any, so a forgotten tab must not hold one open. Not a server failure.
   */
  let serverPaused = false;
  /** `connect()` has been called; pausing before that has no socket to close. */
  let serverStarted = false;
  let pausedAtMs = 0;
  /**
   * The server was live (or about to be) when paused. While set, and until the reopened
   * socket's trust check settles (`resumeTimer`), chain reads stay off as they were while live.
   */
  let holdChainForServer = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  for (const type of ACTIVITY_EVENTS) {
    scope.listen(window, type, noteActivity, { passive: true });
  }

  /** Someone is here. If polling had stopped for idleness, catch up now and resume. */
  function noteActivity(): void {
    lastActivityMs = Date.now();
    if (serverPaused && document.visibilityState !== "hidden") resumeServer();
    // The trust check skips an idle tab; the first input after that restarts it.
    if (socketOpen && trustTimer === null && !trustInFlight && !scope.isDisposed()) scheduleTrustCheck();
    if (!idlePaused || scope.isDisposed()) return;
    idlePaused = false;
    showBoardFreshness();
    void refreshBoardFromContract({ reason: "resume" });
    scheduleBoardPoll();
  }

  scope.listen(document, "visibilitychange", () => {
    if (scope.isDisposed()) return;
    if (document.visibilityState === "visible") {
      // Coming back to the tab is activity: it must not land on a paused wall.
      lastActivityMs = Date.now();
      idlePaused = false;
      if (serverPaused) resumeServer();
      void refreshBoardFromContract({ reason: "visible" });
      scheduleBoardPoll();
    } else {
      clearBoardPoll();
      pauseServer();
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
    if (idlePaused) {
      const age = boardSync.lastAppliedAtMs === null ? "" : `Wall updated ${plainAge(Date.now() - boardSync.lastAppliedAtMs)}. `;
      boardFreshness.textContent = `${age}Live updates paused while you're away. Move the mouse or tap to resume.`;
      return;
    }
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
        if (setBoardSide(meta.side)) deps.onBoardSizeChanged();
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
      if (setBoardSide(meta.side)) deps.onBoardSizeChanged();
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
      // With a server, its blob is the first load; the chain walk runs only if that fails.
      const fromServer = server ? await loadFromServer() : false;
      if (!fromServer) await refreshBoardFromContract();
      deps.applyRoutePaintingContext();
      if (server) startServer();
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
    /** Internal: walk even while the server holds chain reads off. */
    force?: boolean;
  }): Promise<void> {
    if (scope.isDisposed() || !isContractConfigured() || boardLoadInFlight) {
      return;
    }
    // While the server is live its socket keeps the copy current (and while a deliberately
    // paused live socket reopens). Only Refresh (the visitor not trusting the copy) still walks.
    if ((live || holdChainForServer) && !options?.force && (options?.reason ?? "manual") !== "manual") return;
    const loadId = beginBoardLoad(boardSync);
    boardLoadInFlight = true;
    refreshButton.disabled = true;
    const reason = options?.reason ?? "manual";
    boardLoadStatus.textContent = `Board load (${reason}): fetching painted pages at one block…`;
    try {
      const snapshot = await fetchAllPaintedPixels({
        knownVersion: VERSION_CHECKED.has(reason) ? cachedVersion : null,
        // A disposed wall (the visitor left) stops reading instead of finishing the walk.
        isCancelled: () => scope.isDisposed(),
      });
      if (!shouldApplyBoardLoad(boardSync, loadId, snapshot.blockHeight)) {
        boardLoadStatus.textContent = `Board load skipped stale snapshot (block ${snapshot.blockHeight}). ${formatFreshness(boardSync, Date.now())}`;
        return;
      }
      if (snapshot.unchanged) {
        // Same version at a newer block: the copy is current. Nothing to replace or
        // reconcile, but time has passed, so ages and the quoted price still move on.
        markBoardLoadApplied(boardSync, loadId, snapshot.blockHeight, Date.now());
        showBoardFreshness();
        deps.render();
        deps.onBoardUpdated();
        boardLoadStatus.textContent = `Board unchanged at block ${snapshot.blockHeight} (version ${snapshot.version}). ${formatFreshness(boardSync, Date.now())}`;
        return;
      }
      replaceCacheAtBlock(pixelCache, snapshot.pixels, snapshot.blockHeight);
      cachedVersion = snapshot.version ?? null;
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
      // Cancelled because the wall was disposed: not a failure, and nobody is reading it.
      if (error instanceof WalkCancelled) return;
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
    // With a socket open the once-a-minute trust check runs, live or not: it is also
    // what notices the server has caught up again.
    if (socketOpen && trustTimer === null && !trustInFlight) scheduleTrustCheck();
    // While live the socket replaces the poll; so it does while a paused live socket reopens.
    if (live || holdChainForServer) return;
    if (
      scope.isDisposed() ||
      !isContractConfigured() ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    // Healthy visible tabs poll every 4s (BOARD_POLL_BASE_MS), keeping the
    // expected cross-session update window auditable at roughly 3–5 seconds.
    // Read failures back off through nextPollDelayMs; hidden tabs schedule none,
    // and neither does a tab nobody has touched for BOARD_IDLE_PAUSE_MS.
    const delay = nextPollDelayMs(boardSync.consecutiveFailures);
    pollTimer = setTimeout(() => {
      void runBoardPoll();
    }, delay);
  }

  /**
   * First load from the server: cached blob, `last_updated`, and the blob only if newer.
   * Refused without per-tile `written_at_ns`: tile ages feed the repaint estimate on a
   * money screen, so a copy without them is not good enough and the chain walk runs.
   */
  async function loadFromServer(): Promise<boolean> {
    if (!server) return false;
    const loadId = beginBoardLoad(boardSync);
    try {
      boardLoadStatus.textContent = "Board load: reading the board server…";
      const region = await server.loadRegion();
      if (scope.isDisposed() || !region.hasWrittenAt) return false;
      const block = region.lastBlock ?? 0;
      if (!shouldApplyBoardLoad(boardSync, loadId, block)) return false;
      replaceCacheAtBlock(pixelCache, region.pixels, block);
      // Not a chain-verified copy: a fallback poll must walk the chain, not trust a version.
      cachedVersion = null;
      deps.reconcilePending(region.pixels);
      markBoardLoadApplied(boardSync, loadId, block, Date.now());
      showBoardFreshness();
      deps.render();
      deps.onBoardUpdated();
      deps.showSelection();
      boardLoadStatus.textContent = `Board load: ${region.pixels.length} painted cell${
        region.pixels.length === 1 ? "" : "s"
      } from the board server${region.fromCache ? " (cached copy, still current)" : ""}, last write at block ${block}.`;
      return true;
    } catch {
      return false;
    } finally {
      deps.updateCompactStatus();
    }
  }

  function startServer(): void {
    if (!server || scope.isDisposed()) return;
    serverStarted = true;
    scheduleIdleCheck();
    server.connect({
      onOpen() {
        if (scope.isDisposed()) return;
        socketOpen = true;
        serverDistrusted = false;
        suspectSinceMs = null;
        lastTrustVersion = null;
        lastServerMessageMs = Date.now();
        // Live only once a trust check says the server keeps up.
        void runTrustCheck();
      },
      onClose() {
        if (scope.isDisposed()) return;
        socketOpen = false;
        clearTrustCheck();
        if (serverPaused) {
          // Our own pause: not a failure, so no fallback to chain polling and the last
          // health verdict stands. The reopened socket's trust check re-earns live.
          live = false;
          return;
        }
        serverHealthy = false;
        updateLive();
      },
      onDraw: applyServerDraw,
      onExpanded: applyServerExpanded,
    });
    // The tab was hidden while the first load ran: no viewer, no socket.
    if (document.visibilityState === "hidden") pauseServer();
  }

  function applyServerDraw(draw: ServerDraw): void {
    if (scope.isDisposed()) return;
    lastServerMessageMs = Date.now();
    suspectSinceMs = null;
    const pixels: PixelView[] = draw.pixels.map((p) => ({
      x: p.x,
      y: p.y,
      colorIndex: p.colorIndex,
      artistAccountId: p.artistAccountId,
      lastWriteTimestampNs: p.lastWriteTimestampNs,
    }));
    // Entries in applied order; a repeated tile ends with its last entry, as on chain.
    for (const pixel of pixels) rememberPixelAtBlock(pixelCache, pixel, draw.blockHeight);
    deps.reconcilePending(pixels);
    boardSync.lastAppliedAtMs = Date.now();
    showBoardFreshness();
    deps.render();
    deps.onBoardUpdated();
    deps.showSelection();
  }

  function applyServerExpanded(event: ServerBoardExpanded): void {
    if (scope.isDisposed()) return;
    lastServerMessageMs = Date.now();
    suspectSinceMs = null;
    if (setBoardSide(event.to)) deps.onBoardSizeChanged();
    deps.render();
  }

  function updateLive(): void {
    const next = socketOpen && serverHealthy && !serverDistrusted && !scope.isDisposed();
    if (next === live) return;
    live = next;
    if (live) {
      clearBoardPoll();
      boardLoadStatus.textContent = "Board load: live from the board server. Chain polling paused; one check a minute.";
      return;
    }
    // Back to today's path. The version check decides whether the copy needs a walk:
    // a copy loaded from the server has no chain version, so it always gets one.
    boardLoadStatus.textContent = "Board load: board server unavailable or behind; polling the chain.";
    void refreshBoardFromContract({ reason: "reconnect" });
    scheduleBoardPoll();
  }

  /** Close the socket after BOARD_IDLE_PAUSE_MS without input, as the chain poll stops. */
  function scheduleIdleCheck(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (!server || serverPaused || scope.isDisposed()) return;
    const wait = Math.max(0, lastActivityMs + BOARD_IDLE_PAUSE_MS - Date.now());
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (scope.isDisposed() || serverPaused) return;
      if (Date.now() - lastActivityMs < BOARD_IDLE_PAUSE_MS) {
        scheduleIdleCheck();
        return;
      }
      idlePaused = true;
      clearBoardPoll();
      pauseServer();
      showBoardFreshness();
    }, wait);
  }

  function clearResumeTimer(): void {
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  }

  /** Hidden or idle tab: close the server socket on purpose and stop its reconnects. */
  function pauseServer(): void {
    if (!server || !serverStarted || serverPaused || scope.isDisposed()) return;
    // A socket that was live, or a resume still waiting to earn it, keeps chain reads off.
    holdChainForServer = live || resumeTimer !== null;
    clearResumeTimer();
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    serverPaused = true;
    pausedAtMs = Date.now();
    clearTrustCheck();
    server.pause();
    socketOpen = false;
    live = false;
  }

  /** Someone is back: reopen, catch up, and let the trust check decide as on any reconnect. */
  function resumeServer(): void {
    if (!server || !serverPaused || scope.isDisposed()) return;
    serverPaused = false;
    const longGap = Date.now() - pausedAtMs > SERVER_CATCH_UP_SAFE_MS;
    if (holdChainForServer) {
      clearResumeTimer();
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        endResumeHold();
      }, SERVER_RESUME_GRACE_MS);
    }
    scheduleIdleCheck();
    if (longGap) {
      // catch_up may not reach back that far: re-check the region's last_updated first.
      void loadFromServer().then((ok) => {
        if (!ok && !scope.isDisposed()) void refreshBoardFromContract({ reason: "reconnect", force: true });
      });
    }
    server.resume();
  }

  /** The reopened socket's first trust check settled (or never came): live, or today's poll. */
  function endResumeHold(): void {
    if (!holdChainForServer) return;
    clearResumeTimer();
    holdChainForServer = false;
    if (live || scope.isDisposed() || serverPaused) return;
    boardLoadStatus.textContent = "Board load: board server unavailable or behind; polling the chain.";
    void refreshBoardFromContract({ reason: "reconnect" });
    scheduleBoardPoll();
  }

  function clearTrustCheck(): void {
    if (trustTimer !== null) {
      clearTimeout(trustTimer);
      trustTimer = null;
    }
  }

  function scheduleTrustCheck(): void {
    clearTrustCheck();
    if (!server || !socketOpen || scope.isDisposed()) return;
    trustTimer = setTimeout(() => {
      trustTimer = null;
      void runTrustCheck();
    }, SERVER_TRUST_CHECK_MS);
  }

  /**
   * One chain read (`get_board_version`, with its block) and one `/api/health`.
   * Falls back to polling when the server trails the chain by more than
   * SERVER_MAX_LAG_BLOCKS, when health fails, or when the version moved and the server
   * sent nothing about it for a whole check interval.
   */
  async function runTrustCheck(): Promise<void> {
    if (!server || !socketOpen || scope.isDisposed() || trustInFlight) return;
    clearTrustCheck();
    if (document.visibilityState === "hidden" || Date.now() - lastActivityMs >= BOARD_IDLE_PAUSE_MS) {
      // Nobody is looking: no chain reads. Input or visibility restarts the check.
      return;
    }
    trustInFlight = true;
    try {
      const [chain, health] = await Promise.all([readBoardVersion(), server.health()]);
      if (scope.isDisposed() || !socketOpen) return;
      // Lag is measured from the **applied** watermark, not the indexer's: the two are the same
      // block count apart only while the consumer is working, and a dead consumer leaves
      // `last_processed_block` climbing while the board stops. `status` is the server's own
      // consumer liveness (`ok` / `degraded` / `stalled`).
      const applied = health.lastAppliedBlock ?? health.lastProcessedBlock;
      const lag = applied === null ? Infinity : chain.blockHeight - applied;
      serverHealthy = health.status === "ok" && lag <= SERVER_MAX_LAG_BLOCKS;
      if (chain.version !== null) {
        if (suspectSinceMs !== null) {
          // A whole interval since an unexplained change, and still nothing from the server.
          serverDistrusted = true;
        } else if (
          lastTrustVersion !== null &&
          chain.version !== lastTrustVersion &&
          Date.now() - lastServerMessageMs > SERVER_SILENCE_MS
        ) {
          suspectSinceMs = Date.now();
        }
        lastTrustVersion = chain.version;
      }
      if (live && serverHealthy && !serverDistrusted) {
        boardSync.lastAppliedAtMs = Date.now();
        showBoardFreshness();
      }
    } catch {
      serverHealthy = false;
    } finally {
      trustInFlight = false;
    }
    if (scope.isDisposed() || !socketOpen) return;
    updateLive();
    if (holdChainForServer && !serverPaused) endResumeHold();
    if (serverDistrusted) {
      // A fresh socket catches up from the last message seen and earns trust again.
      server.reconnect();
      return;
    }
    scheduleTrustCheck();
  }

  async function runBoardPoll(): Promise<void> {
    if (Date.now() - lastActivityMs >= BOARD_IDLE_PAUSE_MS) {
      // Nobody is looking: stop until input arrives (noteActivity) instead of
      // reading the chain every 4 s for an empty room.
      idlePaused = true;
      showBoardFreshness();
      return;
    }
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
      // A confirmed paint of ours: the server's indexer looks now, not at its next poll.
      deps.boardServer?.hint();
    },
    bootstrap,
    refreshBoardFromContract,
    refreshSelectedPixel,
    scheduleBoardPoll,
    clearBoardPoll,
    revalidateContractMeta,
    serverLive: () => live,
    dispose() {
      clearBoardPoll();
      clearTrustCheck();
      clearResumeTimer();
      if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
      server?.close();
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
