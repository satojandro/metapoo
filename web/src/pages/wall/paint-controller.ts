import { explorerUrl } from "@shared/board-rules.ts";
import type { PixelView } from "@shared/types.ts";
import { paintOperationId, type OperationPhase } from "../../app/operations";
import type { AppServices } from "../../app/services";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import { contractMetaBlockCopy } from "../../contract-meta";
import { createDrawRequest, drawRequestMatchesSession, type DrawRequest } from "../../draw-request";
import { prepareDraw } from "../../draw-policy";
import { isDrawingKeyLow, paintFailureCopy } from "../../drawing-session";
import { canUseLocalDrawingSession, prefetchSigningContext, signAndSendStrokeLocally } from "../../local-draw";
import { clearPaintQueue, createPaintQueue, enqueuePaint, paintQueueLength, shiftPaint } from "../../paint-queue";
import {
  clearPendingPaint, createPendingPaintMap, getPendingPaint, listPendingPaints, reconcilePendingWithConfirmed, setPendingPaint,
  type PendingPaint, type PendingPaintPhase,
} from "../../pending-paint";
import type { Cell } from "../../selection";
import type { SponsorshipStatus } from "../../sponsorship";
import { submitDraw, type SubmitDrawResult } from "../../submit-draw";
import type { BoardController } from "./board-controller";
import type { CameraStrokeHooks } from "./camera-controller";
import { createPaintSessionPanel, type PaintSessionDom } from "./paint-session-panel";
import { createPlacementOutcomeController, mountPlacementOutcomeLayer } from "./placement-outcome";
import type { CreditReservation, PricingController } from "./pricing-controller";
import { isPriceRoseAboveMax } from "./repaint-price";
import { planStrokeCommit, strokeBlockedReason, strokeResultCopy, TRUNCATED_STROKE_COPY, WALLET_STROKE_COPY } from "./stroke-commit";
import { strokeBegin, strokeExtend, MAX_BATCH, type StrokeState } from "./stroke-paint";
import { colorName, fillBlock, fillResultWithLink, type WallView } from "./wall-view";
import type { WallScope } from "./wall-scope";

export interface PaintControllerDeps extends PaintSessionDom {
  scope: WallScope;
  services: AppServices;
  sponsorship: SponsorshipStatus;
  /** Hosts the placement-outcome layer. */
  boardViewport: HTMLElement;
  drawState: HTMLElement;
  /** Why Place paint is disabled, shown beside the button. Optional for older test mounts. */
  placeReason?: HTMLElement;
  /** Shell-owned status strip. */
  flowState: HTMLElement;
  board: Pick<BoardController, "contractMetaOk" | "contractMetaIssue" | "rememberPixel" | "refreshBoardFromContract">;
  pricing: Pick<
    PricingController,
    | "paidBoard" | "priceUnavailable" | "allowGestureRetry" | "ensurePaidQuote" | "admitTap"
    | "refreshCreditsDock" | "repriceCell" | "settle" | "release" | "confirmRequote"
    | "announcePainted" | "clearStrokeHeadline"
  >;
  view: Pick<
    WallView,
    "selected" | "setSelected" | "selectedColor" | "setFlow" | "showSelection" | "pulseSelection"
  >;
  render(): void;
}

export interface PaintController {
  /** What the camera calls for a one-pointer gesture. */
  strokes: CameraStrokeHooks;
  /** Pending paints and the live stroke, for the renderer. */
  overlayPixels(): PendingPaint[];
  pendingCount(): number;
  /** Confirmed pixels arrived; clear the pending marks they settle. */
  reconcilePending(pixels: PixelView[]): void;
  drawInFlight(): boolean;
  /** Place paint / Enter: paint the selected square with the chosen colour. */
  attemptDraw(): Promise<void>;
  /** A deliberate tap; queues a direct paint when Direct paint is armed. */
  maybeEnqueueDirectPaint(cell: Cell, options?: { paintZoom: boolean }): void;
  syncSubmitEnabled(): void;
  updateDirectPaintAvailability(): void;
  showDrawingSession(): void;
  /** The wallet account or network changed: drop the stroke and unsent paints. */
  onWalletChanged(): void;
  /** Test seam (WallMountTestApi): queue a paint without a live session. */
  enqueueUnsent(request: DrawRequest): void;
  queueLength(): number;
  drainPaintQueue(): Promise<void>;
  dispose(): void;
}

type AnchoredStroke = { state: StrokeState; accountId: string; networkId: string; color: number };

/**
 * Sending paints and the drawing session: the single-cell draw, the stroke,
 * the direct-paint queue and the pending marks on the board.
 */
export function createPaintController(deps: PaintControllerDeps): PaintController {
  const { scope, services, sponsorship, board, pricing, view, drawButton, result, drawState, flowState, directPaintToggle } = deps;

  const pendingPaints = createPendingPaintMap();
  const placementOutcomes = createPlacementOutcomeController();
  const queuedPlacementOutcomes = new WeakMap<DrawRequest, string>();
  /** Credits each queued tap holds (pricing-controller owns the balance). */
  const queuedReservations = new WeakMap<DrawRequest, CreditReservation>();
  const unmountPlacementOutcomes = mountPlacementOutcomeLayer(
    deps.boardViewport,
    placementOutcomes,
  );
  const paintQueue = createPaintQueue();
  let drawInFlight = false;
  let activeStroke: AnchoredStroke | null = null;

  /** Mark a cell pending on the board for this request's colour and account. */
  const markPending = (
    paint: Pick<DrawRequest, "x" | "y" | "colorIndex" | "accountId">,
    transactionId: string | null,
    phase: PendingPaintPhase,
  ): void => {
    setPendingPaint(pendingPaints, {
      x: paint.x,
      y: paint.y,
      colorIndex: paint.colorIndex,
      accountId: paint.accountId,
      transactionId,
      phase,
    });
  };

  const session = createPaintSessionPanel({
    ...deps,
    contractMetaOk: () => board.contractMetaOk(),
    selected: () => view.selected(),
    setFlow: (phase) => view.setFlow(phase),
  });

  scope.listen(drawButton, "click", () => {
    void attemptDraw();
  });

  const strokes: CameraStrokeHooks = {
    active: () => activeStroke !== null,
    begin(cell, wantsPan) {
      const selectedColor = view.selectedColor();
      const walletAccount = scope.walletAccount();
      const walletNetwork = scope.walletNetwork();
      pricing.allowGestureRetry();

      if (cell && !wantsPan && directPaintToggle.checked &&
          walletAccount && selectedColor !== null && board.contractMetaOk() &&
          !drawInFlight && !paintQueue.inFlight && !paintQueueLength(paintQueue) &&
          canUseLocalDrawingSession(walletAccount, walletNetwork)) {
        activeStroke = { state: strokeBegin(cell), accountId: walletAccount,
          networkId: scope.walletNetworkId(), color: selectedColor };
        deps.render();
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
      deps.render();
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

  function syncSubmitEnabled(): void {
    const noSquare = view.selected() === null;
    const noPrice = pricing.paidBoard() && pricing.priceUnavailable();
    drawButton.disabled = drawInFlight || noPrice || noSquare;
    if (deps.placeReason) {
      // Say why the button is off, next to it. In flight, the status line already says.
      deps.placeReason.textContent = drawInFlight
        ? ""
        : noSquare
          ? "Choose a square on the wall first."
          : noPrice
            ? "Price unavailable. Refresh the board to try again."
            : "";
    }
  }

  /** After any paint settles: buttons, session note, balance and price. */
  function afterPaintSettled(): void {
    // Dock credits previously refreshed only on wallet change / shortfall —
    // after a confirmed (or delayed) spend the balance must re-read the chain.
    void pricing.refreshCreditsDock();
    const selected = view.selected();
    if (selected) {
      pricing.repriceCell(selected);
    }
  }

  async function attemptDraw(
    request?: DrawRequest,
    queuedPlacementOutcomeId?: string,
    requote?: { approvedMax: number },
  ): Promise<void> {
    const queuedReservation = request ? queuedReservations.get(request) : undefined;
    if (request) queuedReservations.delete(request);
    if (scope.isDisposed() || drawInFlight) {
      pricing.release(queuedReservation);
      return;
    }
    const walletAccount = scope.walletAccount();

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
            networkId: scope.walletNetworkId(),
          })
        : null);

    // Live wallet must still match the frozen request. A queued paint must not
    // keep going after disconnect or account switch just because the request exists.
    if (
      frozen &&
      !drawRequestMatchesSession(frozen, walletAccount, scope.walletNetworkId())
    ) {
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      view.setFlow(walletAccount ? "editing" : "disconnected");
      fillBlock(
        result,
        "Paint cancelled",
        "The wallet account or network no longer matches this paint request, so it was not submitted.",
      );
      pricing.release(queuedReservation);
      deps.render();
      return;
    }

    const decision = prepareDraw({
      x: frozen?.x ?? null,
      y: frozen?.y ?? null,
      color: frozen?.colorIndex ?? null,
      connected: walletAccount !== null,
      accountId: frozen?.accountId ?? walletAccount,
      sessionNetworkId: frozen?.networkId ?? scope.walletNetworkId(),
      boardNetworkId: PAGE_NETWORK,
      contractId: CONTRACT_ID,
    });

    if (decision.outcome === "blocked") {
      pricing.release(queuedReservation);
      view.setFlow(walletAccount ? "editing" : "disconnected");
      fillBlock(result, decision.title, decision.message);
      return;
    }

    if (!board.contractMetaOk()) {
      pricing.release(queuedReservation);
      view.setFlow("failed");
      const copy = contractMetaBlockCopy(board.contractMetaIssue());
      fillBlock(result, copy.title, copy.message);
      return;
    }

    if (!frozen) {
      pricing.release(queuedReservation);
      return;
    }

    // Price before any pending mark or wallet prompt. A failed read must not
    // leave a stripe on the board or open a signature request.
    drawInFlight = true;
    drawButton.disabled = true;
    const priced = await pricing.ensurePaidQuote(
      [{ x: frozen.x, y: frozen.y }],
      frozen.accountId,
      { reservation: queuedReservation, approvedMax: requote?.approvedMax },
    );
    if (!priced || scope.isDisposed()) {
      pricing.release(priced?.reservation ?? queuedReservation);
      drawInFlight = false;
      if (frozen) {
        clearPendingPaint(pendingPaints, frozen.x, frozen.y);
        if (queuedPlacementOutcomeId) {
          placementOutcomes.discard(queuedPlacementOutcomeId);
        }
      }
      if (!scope.isDisposed()) {
        deps.render();
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
    // Every record for this paint shares id, account, network and cell.
    const recordOp = (
      phase: OperationPhase,
      transactionId: string | null,
      title: string,
      detail: string,
    ): void => {
      services.operations.upsert({
        id: opId,
        kind: "paint",
        phase,
        accountId: frozen.accountId,
        networkId: frozen.networkId,
        transactionId,
        title,
        detail,
        meta: { x: frozen.x, y: frozen.y, colorIndex: frozen.colorIndex },
      });
    };
    const placementOutcomeId = queuedPlacementOutcomeId ?? placementOutcomes.submit({
      x: frozen.x,
      y: frozen.y,
      colorIndex: frozen.colorIndex,
    });
    recordOp(
      "awaiting_signature",
      null,
      "Paint",
      `Awaiting wallet for x=${frozen.x}, y=${frozen.y}, color=${frozen.colorIndex}`,
    );
    markPending(frozen, null, "submitted");
    deps.render();
    fillBlock(
      result,
      "Waiting for your wallet",
      [
        `Approve draw at x=${frozen.x}, y=${frozen.y}, color=${frozen.colorIndex} (${colorName(frozen.colorIndex)}).`,
        "Your wallet may ask you to pay a small network gas fee. The game adds no application fee.",
        sponsorship.message,
      ].join(" "),
    );

    const reservation = priced.reservation;
    /** Set when the chain said PriceRoseAboveMax and the painter accepted the new total. */
    let retryMax: number | null = null;
    try {
      const submitResult = await submitDraw({
        x: frozen.x,
        y: frozen.y,
        colorIndex: frozen.colorIndex,
        accountId: frozen.accountId,
        networkId: frozen.networkId,
        maxCredits: priced.maxCredits,
        onProgress: (progress) => {
          // Always record broadcast progress on the shared operations store.
          if (progress.phase === "pending" || progress.phase === "confirming") {
            recordOp(
              "submitted",
              progress.transactionId,
              "Paint",
              progress.phase === "pending"
                ? "Transaction pending confirmation"
                : "Confirming against a fresh board read",
            );
          }
          if (scope.isDisposed()) {
            return;
          }
          if (progress.phase === "wallet_prompt") {
            view.setFlow("wallet_prompt");
            fillBlock(result, "Waiting for your wallet", progress.detail);
          } else if (progress.phase === "pending" || progress.phase === "confirming") {
            view.setFlow("submitted");
            markPending(frozen, progress.transactionId, "submitted");
            deps.render();
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
      // Credits: an executed (or possibly executed) paint settles from the
      // chain; anything else spent nothing.
      if (submitResult.status === "failed" || submitResult.status === "rejected") {
        pricing.release(reservation);
      } else {
        pricing.settle(reservation);
      }
      const recordResult = (phase: OperationPhase) =>
        recordOp(phase, submitResult.transactionId, submitResult.title, submitResult.message);
      const showResult = () =>
        fillResultWithLink(
          result,
          submitResult.title,
          submitResult.message,
          submitResult.transactionId,
          submitResult.explorerUrl,
        );

      if (scope.isDisposed()) {
        // Page left while this draw was in flight: keep operations store, skip DOM.
        if (submitResult.status === "confirmed" || submitResult.status === "overwritten") {
          recordResult(submitResult.status);
        } else if (submitResult.status === "confirmation_delayed") {
          recordResult("confirmation_delayed");
        } else if (submitResult.status !== "rejected") {
          recordResult("failed");
        }
        return;
      }

      if (submitResult.status === "confirmed" && submitResult.pixel) {
        recordResult("confirmed");
        // Use the confirming get_pixel's block height only — never a later tip.
        board.rememberPixel(submitResult.pixel, submitResult.observedBlockHeight);
        clearPendingPaint(pendingPaints, frozen.x, frozen.y);
        deps.render();
        // The dock's headline is the confirmation now (owner, 11 Nov): the tile
        // that just landed is not one about to be painted, so its stroke summary
        // is spent. The ring is on this tile, so it gets one beat.
        pricing.announcePainted(priced.maxCredits);
        view.pulseSelection();
        view.setFlow("confirmed");
        showResult();
        view.showSelection();
        void board.refreshBoardFromContract({ reason: "after_draw" });
        return;
      }

      if (submitResult.status === "confirmation_delayed") {
        recordResult("confirmation_delayed");
        markPending(frozen, submitResult.transactionId, "confirmation_delayed");
        deps.render();
        pricing.clearStrokeHeadline();
        view.setFlow("confirmation_delayed");
        showResult();
        view.showSelection();
        // Do not auto-resubmit. Polling / refresh will reconcile.
        return;
      }

      if (submitResult.status === "overwritten" && submitResult.pixel) {
        recordResult("overwritten");
        board.rememberPixel(submitResult.pixel, submitResult.observedBlockHeight);
        clearPendingPaint(pendingPaints, frozen.x, frozen.y);
        deps.render();
        pricing.clearStrokeHeadline();
        view.setFlow("overwritten");
        showResult();
        view.showSelection();
        void board.refreshBoardFromContract({ reason: "after_draw" });
        return;
      }

      recordResult("failed");
      clearPendingPaint(pendingPaints, frozen.x, frozen.y);
      deps.render();
      pricing.clearStrokeHeadline();
      if (submitResult.status === "failed" && submitResult.keyLow) {
        session.promptKeyRenewal();
      }
      if (submitResult.status === "failed" && isPriceRoseAboveMax(submitResult.message) && !requote) {
        // Nothing was stored or charged. Re-quote and ask once; never retry silently.
        view.setFlow("editing");
        retryMax = await pricing.confirmRequote(
          [{ x: frozen.x, y: frozen.y }],
          frozen.accountId,
        );
        return;
      }
      view.setFlow("failed");
      showResult();
    } finally {
      drawInFlight = false;
      if (!scope.isDisposed()) {
        syncSubmitEnabled();
        session.showDrawingSession();
        afterPaintSettled();
        if (retryMax !== null) {
          await attemptDraw(frozen, undefined, { approvedMax: retryMax });
        }
      }
    }
  }

  async function commitStroke(
    stroke: AnchoredStroke,
    requote?: { approvedMax: number },
  ): Promise<void> {
    const stillArmed = () =>
      stroke.accountId === scope.walletAccount() &&
      stroke.networkId === scope.walletNetworkId() && directPaintToggle.checked;
    if (scope.isDisposed() || drawInFlight || !stillArmed()) return;
    drawInFlight = true;
    drawButton.disabled = true;
    // Read the key, block and gas price while the stroke is being priced.
    const prepared = canUseLocalDrawingSession(scope.walletAccount(), scope.walletNetwork())
      ? prefetchSigningContext({ accountId: stroke.accountId, networkId: stroke.networkId })
      : undefined;
    const priced = await pricing.ensurePaidQuote(stroke.state.cells, stroke.accountId, {
      approvedMax: requote?.approvedMax,
    });
    if (!priced || scope.isDisposed() || !stillArmed()) {
      pricing.release(priced?.reservation);
      drawInFlight = false;
      if (!scope.isDisposed()) syncSubmitEnabled();
      return;
    }
    const plan = planStrokeCommit(
      stroke.state,
      canUseLocalDrawingSession(scope.walletAccount(), scope.walletNetwork()),
    );
    if (plan.kind === "wallet_approval") {
      pricing.release(priced.reservation);
      drawInFlight = false;
      if (!scope.isDisposed()) syncSubmitEnabled();
      fillBlock(result, "Drawing session needed", WALLET_STROKE_COPY);
      return;
    }
    drawInFlight = true;
    for (const cell of stroke.state.cells) setPendingPaint(pendingPaints, {
      ...cell, colorIndex: stroke.color, accountId: stroke.accountId,
      transactionId: null, phase: "submitted",
    });
    deps.render();
    view.setFlow("submitted");
    let retry: { stroke: AnchoredStroke; approvedMax: number } | null = null;
    // Until the outcome says otherwise, assume credits may have been spent.
    let spent = true;
    try {
      const outcome = await signAndSendStrokeLocally({
        accountId: stroke.accountId, networkId: stroke.networkId,
        cells: stroke.state.cells, color: stroke.color,
        maxCredits: priced.chunkMaxCredits,
        prepared,
      });
      // The chain's own PriceRoseAboveMax: that chunk stored and charged nothing.
      // Batches are sent together, so read each one's own result: a failure in the
      // middle does not mean the batches after it were skipped.
      const chunkStates = outcome.chunks;
      const stateOf = (cellIndex: number) => chunkStates[Math.floor(cellIndex / MAX_BATCH)];
      // The chain's own PriceRoseAboveMax: that batch stored and charged nothing.
      const priceRose = chunkStates.some((c) => c.state === "failed" && isPriceRoseAboveMax(c.message));
      const keyLow = chunkStates.some((c) => isDrawingKeyLow(c.message));
      spent = chunkStates.some((c) => c.state === "confirmed" || c.state === "uncertain");
      if (scope.isDisposed()) return;

      // A confirmed chunk's receipt proves the write at a specific block. Stamp
      // those cells now instead of leaving the board stale until the next full
      // read: the read pages the whole wall (6 requests today, 64 on a full
      // 16,384-cell board), and waiting for it is what made a finished stroke
      // look unresolved. board-cache keeps the newer stamp if a snapshot from an
      // older block arrives, so this cannot be rolled back by a slow read.
      for (const { chunkIndex, blockHeight } of outcome.executedBlocks ?? []) {
        const start = chunkIndex * MAX_BATCH;
        for (const cell of stroke.state.cells.slice(start, start + MAX_BATCH)) {
          board.rememberPixel(
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

      // Uncertain batches keep a pending marker; everything else resolves through
      // a fresh chain read. Never infer execution from matching pre-existing paint.
      for (const [i, cell] of stroke.state.cells.entries()) {
        const chunk = stateOf(i);
        if (chunk?.state === "uncertain") {
          setPendingPaint(pendingPaints, { ...cell, colorIndex: stroke.color,
            accountId: stroke.accountId, transactionId: chunk.transactionHash, phase: "confirmation_delayed" });
        } else clearPendingPaint(pendingPaints, cell.x, cell.y);
      }
      fillBlock(result, outcome.status === "confirmed" ? "Stroke confirmed" : "Stroke stopped", strokeResultCopy(stroke.state, outcome));
      // A confirmed stroke replaces the stroke summary with the confirmation; a
      // stopped one leaves no summary behind either (owner, 11 Nov).
      if (outcome.status === "confirmed") pricing.announcePainted(priced.maxCredits);
      else pricing.clearStrokeHeadline();
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
        ? `${statusText} Reason: ${paintFailureCopy(failureReason)}`
        : statusText;
      if (keyLow) session.promptKeyRenewal();
      if (priceRose && !requote) {
        // Ask once for the cells that were not painted.
        const rest = stroke.state.cells.filter((_, i) => {
          const state = stateOf(i)?.state;
          return state === "failed" || state === "not_sent";
        });
        const approvedMax = await pricing.confirmRequote(rest, stroke.accountId);
        if (approvedMax !== null) {
          retry = { stroke: { ...stroke, state: { cells: rest, truncated: false } }, approvedMax };
        }
      }
      await board.refreshBoardFromContract({ reason: "after_draw" });
    } finally {
      if (spent) pricing.settle(priced.reservation);
      else pricing.release(priced.reservation);
      drawInFlight = false;
      if (!scope.isDisposed()) {
        syncSubmitEnabled();
        deps.render();
        afterPaintSettled();
        if (retry) await commitStroke(retry.stroke, { approvedMax: retry.approvedMax });
      }
    }
  }

  function directPaintReady(): boolean {
    const walletAccount = scope.walletAccount();
    return (
      session.tapToPaintEnabled() &&
      canUseLocalDrawingSession(walletAccount, scope.walletNetwork()) &&
      view.selectedColor() !== null &&
      walletAccount !== null &&
      board.contractMetaOk() &&
      !scope.isDisposed()
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
    const walletAccount = scope.walletAccount();
    if (!directPaintReady() || !walletAccount || selectedColor === null) {
      return;
    }
    // A tap is the core gesture and must never wait on the network: the
    // affordability check uses values already on screen (see admitTap).
    const reservation = pricing.admitTap(cell);
    if (!reservation) {
      return;
    }

    const queued = createDrawRequest({
      x: cell.x,
      y: cell.y,
      colorIndex: selectedColor,
      accountId: walletAccount,
      networkId: scope.walletNetworkId(),
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
    queuedReservations.set(queued, reservation);
    enqueuePaint(paintQueue, queued);
    markPending(queued, null, "submitted");
    deps.render();
    void drainPaintQueue();
  }

  function discardQueued(item: DrawRequest): void {
    pricing.release(queuedReservations.get(item));
    queuedReservations.delete(item);
    clearPendingPaint(pendingPaints, item.x, item.y);
    const outcomeId = queuedPlacementOutcomes.get(item);
    if (outcomeId) placementOutcomes.discard(outcomeId);
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
      discardQueued(item);
    }
    clearPaintQueue(paintQueue);
    if (options?.quiet || scope.isDisposed()) {
      return;
    }
    deps.render();
    fillBlock(result, "Queued paints cancelled", reason);
  }

  /**
   * The taps waiting behind `head` that can share its transaction: same account,
   * network and colour, in queue order, up to one `draw_many` (MAX_BATCH cells).
   *
   * No timer: the first tap is sent the moment it arrives, alone. Only taps that
   * queued up while an earlier paint was in flight are grouped, so a lone tap is
   * never delayed and a burst of taps costs one transaction instead of one each.
   * Grouping needs the drawing session (`draw_many` signed in the browser); the
   * wallet path keeps one paint per approval.
   *
   * With a session even a lone tap takes this path: one parallel read set, one
   * send, settled on the receipt. The single-`draw` path it used to take read the
   * key, block and price one after another and then re-read the pixel.
   */
  function takeTapBatch(head: DrawRequest): { items: DrawRequest[]; viaSession: boolean } {
    const batch = [head];
    if (!canUseLocalDrawingSession(scope.walletAccount(), scope.walletNetwork())) {
      return { items: batch, viaSession: false };
    }
    while (batch.length < MAX_BATCH) {
      const candidate = paintQueue.items[0];
      if (
        !candidate ||
        candidate.colorIndex !== head.colorIndex ||
        candidate.accountId !== head.accountId ||
        candidate.networkId !== head.networkId ||
        !drawRequestMatchesSession(candidate, scope.walletAccount(), scope.walletNetworkId())
      ) break;
      batch.push(shiftPaint(paintQueue)!);
    }
    return { items: batch, viaSession: true };
  }

  /**
   * Queued taps sent as one atomic `draw_many`. All of them land or none do,
   * so they share one result: confirmed, possibly broadcast, or not painted.
   */
  async function commitTapBatch(
    items: DrawRequest[],
    requote?: { approvedMax: number },
  ): Promise<void> {
    const first = items[0]!;
    const cells = items.map((item) => ({ x: item.x, y: item.y }));
    const outcomeIds = items.map((item) =>
      queuedPlacementOutcomes.get(item) ??
      placementOutcomes.submit({ x: item.x, y: item.y, colorIndex: item.colorIndex }));
    // One reservation for the batch: keep the first tap's (the quote re-sizes it)
    // and give the others back, or the balance check would count them twice.
    const held = queuedReservations.get(first);
    for (const item of items) {
      if (item !== first) pricing.release(queuedReservations.get(item));
      queuedReservations.delete(item);
      queuedPlacementOutcomes.delete(item);
    }
    const abandon = (): void => {
      for (const [i, item] of items.entries()) {
        clearPendingPaint(pendingPaints, item.x, item.y);
        placementOutcomes.discard(outcomeIds[i]!);
      }
    };
    const stillMatches = () =>
      drawRequestMatchesSession(first, scope.walletAccount(), scope.walletNetworkId());
    if (scope.isDisposed() || drawInFlight || !stillMatches()) {
      pricing.release(held);
      abandon();
      return;
    }
    drawInFlight = true;
    drawButton.disabled = true;
    // The key, block and gas price do not depend on the price: read them while
    // the quote is in flight, so the quote and the signature cost one round trip.
    const prepared = prefetchSigningContext({ accountId: first.accountId, networkId: first.networkId });
    const priced = await pricing.ensurePaidQuote(cells, first.accountId, {
      reservation: held,
      approvedMax: requote?.approvedMax,
    });
    if (!priced || scope.isDisposed() || !stillMatches()) {
      pricing.release(priced?.reservation ?? held);
      drawInFlight = false;
      abandon();
      if (!scope.isDisposed()) {
        deps.render();
        syncSubmitEnabled();
      }
      return;
    }
    const reservation = priced.reservation ?? held;
    // One id per tap for the whole batch. `paintOperationId` stamps the current
    // time into the id, so computing it per update made every phase a new record
    // and left "submitted" behind, listed as recoverable forever.
    const opIds = items.map((item) =>
      paintOperationId({ accountId: item.accountId, x: item.x, y: item.y, colorIndex: item.colorIndex }));
    const recordOps = (phase: OperationPhase, transactionId: string | null, title: string, detail: string): void => {
      for (const [i, item] of items.entries()) {
        services.operations.upsert({
          id: opIds[i]!,
          kind: "paint",
          phase,
          accountId: item.accountId,
          networkId: item.networkId,
          transactionId,
          title,
          detail,
          meta: { x: item.x, y: item.y, colorIndex: item.colorIndex },
        });
      }
    };
    for (const item of items) markPending(item, null, "submitted");
    recordOps("submitted", null, "Paint", `Sent with ${items.length - 1} other queued taps as one transaction`);
    view.setFlow("submitted");
    deps.render();

    let retryMax: number | null = null;
    // Until the outcome says otherwise, assume credits may have been spent.
    let spent = true;
    try {
      const outcome = await signAndSendStrokeLocally({
        accountId: first.accountId, networkId: first.networkId,
        cells, color: first.colorIndex,
        maxCredits: priced.chunkMaxCredits,
        prepared,
        // Settle on the receipt; the block height for the stamp follows.
        deferBlockHeights: true,
      });
      // The chain's own PriceRoseAboveMax: nothing was stored or charged.
      const chunk = outcome.chunks[0];
      // The chain's own PriceRoseAboveMax: nothing was stored or charged.
      const priceRose = chunk?.state === "failed" && isPriceRoseAboveMax(chunk.message);
      const uncertain = chunk?.state === "uncertain";
      spent = chunk?.state === "confirmed" || uncertain;
      const transactionId = chunk?.transactionHash ?? null;
      const executedAt = chunk?.blockHeight ?? null;
      const n = items.length;
      const settled: Pick<SubmitDrawResult, "status" | "message"> & { title: string } = n === 1
        ? (chunk?.state === "confirmed"
          ? { status: "confirmed", title: "Pixel painted",
              message: "Your paint executed on chain. The board refresh that follows shows anyone who painted over it since." }
          : uncertain
            ? { status: "confirmation_delayed", title: "Paint may have been sent",
                message: `Its result is unknown, so it keeps a pending marker. No automatic retry. ${chunk?.message ?? ""}`.trim() }
            : { status: "failed", title: "Paint not painted",
                message: `Nothing was stored. ${paintFailureCopy(chunk?.message ?? "")}`.trim() })
        : chunk?.state === "confirmed"
          ? { status: "confirmed", title: "Taps painted",
              message: `${n} queued taps were sent as one transaction and executed together.` }
          : uncertain
            ? { status: "confirmation_delayed", title: "Taps may have been sent",
                message: `${n} queued taps were sent as one transaction whose result is unknown. They land together or not at all. No automatic retry. ${chunk?.message ?? ""}`.trim() }
            : { status: "failed", title: "Taps not painted",
                message: `${n} queued taps were not painted. Nothing was stored. ${paintFailureCopy(chunk?.message ?? "")}`.trim() };
      for (const id of outcomeIds) placementOutcomes.settle(id, settled);
      const phase: OperationPhase = settled.status === "confirmed"
        ? "confirmed"
        : settled.status === "confirmation_delayed" ? "confirmation_delayed" : "failed";
      recordOps(phase, transactionId, settled.title, settled.message);
      if (scope.isDisposed()) return;

      for (const item of items) {
        if (settled.status === "confirmed") {
          // Executed. The marker stays, tagged with this transaction, until the
          // stamp below replaces it, so the cell never flashes its old colour.
          markPending(item, transactionId, "submitted");
        } else if (settled.status === "confirmation_delayed") {
          markPending(item, transactionId, "confirmation_delayed");
        } else {
          clearPendingPaint(pendingPaints, item.x, item.y);
        }
      }
      deps.render();
      view.setFlow(settled.status === "confirmed" ? "confirmed"
        : settled.status === "confirmation_delayed" ? "confirmation_delayed" : "failed");
      if (settled.status === "confirmed") {
        // What this batch actually cost, so the headline can say what is left.
        // A free board has no credits: the headline just says it is up.
        pricing.announcePainted(
          pricing.paidBoard()
            ? (priced.chunkMaxCredits ?? []).reduce((sum, chunk) => sum + chunk, 0)
            : null,
        );
      } else {
        pricing.clearStrokeHeadline();
      }
      if (n === 1) {
        // A lone tap reads like the single paint it is: its transaction link, and
        // the square stays selected, as the single-draw path showed.
        fillResultWithLink(result, settled.title, settled.message, transactionId,
          explorerUrl(first.networkId, transactionId));
        view.setSelected({ x: first.x, y: first.y });
        if (settled.status !== "failed") view.showSelection();
        if (settled.status === "confirmed") view.pulseSelection();
      } else {
        fillBlock(result, settled.title, settled.message);
      }
      if (settled.status !== "confirmed" && chunk?.message) {
        console.error("[wall] tap batch failed:", chunk.message);
      }
      if (isDrawingKeyLow(chunk?.message)) session.promptKeyRenewal();
      if (settled.status === "confirmed") {
        // The receipt proves the write at its block; stamp it like a stroke does,
        // as soon as the height is known. Nothing waits on this.
        void (outcome.executedBlocksLater ?? Promise.resolve(outcome.executedBlocks)).then((blocks) => {
          if (scope.isDisposed()) return;
          const height = blocks[0]?.blockHeight ?? executedAt;
          for (const item of items) {
            if (height !== null) {
              board.rememberPixel(
                { x: item.x, y: item.y, colorIndex: item.colorIndex,
                  artistAccountId: item.accountId, lastWriteTimestampNs: null },
                height,
              );
            }
            // A later paint on this cell owns its marker now: leave that one alone.
            if (getPendingPaint(pendingPaints, item.x, item.y)?.transactionId === transactionId) {
              clearPendingPaint(pendingPaints, item.x, item.y);
            }
          }
          deps.render();
          void board.refreshBoardFromContract({ reason: "after_draw" });
        });
      } else {
        void board.refreshBoardFromContract({ reason: "after_draw" });
      }
      if (priceRose && !requote) {
        view.setFlow("editing");
        retryMax = await pricing.confirmRequote(cells, first.accountId);
      }
    } finally {
      if (spent) pricing.settle(reservation);
      else pricing.release(reservation);
      drawInFlight = false;
      if (!scope.isDisposed()) {
        syncSubmitEnabled();
        session.showDrawingSession();
        afterPaintSettled();
        if (retryMax !== null) await commitTapBatch(items, { approvedMax: retryMax });
      }
    }
  }

  async function drainPaintQueue(): Promise<void> {
    if (scope.isDisposed() || paintQueue.inFlight) {
      return;
    }
    // Skip (and drop) any head that no longer matches the live wallet.
    let next = shiftPaint(paintQueue);
    while (
      next &&
      !drawRequestMatchesSession(next, scope.walletAccount(), scope.walletNetworkId())
    ) {
      discardQueued(next);
      next = shiftPaint(paintQueue);
    }
    if (!next) {
      if (!scope.isDisposed()) {
        deps.render();
      }
      return;
    }
    if (scope.isDisposed()) {
      discardQueued(next);
      cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
        quiet: true,
      });
      return;
    }
    const batch = takeTapBatch(next);
    paintQueue.inFlight = true;
    try {
      if (batch.viaSession) await commitTapBatch(batch.items);
      else await attemptDraw(next, queuedPlacementOutcomes.get(next));
    } finally {
      paintQueue.inFlight = false;
      if (scope.isDisposed()) {
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

  return {
    strokes,
    overlayPixels: () => [
      ...listPendingPaints(pendingPaints),
      ...(activeStroke?.state.cells.map(cell => ({ ...cell,
        colorIndex: activeStroke!.color, accountId: activeStroke!.accountId,
        transactionId: null, phase: "submitted" as const,
      })) ?? []),
    ],
    pendingCount: () => listPendingPaints(pendingPaints).length,
    reconcilePending: (pixels) => reconcilePendingWithConfirmed(pendingPaints, pixels),
    drawInFlight: () => drawInFlight,
    attemptDraw: () => attemptDraw(),
    maybeEnqueueDirectPaint,
    syncSubmitEnabled,
    updateDirectPaintAvailability: session.updateDirectPaintAvailability,
    showDrawingSession: session.showDrawingSession,
    onWalletChanged() {
      activeStroke = null;
      cancelUnsentPaintQueue("Wallet account or network changed.");
    },
    enqueueUnsent(request) {
      if (scope.isDisposed()) return;
      enqueuePaint(paintQueue, request);
      markPending(request, null, "submitted");
      deps.render();
    },
    queueLength: () => paintQueueLength(paintQueue),
    drainPaintQueue,
    dispose() {
      unmountPlacementOutcomes();
      // Drop unsent queue work; an in-flight attemptDraw may still settle into
      // services.operations. Do not continue draining after leave.
      cancelUnsentPaintQueue("Left the wall before these paints were sent.", {
        quiet: true,
      });
    },
  };
}
