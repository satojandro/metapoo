import { strokeBegin, strokeExtend, MAX_BATCH, type StrokeState } from "./stroke-paint";
import { planStrokeCommit, strokeResultCopy, TRUNCATED_STROKE_COPY, WALLET_STROKE_COPY } from "./stroke-commit";
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
  signAndSendStrokeLocally,
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
import { createGestureState, updateGesture } from "../../gesture";
import { moveSelection, type Cell } from "../../selection";
import { describeSponsorship } from "../../sponsorship";
import { submitDraw } from "../../submit-draw";
import {
  createCameraTransform,
  fitCamera,
  FIT_MIN_CELL_PX,
  isPaintZoom,
  MAX_CELL_PX,
  paintZoomCamera,
  PAINT_CELL_PX,
  panBy,
  zoomAt,
  type Camera,
  type CameraTransform,
  type ViewportSize,
} from "../../viewport";
import { mountWallZoomControls } from "../../wall-zoom-controls";
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
import { mountWallHint } from "../../wall-hint";
import {
  createPlacementOutcomeController,
  mountPlacementOutcomeLayer,
} from "./placement-outcome";

/**
 * Fixture action_nonce when live get_account is not wired yet.
 * Paid contract requires last_action_nonce + 1; fresh accounts start at 0 → "1".
 */
const FIXTURE_ACTION_NONCE = "1";

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
  pendingPaintCount: () => number;
  /** Test-only read seam for verifying board-load ordering. */
  refreshPixel: (cell: Cell) => Promise<void>;
  cachedPixelColor: (cell: Cell) => number | null | undefined;
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
  const stallScene = mustFindIn<HTMLElement>(pageRoot, ".stall-scene");
  const selectionRing = mustFindIn<HTMLElement>(pageRoot, "#selection-ring");
  const boardFocus = mustFindIn<HTMLElement>(pageRoot, "#board-focus");
  const boardViewport = mustFindIn<HTMLElement>(pageRoot, "#board-viewport");
  const boardStage = mustFindIn<HTMLElement>(pageRoot, "#board-stage");
  const boardToolbar = mustFindIn<HTMLElement>(pageRoot, ".board-toolbar");
  const selectionSummary = mustFindIn<HTMLElement>(pageRoot, "#selection-summary");
  const preview = mustFindIn<HTMLElement>(pageRoot, "#selection-preview");
  const palette = mustFindIn<HTMLElement>(pageRoot, "#palette");
  const drawButton = mustFindIn<HTMLButtonElement>(pageRoot, "#draw-button");
  const drawState = mustFindIn<HTMLElement>(pageRoot, "#draw-state");
  const result = mustFindIn<HTMLElement>(pageRoot, "#result");
  const rules = mustFindIn<HTMLElement>(pageRoot, "#rules");
  const sponsorNote = mustFindIn<HTMLElement>(pageRoot, "#sponsor-note");
  const evidence = mustFindIn<HTMLElement>(pageRoot, "#evidence");
  const lede = mustFindIn<HTMLElement>(pageRoot, "#lede");
  const refreshButton = mustFindIn<HTMLButtonElement>(pageRoot, "#refresh-board");
  const boardLoadStatus = mustFindIn<HTMLElement>(pageRoot, "#board-load-status");
  const boardFreshness = mustFindIn<HTMLElement>(pageRoot, "#board-freshness");
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
  const tapToPaintAffordanceCandidate = directPaintToggle.closest<HTMLLabelElement>("label");
  if (!tapToPaintAffordanceCandidate) {
    throw new Error("The wall page is missing the tap-to-paint affordance.");
  }
  const tapToPaintAffordance = tapToPaintAffordanceCandidate;
  // The status line is presentation, so it lives in the template with a real
  // class. It used to be created here with no styling at all, which is how a
  // developer-facing sentence ended up as raw body text in the paint dock.
  const tapToPaintAnnouncement = mustFindIn<HTMLElement>(
    pageRoot,
    "#tap-to-paint-status",
  );
  directPaintToggle.setAttribute("aria-describedby", tapToPaintAnnouncement.id);

  // One-approval unlock. This is the visible entry point to the drawing
  // session; the authorise/revoke panel stays in About / details for people
  // who want the details, but nobody should have to find it to start painting.
  const paintUnlock = mustFindIn<HTMLElement>(pageRoot, "#paint-unlock");
  const paintUnlocked = mustFindIn<HTMLElement>(pageRoot, "#paint-unlocked");
  const unlockPaintButton = mustFindIn<HTMLButtonElement>(
    pageRoot,
    "#unlock-paint-button",
  );

  // Keep the current cell coordinates available when keyboard users reach Place.
  drawButton.setAttribute("aria-describedby", "selection-summary");

  // The pointer preview is mount-owned so the wall template remains presentation-only.
  // It is deliberately separate from selection: moving or dragging never paints.
  const pointerPreview = document.createElement("div");
  pointerPreview.className = "pointer-preview";
  pointerPreview.hidden = true;
  pointerPreview.setAttribute("aria-hidden", "true");
  boardViewport.append(pointerPreview);

  const positionReadout = document.createElement("div");
  positionReadout.className = "position-readout";
  positionReadout.setAttribute("role", "status");
  positionReadout.setAttribute("aria-live", "off");
  boardFocus.append(positionReadout);

  const wallHint = mountWallHint(stallScene);

  // Shell-owned status strip (survives wall dispose; safe if missing in tests).
  const flowState = shellEl<HTMLElement>("#flow-state") ?? document.createElement("p");
  const compactStatus =
    shellEl<HTMLElement>("#compact-status") ?? document.createElement("p");

  const pixelCache = createPixelCache();
  const pendingPaints = createPendingPaintMap();
  const placementOutcomes = createPlacementOutcomeController();
  const queuedPlacementOutcomes = new WeakMap<DrawRequest, string>();
  const unmountPlacementOutcomes = mountPlacementOutcomeLayer(
    boardViewport,
    placementOutcomes,
  );
  const boardSync = createBoardSyncState();
  const paintQueue = createPaintQueue();

  function showBoardFreshness(): void {
    if (boardSync.lastAppliedAtMs === null) {
      boardFreshness.textContent = boardSync.consecutiveFailures > 0
        ? "Board update failed; not read successfully yet."
        : "Board not read yet.";
      return;
    }
    const freshness = formatFreshness(boardSync, Date.now()).replace(
      /^Board freshness: /,
      "",
    );
    boardFreshness.textContent = boardSync.consecutiveFailures > 0
      ? `Board update failed; last ${freshness}`
      : `Board last updated ${freshness}`;
  }

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
  let tapToPaintEnabled = directPaintToggle.checked;
  // Direct paint is a pre-approval, not a second permission: once a drawing
  // session exists, clicking a square should just paint (Berry Club flow).
  // `null` = follow the session; a boolean = the user has decided.
  let tapToPaintUserChoice: boolean | null = null;
  let walletAccount: string | null = null;
  let walletNetwork: string | null = null;
  let drawInFlight = false;
  type AnchoredStroke = { state: StrokeState; accountId: string; networkId: string; color: number };
  let activeStroke: AnchoredStroke | null = null;

  let boardLoadInFlight = false;
  /** False until get_board metadata matches shared constants (or mock mode). */
  let contractMetaOk = !isContractConfigured();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let camera: Camera = { cellSize: 4, panX: 0, panY: 0 };
  let viewTransform: CameraTransform = createCameraTransform(camera);
  let disposed = false;
  let loadAbort: AbortController = new AbortController();
  /** High-level UI phase for the status strip. */
  let uiPhase:
    | "disconnected"
    | "connected"
    | "editing"
    | "wallet_prompt"
    | "submitted"
    | "confirmed"
    | "confirmation_delayed"
    | "overwritten"
    | "failed" = "disconnected";

  const listenerCleanups: Array<() => void> = [];
  const zoomStateListeners = new Set<() => void>();
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

  listenerCleanups.push(
    mountWallZoomControls(boardToolbar, {
      getCurrentZoom: readZoomState,
      zoomBy: zoomFromCenter,
      zoomToFit: fitWallToView,
      subscribe: (listener) => {
        zoomStateListeners.add(listener);
        return () => zoomStateListeners.delete(listener);
      },
    }),
  );

  // Enlarge the real canvas without altering its pixels or wallet state.
  const focusCanvas = mustFindIn<HTMLButtonElement>(pageRoot, "#focus-canvas");
  listen(focusCanvas, "click", () => {
    const focused = pageRoot.querySelector(".wall-layout")!.classList.toggle("is-focused");
    focusCanvas.setAttribute("aria-pressed", String(focused));
    focusCanvas.textContent = focused ? "Back to the stall ↙" : "Focus canvas ↗";
  });

  const sponsorship = describeSponsorship();
  sponsorNote.textContent = sponsorship.message;

  lede.textContent = isContractConfigured()
    ? "A live communal pixel wall on NEAR. Explore freely. Drawing asks your wallet to approve one on-chain paint."
    : "Preview mode · Explore the wall. Blockchain painting is not connected yet.";

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
    pendingPaintCount: () => listPendingPaints(pendingPaints).length,
    refreshPixel: (cell) => refreshSelectedPixel(cell),
    cachedPixelColor: (cell) => getCachedPixel(pixelCache, cell.x, cell.y)?.colorIndex,
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
    tapToPaintUserChoice = directPaintToggle.checked;
    updateDirectPaintAvailability();
  });

  listen(unlockPaintButton, "click", () => {
    void onAuthorizeSessionClick();
  });

  listen(refreshButton, "click", () => {
    void refreshBoardFromContract();
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
      fitWallToView();
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
      wallHint.selectionSucceeded();
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
      activeStroke = null;
      cancelUnsentPaintQueue("Wallet account or network changed.");
      // Account/network change invalidates quote authorization — fresh intent required.
      selectedQuote = null;
      selectedQuoteSource = null;
      void refreshPlacementQuote();
    }
    if (!walletAccount) {
      setFlow("disconnected");
    } else if (uiPhase === "disconnected" || uiPhase === "failed") {
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
  wallHint.selectionSucceeded();
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
    showBoardFreshness();
    render();
    showSelection();
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
    updateCompactStatus();
    scheduleBoardPoll();
  }
}

async function refreshSelectedPixel(cell = selected): Promise<void> {
  if (!cell || !isContractConfigured()) {
    showSelection();
    return;
  }
  const loadId = beginBoardLoad(boardSync);
  try {
    const { pixel, blockHeight } = await getPixelWithBlock(cell.x, cell.y);
    // A cell response is board evidence too.  Do not let it replace a newer
    // full snapshot (or another cell read), including after unmount.
    if (
      disposed ||
      loadAbort.signal.aborted ||
      !shouldApplyBoardLoad(boardSync, loadId, blockHeight)
    ) {
      return;
    }
    rememberPixelAtBlock(pixelCache, pixel, blockHeight);
    reconcilePendingWithConfirmed(pendingPaints, [pixel]);
    markBoardLoadApplied(boardSync, loadId, blockHeight, Date.now());
    showBoardFreshness();
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
  if (
    disposed ||
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

async function attemptDraw(
  request?: DrawRequest,
  queuedPlacementOutcomeId?: string,
): Promise<void> {
  if (disposed || drawInFlight) {
    return;
  }

  // Fresh Place path: authorize at the current quote cost (never silently raise).
  let placeAuthorization:
    | {
        maxCost: string;
        expiresAtNs: string;
        pricingVersion: string;
        actionNonce: string;
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
      // Live path should use get_account.last_action_nonce + 1 when available.
      actionNonce: FIXTURE_ACTION_NONCE,
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
    setFlow("failed");
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
  const placementOutcomeId = queuedPlacementOutcomeId ?? placementOutcomes.submit({
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
      ...(frozen.maxCost !== undefined &&
      frozen.expiresAtNs !== undefined &&
      frozen.pricingVersion !== undefined
        ? {
            paid: {
              maxCost: frozen.maxCost,
              expiresAtNs: frozen.expiresAtNs,
              pricingVersion: frozen.pricingVersion,
              actionNonce: frozen.actionNonce ?? FIXTURE_ACTION_NONCE,
              ...(frozen.sessionId !== undefined
                ? { sessionId: frozen.sessionId }
                : {}),
            },
          }
        : {}),
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
          setFlow("submitted");
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
              : "Re-reading the pixel to distinguish confirmed ownership from a later overwrite…",
            progress.transactionId,
            progress.explorer,
          );
        }
      },
    });
    placementOutcomes.settle(placementOutcomeId, submitResult);

    if (disposed) {
      // Page left while this draw was in flight: keep operations store, skip DOM.
      if (submitResult.status === "confirmed" || submitResult.status === "overwritten") {
        services.operations.upsert({
          id: opId,
          kind: "paint",
          phase: submitResult.status,
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

    if (submitResult.status === "confirmed" && submitResult.pixel) {
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
      setFlow("confirmed");
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
      setFlow("confirmation_delayed");
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
        phase: "overwritten",
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
      setFlow("overwritten");
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
    setFlow("failed");
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
  unlockPaintButton.disabled = true;
  try {
    await services.wallet.connect({ authorizeDrawingSession: true });
    setFlow(selected ? "editing" : "connected");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    setFlow("failed");
    if (walletError) {
      fillBlock(
        walletError,
        "Drawing session was not authorized",
        `Ordinary wallet approval still works for each draw. ${detail}`,
      );
    }
  } finally {
    unlockPaintButton.disabled = false;
    showDrawingSession();
  }
}

function render(): void {
  renderBoard(canvas, paintedPixels(pixelCache), [
    ...listPendingPaints(pendingPaints),
    ...(activeStroke?.state.cells.map(cell => ({ ...cell,
      colorIndex: activeStroke!.color, accountId: activeStroke!.accountId,
      transactionId: null, phase: "submitted" as const,
    })) ?? []),
  ]);
  positionSelection();
  updatePositionReadout();
  updateCompactStatus();
}

function updatePositionReadout(): void {
  const fitCellSize = fitCamera(readViewportSize()).cellSize;
  const zoomPercent = Math.max(1, Math.round((camera.cellSize / fitCellSize) * 100));
  const cellLabel = selected
    ? `Cell (${selected.x}, ${selected.y})`
    : "Cell: none selected";
  positionReadout.textContent = `Zoom ${zoomPercent}% · ${cellLabel}`;
  positionReadout.setAttribute(
    "aria-label",
    selected
      ? `Zoom ${zoomPercent} percent of whole-wall view. Selected cell: column ${selected.x}, row ${selected.y}.`
      : `Zoom ${zoomPercent} percent of whole-wall view. No cell selected.`,
  );
}

function positionSelection(): void {
  if (!selected) {
    selectionRing.hidden = true;
    return;
  }
  const rect = viewTransform.cellRect(selected);
  selectionRing.hidden = false;
  selectionRing.style.left = `${rect.left}px`;
  selectionRing.style.top = `${rect.top}px`;
  selectionRing.style.width = `${rect.width}px`;
  selectionRing.style.height = `${rect.height}px`;
  selectionRing.dataset.hasColor = selectedColor !== null ? "true" : "false";
}

function applyCamera(next: Camera): void {
  viewTransform = createCameraTransform(next);
  camera = viewTransform.camera;
  boardStage.style.width = `${viewTransform.stage.width}px`;
  boardStage.style.height = `${viewTransform.stage.height}px`;
  boardStage.style.transform = viewTransform.stage.transform;
  positionSelection();
  updatePositionReadout();
  for (const listener of zoomStateListeners) listener();
}

function readZoomState() {
  const fittedCamera = fitCamera(readViewportSize());
  const fitted =
    Math.abs(camera.cellSize - fittedCamera.cellSize) < 1e-6 &&
    Math.abs(camera.panX - fittedCamera.panX) < 1e-6 &&
    Math.abs(camera.panY - fittedCamera.panY) < 1e-6;
  return {
    current: camera.cellSize,
    minimum: FIT_MIN_CELL_PX,
    maximum: MAX_CELL_PX,
    fitted,
  };
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

function fitWallToView(): void {
  applyCamera(fitCamera(readViewportSize()));
  positionSelection();
  updateCompactStatus();
}

/**
 * Pointer rules:
 * - direct paint armed (session + colour + consent): one pointer paints a stroke
 * - panning while armed is a deliberate gesture: middle/right button, held
 *   space, two fingers, or a drag that starts outside the board
 * - otherwise one finger / mouse drag past threshold → pan (never paint)
 * - release without much movement → select cell
 * - two pointers → pinch zoom (never paint)
 *
 * Paint zoom is deliberately NOT part of arming. Requiring a zoom level to be
 * allowed to drag-paint was an invented precondition: it made drag silently
 * pan for every user who had not discovered the zoom button, and the button
 * carried no state to discover.
 */
function wirePointerGestures(): void {
  let gesture = createGestureState();
  let strokeCancelled = false;
  let spaceHeld = false;
  const cancelStroke = () => { activeStroke = null; strokeCancelled = true; render(); };
  listen(boardViewport, "wheel", () => { if (gesture.points.length) cancelStroke(); });
  listen(boardViewport, "lostpointercapture", cancelStroke);

  // Space is the conventional "temporarily pan" modifier. Ignore it while a
  // control is focused so the keyboard path for the palette keeps working.
  listen(window, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== " " || (event as KeyboardEvent).repeat) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
    spaceHeld = true;
  });
  listen(window, "keyup", (event) => {
    if ((event as KeyboardEvent).key === " ") spaceHeld = false;
  });
  // Right-drag is a pan gesture here, so the browser menu must not interrupt it.
  listen(boardViewport, "contextmenu", (event) => event.preventDefault());

  let lastX = 0;
  let lastY = 0;
  let pinchStartDistance = 0;
  let pinchStartCamera: Camera | null = null;
  // The reducer decides whether a sequence is a tap. Keep its originating
  // cell alongside that state so a sub-threshold move across tiny fitted
  // cells cannot turn a touch scroll/pan into a placement on another cell.
  let tapStartCell: Cell | null = null;

  const gestureEvent = (
    event: PointerEvent,
    beganOnPanSurface = false,
  ) => ({
    type: event.type as
      | "pointerdown"
      | "pointermove"
      | "pointerup"
      | "pointercancel",
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    timeStamp: event.timeStamp,
    beganOnPanSurface,
  });

  listen(boardViewport, "pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    boardViewport.setPointerCapture(pointerEvent.pointerId);
    const rect = boardViewport.getBoundingClientRect();
    const beganCell = viewTransform.cellAt(
      pointerEvent.clientX - rect.left,
      pointerEvent.clientY - rect.top,
    );
    const beganOnPanSurface = beganCell === null;
    if (gesture.points.length === 0) {
      tapStartCell = beganCell;
    }
    const update = updateGesture(
      gesture,
      gestureEvent(pointerEvent, beganOnPanSurface),
    );
    gesture = update.state;

    if (gesture.points.length === 1) {
      strokeCancelled = false;
      const cell = cellAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
      // A non-primary button or a held space means "I want to move the board",
      // not "I want to paint here". That is the only way drag-painting can be
      // unconditional at every zoom level.
      const wantsPan =
        pointerEvent.button === 1 ||
        pointerEvent.button === 2 ||
        spaceHeld ||
        beganOnPanSurface;
      if (cell && !wantsPan && directPaintToggle.checked &&
          walletAccount && selectedColor !== null && contractMetaOk &&
          !drawInFlight && !paintQueue.inFlight && !paintQueueLength(paintQueue) &&
          canUseLocalDrawingSession(walletAccount, walletNetwork)) {
        activeStroke = { state: strokeBegin(cell), accountId: walletAccount,
          networkId: walletNetworkId(), color: selectedColor };
        render();
      }
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
    } else if (gesture.points.length === 2) {
      cancelStroke();
      const pts = gesture.points;
      pinchStartDistance = Math.hypot(
        pts[0].clientX - pts[1].clientX,
        pts[0].clientY - pts[1].clientY,
      );
      // Every pinch frame derives from the same camera. Mixing a prior frame's
      // pan with the initial cell size makes the board jump under two fingers.
      pinchStartCamera = { ...camera };
      boardViewport.classList.add("is-panning");
    }
  });

  listen(boardViewport, "pointermove", (event) => {
    const pointerEvent = event as PointerEvent;
    if (!gesture.points.some((point) => point.pointerId === pointerEvent.pointerId)) {
      updatePointerPreview(pointerEvent);
      return;
    }
    const update = updateGesture(gesture, gestureEvent(pointerEvent));
    gesture = update.state;

    if (update.activeKind === "pinch" && gesture.points.length >= 2) {
      const pts = gesture.points;
      const distance = Math.hypot(
        pts[0].clientX - pts[1].clientX,
        pts[0].clientY - pts[1].clientY,
      );
      if (pinchStartDistance > 0 && pinchStartCamera) {
        const rect = boardViewport.getBoundingClientRect();
        const midX = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
        const midY = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
        const factor = distance / pinchStartDistance;
        applyCamera(
          zoomAt(
            pinchStartCamera,
            readViewportSize(),
            factor,
            midX,
            midY,
          ),
        );
        positionSelection();
        updateCompactStatus();
      }
      updatePointerPreview(pointerEvent);
      return;
    }

    if (pointerEvent.pointerId !== gesture.primaryId) {
      return;
    }

    if (activeStroke) {
      const cell = cellAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
      if (cell) activeStroke.state = strokeExtend(activeStroke.state, cell);
      render();
      if (activeStroke.state.truncated) fillBlock(result, "Stroke limit", TRUNCATED_STROKE_COPY);
      updatePointerPreview(pointerEvent);
      return;
    }
    if (update.activeKind === "drag" || update.activeKind === "pan") {
      boardViewport.classList.add("is-panning");
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
    }
    updatePointerPreview(pointerEvent);
  });

  const endPointer = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.type === "pointercancel") {
      cancelStroke();
      clearPointerPreview();
    }
    if (!gesture.points.some((point) => point.pointerId === pointerEvent.pointerId)) {
      return;
    }
    const update = updateGesture(gesture, gestureEvent(pointerEvent));
    gesture = update.state;

    if (gesture.points.length < 2) {
      pinchStartDistance = 0;
      pinchStartCamera = null;
    }

    if (update.completedKind !== null) {
      boardViewport.classList.remove("is-panning");

      if (activeStroke) {
        const cell = cellAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
        if (cell) activeStroke.state = strokeExtend(activeStroke.state, cell);
        const stroke = activeStroke;
        activeStroke = null;
        // Long presses and cancelled gestures retain the classifier's guards.
        if (update.completedKind === "tap" || update.completedKind === "drag") {
          if (stroke.state.cells.length > 1) void commitStroke(stroke);
          else if (update.completedKind === "tap") selectAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
        }
        render();
        return;
      }
      if (strokeCancelled) { updateCompactStatus(); return; }
      // Only the pure classifier's deliberate-tap result may reach selection
      // or direct paint. It must also end in the cell where it started:
      // fitted cells can be smaller than the movement threshold. Drag, pan,
      // pinch, long press, cancel, and cross-cell releases are discarded.
      const beganCell = tapStartCell;
      tapStartCell = null;
      const rect = boardViewport.getBoundingClientRect();
      const endedCell = viewTransform.cellAt(
        pointerEvent.clientX - rect.left,
        pointerEvent.clientY - rect.top,
      );
      if (
        update.completedKind === "tap" &&
        beganCell !== null &&
        endedCell !== null &&
        beganCell.x === endedCell.x &&
        beganCell.y === endedCell.y
      ) {
        selectAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
      } else {
        updateCompactStatus();
      }
      return;
    }

    if (gesture.points.length === 1) {
      const remaining = gesture.points[0];
      lastX = remaining.clientX;
      lastY = remaining.clientY;
      boardViewport.classList.add("is-panning");
    }
  };

  listen(boardViewport, "pointerup", endPointer);
  listen(boardViewport, "pointercancel", endPointer);
  listen(boardViewport, "pointerleave", clearPointerPreview);
}

function cellAtClientPoint(clientX: number, clientY: number): Cell | null {
  const rect = boardViewport.getBoundingClientRect();
  return viewTransform.cellAt(clientX - rect.left, clientY - rect.top);
}

async function commitStroke(stroke: AnchoredStroke): Promise<void> {
  if (disposed || drawInFlight || stroke.accountId !== walletAccount ||
      stroke.networkId !== walletNetworkId() || !directPaintToggle.checked) return;
  const plan = planStrokeCommit(stroke.state, canUseLocalDrawingSession(walletAccount, walletNetwork));
  if (plan.kind === "wallet_approval") {
    fillBlock(result, "Drawing session needed", WALLET_STROKE_COPY);
    return;
  }
  drawInFlight = true;
  for (const cell of stroke.state.cells) setPendingPaint(pendingPaints, {
    ...cell, colorIndex: stroke.color, accountId: stroke.accountId,
    transactionId: null, phase: "submitted",
  });
  render();
  setFlow("submitted");
  try {
    const outcome = await signAndSendStrokeLocally({
      accountId: stroke.accountId, networkId: stroke.networkId,
      cells: stroke.state.cells, color: stroke.color,
    });
    if (disposed) return;
    // Resolve known outcomes through a fresh chain read; uncertain cells keep
    // a pending marker. Never infer execution from matching pre-existing paint.
    const uncertain = outcome.failingChunk?.mayHaveBroadcast;
    const uncertainStart = outcome.confirmedChunks * MAX_BATCH;
    for (const [i, cell] of stroke.state.cells.entries()) {
      if (uncertain && i >= uncertainStart && i < uncertainStart + MAX_BATCH) {
        setPendingPaint(pendingPaints, { ...cell, colorIndex: stroke.color,
          accountId: stroke.accountId, transactionId: null, phase: "confirmation_delayed" });
      } else clearPendingPaint(pendingPaints, cell.x, cell.y);
    }
    fillBlock(result, outcome.status === "confirmed" ? "Stroke confirmed" : "Stroke stopped", strokeResultCopy(stroke.state, outcome));
    setFlow(outcome.status === "confirmed" ? "confirmed" : "confirmation_delayed");
    // Stroke execution and latest ownership are distinct; do not reuse the
    // single-cell label that promises a matching confirming read.
    const statusText = outcome.status === "confirmed"
      ? "Stroke transactions executed. Refreshing the latest board state."
      : "Stroke stopped. Review the batch results before painting again.";
    // Keep the reason where it cannot scroll away: the dock line persists, the
    // result block is one action away from being replaced.
    const failureReason =
      outcome.status === "confirmed" ? null : outcome.failingChunk?.message;
    if (failureReason) {
      // Also to the console, so a tester can hand back the exact error.
      console.error("[wall] stroke submission failed:", failureReason);
    }
    flowState.textContent = statusText;
    drawState.textContent = failureReason
      ? `${statusText} Reason: ${failureReason}`
      : statusText;
    await refreshBoardFromContract({ reason: "after_draw" });
  } finally {
    drawInFlight = false;
    if (!disposed) render();
  }
}

function selectAtClientPoint(clientX: number, clientY: number): void {
  const next = cellAtClientPoint(clientX, clientY);
  if (!next) {
    return;
  }
  selected = next;
  wallHint.selectionSucceeded();
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
    // Paint zoom is the deliberate, r/place-style direct-placement mode. It
    // relaxes the two-step form (tap = place), but NEVER the consent toggle:
    // direct submission requires the user to have opted in, same as 2-step
    // mode, plus the pre-authorized local drawing session. A gesture never
    // routes through a form submission, and never submits unrequested.
    maybeEnqueueDirectPaint(next, { paintZoom: isPaintZoom(camera) });
  });
}

function maybeEnqueueDirectPaint(
  cell: Cell,
  options: { paintZoom: boolean } = { paintZoom: false },
): void {
  if (
    drawInFlight ||
    !tapToPaintEnabled ||
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
    actionNonce: string;
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
      actionNonce: FIXTURE_ACTION_NONCE,
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
  // A direct tap gets a mount-local pending marker immediately, before the
  // serialized draw reaches the existing submit path. It is never a second
  // submission path: drainPaintQueue hands this id to attemptDraw below.
  queuedPlacementOutcomes.set(
    queued,
    placementOutcomes.submit({
      x: queued.x,
      y: queued.y,
      colorIndex: queued.colorIndex,
    }),
  );
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

function updatePointerPreview(event: PointerEvent): void {
  // Hover is a fine-pointer affordance only. On a touch pointer, or on a
  // surface that owns touch gestures, it must neither show a prospective cell
  // nor participate in the tap-to-paint route.
  if (
    event.pointerType === "touch" ||
    getComputedStyle(boardViewport).touchAction !== "auto"
  ) {
    clearPointerPreview();
    return;
  }
  const rect = boardViewport.getBoundingClientRect();
  const cell = viewTransform.cellAt(event.clientX - rect.left, event.clientY - rect.top);
  if (!cell) {
    clearPointerPreview();
    return;
  }
  const cellRect = viewTransform.cellRect(cell);
  pointerPreview.hidden = false;
  pointerPreview.style.left = `${cellRect.left}px`;
  pointerPreview.style.top = `${cellRect.top}px`;
  pointerPreview.style.width = `${cellRect.width}px`;
  pointerPreview.style.height = `${cellRect.height}px`;
  hoverSummary.textContent = `x ${cell.x} · y ${cell.y}`;
}

function clearPointerPreview(): void {
  pointerPreview.hidden = true;
  hoverSummary.textContent = "";
}

function updateDirectPaintAvailability(): void {
  const allowed =
    canUseLocalDrawingSession(walletAccount, walletNetwork) && contractMetaOk;
  const connected = walletAccount !== null;

  // A disabled checkbox is not an explanation. With no session there is
  // nothing to toggle, so the toggle is hidden and the dock offers the single
  // approval that turns painting on. With a session, Direct paint is on by
  // default unless the user has explicitly turned it off.
  tapToPaintEnabled = allowed && (tapToPaintUserChoice ?? true);
  directPaintToggle.checked = tapToPaintEnabled;
  directPaintToggle.disabled = false;
  directPaintToggle.title = tapToPaintEnabled
    ? "Direct paint is on: click a square to paint it, with no wallet popup."
    : "Direct paint is off: select a square, then press Place paint.";

  paintUnlock.hidden = !(
    connected &&
    !allowed &&
    contractMetaOk &&
    isContractConfigured()
  );
  tapToPaintAffordance.hidden = !allowed;
  tapToPaintAnnouncement.hidden = !allowed;

  // "Place paint" and "Direct paint is on" are two instructions for the same
  // act. While painting is armed the button is redundant — clicking a cell
  // already places the paint — so it steps aside instead of contradicting the
  // status line. It returns the moment painting is not armed, which is when it
  // is the only pointer path. Enter still places either way (board keydown).
  drawButton.hidden = allowed && tapToPaintEnabled;

  // A one-approval unlock that vanishes after use reads as "did it work?".
  // Keep a quiet, permanent line while the session is live.
  paintUnlocked.hidden = !allowed;
  paintUnlocked.textContent = allowed
    ? "Painting unlocked this browser. No wallet popup per pixel. Revoke it any time under About / details."
    : "";

  tapToPaintAnnouncement.textContent = !allowed
    ? ""
    : tapToPaintEnabled
      ? "Direct paint is on. Drag or click to paint. To move the board, hold space, use two fingers, or the middle mouse button."
      : "Direct paint is off. Select a square, then press Place paint.";
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
    const outcomeId = queuedPlacementOutcomes.get(item);
    if (outcomeId) placementOutcomes.discard(outcomeId);
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
    const outcomeId = queuedPlacementOutcomes.get(next);
    if (outcomeId) placementOutcomes.discard(outcomeId);
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
    const outcomeId = queuedPlacementOutcomes.get(next);
    if (outcomeId) placementOutcomes.discard(outcomeId);
    cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
      quiet: true,
    });
    return;
  }
  paintQueue.inFlight = true;
  try {
    await attemptDraw(next, queuedPlacementOutcomes.get(next));
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
    "Explore with pan and zoom. Place paint (or Enter) submits a draw. With Direct paint enabled at paint zoom, drag to paint a stroke. Pan and pinch never paint.",
    isContractConfigured()
      ? `Game contract: ${CONTRACT_ID} on ${PAGE_NETWORK}. On open (and Refresh), the page loads every painted cell via paginated get_pixels. Transaction execution is reported separately from the latest cell owner; a successful paint may already be overwritten under Open wall.`
      : "No game contract id is configured yet (VITE_CONTRACT_ID empty), so this page will not open a draw signature or claim a chain success.",
    sponsorship.flagEnabled
      ? "Sponsorship flag is on, but the submit path stays ordinary wallet until a sponsor service exists."
      : "Sponsorship is off. No cross-chain or paid checkout is offered on this page.",
    paidModeEnabled
      ? useMockQuotes
        ? `Paint-cost UI is on (${MOCK_QUOTE_DEMO_LABEL}). Place builds contract-shaped paint_with_wallet / session draw args; live get_quote and get_account nonce still use fixtures until RPC views are wired.`
        : "Paint-cost UI is on from paid board metadata. Place submits paint_with_wallet (or session draw) with max_cost, pricing_version, expires_at_ns, and action_nonce."
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
    button.setAttribute("aria-describedby", "selection-summary");
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
    submitted: "State: submitted — transaction is in flight; awaiting confirmation.",
    confirmed: "State: confirmed — the transaction executed and the confirming read matched.",
    confirmation_delayed: "State: confirmation delayed — outcome is unresolved and will not be resubmitted automatically.",
    overwritten: "State: overwritten — the transaction executed, then another artist became the current cell owner.",
    failed: "State: failed — the transaction did not execute; you can review and try again.",
  };
  flowState.textContent = labels[phase];
  flowState.dataset.phase = phase;
  // Keep the current transaction outcome adjacent to the action that caused it;
  // shell chrome remains a compact duplicate for navigation-wide visibility.
  drawState.textContent = labels[phase].replace(/^State: /, "");
  drawState.dataset.phase = phase;
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
    wallHint.dispose();
    unmountPlacementOutcomes();
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
