import { strokeBegin, strokeExtend, MAX_BATCH, type StrokeState } from "./stroke-paint";
import { planStrokeCommit, strokeBlockedReason, strokeResultCopy, TRUNCATED_STROKE_COPY, WALLET_STROKE_COPY } from "./stroke-commit";
import type { NetworkId } from "@shared/types.ts";
import {
  createDrawRequest,
  drawRequestMatchesSession,
  type DrawRequest,
} from "../../draw-request";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import { isContractConfigured } from "../../contract";
import { contractMetaBlockCopy } from "../../contract-meta";
import type { RepaintChrome } from "./repaint-price";
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
import type { Cell } from "../../selection";
import { describeSponsorship } from "../../sponsorship";
import { submitDraw } from "../../submit-draw";
import { fitCamera } from "../../viewport";
import { createBoardController } from "./board-controller";
import { createPricingController } from "./pricing-controller";
import { clearBlock, colorName, createWallView, fillBlock, fillResultWithLink } from "./wall-view";
import { createCameraController, type CameraStrokeHooks } from "./camera-controller";
import type { WallScope } from "./wall-scope";
import { revokeDrawingSessionKeyOnChain } from "../../wallet";
import type { PageMount } from "../../app/page-registry";
import type { ParsedRoute } from "../../app/routes";
import type { AppServices } from "../../app/services";
import { paintOperationId } from "../../app/operations";
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
  // Keep the current cell coordinates available when keyboard users reach Place.
  drawButton.setAttribute("aria-describedby", "selection-summary cell-price stroke-total");

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
  let disposed = false;
  const scope: WallScope = {
    listen,
    onDispose: (cleanup) => {
      listenerCleanups.push(cleanup);
    },
    isDisposed: () => disposed,
    walletAccount: () => walletAccount,
    walletNetwork: () => walletNetwork,
    walletNetworkId: () => walletNetworkId(),
  };

  const pricing = createPricingController({
    scope,
    services,
    creditsDock,
    creditsBalance,
    buyCreditsButton,
    buyCreditsHost,
    repaintChrome,
    result,
    boardSchema: () => board.boardSchema(),
    cachedPixel: (cell) => board.cachedPixel(cell),
    drawInFlight: () => drawInFlight,
    syncSubmitEnabled: () => syncSubmitEnabled(),
  });

  const strokeHooks: CameraStrokeHooks = {
    active: () => activeStroke !== null,
    begin(cell, wantsPan) {
      const selectedColor = view.selectedColor();
      pricing.allowGestureRetry();

      if (cell && !wantsPan && directPaintToggle.checked &&
          walletAccount && selectedColor !== null && board.contractMetaOk() &&
          !drawInFlight && !paintQueue.inFlight && !paintQueueLength(paintQueue) &&
          canUseLocalDrawingSession(walletAccount, walletNetwork)) {
        activeStroke = { state: strokeBegin(cell), accountId: walletAccount,
          networkId: walletNetworkId(), color: selectedColor };
        camera.render();
      } else {
        // Say which precondition is missing. A drag that silently pans reads as
        // "painting is broken", which is how this was first reported.
        const blocked = strokeBlockedReason({
          directPaint: directPaintToggle.checked,
          accountId: walletAccount,
          colorIndex: selectedColor,
          contractOk: board.contractMetaOk(),
          sessionActive: walletAccount
            ? canUseLocalDrawingSession(walletAccount, walletNetwork)
            : false,
          priceOk: !pricing.paidBoard() || !pricing.priceUnavailable(),
          drawInFlight,
          queueBusy: paintQueue.inFlight || paintQueueLength(paintQueue) > 0,
        });
        if (cell && !wantsPan && blocked) {
          drawState.textContent = blocked;
        }
      }
    },
    extend(cell) {
      if (!activeStroke) return;
      if (cell) activeStroke.state = strokeExtend(activeStroke.state, cell);
      camera.render();
      if (activeStroke.state.truncated) fillBlock(result, "Stroke limit", TRUNCATED_STROKE_COPY);
    },
    finish(cell, completedKind, selectHere) {
      if (!activeStroke) return;
      if (cell) activeStroke.state = strokeExtend(activeStroke.state, cell);
      const stroke = activeStroke;
      activeStroke = null;
      // Long presses and cancelled gestures retain the classifier's guards.
      if (completedKind === "tap" || completedKind === "drag") {
        if (stroke.state.cells.length > 1) void commitStroke(stroke);
        else if (completedKind === "tap") selectHere();
      }
    },
    cancel() {
      activeStroke = null;
    },
  };

  const camera = createCameraController({
    scope,
    canvas,
    boardViewport,
    boardStage,
    boardToolbar,
    boardFocus,
    selectionRing,
    hoverSummary,
    zoomPaintButton,
    paintedPixels: () => board.paintedPixels(),
    overlayPixels: () => [
      ...listPendingPaints(pendingPaints),
      ...(activeStroke?.state.cells.map(cell => ({ ...cell,
        colorIndex: activeStroke!.color, accountId: activeStroke!.accountId,
        transactionId: null, phase: "submitted" as const,
      })) ?? []),
    ],
    selection: {
      selected: () => view.selected(),
      selectedColor: () => view.selectedColor(),
      select: (cell) => view.select(cell),
      showSelection: () => view.showSelection(),
      refreshSelectedPixel: () => {
        void board.refreshSelectedPixel();
      },
    },
    strokes: strokeHooks,
    updateCompactStatus: () => view.updateCompactStatus(),
    attemptDraw: () => {
      void attemptDraw();
    },
    tapSelected: (cell, tapOptions) => maybeEnqueueDirectPaint(cell, tapOptions),
    hoverCell: (cell) => pricing.requestCellPrice(cell),
  });

  const wallHint = mountWallHint(stallScene);

  // Shell-owned status strip (survives wall dispose; safe if missing in tests).
  const flowState = shellEl<HTMLElement>("#flow-state") ?? document.createElement("p");
  const compactStatus =
    shellEl<HTMLElement>("#compact-status") ?? document.createElement("p");

  const pendingPaints = createPendingPaintMap();
  const placementOutcomes = createPlacementOutcomeController();
  const queuedPlacementOutcomes = new WeakMap<DrawRequest, string>();
  const unmountPlacementOutcomes = mountPlacementOutcomeLayer(
    boardViewport,
    placementOutcomes,
  );
  const paintQueue = createPaintQueue();
  const sponsorship = describeSponsorship();

  const board = createBoardController({
    scope,
    evidence,
    contractLine,
    boardLoadStatus,
    boardFreshness,
    refreshButton,
    sponsorNote,
    sponsorship,
    routeFocusesCell: Boolean(options.route?.query.x),
    selected: () => view.selected(),
    fillResult: (title, message) => fillBlock(result, title, message),
    render: () => camera.render(),
    showSelection: () => view.showSelection(),
    updateCompactStatus: () => view.updateCompactStatus(),
    updateDirectPaintAvailability: () => updateDirectPaintAvailability(),
    applyRoutePaintingContext: () => view.applyRoutePaintingContext(),
    reconcilePending: (pixels) => reconcilePendingWithConfirmed(pendingPaints, pixels),
    onBoardUpdated: () => pricing.onBoardUpdated(),
    onSchemaChanged: () => pricing.onSchemaChanged(),
    onManualRefresh: () => pricing.manualRefresh(),
  });

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

  const view = createWallView({
    scope,
    pageRoot,
    selectionSummary,
    preview,
    palette,
    rules,
    lede,
    sponsorNote,
    drawState,
    boardLoadStatus,
    focusCanvas: mustFindIn<HTMLButtonElement>(pageRoot, "#focus-canvas"),
    flowState,
    compactStatus,
    sponsorship,
    route: options.route,
    wallHint,
    render: () => camera.render(),
    positionSelection: () => camera.positionSelection(),
    applyCamera: (next) => camera.applyCamera(next),
    readViewportSize: () => camera.readViewportSize(),
    cellSize: () => camera.camera().cellSize,
    requestCellPrice: (cell) => pricing.requestCellPrice(cell),
    cachedPixel: (cell) => board.cachedPixel(cell),
    refreshSelectedPixel: () => {
      void board.refreshSelectedPixel();
    },
    pendingCount: () => listPendingPaints(pendingPaints).length,
    boardSync: () => board.syncState(),
  });

  view.fillRules();
  view.buildPalette();
  view.setFlow("disconnected");
  camera.applyCamera(fitCamera(camera.readViewportSize()));
  camera.render();
  view.showSelection();
  showDrawingSession();
  view.applyRoutePaintingContext();
  void board.bootstrap();
  board.scheduleBoardPoll();

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
      camera.render();
    },
    queueLength: () => paintQueueLength(paintQueue),
    kickDrain: () => drainPaintQueue(),
    pendingPaintCount: () => listPendingPaints(pendingPaints).length,
    refreshPixel: (cell) => board.refreshSelectedPixel(cell),
    cachedPixelColor: (cell) => board.cachedPixel(cell)?.colorIndex,
  });

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
      view.setFlow("disconnected");
    } else if (view.uiPhase() === "disconnected" || view.uiPhase() === "failed") {
      view.setFlow(view.selected() ? "editing" : "connected");
    }
    showDrawingSession();
    void pricing.refreshCreditsDock();
  });
  listenerCleanups.push(unsubWallet);
  listenerCleanups.push(() => {
    pricing.dispose();
  });

async function attemptDraw(
  request?: DrawRequest,
  queuedPlacementOutcomeId?: string,
): Promise<void> {
  if (disposed || drawInFlight) {
    return;
  }

  const selected = view.selected();
  const selectedColor = view.selectedColor();
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
    view.setFlow(walletAccount ? "editing" : "disconnected");
    fillBlock(
      result,
      "Paint cancelled",
      "The wallet account or network no longer matches this paint request, so it was not submitted.",
    );
    camera.render();
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
    view.setFlow(walletAccount ? "editing" : "disconnected");
    fillBlock(result, decision.title, decision.message);
    return;
  }

  if (!board.contractMetaOk()) {
    view.setFlow("failed");
    const copy = contractMetaBlockCopy(board.contractMetaIssue());
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
  const priced = await pricing.ensurePaidQuote(
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
      camera.render();
      syncSubmitEnabled();
    }
    return;
  }

  // Keep UI selection in sync with the request, but never re-read color/account
  // from live UI state while this request is in flight.
  view.setSelected({ x: frozen.x, y: frozen.y });
  view.setFlow("wallet_prompt");
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
  camera.render();
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
          view.setFlow("wallet_prompt");
          fillBlock(result, "Waiting for your wallet", progress.detail);
        } else if (progress.phase === "pending" || progress.phase === "confirming") {
          view.setFlow("submitted");
          setPendingPaint(pendingPaints, {
            x: frozen.x,
            y: frozen.y,
            colorIndex: frozen.colorIndex,
            accountId: frozen.accountId,
            transactionId: progress.transactionId,
            phase: "submitted",
          });
          camera.render();
          fillResultWithLink(
            result,
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
      board.rememberPixel(submitResult.pixel,
        submitResult.observedBlockHeight,
      );
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      camera.render();
      view.setFlow("confirmed");
      fillResultWithLink(
        result,
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      view.showSelection();
      void board.refreshBoardFromContract({ reason: "after_draw" });
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
      camera.render();
      view.setFlow("confirmation_delayed");
      fillResultWithLink(
        result,
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      view.showSelection();
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
      board.rememberPixel(submitResult.pixel,
        submitResult.observedBlockHeight,
      );
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      camera.render();
      view.setFlow("overwritten");
      fillResultWithLink(
        result,
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      view.showSelection();
      void board.refreshBoardFromContract({ reason: "after_draw" });
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
    camera.render();
    view.setFlow("failed");
    fillResultWithLink(
      result,
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
      void pricing.refreshCreditsDock();
      const selected = view.selected();
      if (selected) {
        pricing.repriceCell(selected);
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
    view.setFlow(view.selected() ? "editing" : "connected");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    view.setFlow("failed");
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

async function commitStroke(stroke: AnchoredStroke): Promise<void> {
  if (disposed || drawInFlight || stroke.accountId !== walletAccount ||
      stroke.networkId !== walletNetworkId() || !directPaintToggle.checked) return;
  drawInFlight = true;
  drawButton.disabled = true;
  const priced = await pricing.ensurePaidQuote(stroke.state.cells, stroke.accountId);
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
  camera.render();
  view.setFlow("submitted");
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
        board.rememberPixel({
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
    view.setFlow(outcome.status === "confirmed" ? "confirmed" : "confirmation_delayed");
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
    await board.refreshBoardFromContract({ reason: "after_draw" });
  } finally {
    drawInFlight = false;
    if (!disposed) {
      syncSubmitEnabled();
      camera.render();
      void pricing.refreshCreditsDock();
      const selected = view.selected();
      if (selected) {
        pricing.repriceCell(selected);
      }
    }
  }
}

function directPaintReady(): boolean {
  return (
    tapToPaintEnabled &&
    canUseLocalDrawingSession(walletAccount, walletNetwork) &&
    view.selectedColor() !== null &&
    walletAccount !== null &&
    board.contractMetaOk() &&
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
  const selectedColor = view.selectedColor();
  if (!directPaintReady() || !walletAccount || selectedColor === null) {
    return;
  }
  // A tap is the core gesture and must never wait on the network. The old
  // pre-flight quote put two sequential reads in front of every direct paint,
  // which is why this board felt worse than the free one. Affordability is
  // checked against the cached dock balance and the last quoted cost for this
  // cell; the contract enforces the rest, because `draw` takes no max_cost.
  if (!pricing.admitTap(cell)) {
    return;
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
  camera.render();
  void drainPaintQueue();
}

function updateDirectPaintAvailability(): void {
  const allowed =
    canUseLocalDrawingSession(walletAccount, walletNetwork) && board.contractMetaOk();
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
    board.contractMetaOk() &&
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
  camera.render();
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
      camera.render();
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

function syncSubmitEnabled(): void {
  drawButton.disabled = drawInFlight || (pricing.paidBoard() && pricing.priceUnavailable());
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
    board.dispose();
    wallHint.dispose();
    unmountPlacementOutcomes();
    // Drop unsent queue work; an in-flight attemptDraw may still settle into
    // services.operations. Do not continue draining after leave.
    cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
      quiet: true,
    });
    camera.dispose();
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
