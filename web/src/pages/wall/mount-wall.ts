import type { NetworkId } from "@shared/types.ts";
import type { PageMount } from "../../app/page-registry";
import type { ParsedRoute } from "../../app/routes";
import type { AppServices } from "../../app/services";
import { PAGE_NETWORK } from "../../config";
import type { DrawRequest } from "../../draw-request";
import type { Cell } from "../../selection";
import { describeSponsorship } from "../../sponsorship";
import { fitCamera } from "../../viewport";
import { mountWallHint } from "../../wall-hint";
import { createBoardController } from "./board-controller";
import { createCameraController } from "./camera-controller";
import { createPaintController } from "./paint-controller";
import { createPricingController } from "./pricing-controller";
import type { RepaintChrome } from "./repaint-price";
import { wallPageHtml } from "./wall-template";
import { createWallView, fillBlock } from "./wall-view";
import type { WallScope } from "./wall-scope";

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
    drawInFlight: () => paint.drawInFlight(),
    syncSubmitEnabled: () => paint.syncSubmitEnabled(),
  });

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
    overlayPixels: () => paint.overlayPixels(),
    selection: {
      selected: () => view.selected(),
      selectedColor: () => view.selectedColor(),
      select: (cell) => view.select(cell),
      showSelection: () => view.showSelection(),
      refreshSelectedPixel: () => {
        void board.refreshSelectedPixel();
      },
    },
    strokes: {
      active: () => paint.strokes.active(),
      begin: (cell, wantsPan) => paint.strokes.begin(cell, wantsPan),
      extend: (cell) => paint.strokes.extend(cell),
      finish: (cell, kind, selectHere) => paint.strokes.finish(cell, kind, selectHere),
      cancel: () => paint.strokes.cancel(),
    },
    updateCompactStatus: () => view.updateCompactStatus(),
    attemptDraw: () => {
      void paint.attemptDraw();
    },
    tapSelected: (cell, tapOptions) => paint.maybeEnqueueDirectPaint(cell, tapOptions),
    hoverCell: (cell) => pricing.requestCellPrice(cell),
  });

  const wallHint = mountWallHint(stallScene);

  // Shell-owned status strip (survives wall dispose; safe if missing in tests).
  const flowState = shellEl<HTMLElement>("#flow-state") ?? document.createElement("p");
  const compactStatus =
    shellEl<HTMLElement>("#compact-status") ?? document.createElement("p");

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
    updateDirectPaintAvailability: () => paint.updateDirectPaintAvailability(),
    applyRoutePaintingContext: () => view.applyRoutePaintingContext(),
    reconcilePending: (pixels) => paint.reconcilePending(pixels),
    onBoardUpdated: () => pricing.onBoardUpdated(),
    onSchemaChanged: () => pricing.onSchemaChanged(),
    onManualRefresh: () => pricing.manualRefresh(),
  });

  let walletAccount: string | null = null;
  let walletNetwork: string | null = null;

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
    pendingCount: () => paint.pendingCount(),
    boardSync: () => board.syncState(),
  });

  const paint = createPaintController({
    scope,
    services,
    sponsorship,
    boardViewport,
    drawState,
    flowState,
    drawButton,
    result,
    directPaintToggle,
    tapToPaintAffordance,
    tapToPaintAnnouncement,
    paintUnlock,
    paintUnlocked,
    unlockPaintButton,
    authorizeSessionButton,
    forgetSessionButton,
    revokeSessionButton,
    drawingSessionStatus,
    drawingSessionNote,
    board,
    pricing,
    view,
    render: () => camera.render(),
  });

  view.fillRules();
  view.buildPalette();
  view.setFlow("disconnected");
  camera.applyCamera(fitCamera(camera.readViewportSize()));
  camera.render();
  view.showSelection();
  paint.showDrawingSession();
  view.applyRoutePaintingContext();
  void board.bootstrap();
  board.scheduleBoardPoll();

  options.attachTestApi?.({
    enqueueUnsent: (request) => paint.enqueueUnsent(request),
    queueLength: () => paint.queueLength(),
    kickDrain: () => paint.drainPaintQueue(),
    pendingPaintCount: () => paint.pendingCount(),
    refreshPixel: (cell) => board.refreshSelectedPixel(cell),
    cachedPixelColor: (cell) => board.cachedPixel(cell)?.colorIndex,
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
      paint.onWalletChanged();
    }
    if (!walletAccount) {
      view.setFlow("disconnected");
    } else if (view.uiPhase() === "disconnected" || view.uiPhase() === "failed") {
      view.setFlow(view.selected() ? "editing" : "connected");
    }
    paint.showDrawingSession();
    void pricing.refreshCreditsDock();
  });
  listenerCleanups.push(unsubWallet);
  listenerCleanups.push(() => {
    pricing.dispose();
  });

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
    paint.dispose();
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
