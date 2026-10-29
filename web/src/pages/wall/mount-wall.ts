import { strokeBegin, strokeExtend, MAX_BATCH, type StrokeState } from "./stroke-paint";
import { planStrokeCommit, strokeBlockedReason, strokeResultCopy, TRUNCATED_STROKE_COPY, WALLET_STROKE_COPY } from "./stroke-commit";
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
import { contractMetaBlockCopy, PAID_BOARD_SCHEMA_VERSION, validateContractMetadata, type ContractMetaIssue } from "../../contract-meta";
import {
  chainRepaintReaders,
  creditShortfall,
  quoteRepaint,
  tapAffordability,
  showPriceUnavailable,
  showRepaintQuote,
  type RepaintChrome,
} from "./repaint-price";
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
import { renderBoard } from "../../render-board";
import { createGestureState, updateGesture } from "../../gesture";
import { moveSelection, type Cell } from "../../selection";
import { describeSponsorship } from "../../sponsorship";
import { submitDraw } from "../../submit-draw";
import {
  createCameraTransform,
  fitCamera,
  fitCellSize,
  FIT_MIN_CELL_PX,
  isPaintZoom,
  MAX_CELL_PX,
  paintZoomCamera,
  PAINT_CELL_PX,
  panBy,
  wheelZoomFactor,
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
import { mountBuyCreditsSheet } from "../../app/buy-credits-sheet";
import { parseWallLinkSearch } from "./wall-link";
import { wallPageHtml } from "./wall-template";
import { mountWallHint } from "../../wall-hint";
import {
  createPlacementOutcomeController,
  mountPlacementOutcomeLayer,
} from "./placement-outcome";

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
 * Page-registry adapter: passes route context so `/wall?x=…&y=…` links focus the wall.
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
  const repaintChrome: RepaintChrome = {
    legend: mustFindIn<HTMLElement>(pageRoot, "#repaint-legend"),
    badge: mustFindIn<HTMLElement>(pageRoot, "#cell-price"),
    strokeTotal: mustFindIn<HTMLElement>(pageRoot, "#stroke-total"),
    submit: drawButton,
  };
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
  const contractLine = mustFindIn<HTMLElement>(pageRoot, "#wall-contract-line");
  const directPaintToggle = mustFindIn<HTMLInputElement>(pageRoot, "#direct-paint-toggle");
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
  const creditsDock = mustFindIn<HTMLElement>(pageRoot, "#credits-dock");
  const creditsBalance = mustFindIn<HTMLElement>(pageRoot, "#credits-balance");
  const buyCreditsButton = mustFindIn<HTMLButtonElement>(
    pageRoot,
    "#buy-credits-button",
  );
  const buyCreditsHost = mustFindIn<HTMLElement>(pageRoot, "#buy-credits-host");
  const buyCreditsSheet = mountBuyCreditsSheet(buyCreditsHost, services, {
    onCreditsChanged: (balance) => {
      if (disposed) return;
      creditsBalance.textContent =
        balance === null
          ? "Credits: not registered · 0"
          : balance === undefined
            ? "Credits: …"
            : `Credits: ${balance}`;
    },
  });

  // Keep the current cell coordinates available when keyboard users reach Place.
  drawButton.setAttribute("aria-describedby", "selection-summary cell-price stroke-total");

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
  /** Schema from the last successful get_board. 4 means paid credits. */
  let boardSchema: number | null = null;
  /** A failed get_cell_cost / get_tunables read. Submit stays off until a later read works. */
  let priceUnavailable = false;
  /**
   * Last credit balance the dock read. Advisory: the tap path checks against
   * this instead of making a network read, because the contract enforces
   * affordability itself (`draw` takes no max_cost).
   */
  let cachedCredits: bigint | null = null;
  let creditsKnown = false;
  /** Cost last quoted for a cell, keyed "x,y". Lets a tap skip the read. */
  const cellCostCache = new Map<string, number>();
  let pricedCellKey: string | null = null;
  let priceRequest = 0;
  let submitQuoteInFlight = false;
  const repaintReaders = chainRepaintReaders({
    writtenAtNsFromCache: (cell) => {
      const cached = getCachedPixel(pixelCache, cell.x, cell.y);
      return cached ? cached.lastWriteTimestampNs : null;
    },
  });
  // A failed *read* and a real metadata *mismatch* both leave contractMetaOk
  // false, and the draw path used to report both as "did not match the shared
  // schema". They need different advice: one is "try again", the other is
  // "this contract is not this board".
  let contractMetaIssue: ContractMetaIssue | null = null;
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
    // A transient read failure at load used to block drawing until a full page
    // reload, because nothing re-ran the metadata check. Refresh now does.
    if (!contractMetaOk) {
      void revalidateContractMeta();
    } else if (paidBoard()) {
      pricedCellKey = null;
      // Tunables only change on set_tunables; Refresh is the one deliberate re-read.
      repaintReaders.clearTunablesCache();
      void refreshPaidLegend();
    }
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
      const factor = wheelZoomFactor(wheelEvent.deltaY, wheelEvent.deltaMode);
      if (factor === 1) {
        return;
      }
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
    }
    if (!walletAccount) {
      setFlow("disconnected");
    } else if (uiPhase === "disconnected" || uiPhase === "failed") {
      setFlow(selected ? "editing" : "connected");
    }
    showDrawingSession();
    void refreshCreditsDock();
  });
  listenerCleanups.push(unsubWallet);
  buyCreditsButton.addEventListener("click", () => {
    buyCreditsSheet.open();
  });
  listenerCleanups.push(() => {
    buyCreditsSheet.dispose();
  });

/**
 * Apply a `/wall?x=…&y=…&zoom=…` location link after the wall mounts.
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
  const parsed = parseWallLinkSearch(`?${params.toString()}`);
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
    updateDirectPaintAvailability();
    return true;
  }
  try {
    const board = await getBoard();
    const meta = validateContractMetadata(board);
    contractMetaOk = meta.ok;
    contractMetaIssue = meta.ok ? null : { kind: "mismatch", detail: meta.message };
    rememberBoardSchema(meta.ok ? board.schema_version : null);
    if (meta.ok) {
      contractLine.textContent =
        `Every square is stored on the NEAR ${PAGE_NETWORK} contract ${CONTRACT_ID}. ` +
        `Painting a square replaces the colour that was there, and the contract ` +
        `records which account painted it and when.`;
    } else {
      fillBlock(result, meta.title, meta.message);
    }
    return meta.ok;
  } catch (error) {
    contractMetaOk = false;
    const detail = error instanceof Error ? error.message : "Unknown read error";
    contractMetaIssue = { kind: "read", detail };
    rememberBoardSchema(null);
    return false;
  } finally {
    updateDirectPaintAvailability();
  }
}

async function bootstrapBoard(): Promise<void> {
  if (!isContractConfigured()) {
    contractMetaOk = true;
    rememberBoardSchema(null);
    evidence.textContent =
      "Evidence: local mock. This picture is an empty board drawn in your browser. It is not testnet or mainnet state. Set VITE_CONTRACT_ID to read a real contract.";
    contractLine.textContent =
      "This is a local demo board. Nothing here is on a blockchain."
    if (!options.route?.query.x) {
      boardLoadStatus.textContent =
        "Board load: mock only (no contract id). Refresh stays disabled.";
    }
    updateCompactStatus();
    updateDirectPaintAvailability();
    applyRoutePaintingContext();
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
    // One sentence a non-crypto visitor can repeat. Everything here is enforced
    // by the contract (`overwrite_rule: open_wall`), not by this page.
    contractLine.textContent =
      `Every square is stored on the NEAR ${PAGE_NETWORK} contract ${CONTRACT_ID}. ` +
      `Painting a square replaces the colour that was there, and the contract ` +
      `records which account painted it and when.`;
    await refreshBoardFromContract();
    applyRoutePaintingContext();
  } catch (error) {
    contractMetaOk = false;
    const detail = error instanceof Error ? error.message : "Unknown read error";
    contractMetaIssue = { kind: "read", detail };
    rememberBoardSchema(null);
    evidence.textContent = `Evidence: contract id is set (${CONTRACT_ID}), but the initial board read failed: ${detail}. You can still look at the local empty picture and try Refresh. Drawing stays blocked until metadata validates.`;
    contractLine.textContent =
      "The board contract could not be read, so nothing here is confirmed chain state.";
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
    // A refresh can change how old a cell is, so the last quoted price is stale.
    pricedCellKey = null;
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

  const frozen =
    request ??
    (selected && selectedColor !== null && walletAccount
      ? createDrawRequest({
          x: selected.x,
          y: selected.y,
          colorIndex: selectedColor,
          accountId: walletAccount,
          networkId: walletNetworkId(),
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
    const copy = contractMetaBlockCopy(contractMetaIssue);
    fillBlock(result, copy.title, copy.message);
    return;
  }

  if (!frozen) {
    return;
  }

  // Price before any pending mark or wallet prompt. A failed read must not
  // leave a stripe on the board or open a signature request.
  drawInFlight = true;
  drawButton.disabled = true;
  const priced = await ensurePaidQuote(
    [{ x: frozen.x, y: frozen.y }],
    frozen.accountId,
  );
  if (!priced || disposed) {
    drawInFlight = false;
    if (frozen) {
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      if (queuedPlacementOutcomeId) {
        placementOutcomes.discard(queuedPlacementOutcomeId);
      }
    }
    if (!disposed) {
      render();
      syncSubmitEnabled();
    }
    return;
  }

  // Keep UI selection in sync with the request, but never re-read color/account
  // from live UI state while this request is in flight.
  selected = { x: frozen.x, y: frozen.y };
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
      "Your wallet may ask you to pay a small network gas fee. The game adds no application fee.",
      sponsorship.message,
    ].join(" "),
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
      syncSubmitEnabled();
      showDrawingSession();
      // Dock credits previously refreshed only on wallet change / shortfall —
      // after a confirmed (or delayed) spend the balance must re-read the chain.
      void refreshCreditsDock();
      if (selected && paidBoard()) {
        pricedCellKey = null;
        requestCellPrice(selected);
      }
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
  const viewport = readViewportSize();
  const fittedCamera = fitCamera(viewport);
  const fitted =
    Math.abs(camera.cellSize - fittedCamera.cellSize) < 1e-6 &&
    Math.abs(camera.panX - fittedCamera.panX) < 1e-6 &&
    Math.abs(camera.panY - fittedCamera.panY) < 1e-6;
  return {
    current: camera.cellSize,
    // The floor is the fitted size, not the smallest representable cell: a
    // board smaller than the viewport is only empty space with a picture in it.
    minimum: fitCellSize(viewport),
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
      // One failed price read must not dead-end painting. `priceUnavailable`
      // is a display state, but it also gated gesture start, so a single 4xx or
      // 429 left the board refusing every tap and drag until a full reload --
      // reported as "I click and nothing happens, then I am stuck". Clear it
      // here so each gesture gets its own attempt; a fresh failure re-latches.
      if (paidBoard() && priceUnavailable) {
        priceUnavailable = false;
      }

      if (cell && !wantsPan && directPaintToggle.checked &&
          walletAccount && selectedColor !== null && contractMetaOk &&
          !drawInFlight && !paintQueue.inFlight && !paintQueueLength(paintQueue) &&
          canUseLocalDrawingSession(walletAccount, walletNetwork)) {
        activeStroke = { state: strokeBegin(cell), accountId: walletAccount,
          networkId: walletNetworkId(), color: selectedColor };
        render();
      } else {
        // Say which precondition is missing. A drag that silently pans reads as
        // "painting is broken", which is how this was first reported.
        const blocked = strokeBlockedReason({
          directPaint: directPaintToggle.checked,
          accountId: walletAccount,
          colorIndex: selectedColor,
          contractOk: contractMetaOk,
          sessionActive: walletAccount
            ? canUseLocalDrawingSession(walletAccount, walletNetwork)
            : false,
          priceOk: !paidBoard() || !priceUnavailable,
          drawInFlight,
          queueBusy: paintQueue.inFlight || paintQueueLength(paintQueue) > 0,
        });
        if (cell && !wantsPan && blocked) {
          drawState.textContent = blocked;
        }
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
  drawInFlight = true;
  drawButton.disabled = true;
  const priced = await ensurePaidQuote(stroke.state.cells, stroke.accountId);
  if (!priced || disposed || stroke.accountId !== walletAccount ||
      stroke.networkId !== walletNetworkId() || !directPaintToggle.checked) {
    drawInFlight = false;
    if (!disposed) syncSubmitEnabled();
    return;
  }
  const plan = planStrokeCommit(stroke.state, canUseLocalDrawingSession(walletAccount, walletNetwork));
  if (plan.kind === "wallet_approval") {
    drawInFlight = false;
    if (!disposed) syncSubmitEnabled();
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

    // A confirmed chunk's receipt proves the write at a specific block. Stamp
    // those cells now instead of leaving the board stale until the next full
    // read: the read pages the whole wall (6 requests today, 64 on a full
    // 16,384-cell board), and waiting for it is what made a finished stroke
    // look unresolved. board-cache keeps the newer stamp if a snapshot from an
    // older block arrives, so this cannot be rolled back by a slow read.
    for (const { chunkIndex, blockHeight } of outcome.executedBlocks ?? []) {
      const start = chunkIndex * MAX_BATCH;
      for (const cell of stroke.state.cells.slice(start, start + MAX_BATCH)) {
        rememberPixelAtBlock(
          pixelCache,
          {
            x: cell.x,
            y: cell.y,
            colorIndex: stroke.color,
            artistAccountId: stroke.accountId,
            lastWriteTimestampNs: null,
          },
          blockHeight,
        );
      }
    }

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
    if (!disposed) {
      syncSubmitEnabled();
      render();
      void refreshCreditsDock();
      if (selected && paidBoard()) {
        pricedCellKey = null;
        requestCellPrice(selected);
      }
    }
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
  // Paint zoom is the deliberate, r/place-style direct-placement mode. It
  // relaxes the two-step form (tap = place), but NEVER the consent toggle:
  // direct submission requires the user to have opted in, same as 2-step
  // mode, plus the pre-authorized local drawing session. A gesture never
  // routes through a form submission, and never submits unrequested.
  maybeEnqueueDirectPaint(next, { paintZoom: isPaintZoom(camera) });
}

function directPaintReady(): boolean {
  return (
    tapToPaintEnabled &&
    canUseLocalDrawingSession(walletAccount, walletNetwork) &&
    selectedColor !== null &&
    walletAccount !== null &&
    contractMetaOk &&
    !disposed
  );
}

function maybeEnqueueDirectPaint(
  cell: Cell,
  options: { paintZoom: boolean } = { paintZoom: false },
): void {
  // A deliberate tap is a user decision, so it is queued even while another
  // paint is still confirming: `drainPaintQueue` is the serialiser and runs the
  // next entry when this one settles. Dropping it here instead made the second
  // click on a cell silently do nothing until the first transaction landed,
  // which read as "painting stopped working".
  if (!directPaintReady()) {
    return;
  }
  void enqueuePricedDirectPaint(cell, options);
}

async function enqueuePricedDirectPaint(
  cell: Cell,
  _options: { paintZoom: boolean },
): Promise<void> {
  if (!directPaintReady() || !walletAccount || selectedColor === null) {
    return;
  }
  // A tap is the core gesture and must never wait on the network. The old
  // pre-flight quote put two sequential reads in front of every direct paint,
  // which is why this board felt worse than the free one. Affordability is
  // checked against the cached dock balance and the last quoted cost for this
  // cell; the contract enforces the rest, because `draw` takes no max_cost.
  if (paidBoard()) {
    const decision = tapAffordability({
      credits: cachedCredits,
      creditsKnown,
      knownCost: cellCostCache.get(`${cell.x},${cell.y}`),
    });
    if (!decision.allowed) {
      const shortfall = creditShortfall(cachedCredits, decision.needed);
      if (shortfall) {
        fillBlock(result, "Not enough credits", shortfall);
      }
      buyCreditsSheet.open({ quantity: Math.max(1, decision.needed - Number(cachedCredits ?? 0n)) });
      void refreshCreditsDock();
      return;
    }
    // Price the badge in the background. It must never block the paint.
    requestCellPrice(cell);
  }

  const queued = createDrawRequest({
    x: cell.x,
    y: cell.y,
    colorIndex: selectedColor,
    accountId: walletAccount,
    networkId: walletNetworkId(),
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
  // Gate on the pointer, not on `touch-action`. `.board-viewport` sets
  // `touch-action: none`, so the old check meant this branch always ran and the
  // per-cell price could never appear on hover on any desktop.
  if (event.pointerType === "touch") {
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
  requestCellPrice(cell);
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

function chainNowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function paidBoard(): boolean {
  return boardSchema === PAID_BOARD_SCHEMA_VERSION;
}

function syncSubmitEnabled(): void {
  drawButton.disabled = drawInFlight || (paidBoard() && priceUnavailable);
}

function rememberBoardSchema(schema: number | null): void {
  boardSchema = schema;
  if (!paidBoard()) {
    priceUnavailable = false;
    pricedCellKey = null;
    repaintChrome.legend.hidden = true;
    repaintChrome.legend.textContent = "";
    repaintChrome.badge.textContent = "";
    repaintChrome.strokeTotal.textContent = "";
    creditsDock.hidden = true;
    buyCreditsSheet.setVisible(false);
    syncSubmitEnabled();
    return;
  }
  creditsDock.hidden = false;
  buyCreditsSheet.setVisible(true);
  void refreshPaidLegend();
  void refreshCreditsDock();
}

async function refreshCreditsDock(): Promise<void> {
  if (!paidBoard()) {
    creditsDock.hidden = true;
    buyCreditsSheet.setVisible(false);
    return;
  }
  creditsDock.hidden = false;
  buyCreditsSheet.setVisible(true);
  if (!walletAccount) {
    creditsBalance.textContent = "Credits: connect wallet";
    cachedCredits = null;
    creditsKnown = false;
    buyCreditsButton.disabled = true;
    buyCreditsSheet.setCredits(undefined);
    return;
  }
  buyCreditsButton.disabled = false;
  creditsBalance.textContent = "Credits: …";
  try {
    const balance = await repaintReaders.credits(walletAccount);
    if (disposed) return;
    creditsBalance.textContent =
      balance === null ? "Credits: not registered · 0" : `Credits: ${balance}`;
    buyCreditsSheet.setCredits(balance);
    cachedCredits = balance;
    creditsKnown = true;
  } catch {
    if (disposed) return;
    creditsBalance.textContent = "Credits: unavailable — retry";
  }
}

/** Legend only. An empty cell list still proves get_tunables answered. */
async function refreshPaidLegend(): Promise<void> {
  if (!paidBoard()) {
    return;
  }
  const request = ++priceRequest;
  const quote = await quoteRepaint({
    readers: repaintReaders,
    cells: [],
    nowNs: chainNowNs(),
  });
  if (disposed || request !== priceRequest || submitQuoteInFlight) {
    return;
  }
  if (!quote.ok) {
    priceUnavailable = true;
    showPriceUnavailable(repaintChrome);
    syncSubmitEnabled();
    return;
  }
  priceUnavailable = false;
  showRepaintQuote(repaintChrome, quote);
  syncSubmitEnabled();
}

function requestCellPrice(cell: Cell): void {
  if (!paidBoard() || submitQuoteInFlight || drawInFlight) {
    return;
  }
  const key = `${cell.x},${cell.y}`;
  if (pricedCellKey === key) {
    return;
  }
  pricedCellKey = key;
  const request = ++priceRequest;
  void quoteRepaint({
    readers: repaintReaders,
    cells: [cell],
    nowNs: chainNowNs(),
  }).then((quote) => {
    if (disposed || request !== priceRequest || submitQuoteInFlight) {
      return;
    }
    if (!quote.ok) {
      priceUnavailable = true;
      showPriceUnavailable(repaintChrome);
      syncSubmitEnabled();
      return;
    }
    priceUnavailable = false;
    for (const row of quote.cells) {
      cellCostCache.set(`${row.cell.x},${row.cell.y}`, row.credits);
    }
    showRepaintQuote(repaintChrome, quote);
    syncSubmitEnabled();
  });
}

/**
 * Price a stroke before anything is marked pending or sent to a wallet.
 * Returns false when the read failed or the account cannot afford the total.
 */
async function ensurePaidQuote(cells: Cell[], accountId: string | null): Promise<boolean> {
  if (!paidBoard()) {
    return true;
  }
  submitQuoteInFlight = true;
  const request = ++priceRequest;
  try {
    const quote = await quoteRepaint({
      readers: repaintReaders,
      cells,
      nowNs: chainNowNs(),
    });
    if (disposed || request !== priceRequest) {
      return false;
    }
    if (!quote.ok) {
      priceUnavailable = true;
      showPriceUnavailable(repaintChrome);
      fillBlock(
        result,
        "Price unavailable",
        "The repaint price could not be read, so nothing was submitted. Refresh the board and try again.",
      );
      syncSubmitEnabled();
      return false;
    }
    priceUnavailable = false;
    for (const row of quote.cells) {
      cellCostCache.set(`${row.cell.x},${row.cell.y}`, row.credits);
    }
    showRepaintQuote(repaintChrome, quote);
    syncSubmitEnabled();
    if (!accountId) {
      return true;
    }
    let have: bigint | null;
    try {
      have = await repaintReaders.credits(accountId);
      cachedCredits = have;
      creditsKnown = true;
    } catch {
      priceUnavailable = true;
      showPriceUnavailable(repaintChrome);
      fillBlock(
        result,
        "Price unavailable",
        "The credit balance could not be read, so nothing was submitted. Refresh the board and try again.",
      );
      syncSubmitEnabled();
      return false;
    }
    if (disposed || request !== priceRequest) {
      return false;
    }
    const shortfall = creditShortfall(have, quote.totalCredits);
    if (shortfall) {
      repaintChrome.strokeTotal.textContent = `${quote.strokeText}. ${shortfall}`;
      fillBlock(result, "Not enough credits", shortfall);
      const haveCount = have === null ? 0 : Number(have);
      const needCount = quote.totalCredits;
      const buyQuantity =
        Number.isFinite(haveCount) && needCount > haveCount
          ? needCount - haveCount
          : Math.max(1, needCount);
      const buyMore = document.createElement("button");
      buyMore.type = "button";
      buyMore.className = "action place";
      buyMore.textContent = "Buy credits";
      buyMore.addEventListener("click", () => {
        buyCreditsSheet.open({ quantity: Math.max(1, buyQuantity) });
      });
      result.append(buyMore);
      buyCreditsSheet.open({ quantity: Math.max(1, buyQuantity) });
      void refreshCreditsDock();
      return false;
    }
    return true;
  } finally {
    submitQuoteInFlight = false;
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
  // Touch has no hover. Selecting a square is how a finger reads the price.
  requestCellPrice(selected);

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
