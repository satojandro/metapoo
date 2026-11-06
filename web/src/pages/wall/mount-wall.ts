import type { PageMount } from "../../app/page-registry";
import type { ParsedRoute } from "../../app/routes";
import type { AppServices } from "../../app/services";
import type { DrawRequest } from "../../draw-request";
import type { Cell } from "../../selection";
import { describeSponsorship } from "../../sponsorship";
import { fitCamera, PAINT_CELL_PX, paintZoomCamera } from "../../viewport";
import { mountWallHint } from "../../wall-hint";
import { createBoardController } from "./board-controller";
import { createCameraController } from "./camera-controller";
import { createPaintController } from "./paint-controller";
import { createPricingController } from "./pricing-controller";
import type { RepaintChrome } from "./repaint-price";
import { wallPageHtml } from "./wall-template";
import { createWallView, fillBlock } from "./wall-view";
import { createWallScope } from "./wall-scope";
import { createWallModes } from "./wall-modes";
import { mountDockPrimary } from "./dock-primary";
import { createWallViews, type WallViews } from "./wall-views";
import { createTileInspector, parseTileHash, type TileInspector } from "./tile-inspector";
import { createWallInvite, type WallInvite } from "./wall-invite";
import { PAGE_NETWORK } from "../../config";
import { viewFunction } from "../../contract";
import "./wall-page.css";

/**
 * Lifecycle-safe wall mount.
 * mountWall(root, services) → dispose() cancels timers, aborts polls, removes listeners,
 * and clears unsent queue paints (already-broadcast ops stay on services.operations).
 *
 * The page is five controllers, each owning its own state:
 * - camera-controller: zoom, pan, gestures, pointer preview
 * - board-controller: load, poll, freshness, contract metadata, pixel cache
 * - wall-view: status text, selection panel, palette, rules
 * - pricing-controller: credits, cell prices, buy-credits sheet
 * - paint-controller: draws, strokes, the direct-paint queue, drawing session
 * This file only finds DOM nodes, creates them, connects them and disposes them.
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
  /** Zoom to painting size on the selection (what the old Paint zoom button did). */
  paintZoom: () => void;
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
  const el = <T extends Element = HTMLElement>(selector: string) => mustFindIn<T>(pageRoot, selector);

  const canvas = el<HTMLCanvasElement>("#board");
  const selectionRing = el("#selection-ring");
  const boardFocus = el("#board-focus");
  const boardViewport = el("#board-viewport");
  const boardStage = el("#board-stage");
  const boardToolbar = el(".board-toolbar");
  const selectionSummary = el("#selection-summary");
  const preview = el("#selection-preview");
  const palette = el("#palette");
  const drawButton = el<HTMLButtonElement>("#draw-button");
  const repaintChrome: RepaintChrome = {
    legend: el("#repaint-legend"),
    badge: el("#cell-price"),
    strokeTotal: el("#stroke-total"),
    submit: drawButton,
  };
  const drawState = el("#draw-state");
  const result = el("#result");
  const rules = el("#rules");
  const sponsorNote = el("#sponsor-note");
  const evidence = el("#evidence");
  const lede = el("#lede");
  const refreshButton = el<HTMLButtonElement>("#refresh-board");
  const boardLoadStatus = el("#board-load-status");
  const boardFreshness = el("#board-freshness");
  const drawingSessionStatus = el("#drawing-session-status");
  const drawingSessionNote = el("#drawing-session-note");
  const authorizeSessionButton = el<HTMLButtonElement>("#authorize-session-button");
  const forgetSessionButton = el<HTMLButtonElement>("#forget-session-button");
  const revokeSessionButton = el<HTMLButtonElement>("#revoke-session-button");
  const hoverSummary = el("#hover-summary");
  const contractLine = el("#wall-contract-line");
  const directPaintToggle = el<HTMLInputElement>("#direct-paint-toggle");
  const tapToPaintAffordanceCandidate = directPaintToggle.closest<HTMLLabelElement>("label");
  if (!tapToPaintAffordanceCandidate) {
    throw new Error("The wall page is missing the tap-to-paint affordance.");
  }
  const tapToPaintAffordance = tapToPaintAffordanceCandidate;
  // The status line is presentation, so it lives in the template with a real
  // class. It used to be created here with no styling at all, which is how a
  // developer-facing sentence ended up as raw body text in the paint dock.
  const tapToPaintAnnouncement = el("#tap-to-paint-status");
  directPaintToggle.setAttribute("aria-describedby", tapToPaintAnnouncement.id);

  // One-approval unlock. This is the visible entry point to the drawing
  // session; the authorise/revoke panel stays in About / details for people
  // who want the details, but nobody should have to find it to start painting.
  const paintUnlock = el("#paint-unlock");
  const paintUnlocked = el("#paint-unlocked");
  const unlockPaintButton = el<HTMLButtonElement>("#unlock-paint-button");
  const paintRenew = el("#paint-renew");
  const renewPaintButton = el<HTMLButtonElement>("#renew-paint-button");
  const creditsDock = el("#credits-dock");
  const creditsBalance = el("#credits-balance");
  const buyCreditsButton = el<HTMLButtonElement>("#buy-credits-button");
  const buyCreditsHost = el("#buy-credits-host");
  // Keep the current cell coordinates available when keyboard users reach Place.
  drawButton.setAttribute("aria-describedby", "selection-summary place-reason cell-price stroke-total");

  const scope = createWallScope();
  let views: WallViews | null = null;
  let inspector: TileInspector | null = null;
  let invite: WallInvite | null = null;
  let invitePrimed = false;

  // Look / Paint and Move decide what a gesture means; they never change the camera
  // maths or the paint path. Look is the default (owner, 2 Nov); there is no toggle,
  // signing in opens Paint and signing out returns to Look (owner, 6 Nov).
  const wallPage = el<HTMLElement>(".wall-page");
  const tileCard = el<HTMLElement>(".wall-inspect");
  const modes = createWallModes({
    scope,
    page: wallPage,
    moveButton: el<HTMLButtonElement>("#wall-move"),
    startPainting: el<HTMLButtonElement>("#start-painting"),
    backToLook: el<HTMLButtonElement>("#wall-back-to-look"),
  });

  // Controllers reach each other only through these closures, so creation
  // order is free except where the DOM cares: the buy-credits sheet subscribes
  // to the wallet before the wall does, and the camera's pointer preview sits
  // in the viewport before the paint controller's placement-outcome layer.
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
    freePaints: () => views?.free() ?? { kind: "unknown" },
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
    paintedPixels: () => board.paintedPixels(),
    overlayPixels: () => paint.overlayPixels(),
    selection: {
      selected: () => view.selected(),
      selectedColor: () => view.selectedColor(),
      select: (cell) => {
        view.select(cell);
        // In Look a tap is a question about that tile: bring its card into view
        // in the panel. Never while painting, where the palette must stay put.
        if (modes.mode() === "look") {
          requestAnimationFrame(() => {
            if (!scope.isDisposed()) tileCard.scrollIntoView?.({ block: "nearest" });
          });
        }
      },
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
      // Enter in Look mode opens Paint instead of sending anything.
      if (modes.mode() === "look") {
        modes.setMode("paint");
        return;
      }
      void paint.attemptDraw();
    },
    // A tap in Look mode (or with Move on) only shows the tile; it never paints.
    tapSelected: (cell, tapOptions) => {
      if (modes.tapMayPaint()) paint.maybeEnqueueDirectPaint(cell, tapOptions);
    },
    hoverCell: (cell) => pricing.requestCellPrice(cell),
    panOnly: () => modes.panOnly(),
    tilePainter: () => views?.painter() ?? null,
  });

  const wallHint = mountWallHint(el<HTMLElement>("#wall-hint-host"));

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
    onBoardUpdated: () => {
      pricing.onBoardUpdated();
      views?.refresh();
      inspector?.render();
      // The invite's wet count and free-paints line need the board's tunables.
      if (!invitePrimed && views) {
        invitePrimed = true;
        views.prime();
      }
      invite?.render();
    },
    onSchemaChanged: () => pricing.onSchemaChanged(),
    onManualRefresh: () => pricing.manualRefresh(),
    onPaletteChanged: (paletteLength) => view.setPaletteLength(paletteLength),
    onBoardSizeChanged: () => {
      // The fit, the canvas bitmap and the rules text all read the live size.
      camera.applyCamera(fitCamera(camera.readViewportSize()));
      camera.render();
      view.fillRules();
    },
  });

  // The view reports selection changes; Place paint follows once painting is wired.
  let paintCreated = false;
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
    onSelectionShown: () => {
      if (paintCreated) paint.syncSubmitEnabled();
      inspector?.render();
    },
  });

  const paint = createPaintController({
    scope,
    services,
    sponsorship,
    boardViewport,
    drawState,
    placeReason: el<HTMLElement>("#place-reason"),
    flowState,
    drawButton,
    result,
    directPaintToggle,
    tapToPaintAffordance,
    tapToPaintAnnouncement,
    paintUnlock,
    paintUnlocked,
    unlockPaintButton,
    paintRenew,
    renewPaintButton,
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

  paintCreated = true;
  paint.syncSubmitEnabled();

  // Art / Price / Age / Turf: colouring only, read from data the page already has.
  views = createWallViews({
    scope,
    chips: Array.from(pageRoot.querySelectorAll<HTMLButtonElement>("[data-wall-view]")),
    legend: el<HTMLElement>("#wall-view-legend"),
    pixels: () => board.paintedPixels(),
    viewer: () => scope.walletAccount(),
    readTunables: () => pricing.viewTunables(),
    readFreeFirst: (account) => viewFunction("get_free_first_paints", { account_id: account }),
    render: () => camera.render(),
    onChange: () => {
      inspector?.render();
      invite?.render();
    },
  });

  // The Look-mode invite: real counts, and the nearly-empty wall's own pitch.
  invite = createWallInvite({
    scope,
    card: el<HTMLElement>(".wall-invite"),
    pixels: () => board.paintedPixels(),
    loaded: () => board.syncState().lastAppliedAtMs !== null,
    tunables: () => views?.tunables() ?? null,
    viewerFree: () => views?.free() ?? { kind: "unknown" },
    connected: () => scope.walletAccount() !== null,
  });
  invite.render();

  // The drawing-key opt-in ("Also allow painting without a popup each time") is
  // shell-owned. On the wall it sits in the dock, next to Connect, not in the header.
  const optIn = document.querySelector<HTMLLabelElement>("label.drawing-session-opt-in");
  const optInSlot = pageRoot.querySelector<HTMLElement>("#wall-optin-slot");
  if (optIn && optInSlot && !pageRoot.contains(optIn)) {
    const home = optIn.parentElement;
    const next = optIn.nextSibling;
    optInSlot.append(optIn);
    scope.onDispose(() => {
      if (home && home.isConnected) home.insertBefore(optIn, next && next.parentNode === home ? next : null);
    });
  }

  // The Tile card: painter, age, cost to cover, Paint over this, Copy link.
  inspector = createTileInspector({
    scope,
    card: el<HTMLElement>(".wall-inspect"),
    host: el<HTMLElement>("#tile-inspector"),
    selected: () => view.selected(),
    cachedPixel: (cell) => board.cachedPixel(cell),
    viewer: () => scope.walletAccount(),
    tunables: () => views?.tunables() ?? null,
    free: () => views?.free() ?? { kind: "unknown" },
    knownCost: (cell) => pricing.knownCost(cell),
    network: PAGE_NETWORK,
    loaded: () => board.syncState().lastAppliedAtMs !== null,
    prime: () => views?.prime(),
    paintOver: (cell) => {
      modes.setMode("paint");
      view.select(cell);
      view.showSelection();
      camera.render();
      el<HTMLElement>(".wall-dock").scrollIntoView?.({ block: "nearest" });
    },
  });
  inspector.render();

  const dockPrimary = mountDockPrimary({
    scope,
    // The panel, not just the dock: the action row, status and result sit in its
    // pinned footer while the palette and credits sit in its scrolling body.
    dock: el<HTMLElement>(".wall-panel"),
    actionRow: el<HTMLElement>(".wall-action"),
    primary: el<HTMLButtonElement>("#dock-primary"),
    drawButton,
    creditsDock,
    creditsBalance,
    buyCreditsButton,
    drawState,
    connected: () => scope.walletAccount() !== null,
    colourChosen: () => view.selectedColor() !== null,
    connect: () => {
      // The shell's Connect wallet button carries the drawing-key opt-in.
      const shellConnect = shellEl<HTMLButtonElement>("#connect-button");
      if (shellConnect) shellConnect.click();
      else void services.wallet.connect();
    },
  });
  scope.onDispose(() => dockPrimary.dispose());
  view.fillRules();
  view.buildPalette();
  view.setFlow("disconnected");
  camera.applyCamera(fitCamera(camera.readViewportSize()));
  camera.render();
  view.showSelection();

  // `#tile-x-y` opens the wall on that tile, in Look mode.
  function focusTileFromHash(): void {
    const cell = parseTileHash(window.location.hash);
    if (!cell || scope.isDisposed()) return;
    view.select(cell);
    camera.applyCamera(paintZoomCamera(camera.readViewportSize(), cell, PAINT_CELL_PX));
    camera.render();
    view.showSelection();
  }
  focusTileFromHash();
  scope.listen(window, "hashchange", focusTileFromHash);
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
    paintZoom: () => camera.zoomToPaint(),
  });

  const unsubWallet = services.wallet.subscribe((session) => {
    if (scope.isDisposed()) return;
    const previousAccount = scope.walletAccount();
    const previousNetwork = scope.walletNetwork();
    scope.setWallet(session.accountId, session.networkId);
    if (
      previousAccount !== session.accountId ||
      previousNetwork !== session.networkId
    ) {
      paint.onWalletChanged();
    }
    wallPage.dataset.signedIn = String(session.accountId !== null);
    if (!previousAccount && session.accountId) modes.setMode("paint");
    else if (previousAccount && !session.accountId) modes.setMode("look");
    if (!session.accountId) {
      view.setFlow("disconnected");
    } else if (view.uiPhase() === "disconnected" || view.uiPhase() === "failed") {
      view.setFlow(view.selected() ? "editing" : "connected");
    }
    paint.showDrawingSession();
    void pricing.refreshCreditsDock();
    dockPrimary.sync();
    if (previousAccount !== session.accountId) views?.onWalletChanged();
    invite?.render();
  });
  scope.onDispose(unsubWallet);
  scope.onDispose(() => {
    pricing.dispose();
  });

  function disposeWall(): void {
    if (!scope.markDisposed()) return;
    board.dispose();
    wallHint.dispose();
    paint.dispose();
    camera.dispose();
    scope.runCleanups();
    // Do NOT clear services.operations — broadcast ops must survive navigation.
    pageRoot.replaceChildren();
  }

  return disposeWall;
}
