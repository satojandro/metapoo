import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type NetworkId } from "@shared/types.ts";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixelAtBlock,
  replaceCacheAtBlock,
} from "../../board-cache";
import {
  createDrawRequest,
  drawRequestMatchesSession,
  type DrawRequest,
} from "../../draw-request";
import {
  beginBoardLoad,
  createBoardSyncState,
  formatFreshness,
  markBoardLoadApplied,
  markBoardLoadFailed,
  nextPollDelayMs,
  shouldApplyBoardLoad,
  shouldPollNow,
} from "../../board-sync";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import {
  fetchAllPaintedPixels,
  getBoard,
  getPixelWithBlock,
  isContractConfigured,
} from "../../contract";
import { validateContractMetadata } from "../../contract-meta";
import { prepareDraw } from "../../draw-policy";
import {
  describeDrawingSession,
  forgetDrawingSessionLocally,
  formatAllowanceNear,
  loadDrawingSessionRecord,
} from "../../drawing-session";
import {
  canUseLocalDrawingSession,
  fetchDrawingSessionAllowance,
} from "../../local-draw";
import {
  clearPaintQueue,
  createPaintQueue,
  enqueuePaint,
  paintQueueLength,
  shiftPaint,
} from "../../paint-queue";
import {
  createPendingPaintMap,
  listPendingPaints,
  reconcilePendingWithConfirmed,
  setPendingPaint,
  clearPendingPaint,
} from "../../pending-paint";
import {
  boardReportsPaidSchema,
  isPaidPaintModeEnabled,
  shouldUseMockPressureQuotes,
} from "../../paid-mode";
import { maxCostFromQuote } from "../../paid-paint";
import {
  getQuote,
  MOCK_QUOTE_DEMO_LABEL,
  type QuoteResult,
} from "../../pressure-quote";
import { renderBoard } from "../../render-board";
import { moveSelection, type Cell } from "../../selection";
import { describeSponsorship } from "../../sponsorship";
import { submitDraw } from "../../submit-draw";
import {
  cellFromViewportPoint,
  fitCamera,
  isPanGesture,
  paintZoomCamera,
  PAINT_CELL_PX,
  panBy,
  selectionRingStyle,
  stageSizeStyle,
  stageTransform,
  zoomAt,
  type Camera,
  type ViewportSize,
} from "../../viewport";
import { revokeDrawingSessionKeyOnChain } from "../../wallet";
import type { PageMount } from "../../app/page-registry";
import type { ParsedRoute } from "../../app/routes";
import type { AppServices } from "../../app/services";
import { paintOperationId } from "../../app/operations";
import { parseHelpPaintSearch } from "../bounties/deep-link";
import { wallPageHtml } from "./wall-template";
import {
  createPressureOverlayHooks,
  formatToiletAmount,
  revalidateQueuedPaint,
  summarizeQuoteTiming,
  type PressureOverlayElements,
} from "../../features/pressure";
import type { QuoteView } from "@shared/protocol/board.ts";

/**
 * Lifecycle-safe wall mount.
 * mountWall(root, services) → dispose() cancels timers, aborts polls, removes listeners,
 * and clears unsent queue paints (already-broadcast ops stay on services.operations).
 */

export interface MountWallOptions {
  /** Validated router location (Help-paint deep links, etc.). */
  route?: ParsedRoute | null;
  /**
   * Test seam: enqueue unsent paints and drive the drain without a live session.
   * Production mounts omit this.
   */
  attachTestApi?: (api: WallMountTestApi) => void;
}

export interface WallMountTestApi {
  enqueueUnsent: (request: DrawRequest) => void;
  queueLength: () => number;
  kickDrain: () => Promise<void>;
}

function mustFindIn<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`The wall page is missing required element ${selector}.`);
  }
  return element;
}

function shellEl<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/**
 * Page-registry adapter: passes route context so bounty Help-paint links focus the wall.
 */
export const mountWallPage: PageMount = (root, ctx) =>
  mountWall(root, ctx.services, { route: ctx.route });

/**
 * Extracted from the former main.ts entry. Preserves open-wall gameplay.
 */
export function mountWall(
  root: HTMLElement,
  services: AppServices,
  options: MountWallOptions = {},
): () => void {
  root.innerHTML = wallPageHtml();
  const pageRoot = root;

  const canvas = mustFindIn<HTMLCanvasElement>(pageRoot, "#board");
  const selectionRing = mustFindIn<HTMLElement>(pageRoot, "#selection-ring");
  const boardFocus = mustFindIn<HTMLElement>(pageRoot, "#board-focus");
  const boardViewport = mustFindIn<HTMLElement>(pageRoot, "#board-viewport");
  const boardStage = mustFindIn<HTMLElement>(pageRoot, "#board-stage");
  const selectionSummary = mustFindIn<HTMLElement>(pageRoot, "#selection-summary");
  const preview = mustFindIn<HTMLElement>(pageRoot, "#selection-preview");
  const palette = mustFindIn<HTMLElement>(pageRoot, "#palette");
  const drawButton = mustFindIn<HTMLButtonElement>(pageRoot, "#draw-button");
  const result = mustFindIn<HTMLElement>(pageRoot, "#result");
  const rules = mustFindIn<HTMLElement>(pageRoot, "#rules");
  const sponsorNote = mustFindIn<HTMLElement>(pageRoot, "#sponsor-note");
  const evidence = mustFindIn<HTMLElement>(pageRoot, "#evidence");
  const lede = mustFindIn<HTMLElement>(pageRoot, "#lede");
  const refreshButton = mustFindIn<HTMLButtonElement>(pageRoot, "#refresh-board");
  const boardLoadStatus = mustFindIn<HTMLElement>(pageRoot, "#board-load-status");
  const zoomInButton = mustFindIn<HTMLButtonElement>(pageRoot, "#zoom-in");
  const zoomOutButton = mustFindIn<HTMLButtonElement>(pageRoot, "#zoom-out");
  const zoomFitButton = mustFindIn<HTMLButtonElement>(pageRoot, "#zoom-fit");
  const zoomPaintButton = mustFindIn<HTMLButtonElement>(pageRoot, "#zoom-paint");
  const drawingSessionStatus = mustFindIn<HTMLElement>(pageRoot, "#drawing-session-status");
  const drawingSessionNote = mustFindIn<HTMLElement>(pageRoot, "#drawing-session-note");
  const authorizeSessionButton = mustFindIn<HTMLButtonElement>(
    pageRoot,
    "#authorize-session-button",
  );
  const forgetSessionButton = mustFindIn<HTMLButtonElement>(
    pageRoot,
    "#forget-session-button",
  );
  const revokeSessionButton = mustFindIn<HTMLButtonElement>(
    pageRoot,
    "#revoke-session-button",
  );
  const hoverSummary = mustFindIn<HTMLElement>(pageRoot, "#hover-summary");
  const directPaintToggle = mustFindIn<HTMLInputElement>(pageRoot, "#direct-paint-toggle");
  const pressurePanel = mustFindIn<HTMLElement>(pageRoot, "#pressure-panel");
  const pressureToggle = mustFindIn<HTMLInputElement>(pageRoot, "#pressure-toggle");
  const pressureLegend = mustFindIn<HTMLElement>(pageRoot, "#pressure-legend");
  const pressureQuoteSummary = mustFindIn<HTMLElement>(
    pageRoot,
    "#pressure-quote-summary",
  );
  const pressureDemoBanner = mustFindIn<HTMLElement>(pageRoot, "#pressure-demo-banner");
  const placementQuote = mustFindIn<HTMLElement>(pageRoot, "#placement-quote");
  const placementQuoteBody = mustFindIn<HTMLElement>(pageRoot, "#placement-quote-body");

  // Shell-owned status strip (survives wall dispose; safe if missing in tests).
  const flowState = shellEl<HTMLElement>("#flow-state") ?? document.createElement("p");
  const compactStatus =
    shellEl<HTMLElement>("#compact-status") ?? document.createElement("p");

  const pixelCache = createPixelCache();
  const pendingPaints = createPendingPaintMap();
  const boardSync = createBoardSyncState();
  const paintQueue = createPaintQueue();

  /** Paid UI off until flag or paid schema detection; free path unchanged. */
  let paidModeEnabled = isPaidPaintModeEnabled();
  let boardLooksPaid = false;
  let useMockQuotes = shouldUseMockPressureQuotes({
    paidModeEnabled,
    boardReportsPaid: boardLooksPaid,
    liveQuoteAvailable: false,
  });
  let selectedQuote: QuoteView | null = null;
  let selectedQuoteSource: QuoteResult["source"] | null = null;
  let quoteFetchGeneration = 0;

  const pressureElements: PressureOverlayElements = {
    toggle: pressureToggle,
    panel: pressurePanel,
    legend: pressureLegend,
    quoteSummary: pressureQuoteSummary,
    demoBanner: pressureDemoBanner,
  };
  let pressureHooks = createPressureOverlayHooks(pressureElements, {
    available: paidModeEnabled,
  });
  applyPaidModeChrome();

  let selected: Cell | null = null;
  let selectedColor: number | null = null;
  let walletAccount: string | null = null;
  let walletNetwork: string | null = null;
  let drawInFlight = false;
  let boardLoadInFlight = false;
  /** False until get_board metadata matches shared constants (or mock mode). */
  let contractMetaOk = !isContractConfigured();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let camera: Camera = { cellSize: 4, panX: 0, panY: 0 };
  let disposed = false;
  let loadAbort: AbortController = new AbortController();
  /** High-level UI phase for the status strip. */
  let uiPhase:
    | "disconnected"
    | "connected"
    | "editing"
    | "wallet_prompt"
    | "pending"
    | "success"
    | "error" = "disconnected";

  const listenerCleanups: Array<() => void> = [];
  function listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    listenerCleanups.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }

  const sponsorship = describeSponsorship();
  sponsorNote.textContent = sponsorship.message;

  lede.textContent = isContractConfigured()
    ? "A live communal pixel wall on NEAR. Explore freely. Drawing asks your wallet to approve one on-chain paint."
    : "A live communal pixel wall. Explore freely. Drawing stays blocked until a game contract id is configured.";

  fillRules();
  buildPalette();
  setFlow("disconnected");
  applyCamera(fitCamera(readViewportSize()));
  render();
  showSelection();
  showDrawingSession();
  applyRoutePaintingContext();
  void bootstrapBoard();
  scheduleBoardPoll();

  options.attachTestApi?.({
    enqueueUnsent: (request) => {
      if (disposed) return;
      enqueuePaint(paintQueue, request);
      setPendingPaint(pendingPaints, {
        x: request.x,
        y: request.y,
        colorIndex: request.colorIndex,
        accountId: request.accountId,
        transactionId: null,
        phase: "submitted",
      });
      render();
    },
    queueLength: () => paintQueueLength(paintQueue),
    kickDrain: () => drainPaintQueue(),
  });

  listen(document, "visibilitychange", () => {
    if (disposed) return;
    if (document.visibilityState === "visible") {
      void refreshBoardFromContract({ reason: "visible" });
      scheduleBoardPoll();
    } else {
      clearBoardPoll();
    }
  });

  listen(window, "online", () => {
    if (disposed) return;
    void refreshBoardFromContract({ reason: "reconnect" });
    scheduleBoardPoll();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (disposed) return;
    camera = clampToViewport(camera);
    applyCamera(camera);
    positionSelection();
  });
  resizeObserver.observe(boardViewport);

  listen(drawButton, "click", () => {
    void attemptDraw();
  });

  listen(authorizeSessionButton, "click", () => {
    void onAuthorizeSessionClick();
  });

  listen(forgetSessionButton, "click", () => {
    forgetDrawingSessionLocally();
    showDrawingSession();
  });

  listen(revokeSessionButton, "click", () => {
    void onRevokeSessionClick();
  });

  listen(directPaintToggle, "change", () => {
    updateDirectPaintAvailability();
  });

  listen(refreshButton, "click", () => {
    void refreshBoardFromContract();
  });

  listen(zoomInButton, "click", () => {
    zoomFromCenter(1.25);
  });
  listen(zoomOutButton, "click", () => {
    zoomFromCenter(1 / 1.25);
  });
  listen(zoomFitButton, "click", () => {
    applyCamera(fitCamera(readViewportSize()));
    positionSelection();
    updateCompactStatus();
  });
  listen(zoomPaintButton, "click", () => {
    const focus = selected ?? { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
    applyCamera(paintZoomCamera(readViewportSize(), focus));
    positionSelection();
    updateCompactStatus();
  });

  refreshButton.disabled = !isContractConfigured();
  refreshButton.title = isContractConfigured()
    ? "Reload every painted cell from the contract"
    : "Configure VITE_CONTRACT_ID to load chain state";

  wirePointerGestures();

  listen(
    boardViewport,
    "wheel",
    (event) => {
      const wheelEvent = event as WheelEvent;
      wheelEvent.preventDefault();
      const rect = boardViewport.getBoundingClientRect();
      const factor = wheelEvent.deltaY < 0 ? 1.12 : 1 / 1.12;
      applyCamera(
        zoomAt(
          camera,
          readViewportSize(),
          factor,
          wheelEvent.clientX - rect.left,
          wheelEvent.clientY - rect.top,
        ),
      );
      positionSelection();
      updateCompactStatus();
    },
    { passive: false },
  );

  listen(boardFocus, "keydown", (event) => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === "Enter") {
      keyEvent.preventDefault();
      void attemptDraw();
      return;
    }
    if (keyEvent.key === "+" || keyEvent.key === "=") {
      keyEvent.preventDefault();
      zoomFromCenter(1.25);
      return;
    }
    if (keyEvent.key === "-" || keyEvent.key === "_") {
      keyEvent.preventDefault();
      zoomFromCenter(1 / 1.25);
      return;
    }
    if (keyEvent.key === "0") {
      keyEvent.preventDefault();
      applyCamera(fitCamera(readViewportSize()));
      positionSelection();
      updateCompactStatus();
      return;
    }
    const next = moveSelection(selected, keyEvent.key);
    if (next === selected) {
      return;
    }
    if (
      keyEvent.key === "ArrowUp" ||
      keyEvent.key === "ArrowDown" ||
      keyEvent.key === "ArrowLeft" ||
      keyEvent.key === "ArrowRight"
    ) {
      keyEvent.preventDefault();
      selected = next;
      if (walletAccount) {
        setFlow("editing");
      }
      if (selected) {
        applyCamera(paintZoomCamera(readViewportSize(), selected, camera.cellSize));
      }
      render();
      showSelection();
      void refreshSelectedPixel();
      void refreshPlacementQuote();
    }
  });

  const unsubWallet = services.wallet.subscribe((session) => {
    if (disposed) return;
    const previousAccount = walletAccount;
    const previousNetwork = walletNetwork;
    walletAccount = session.accountId;
    walletNetwork = session.networkId;
    if (
      previousAccount !== walletAccount ||
      previousNetwork !== walletNetwork
    ) {
      cancelUnsentPaintQueue("Wallet account or network changed.");
      // Account/network change invalidates quote authorization — fresh intent required.
      selectedQuote = null;
      selectedQuoteSource = null;
      void refreshPlacementQuote();
    }
    if (!walletAccount) {
      setFlow("disconnected");
    } else if (uiPhase === "disconnected" || uiPhase === "error") {
      setFlow(selected ? "editing" : "connected");
    }
    showDrawingSession();
  });
  listenerCleanups.push(unsubWallet);

function applyPaidModeChrome(): void {
  pressurePanel.hidden = !paidModeEnabled;
  placementQuote.hidden = !paidModeEnabled;
  if (!paidModeEnabled) {
    placementQuoteBody.textContent = "";
    pressureDemoBanner.hidden = true;
    return;
  }
  // Conspicuous demo label whenever fixture quotes are in use.
  if (useMockQuotes) {
    pressureDemoBanner.hidden = false;
    pressureDemoBanner.textContent = MOCK_QUOTE_DEMO_LABEL;
  } else {
    pressureDemoBanner.hidden = true;
  }
}

function rebuildPressureHooks(): void {
  pressureHooks.dispose();
  pressureHooks = createPressureOverlayHooks(pressureElements, {
    available: paidModeEnabled,
  });
  applyPaidModeChrome();
}

function nowNsString(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

function renderPlacementQuotePanel(): void {
  if (!paidModeEnabled) {
    placementQuote.hidden = true;
    placementQuoteBody.textContent = "";
    return;
  }
  placementQuote.hidden = false;
  if (!selected || selectedColor === null) {
    placementQuoteBody.textContent =
      "Select a square and a named color to see TOILET cost, balance, quote age, and your max authorized cost before Place.";
    return;
  }
  if (!selectedQuote) {
    placementQuoteBody.textContent = "Fetching placement quote…";
    return;
  }
  const timing = summarizeQuoteTiming(selectedQuote, nowNsString());
  const maxAuthorized = maxCostFromQuote(selectedQuote);
  const lines = [
    `Cost ${formatToiletAmount(selectedQuote.cost)}`,
    `Balance ${formatToiletAmount(selectedQuote.balance)}`,
    `Max authorized ${formatToiletAmount(maxAuthorized)}`,
    `Quote ${timing.ageLabel}; ${timing.expiryLabel}`,
    "Network gas is separate from TOILET paint cost.",
  ];
  if (useMockQuotes || selectedQuoteSource === "mock") {
    lines.push(MOCK_QUOTE_DEMO_LABEL);
  }
  placementQuoteBody.textContent = lines.join(" · ");
  pressureHooks.setSelectedQuote(selectedQuote, {
    nowNs: nowNsString(),
    demoLabel: useMockQuotes || selectedQuoteSource === "mock" ? MOCK_QUOTE_DEMO_LABEL : null,
  });
}

async function refreshPlacementQuote(): Promise<void> {
  if (disposed || !paidModeEnabled) {
    selectedQuote = null;
    selectedQuoteSource = null;
    renderPlacementQuotePanel();
    return;
  }
  if (!selected || selectedColor === null) {
    selectedQuote = null;
    selectedQuoteSource = null;
    pressureHooks.setSelectedQuote(null);
    renderPlacementQuotePanel();
    return;
  }
  const generation = ++quoteFetchGeneration;
  const accountId = walletAccount ?? "anonymous.demo";
  try {
    const result = await getQuote(
      {
        x: selected.x,
        y: selected.y,
        color: selectedColor,
        accountId,
      },
      { useMock: useMockQuotes },
    );
    if (disposed || generation !== quoteFetchGeneration) {
      return;
    }
    selectedQuote = result.quote;
    selectedQuoteSource = result.source;
    renderPlacementQuotePanel();
  } catch (error) {
    if (disposed || generation !== quoteFetchGeneration) {
      return;
    }
    selectedQuote = null;
    selectedQuoteSource = null;
    const detail = error instanceof Error ? error.message : "Quote unavailable";
    placementQuoteBody.textContent = `Could not load placement quote: ${detail}`;
  }
}

/**
 * Apply Help-paint / bounty deep-link query after the wall mounts.
 * Coordinates and zoom are clamped; a URL never supplies a trusted price.
 */
function applyRoutePaintingContext(): void {
  if (disposed || !options.route) {
    return;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.route.query)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const parsed = parseHelpPaintSearch(`?${params.toString()}`);
  if (parsed.x === null || parsed.y === null) {
    return;
  }

  selected = { x: parsed.x, y: parsed.y };
  const cellPx = parsed.zoom ?? PAINT_CELL_PX;
  applyCamera(paintZoomCamera(readViewportSize(), selected, cellPx));

  const contextBits: string[] = [
    `Focused square x=${parsed.x}, y=${parsed.y} from the link.`,
  ];
  if (parsed.bounty) {
    contextBits.push(`Bounty context ${parsed.bounty} (coordination only — not territory).`);
  }
  if (parsed.template) {
    contextBits.push(`Template id ${parsed.template} (overlay not applied in this shell yet).`);
  }
  if (parsed.board && CONTRACT_ID && parsed.board !== CONTRACT_ID) {
    contextBits.push(
      `Link board "${parsed.board}" differs from configured contract ${CONTRACT_ID}; coordinates were still applied.`,
    );
  }
  boardLoadStatus.textContent = contextBits.join(" ");
  if (walletAccount) {
    setFlow("editing");
  }
  showSelection();
  render();
  void refreshSelectedPixel();
}

function syncPaidModeFromBoard(board: unknown): void {
  const hints = (board ?? null) as Parameters<typeof boardReportsPaidSchema>[0];
  boardLooksPaid = boardReportsPaidSchema(hints);
  const nextEnabled = isPaidPaintModeEnabled({ board: hints });
  const nextMock = shouldUseMockPressureQuotes({
    paidModeEnabled: nextEnabled,
    boardReportsPaid: boardLooksPaid,
    liveQuoteAvailable: false,
  });
  const changed =
    nextEnabled !== paidModeEnabled || nextMock !== useMockQuotes;
  paidModeEnabled = nextEnabled;
  useMockQuotes = nextMock;
  if (changed) {
    rebuildPressureHooks();
  } else {
    applyPaidModeChrome();
  }
}

async function bootstrapBoard(): Promise<void> {
  if (!isContractConfigured()) {
    contractMetaOk = true;
    syncPaidModeFromBoard(null);
    evidence.textContent =
      "Evidence: local mock. This picture is an empty board drawn in your browser. It is not testnet or mainnet state. Set VITE_CONTRACT_ID to read a real contract.";
    if (!options.route?.query.x) {
      boardLoadStatus.textContent =
        "Board load: mock only (no contract id). Refresh stays disabled.";
    }
    updateCompactStatus();
    updateDirectPaintAvailability();
    applyRoutePaintingContext();
    void refreshPlacementQuote();
    return;
  }

  evidence.textContent = `Evidence: reading contract ${CONTRACT_ID} on ${PAGE_NETWORK}. Validating metadata, then loading painted cells…`;
  try {
    const board = await getBoard();
    syncPaidModeFromBoard(board);
    const meta = validateContractMetadata(board);
    contractMetaOk = meta.ok;
    if (!meta.ok) {
      evidence.textContent = `Evidence: contract ${CONTRACT_ID} on ${PAGE_NETWORK} failed metadata checks — ${meta.message}`;
      fillBlock(result, meta.title, meta.message);
      boardLoadStatus.textContent = `Board metadata rejected: ${meta.title}`;
      updateCompactStatus();
      updateDirectPaintAvailability();
      return;
    }
    if (board.sponsorship_enabled && !sponsorship.flagEnabled) {
      sponsorNote.textContent = `${sponsorship.message} (Contract reported sponsorship_enabled=true; this page still does not offer a sponsored submit path.)`;
    }
    evidence.textContent = `Evidence: contract ${CONTRACT_ID} on ${PAGE_NETWORK}. ${meta.summary} sponsorship_enabled=${board.sponsorship_enabled}.`;
    await refreshBoardFromContract();
    applyRoutePaintingContext();
    void refreshPlacementQuote();
  } catch (error) {
    contractMetaOk = false;
    const detail = error instanceof Error ? error.message : "Unknown read error";
    evidence.textContent = `Evidence: contract id is set (${CONTRACT_ID}), but the initial board read failed: ${detail}. You can still look at the local empty picture and try Refresh. Drawing stays blocked until metadata validates.`;
    boardLoadStatus.textContent = `Board load failed: ${detail}`;
    updateCompactStatus();
  } finally {
    updateDirectPaintAvailability();
  }
}

/**
 * Replace the local picture from a full paginated walk of `get_pixels`,
 * pinned to one block. Safe without a wallet. Does not invent pixels from clicks.
 * Older snapshots are ignored so a slow refresh cannot overwrite a newer one.
 */
async function refreshBoardFromContract(options?: {
  reason?: "manual" | "poll" | "visible" | "reconnect" | "after_draw";
}): Promise<void> {
  if (disposed || !isContractConfigured() || boardLoadInFlight) {
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
    reconcilePendingWithConfirmed(pendingPaints, snapshot.pixels);
    markBoardLoadApplied(boardSync, loadId, snapshot.blockHeight, Date.now());
    render();
    showSelection();
    boardLoadStatus.textContent = `Board load: ${snapshot.pixels.length} painted cell${
      snapshot.pixels.length === 1 ? "" : "s"
    } at block ${snapshot.blockHeight}. ${formatFreshness(boardSync, Date.now())}`;
  } catch (error) {
    markBoardLoadFailed(boardSync);
    const detail = error instanceof Error ? error.message : "Unknown read error";
    boardLoadStatus.textContent = `Board load failed: ${detail}. ${formatFreshness(boardSync, Date.now())}`;
  } finally {
    boardLoadInFlight = false;
    refreshButton.disabled = !isContractConfigured();
    updateCompactStatus();
    scheduleBoardPoll();
  }
}

async function refreshSelectedPixel(): Promise<void> {
  if (!selected || !isContractConfigured()) {
    showSelection();
    return;
  }
  try {
    const { pixel, blockHeight } = await getPixelWithBlock(selected.x, selected.y);
    rememberPixelAtBlock(pixelCache, pixel, blockHeight);
    reconcilePendingWithConfirmed(pendingPaints, [pixel]);
    render();
    showSelection();
  } catch {
    // Keep the last cached view; selection text still works offline.
    showSelection();
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
  if (disposed || !isContractConfigured()) {
    return;
  }
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

async function attemptDraw(request?: DrawRequest): Promise<void> {
  if (disposed || drawInFlight) {
    return;
  }

  // Fresh Place path: authorize at the current quote cost (never silently raise).
  let placeAuthorization:
    | {
        maxCost: string;
        expiresAtNs: string;
        pricingVersion: string;
      }
    | undefined;
  if (!request && paidModeEnabled) {
    await refreshPlacementQuote();
    if (disposed) {
      return;
    }
    if (!selectedQuote) {
      setFlow(walletAccount ? "editing" : "disconnected");
      fillBlock(
        result,
        "Quote required",
        "A TOILET placement quote is required before Place. Select a square and color, wait for the quote, then try again.",
      );
      return;
    }
    const timing = summarizeQuoteTiming(selectedQuote, nowNsString());
    if (timing.expired) {
      setFlow("editing");
      fillBlock(
        result,
        "Quote expired",
        "This price quote expired. Review the refreshed cost, then Place again.",
      );
      void refreshPlacementQuote();
      return;
    }
    placeAuthorization = {
      maxCost: maxCostFromQuote(selectedQuote),
      expiresAtNs: selectedQuote.expiresAtNs,
      pricingVersion: selectedQuote.pricingVersion,
    };
  }

  const frozen =
    request ??
    (selected && selectedColor !== null && walletAccount
      ? createDrawRequest({
          x: selected.x,
          y: selected.y,
          colorIndex: selectedColor,
          accountId: walletAccount,
          networkId: walletNetworkId(),
          ...(placeAuthorization ?? {}),
        })
      : null);

  // Live wallet must still match the frozen request. A queued paint must not
  // keep going after disconnect or account switch just because the request exists.
  if (
    frozen &&
    !drawRequestMatchesSession(frozen, walletAccount, walletNetworkId())
  ) {
    clearPendingPaint(pendingPaints, frozen.x, frozen.y);
    setFlow(walletAccount ? "editing" : "disconnected");
    fillBlock(
      result,
      "Paint cancelled",
      "The wallet account or network no longer matches this paint request, so it was not submitted.",
    );
    render();
    return;
  }

  const decision = prepareDraw({
    x: frozen?.x ?? null,
    y: frozen?.y ?? null,
    color: frozen?.colorIndex ?? null,
    connected: walletAccount !== null,
    accountId: frozen?.accountId ?? walletAccount,
    sessionNetworkId: frozen?.networkId ?? walletNetworkId(),
    boardNetworkId: PAGE_NETWORK,
    contractId: CONTRACT_ID,
  });

  if (decision.outcome === "blocked") {
    setFlow(walletAccount ? "editing" : "disconnected");
    fillBlock(result, decision.title, decision.message);
    return;
  }

  if (!contractMetaOk) {
    setFlow("error");
    fillBlock(
      result,
      "Drawing blocked by contract metadata",
      "This page refused to enable drawing because get_board did not match the shared schema, size, rule, or palette. Fix the contract id or deploy a matching board.",
    );
    return;
  }

  if (!frozen) {
    return;
  }

  // Queued paid paints: revalidate quote vs frozen maxCost before signing.
  if (request && paidModeEnabled && frozen.maxCost !== undefined) {
    try {
      const fresh = await getQuote(
        {
          x: frozen.x,
          y: frozen.y,
          color: frozen.colorIndex,
          accountId: frozen.accountId,
        },
        { useMock: useMockQuotes },
      );
      if (disposed) {
        return;
      }
      const check = revalidateQueuedPaint({
        request: frozen,
        quotedCost: fresh.quote.cost,
        quoteExpiresAtNs: fresh.quote.expiresAtNs,
        nowNs: nowNsString(),
        quotePricingVersion: fresh.quote.pricingVersion,
        paidMode: true,
      });
      if (!check.ok) {
        clearPendingPaint(pendingPaints, frozen.x, frozen.y);
        cancelUnsentPaintQueue(check.message);
        setFlow("editing");
        fillBlock(result, check.title, check.message);
        selectedQuote = fresh.quote;
        selectedQuoteSource = fresh.source;
        renderPlacementQuotePanel();
        render();
        return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Quote unavailable";
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      cancelUnsentPaintQueue(`Could not revalidate paint cost: ${detail}`);
      setFlow("editing");
      fillBlock(
        result,
        "Quote revalidation failed",
        `Queued paint was not submitted. ${detail}`,
      );
      render();
      return;
    }
  }

  // Keep UI selection in sync with the request, but never re-read color/account
  // from live UI state while this request is in flight.
  selected = { x: frozen.x, y: frozen.y };

  drawInFlight = true;
  drawButton.disabled = true;
  setFlow("wallet_prompt");
  const opId = paintOperationId({
    accountId: frozen.accountId,
    x: frozen.x,
    y: frozen.y,
    colorIndex: frozen.colorIndex,
  });
  services.operations.upsert({
    id: opId,
    kind: "paint",
    phase: "awaiting_signature",
    accountId: frozen.accountId,
    networkId: frozen.networkId,
    transactionId: null,
    title: "Paint",
    detail: `Awaiting wallet for x=${frozen.x}, y=${frozen.y}, color=${frozen.colorIndex}`,
    meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
  });
  setPendingPaint(pendingPaints, {
    x: frozen.x,
    y: frozen.y,
    colorIndex: frozen.colorIndex,
    accountId: frozen.accountId,
    transactionId: null,
    phase: "submitted",
  });
  render();
  fillBlock(
    result,
    "Waiting for your wallet",
    [
      `Approve draw at x=${frozen.x}, y=${frozen.y}, color=${frozen.colorIndex} (${colorName(frozen.colorIndex)}).`,
      frozen.maxCost !== undefined
        ? `Max authorized paint cost: ${formatToiletAmount(frozen.maxCost)}. The contract rejects a higher execution cost; this page never silently raises that limit.`
        : "Your wallet may ask you to pay a small network gas fee. The game adds no application fee.",
      frozen.maxCost !== undefined
        ? "Network gas is separate from TOILET paint cost."
        : null,
      sponsorship.message,
      useMockQuotes && frozen.maxCost !== undefined ? MOCK_QUOTE_DEMO_LABEL : null,
    ]
      .filter((line): line is string => line !== null)
      .join(" "),
  );

  try {
    const submitResult = await submitDraw({
      x: frozen.x,
      y: frozen.y,
      colorIndex: frozen.colorIndex,
      accountId: frozen.accountId,
      networkId: frozen.networkId,
      onProgress: (progress) => {
        // Always record broadcast progress on the shared operations store.
        if (progress.phase === "pending" || progress.phase === "confirming") {
          services.operations.upsert({
            id: opId,
            kind: "paint",
            phase: "submitted",
            accountId: frozen.accountId,
            networkId: frozen.networkId,
            transactionId: progress.transactionId,
            title: "Paint",
            detail:
              progress.phase === "pending"
                ? "Transaction pending confirmation"
                : "Confirming against a fresh board read",
            meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
          });
        }
        if (disposed) {
          return;
        }
        if (progress.phase === "wallet_prompt") {
          setFlow("wallet_prompt");
          fillBlock(result, "Waiting for your wallet", progress.detail);
        } else if (progress.phase === "pending" || progress.phase === "confirming") {
          setFlow("pending");
          setPendingPaint(pendingPaints, {
            x: frozen.x,
            y: frozen.y,
            colorIndex: frozen.colorIndex,
            accountId: frozen.accountId,
            transactionId: progress.transactionId,
            phase: "submitted",
          });
          render();
          fillResultWithLink(
            "Transaction pending",
            progress.phase === "pending"
              ? "The wallet returned a transaction id. Confirming against a fresh board read…"
              : "Re-reading the pixel from the contract before we claim success…",
            progress.transactionId,
            progress.explorer,
          );
        }
      },
    });

    if (disposed) {
      // Page left while this draw was in flight: keep operations store, skip DOM.
      if (submitResult.status === "success" || submitResult.status === "overwritten") {
        services.operations.upsert({
          id: opId,
          kind: "paint",
          phase: "confirmed",
          accountId: frozen.accountId,
          networkId: frozen.networkId,
          transactionId: submitResult.transactionId,
          title: submitResult.title,
          detail: submitResult.message,
          meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
        });
      } else if (submitResult.status === "confirmation_delayed") {
        services.operations.upsert({
          id: opId,
          kind: "paint",
          phase: "confirmation_delayed",
          accountId: frozen.accountId,
          networkId: frozen.networkId,
          transactionId: submitResult.transactionId,
          title: submitResult.title,
          detail: submitResult.message,
          meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
        });
      } else if (submitResult.status !== "rejected") {
        services.operations.upsert({
          id: opId,
          kind: "paint",
          phase: "failed",
          accountId: frozen.accountId,
          networkId: frozen.networkId,
          transactionId: submitResult.transactionId,
          title: submitResult.title,
          detail: submitResult.message,
          meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
        });
      }
      return;
    }

    if (submitResult.status === "success" && submitResult.pixel) {
      services.operations.upsert({
        id: opId,
        kind: "paint",
        phase: "confirmed",
        accountId: frozen.accountId,
        networkId: frozen.networkId,
        transactionId: submitResult.transactionId,
        title: submitResult.title,
        detail: submitResult.message,
        meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
      });
      // Use the confirming get_pixel's block height only — never a later tip.
      rememberPixelAtBlock(
        pixelCache,
        submitResult.pixel,
        submitResult.observedBlockHeight,
      );
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      render();
      setFlow("success");
      fillResultWithLink(
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      showSelection();
      void refreshBoardFromContract({ reason: "after_draw" });
      return;
    }

    if (submitResult.status === "confirmation_delayed") {
      services.operations.upsert({
        id: opId,
        kind: "paint",
        phase: "confirmation_delayed",
        accountId: frozen.accountId,
        networkId: frozen.networkId,
        transactionId: submitResult.transactionId,
        title: submitResult.title,
        detail: submitResult.message,
        meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
      });
      setPendingPaint(pendingPaints, {
        x: frozen.x,
        y: frozen.y,
        colorIndex: frozen.colorIndex,
        accountId: frozen.accountId,
        transactionId: submitResult.transactionId,
        phase: "confirmation_delayed",
      });
      render();
      setFlow("pending");
      fillResultWithLink(
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      showSelection();
      // Do not auto-resubmit. Polling / refresh will reconcile.
      return;
    }

    if (submitResult.status === "overwritten" && submitResult.pixel) {
      services.operations.upsert({
        id: opId,
        kind: "paint",
        phase: "confirmed",
        accountId: frozen.accountId,
        networkId: frozen.networkId,
        transactionId: submitResult.transactionId,
        title: submitResult.title,
        detail: submitResult.message,
        meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
      });
      rememberPixelAtBlock(
        pixelCache,
        submitResult.pixel,
        submitResult.observedBlockHeight,
      );
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      render();
      setFlow("success");
      fillResultWithLink(
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      showSelection();
      void refreshBoardFromContract({ reason: "after_draw" });
      return;
    }

    services.operations.upsert({
      id: opId,
      kind: "paint",
      phase: "failed",
      accountId: frozen.accountId,
      networkId: frozen.networkId,
      transactionId: submitResult.transactionId,
      title: submitResult.title,
      detail: submitResult.message,
      meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
    });
    clearPendingPaint(pendingPaints, frozen.x, frozen.y);
    render();
    setFlow("error");
    fillResultWithLink(
      submitResult.title,
      submitResult.message,
      submitResult.transactionId,
      submitResult.explorerUrl,
    );
  } finally {
    drawInFlight = false;
    if (!disposed) {
      drawButton.disabled = false;
      showDrawingSession();
    }
  }
}

/**
 * Re-run connect with addFunctionCallKey while already signed in (or when the
 * checkbox path was skipped). Ordinary Connect remains available as fallback
 * on the shell wallet chrome.
 */
async function onAuthorizeSessionClick(): Promise<void> {
  if (disposed) return;
  const walletError = shellEl<HTMLElement>("#wallet-error");
  if (walletError) clearBlock(walletError);
  if (!isContractConfigured()) {
    if (walletError) {
      fillBlock(
        walletError,
        "Drawing session unavailable",
        "Set VITE_CONTRACT_ID before authorizing a drawing session.",
      );
    }
    return;
  }
  authorizeSessionButton.disabled = true;
  try {
    await services.wallet.connect({ authorizeDrawingSession: true });
    setFlow(selected ? "editing" : "connected");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    setFlow("error");
    if (walletError) {
      fillBlock(
        walletError,
        "Drawing session was not authorized",
        `Ordinary wallet approval still works for each draw. ${detail}`,
      );
    }
  } finally {
    showDrawingSession();
  }
}

function render(): void {
  renderBoard(canvas, paintedPixels(pixelCache), listPendingPaints(pendingPaints));
  positionSelection();
  updateCompactStatus();
}

function positionSelection(): void {
  if (!selected) {
    selectionRing.hidden = true;
    return;
  }
  const style = selectionRingStyle(selected);
  selectionRing.hidden = false;
  selectionRing.style.left = style.left;
  selectionRing.style.top = style.top;
  selectionRing.style.width = style.width;
  selectionRing.style.height = style.height;
  selectionRing.dataset.hasColor = selectedColor !== null ? "true" : "false";
}

function applyCamera(next: Camera): void {
  camera = next;
  const size = stageSizeStyle(camera);
  boardStage.style.width = size.width;
  boardStage.style.height = size.height;
  boardStage.style.transform = stageTransform(camera);
}

function clampToViewport(current: Camera): Camera {
  const viewport = readViewportSize();
  // Re-fit if we were essentially in overview; otherwise keep zoom and reclamps.
  if (current.cellSize <= fitCamera(viewport).cellSize * 1.05) {
    return fitCamera(viewport);
  }
  return panBy(current, viewport, 0, 0);
}

function readViewportSize(): ViewportSize {
  const rect = boardViewport.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

function zoomFromCenter(factor: number): void {
  const viewport = readViewportSize();
  applyCamera(zoomAt(camera, viewport, factor, viewport.width / 2, viewport.height / 2));
  positionSelection();
  updateCompactStatus();
}

/**
 * Pointer rules:
 * - one finger / mouse drag past threshold → pan (never paint)
 * - release without much movement → select cell
 * - two pointers → pinch zoom (never paint)
 */
function wirePointerGestures(): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let primaryId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let panning = false;
  let pinchStartDistance = 0;
  let pinchStartCellSize = 0;

  listen(boardViewport, "pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    boardViewport.setPointerCapture(pointerEvent.pointerId);
    pointers.set(pointerEvent.pointerId, {
      x: pointerEvent.clientX,
      y: pointerEvent.clientY,
    });

    if (pointers.size === 1) {
      primaryId = pointerEvent.pointerId;
      startX = pointerEvent.clientX;
      startY = pointerEvent.clientY;
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
      panning = false;
    } else if (pointers.size === 2) {
      panning = true;
      const pts = [...pointers.values()];
      pinchStartDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartCellSize = camera.cellSize;
      boardViewport.classList.add("is-panning");
    }
  });

  listen(boardViewport, "pointermove", (event) => {
    const pointerEvent = event as PointerEvent;
    if (!pointers.has(pointerEvent.pointerId)) {
      return;
    }
    pointers.set(pointerEvent.pointerId, {
      x: pointerEvent.clientX,
      y: pointerEvent.clientY,
    });

    if (pointers.size >= 2) {
      const pts = [...pointers.values()];
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStartDistance > 0) {
        const rect = boardViewport.getBoundingClientRect();
        const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
        const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
        const factor = distance / pinchStartDistance;
        applyCamera(
          zoomAt(
            { ...camera, cellSize: pinchStartCellSize },
            readViewportSize(),
            factor,
            midX,
            midY,
          ),
        );
        positionSelection();
        updateCompactStatus();
      }
      return;
    }

    if (pointerEvent.pointerId !== primaryId) {
      return;
    }

    const dx = pointerEvent.clientX - startX;
    const dy = pointerEvent.clientY - startY;
    if (!panning && isPanGesture(dx, dy)) {
      panning = true;
      boardViewport.classList.add("is-panning");
    }
    if (panning) {
      applyCamera(
        panBy(
          camera,
          readViewportSize(),
          pointerEvent.clientX - lastX,
          pointerEvent.clientY - lastY,
        ),
      );
      positionSelection();
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
    } else {
      updateHoverFromClient(pointerEvent.clientX, pointerEvent.clientY);
    }
  });

  const endPointer = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (!pointers.has(pointerEvent.pointerId)) {
      return;
    }
    pointers.delete(pointerEvent.pointerId);

    if (pointers.size < 2) {
      pinchStartDistance = 0;
    }

    if (pointerEvent.pointerId === primaryId && pointers.size === 0) {
      const wasPan = panning;
      boardViewport.classList.remove("is-panning");
      primaryId = null;
      panning = false;

      if (!wasPan) {
        selectAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
      } else {
        updateCompactStatus();
      }
      return;
    }

    if (pointers.size === 1) {
      const remaining = [...pointers.entries()][0];
      primaryId = remaining[0];
      startX = remaining[1].x;
      startY = remaining[1].y;
      lastX = remaining[1].x;
      lastY = remaining[1].y;
      panning = true;
    }
  };

  listen(boardViewport, "pointerup", endPointer);
  listen(boardViewport, "pointercancel", endPointer);
}

function selectAtClientPoint(clientX: number, clientY: number): void {
  const rect = boardViewport.getBoundingClientRect();
  const next = cellFromViewportPoint(clientX - rect.left, clientY - rect.top, camera);
  if (!next) {
    return;
  }
  selected = next;
  if (walletAccount) {
    setFlow("editing");
  }
  render();
  showSelection();
  boardFocus.focus();
  void refreshSelectedPixel();
  void refreshPlacementQuote().then(() => {
    if (disposed) {
      return;
    }
    maybeEnqueueDirectPaint(next);
  });
}

function maybeEnqueueDirectPaint(cell: Cell): void {
  if (
    !directPaintToggle.checked ||
    !canUseLocalDrawingSession(walletAccount, walletNetwork) ||
    selectedColor === null ||
    !walletAccount ||
    !contractMetaOk ||
    disposed
  ) {
    return;
  }

  let paidFields: {
    maxCost: string;
    expiresAtNs: string;
    pricingVersion: string;
  } | undefined;
  if (paidModeEnabled) {
    if (!selectedQuote) {
      fillBlock(
        result,
        "Quote required",
        "Direct paint waited for a TOILET quote before queueing. Try the cell again once the quote appears.",
      );
      return;
    }
    const timing = summarizeQuoteTiming(selectedQuote, nowNsString());
    if (timing.expired) {
      fillBlock(
        result,
        "Quote expired",
        "Refresh the quote, then tap again. Queued paints never silently raise max cost.",
      );
      void refreshPlacementQuote();
      return;
    }
    paidFields = {
      maxCost: maxCostFromQuote(selectedQuote),
      expiresAtNs: selectedQuote.expiresAtNs,
      pricingVersion: selectedQuote.pricingVersion,
    };
  }

  const queued = createDrawRequest({
    x: cell.x,
    y: cell.y,
    colorIndex: selectedColor,
    accountId: walletAccount,
    networkId: walletNetworkId(),
    ...(paidFields ?? {}),
  });
  enqueuePaint(paintQueue, queued);
  setPendingPaint(pendingPaints, {
    x: queued.x,
    y: queued.y,
    colorIndex: queued.colorIndex,
    accountId: queued.accountId,
    transactionId: null,
    phase: "submitted",
  });
  render();
  void drainPaintQueue();
}

function updateHoverFromClient(clientX: number, clientY: number): void {
  const rect = boardViewport.getBoundingClientRect();
  const cell = cellFromViewportPoint(clientX - rect.left, clientY - rect.top, camera);
  if (!cell) {
    hoverSummary.textContent = "";
    return;
  }
  hoverSummary.textContent = `Hover x=${cell.x}, y=${cell.y}`;
}

function updateDirectPaintAvailability(): void {
  const allowed =
    canUseLocalDrawingSession(walletAccount, walletNetwork) && contractMetaOk;
  directPaintToggle.disabled = !allowed;
  if (!allowed) {
    directPaintToggle.checked = false;
  }
  directPaintToggle.title = allowed
    ? "Tap cells to queue paints through your drawing session (serialized, no auto-resubmit on uncertainty)"
    : "Authorize a drawing session first to enable direct paint";
}

/**
 * Drop waiting queue entries and their pending previews.
 * An in-flight submit (already shifted out of the queue) is left alone so a
 * broadcast can finish recording on services.operations.
 */
function cancelUnsentPaintQueue(reason: string, options?: { quiet?: boolean }): void {
  if (paintQueueLength(paintQueue) === 0) {
    return;
  }
  for (const item of paintQueue.items) {
    clearPendingPaint(pendingPaints, item.x, item.y);
  }
  clearPaintQueue(paintQueue);
  if (options?.quiet || disposed) {
    return;
  }
  render();
  fillBlock(result, "Queued paints cancelled", reason);
}

async function drainPaintQueue(): Promise<void> {
  if (disposed || paintQueue.inFlight) {
    return;
  }
  // Skip (and drop) any head that no longer matches the live wallet.
  let next = shiftPaint(paintQueue);
  while (
    next &&
    !drawRequestMatchesSession(next, walletAccount, walletNetworkId())
  ) {
    clearPendingPaint(pendingPaints, next.x, next.y);
    next = shiftPaint(paintQueue);
  }
  if (!next) {
    if (!disposed) {
      render();
    }
    return;
  }
  if (disposed) {
    clearPendingPaint(pendingPaints, next.x, next.y);
    cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
      quiet: true,
    });
    return;
  }
  paintQueue.inFlight = true;
  try {
    await attemptDraw(next);
  } finally {
    paintQueue.inFlight = false;
    if (disposed) {
      cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
        quiet: true,
      });
      return;
    }
    if (paintQueueLength(paintQueue) > 0) {
      void drainPaintQueue();
    }
  }
}

async function onRevokeSessionClick(): Promise<void> {
  const walletError = shellEl<HTMLElement>("#wallet-error");
  if (walletError) clearBlock(walletError);
  const record = loadDrawingSessionRecord();
  if (!record?.publicKey) {
    if (walletError) fillBlock(
      walletError,
      "Nothing to revoke",
      "No experimental drawing-session public key is stored in this browser.",
    );
    return;
  }
  revokeSessionButton.disabled = true;
  try {
    await revokeDrawingSessionKeyOnChain(record.publicKey);
    forgetDrawingSessionLocally();
    fillBlock(
      result,
      "Revoke submitted",
      "The wallet was asked to delete the drawing-session access key on chain. Confirm in the explorer or account keys list. This browser session was cleared.",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    if (walletError) {
      fillBlock(
        walletError,
        "On-chain revoke did not complete",
        `The key may still exist on chain. ${detail}`,
      );
    }
  } finally {
    showDrawingSession();
  }
}

function showSelection(): void {
  const colorLabel =
    selectedColor === null ? "none yet" : `${colorName(selectedColor)} (index ${selectedColor})`;

  updatePreview();
  positionSelection();

  if (!selected) {
    selectionSummary.textContent = `No square selected. Chosen paint: ${colorLabel}. Unpainted squares have no artist.`;
    return;
  }

  const cached = getCachedPixel(pixelCache, selected.x, selected.y);
  let cellText: string;
  if (!cached || cached.colorIndex === null) {
    cellText = isContractConfigured()
      ? "This square has no confirmed paint in our cache (unpainted or not read yet)."
      : "This square is unpainted on the local mock board.";
  } else {
    const paintedName = colorName(cached.colorIndex);
    const artist = cached.artistAccountId ?? "unknown account";
    cellText = `On-chain credit: ${paintedName} (index ${cached.colorIndex}) by ${artist}. Credit is the latest writer, not legal ownership.`;
  }

  selectionSummary.textContent = `Selected square x=${selected.x}, y=${selected.y}. Chosen paint: ${colorLabel}. Counting starts at the top-left. ${cellText}`;
}

function updatePreview(): void {
  preview.replaceChildren();
  const label = document.createElement("span");
  label.className = "preview-label";

  if (selectedColor === null) {
    label.textContent = "Paint preview: pick a named color.";
    preview.append(label);
    return;
  }

  const swatch = PALETTE.find((item) => item.index === selectedColor);
  if (!swatch) {
    label.textContent = "Paint preview: invalid color.";
    preview.append(label);
    return;
  }

  const chip = document.createElement("span");
  chip.className = "chip";
  chip.style.background = swatch.hex;
  chip.setAttribute("aria-hidden", "true");
  label.textContent = `Paint preview: ${swatch.name} (palette index ${swatch.index})`;
  preview.append(chip, label);
}

/**
 * Experimental drawing-session panel. Uses textContent only.
 */
function showDrawingSession(): void {
  const status = describeDrawingSession({
    contractId: CONTRACT_ID,
    accountId: walletAccount,
    networkId: walletNetwork,
    record: loadDrawingSessionRecord(),
  });
  drawingSessionStatus.textContent = `${status.title}. ${status.message}`;
  drawingSessionNote.textContent = [
    `Configured allowance for a new session: ${status.allowanceLabel}.`,
    "Renewal: authorize again to request a new limited key (old on-chain keys are not auto-removed).",
    "Forget clears this browser only. Revoke on-chain asks the wallet to DeleteKey.",
  ].join(" ");

  const canUseContract = isContractConfigured();
  const sessionActive = status.phase === "active";
  authorizeSessionButton.disabled = !canUseContract || sessionActive;
  forgetSessionButton.disabled =
    status.record === null || status.phase === "forgotten_locally";
  revokeSessionButton.disabled = !sessionActive || !walletAccount;
  updateDirectPaintAvailability();

  if (sessionActive && walletAccount) {
    void refreshAllowanceNote(walletAccount, walletNetwork ?? PAGE_NETWORK);
  }
}

async function refreshAllowanceNote(
  accountId: string,
  networkId: string,
): Promise<void> {
  try {
    const info = await fetchDrawingSessionAllowance({ accountId, networkId });
    if (!info.found) {
      drawingSessionNote.textContent = `${drawingSessionNote.textContent} Live key check: not found on account — authorize again.`;
      return;
    }
    const remaining =
      info.remainingYocto === null
        ? "unlimited or unknown"
        : formatAllowanceNear(info.remainingYocto);
    drawingSessionNote.textContent = [
      `Live remaining allowance: ${remaining}.`,
      info.permissionSummary,
      "Forget clears this browser only. Revoke on-chain asks the wallet to DeleteKey.",
    ].join(" ");
  } catch {
    // Keep the static note if the live query fails.
  }
}

function updateCompactStatus(): void {
  const network = isContractConfigured() ? PAGE_NETWORK : "mock";
  const account = walletAccount ? walletAccount : "not connected";
  const zoom = `~${camera.cellSize.toFixed(1)} px/cell`;
  const pendingCount = listPendingPaints(pendingPaints).length;
  const pendingLabel =
    pendingCount > 0 ? ` · ${pendingCount} pending` : "";
  const fresh =
    boardSync.lastAppliedAtMs === null
      ? ""
      : ` · ${formatFreshness(boardSync, Date.now()).replace(/^Board freshness: /, "")}`;
  compactStatus.textContent = `${network} · ${account} · ${zoom}${pendingLabel}${fresh} · no app fee`;
}

function fillRules(): void {
  const lines = [
    `The board is ${BOARD_WIDTH} by ${BOARD_HEIGHT} squares.`,
    "Square (0, 0) is the top-left. x counts to the right. y counts downward.",
    "An unpainted square is not a color. It has no stored artist. Palette index 0 is Ink, a real paint color.",
    "Overwrite rule: Open wall. Any connected account may paint any pixel, including one someone else painted. Vandalism is possible.",
    "The current artist is credit for the latest successful write. That is not a legal claim on the artwork.",
    "Explore with pan and zoom. Only Place paint (or Enter) submits a draw — drag and pinch never paint.",
    isContractConfigured()
      ? `Game contract: ${CONTRACT_ID} on ${PAGE_NETWORK}. On open (and Refresh), the page loads every painted cell via paginated get_pixels. Success still requires a transaction id and a matching get_pixel read.`
      : "No game contract id is configured yet (VITE_CONTRACT_ID empty), so this page will not open a draw signature or claim a chain success.",
    sponsorship.flagEnabled
      ? "Sponsorship flag is on, but the submit path stays ordinary wallet until a sponsor service exists."
      : "Sponsorship is off. No cross-chain or paid checkout is offered on this page.",
    paidModeEnabled
      ? useMockQuotes
        ? `Paint-cost UI is on (${MOCK_QUOTE_DEMO_LABEL}). Live paid draw/get_quote wait on the board contract (Worker B). Free draw still used until a paid schema is live.`
        : "Paint-cost UI is on from paid board metadata. Quotes and max-cost checks apply before Place."
      : "Paid-paint UI is off (VITE_PAID_PAINT unset/false and unpaid schema). Free-board Place path is unchanged.",
  ];
  const list = document.createElement("ul");
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  rules.replaceChildren(list);
}

function buildPalette(): void {
  for (const swatch of PALETTE) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute(
      "aria-label",
      `${swatch.name}, palette index ${swatch.index}, color ${swatch.hex}`,
    );
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = swatch.hex;
    chip.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = `${swatch.name} (${swatch.index})`;
    button.append(chip, label);
    button.addEventListener("click", () => {
      selectedColor = swatch.index;
      for (const other of palette.querySelectorAll("button")) {
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      }
      if (walletAccount && selected) {
        setFlow("editing");
      }
      render();
      showSelection();
      void refreshPlacementQuote();
    });
    palette.append(button);
  }
}

function setFlow(phase: typeof uiPhase): void {
  uiPhase = phase;
  const labels: Record<typeof uiPhase, string> = {
    disconnected: "State: disconnected — look freely; draw needs a wallet.",
    connected: "State: connected — pick a square and a named color.",
    editing: "State: editing — review the pixel rule, then Place paint.",
    wallet_prompt: "State: wallet prompt — approve or reject in your wallet.",
    pending: "State: pending — waiting for transaction confirmation + board read.",
    success: "State: success — chain read matched your draw.",
    error: "State: error — recoverable; you can change selection or reconnect.",
  };
  flowState.textContent = labels[phase];
  flowState.dataset.phase = phase;
}

/** textContent only. Account ids and error strings must not be inserted as HTML. */
function fillBlock(host: HTMLElement, title: string, message: string): void {
  host.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  host.append(heading, paragraph);
}

function fillResultWithLink(
  title: string,
  message: string,
  transactionId: string | null,
  explorer: string | null,
): void {
  result.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  result.append(heading, paragraph);
  if (transactionId) {
    const idLine = document.createElement("p");
    idLine.textContent = `Transaction id: ${transactionId}`;
    result.append(idLine);
  }
  if (explorer) {
    const link = document.createElement("a");
    link.href = explorer;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open transaction in explorer";
    result.append(link);
  }
}

function clearBlock(host: HTMLElement): void {
  host.replaceChildren();
}

function colorName(index: number): string {
  return PALETTE.find((swatch) => swatch.index === index)?.name ?? `index ${index}`;
}

function walletNetworkId(): NetworkId {
  if (
    walletNetwork === "mock" ||
    walletNetwork === "localnet" ||
    walletNetwork === "testnet" ||
    walletNetwork === "mainnet"
  ) {
    return walletNetwork;
  }
  return PAGE_NETWORK;
}

  function disposeWall(): void {
    if (disposed) return;
    disposed = true;
    clearBoardPoll();
    loadAbort.abort();
    quoteFetchGeneration += 1;
    pressureHooks.dispose();
    // Drop unsent queue work; an in-flight attemptDraw may still settle into
    // services.operations. Do not continue draining after leave.
    cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
      quiet: true,
    });
    resizeObserver.disconnect();
    for (const cleanup of listenerCleanups) {
      try {
        cleanup();
      } catch {
        // ignore listener cleanup errors
      }
    }
    listenerCleanups.length = 0;
    // Do NOT clear services.operations — broadcast ops must survive navigation.
    pageRoot.replaceChildren();
  }

  return disposeWall;
}

