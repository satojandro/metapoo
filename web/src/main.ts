import "./style.css";
import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type NetworkId } from "@shared/types.ts";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixel,
  rememberPixelIfNewer,
  replaceCache,
} from "./board-cache";
import {
  beginBoardLoad,
  createBoardSyncState,
  formatFreshness,
  markBoardLoadApplied,
  markBoardLoadFailed,
  nextPollDelayMs,
  shouldApplyBoardLoad,
  shouldPollNow,
} from "./board-sync";
import { CONTRACT_ID, PAGE_NETWORK } from "./config";
import {
  fetchAllPaintedPixels,
  getBoard,
  getPixel,
  isContractConfigured,
} from "./contract";
import { validateContractMetadata } from "./contract-meta";
import { prepareDraw } from "./draw-policy";
import {
  describeDrawingSession,
  forgetDrawingSessionLocally,
  formatAllowanceNear,
  loadDrawingSessionRecord,
} from "./drawing-session";
import {
  canUseLocalDrawingSession,
  fetchDrawingSessionAllowance,
} from "./local-draw";
import { describeNetwork } from "./network";
import {
  createPaintQueue,
  enqueuePaint,
  paintQueueLength,
  shiftPaint,
} from "./paint-queue";
import {
  createPendingPaintMap,
  listPendingPaints,
  reconcilePendingWithConfirmed,
  setPendingPaint,
  clearPendingPaint,
} from "./pending-paint";
import { renderBoard } from "./render-board";
import { moveSelection, type Cell } from "./selection";
import { describeSponsorship } from "./sponsorship";
import { submitDraw } from "./submit-draw";
import {
  cellFromViewportPoint,
  fitCamera,
  isPanGesture,
  paintZoomCamera,
  panBy,
  selectionRingStyle,
  stageSizeStyle,
  stageTransform,
  zoomAt,
  type Camera,
  type ViewportSize,
} from "./viewport";
import {
  connectWallet,
  disconnectWallet,
  onWalletSession,
  revokeDrawingSessionKeyOnChain,
} from "./wallet";

/**
 * Page wiring.
 *
 * State flow (also documented in web/README.md):
 * disconnected → connected → editing → wallet prompt → pending → success | error
 *
 * Confirmed pixels come only from chain reads. Pending paint is a separate
 * client layer. Pan / pinch / scroll-zoom never submit paint — only Place /
 * Enter do. Uncertain outcomes are not auto-resubmitted.
 */

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`The page is missing required element ${selector}.`);
  }
  return element;
}

const canvas = mustFind<HTMLCanvasElement>("#board");
const selectionRing = mustFind<HTMLElement>("#selection-ring");
const boardFocus = mustFind<HTMLElement>("#board-focus");
const boardViewport = mustFind<HTMLElement>("#board-viewport");
const boardStage = mustFind<HTMLElement>("#board-stage");
const selectionSummary = mustFind<HTMLElement>("#selection-summary");
const preview = mustFind<HTMLElement>("#selection-preview");
const palette = mustFind<HTMLElement>("#palette");
const drawButton = mustFind<HTMLButtonElement>("#draw-button");
const result = mustFind<HTMLElement>("#result");
const rules = mustFind<HTMLElement>("#rules");
const walletSummary = mustFind<HTMLElement>("#wallet-summary");
const networkSummary = mustFind<HTMLElement>("#network-summary");
const connectButton = mustFind<HTMLButtonElement>("#connect-button");
const walletError = mustFind<HTMLElement>("#wallet-error");
const sponsorNote = mustFind<HTMLElement>("#sponsor-note");
const evidence = mustFind<HTMLElement>("#evidence");
const flowState = mustFind<HTMLElement>("#flow-state");
const compactStatus = mustFind<HTMLElement>("#compact-status");
const lede = mustFind<HTMLElement>("#lede");
const refreshButton = mustFind<HTMLButtonElement>("#refresh-board");
const boardLoadStatus = mustFind<HTMLElement>("#board-load-status");
const zoomInButton = mustFind<HTMLButtonElement>("#zoom-in");
const zoomOutButton = mustFind<HTMLButtonElement>("#zoom-out");
const zoomFitButton = mustFind<HTMLButtonElement>("#zoom-fit");
const zoomPaintButton = mustFind<HTMLButtonElement>("#zoom-paint");
const drawingSessionStatus = mustFind<HTMLElement>("#drawing-session-status");
const drawingSessionNote = mustFind<HTMLElement>("#drawing-session-note");
const authorizeDrawingSession = mustFind<HTMLInputElement>(
  "#authorize-drawing-session",
);
const authorizeSessionButton = mustFind<HTMLButtonElement>(
  "#authorize-session-button",
);
const forgetSessionButton = mustFind<HTMLButtonElement>(
  "#forget-session-button",
);
const revokeSessionButton = mustFind<HTMLButtonElement>(
  "#revoke-session-button",
);
const hoverSummary = mustFind<HTMLElement>("#hover-summary");
const directPaintToggle = mustFind<HTMLInputElement>("#direct-paint-toggle");

const pixelCache = createPixelCache();
const pendingPaints = createPendingPaintMap();
const boardSync = createBoardSyncState();
const paintQueue = createPaintQueue();

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
/** High-level UI phase for the status strip. */
let uiPhase:
  | "disconnected"
  | "connected"
  | "editing"
  | "wallet_prompt"
  | "pending"
  | "success"
  | "error" = "disconnected";

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
showWallet();
showDrawingSession();
void bootstrapBoard();
scheduleBoardPoll();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshBoardFromContract({ reason: "visible" });
    scheduleBoardPoll();
  } else {
    clearBoardPoll();
  }
});

window.addEventListener("online", () => {
  void refreshBoardFromContract({ reason: "reconnect" });
  scheduleBoardPoll();
});

const resizeObserver = new ResizeObserver(() => {
  camera = clampToViewport(camera);
  applyCamera(camera);
  positionSelection();
});
resizeObserver.observe(boardViewport);

drawButton.addEventListener("click", () => {
  void attemptDraw();
});

connectButton.addEventListener("click", () => {
  void onConnectClick();
});

authorizeSessionButton.addEventListener("click", () => {
  void onAuthorizeSessionClick();
});

forgetSessionButton.addEventListener("click", () => {
  forgetDrawingSessionLocally();
  showDrawingSession();
});

revokeSessionButton.addEventListener("click", () => {
  void onRevokeSessionClick();
});

directPaintToggle.addEventListener("change", () => {
  updateDirectPaintAvailability();
});

refreshButton.addEventListener("click", () => {
  void refreshBoardFromContract();
});

zoomInButton.addEventListener("click", () => {
  zoomFromCenter(1.25);
});
zoomOutButton.addEventListener("click", () => {
  zoomFromCenter(1 / 1.25);
});
zoomFitButton.addEventListener("click", () => {
  applyCamera(fitCamera(readViewportSize()));
  positionSelection();
  updateCompactStatus();
});
zoomPaintButton.addEventListener("click", () => {
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

boardViewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = boardViewport.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    applyCamera(
      zoomAt(
        camera,
        readViewportSize(),
        factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      ),
    );
    positionSelection();
    updateCompactStatus();
  },
  { passive: false },
);

boardFocus.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void attemptDraw();
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomFromCenter(1.25);
    return;
  }
  if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomFromCenter(1 / 1.25);
    return;
  }
  if (event.key === "0") {
    event.preventDefault();
    applyCamera(fitCamera(readViewportSize()));
    positionSelection();
    updateCompactStatus();
    return;
  }
  const next = moveSelection(selected, event.key);
  if (next === selected) {
    return;
  }
  if (
    event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "ArrowLeft" ||
    event.key === "ArrowRight"
  ) {
    event.preventDefault();
    selected = next;
    if (walletAccount) {
      setFlow("editing");
    }
    // Keep the selected cell in view when stepping with keys while zoomed.
    if (selected) {
      applyCamera(paintZoomCamera(readViewportSize(), selected, camera.cellSize));
    }
    render();
    showSelection();
    void refreshSelectedPixel();
  }
});

onWalletSession((session) => {
  walletAccount = session.accountId;
  walletNetwork = session.networkId;
  if (!walletAccount) {
    setFlow("disconnected");
  } else if (uiPhase === "disconnected" || uiPhase === "error") {
    setFlow(selected ? "editing" : "connected");
  }
  showWallet();
  showDrawingSession();
});

async function bootstrapBoard(): Promise<void> {
  if (!isContractConfigured()) {
    contractMetaOk = true;
    evidence.textContent =
      "Evidence: local mock. This picture is an empty board drawn in your browser. It is not testnet or mainnet state. Set VITE_CONTRACT_ID to read a real contract.";
    boardLoadStatus.textContent =
      "Board load: mock only (no contract id). Refresh stays disabled.";
    updateCompactStatus();
    updateDirectPaintAvailability();
    return;
  }

  evidence.textContent = `Evidence: reading contract ${CONTRACT_ID} on ${PAGE_NETWORK}. Validating metadata, then loading painted cells…`;
  try {
    const board = await getBoard();
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
  if (!isContractConfigured() || boardLoadInFlight) {
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
    replaceCache(pixelCache, snapshot.pixels);
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
    const pixel = await getPixel(selected.x, selected.y);
    rememberPixelIfNewer(pixelCache, pixel);
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
  if (!isContractConfigured()) {
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

async function attemptDraw(target?: Cell): Promise<void> {
  if (drawInFlight) {
    return;
  }

  const cell = target ?? selected;
  const decision = prepareDraw({
    x: cell?.x ?? null,
    y: cell?.y ?? null,
    color: selectedColor,
    connected: walletAccount !== null,
    accountId: walletAccount,
    sessionNetworkId: walletNetworkId(),
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

  if (!cell || selectedColor === null || !walletAccount) {
    return;
  }
  selected = cell;

  drawInFlight = true;
  drawButton.disabled = true;
  setFlow("wallet_prompt");
  setPendingPaint(pendingPaints, {
    x: selected.x,
    y: selected.y,
    colorIndex: selectedColor,
    accountId: walletAccount,
    transactionId: null,
    phase: "submitted",
  });
  render();
  fillBlock(
    result,
    "Waiting for your wallet",
    [
      `Approve draw at x=${selected.x}, y=${selected.y}, color=${selectedColor} (${colorName(selectedColor)}).`,
      "Your wallet may ask you to pay a small network gas fee. The game adds no application fee.",
      sponsorship.message,
    ].join(" "),
  );

  try {
    const submitResult = await submitDraw({
      x: selected.x,
      y: selected.y,
      colorIndex: selectedColor,
      accountId: walletAccount,
      networkId: walletNetworkId(),
      onProgress: (progress) => {
        if (progress.phase === "wallet_prompt") {
          setFlow("wallet_prompt");
          fillBlock(result, "Waiting for your wallet", progress.detail);
        } else if (progress.phase === "pending" || progress.phase === "confirming") {
          setFlow("pending");
          if (selected && selectedColor !== null && walletAccount) {
            setPendingPaint(pendingPaints, {
              x: selected.x,
              y: selected.y,
              colorIndex: selectedColor,
              accountId: walletAccount,
              transactionId: progress.transactionId,
              phase: "submitted",
            });
            render();
          }
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

    if (submitResult.status === "success" && submitResult.pixel) {
      rememberPixel(pixelCache, submitResult.pixel);
      clearPendingPaint(pendingPaints, selected.x, selected.y);
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
      setPendingPaint(pendingPaints, {
        x: selected.x,
        y: selected.y,
        colorIndex: selectedColor,
        accountId: walletAccount,
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
      rememberPixelIfNewer(pixelCache, submitResult.pixel);
      clearPendingPaint(pendingPaints, selected.x, selected.y);
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

    clearPendingPaint(pendingPaints, selected.x, selected.y);
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
    drawButton.disabled = false;
    showWallet();
    showDrawingSession();
  }
}

async function onConnectClick(): Promise<void> {
  clearBlock(walletError);
  connectButton.disabled = true;
  authorizeSessionButton.disabled = true;
  try {
    if (walletAccount) {
      await disconnectWallet();
      setFlow("disconnected");
    } else {
      const wantSession =
        authorizeDrawingSession.checked && isContractConfigured();
      await connectWallet({ authorizeDrawingSession: wantSession });
      setFlow(selected ? "editing" : "connected");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    setFlow("error");
    fillBlock(
      walletError,
      "Wallet was not connected",
      `You can keep looking at the board. ${detail}`,
    );
  } finally {
    connectButton.disabled = false;
    showWallet();
    showDrawingSession();
  }
}

/**
 * Re-run connect with addFunctionCallKey while already signed in (or when the
 * checkbox path was skipped). Ordinary Connect remains available as fallback.
 */
async function onAuthorizeSessionClick(): Promise<void> {
  clearBlock(walletError);
  if (!isContractConfigured()) {
    fillBlock(
      walletError,
      "Drawing session unavailable",
      "Set VITE_CONTRACT_ID before authorizing a drawing session.",
    );
    return;
  }
  authorizeSessionButton.disabled = true;
  connectButton.disabled = true;
  try {
    await connectWallet({ authorizeDrawingSession: true });
    setFlow(selected ? "editing" : "connected");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    setFlow("error");
    fillBlock(
      walletError,
      "Drawing session was not authorized",
      `Ordinary wallet approval still works for each draw. ${detail}`,
    );
  } finally {
    connectButton.disabled = false;
    showWallet();
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

  boardViewport.addEventListener("pointerdown", (event) => {
    boardViewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      primaryId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      lastX = event.clientX;
      lastY = event.clientY;
      panning = false;
    } else if (pointers.size === 2) {
      panning = true;
      const pts = [...pointers.values()];
      pinchStartDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartCellSize = camera.cellSize;
      boardViewport.classList.add("is-panning");
    }
  });

  boardViewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) {
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

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

    if (event.pointerId !== primaryId) {
      return;
    }

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!panning && isPanGesture(dx, dy)) {
      panning = true;
      boardViewport.classList.add("is-panning");
    }
    if (panning) {
      applyCamera(
        panBy(camera, readViewportSize(), event.clientX - lastX, event.clientY - lastY),
      );
      positionSelection();
      lastX = event.clientX;
      lastY = event.clientY;
    } else {
      updateHoverFromClient(event.clientX, event.clientY);
    }
  });

  const endPointer = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) {
      return;
    }
    pointers.delete(event.pointerId);

    if (pointers.size < 2) {
      pinchStartDistance = 0;
    }

    if (event.pointerId === primaryId && pointers.size === 0) {
      const wasPan = panning;
      boardViewport.classList.remove("is-panning");
      primaryId = null;
      panning = false;

      if (!wasPan) {
        selectAtClientPoint(event.clientX, event.clientY);
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

  boardViewport.addEventListener("pointerup", endPointer);
  boardViewport.addEventListener("pointercancel", endPointer);
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

  if (
    directPaintToggle.checked &&
    canUseLocalDrawingSession(walletAccount, walletNetwork) &&
    selectedColor !== null &&
    contractMetaOk
  ) {
    enqueuePaint(paintQueue, {
      x: next.x,
      y: next.y,
      colorIndex: selectedColor,
    });
    setPendingPaint(pendingPaints, {
      x: next.x,
      y: next.y,
      colorIndex: selectedColor,
      accountId: walletAccount!,
      transactionId: null,
      phase: "submitted",
    });
    render();
    void drainPaintQueue();
  }
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

async function drainPaintQueue(): Promise<void> {
  if (paintQueue.inFlight) {
    return;
  }
  const next = shiftPaint(paintQueue);
  if (!next) {
    return;
  }
  paintQueue.inFlight = true;
  try {
    await attemptDraw(next);
  } finally {
    paintQueue.inFlight = false;
    if (paintQueueLength(paintQueue) > 0) {
      void drainPaintQueue();
    }
  }
}

async function onRevokeSessionClick(): Promise<void> {
  clearBlock(walletError);
  const record = loadDrawingSessionRecord();
  if (!record?.publicKey) {
    fillBlock(
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
    fillBlock(
      walletError,
      "On-chain revoke did not complete",
      `The key may still exist on chain. ${detail}`,
    );
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

function showWallet(): void {
  if (walletAccount) {
    walletSummary.textContent = `Connected account: ${walletAccount}. Contract: ${
      CONTRACT_ID || "not configured"
    }.`;
    connectButton.textContent = "Disconnect wallet";
  } else {
    walletSummary.textContent = `Not connected. You can still look at the board. Contract: ${
      CONTRACT_ID || "not configured"
    }.`;
    connectButton.textContent = "Connect NEAR wallet";
  }
  const notice = describeNetwork(walletAccount ? walletNetwork : null);
  networkSummary.textContent = notice.message;
  updateCompactStatus();
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
  authorizeDrawingSession.disabled = !canUseContract || walletAccount !== null;
  authorizeDrawingSession.title = canUseContract
    ? "Ask the wallet for a draw-only function-call key during Connect"
    : "Configure VITE_CONTRACT_ID first";

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
