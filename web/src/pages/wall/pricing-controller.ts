import { mountBuyCreditsSheet } from "../../app/buy-credits-sheet";
import type { AppServices } from "../../app/services";
import type { CachedPixel } from "../../board-cache";
import { PAID_BOARD_SCHEMA_VERSION } from "../../contract-meta";
import type { Cell } from "../../selection";
import {
  chainRepaintReaders,
  creditShortfall,
  priceRoseCopy,
  quoteRepaint,
  showPriceUnavailable,
  showRepaintQuote,
  type RepaintChrome,
  type RepaintQuote,
} from "./repaint-price";
import { clearBlock, fillBlock } from "./wall-view";
import { blankIsFree, type FreeFirstState } from "./wall-views";
import type { WallScope } from "./wall-scope";

export interface PricingControllerDeps {
  scope: WallScope;
  services: AppServices;
  /**
   * Whether the viewer still has free first paints. Read at tap time: an empty
   * account whose first tap is on a blank cell must not be told to buy credits.
   * Omitted: treated as `unknown`.
   */
  freePaints?: () => FreeFirstState;
  creditsDock: HTMLElement;
  creditsBalance: HTMLElement;
  buyCreditsButton: HTMLButtonElement;
  buyCreditsHost: HTMLElement;
  repaintChrome: RepaintChrome;
  result: HTMLElement;
  /** Schema from the last successful get_board. */
  boardSchema(): number | null;
  cachedPixel(cell: Cell): CachedPixel | undefined;
  /** A paint is between price check and settlement. */
  drawInFlight(): boolean;
  /** Re-derive Place paint's disabled state (owned by the paint side). */
  syncSubmitEnabled(): void;
}

/**
 * Credits held back for one paint between "the painter asked" and "the chain
 * settled it". Opaque to callers: hand it back to `settle` or `release`.
 */
export interface CreditReservation {
  readonly id: number;
}

/** A priced paint, ready to send. */
export interface PaidQuote {
  /** `max_credits` for `draw`; null on a free board. */
  maxCredits: number | null;
  /** `max_credits` per draw_many chunk; null on a free board. */
  chunkMaxCredits: number[] | null;
  /** Credits held for this paint; settle or release it once it resolves. */
  reservation: CreditReservation | null;
}

export interface PaidQuoteOptions {
  /** A queued tap's reservation from `admitTap`; re-sized to the quote. */
  reservation?: CreditReservation | null;
  /**
   * The total the painter accepted in the re-quote prompt. A quote above it is
   * not sent (the price rose again) and the prompt is not shown a second time.
   */
  approvedMax?: number;
}

export interface PricingController {
  /** Schema 4: every paint costs credits. */
  paidBoard(): boolean;
  /** A failed get_cell_cost / get_tunables read. Submit stays off until a later read works. */
  priceUnavailable(): boolean;
  /** A new gesture gets its own attempt: clear a latched price failure. */
  allowGestureRetry(): void;
  refreshCreditsDock(): Promise<void>;
  refreshPaidLegend(): Promise<void>;
  requestCellPrice(cell: Cell): void;
  /**
   * Price cells before anything is pending or sent, check them against the
   * balance left after other reservations, and reserve the total. Null: do not
   * submit (an `options.reservation` passed in is still the caller's to release).
   */
  ensurePaidQuote(
    cells: Cell[],
    accountId: string | null,
    options?: PaidQuoteOptions,
  ): Promise<PaidQuote | null>;
  /**
   * A direct tap, checked without a network read against the balance minus
   * every queued paint's reservation. Returns the tap's reservation, or null
   * when blocked (the shortfall is shown and Buy credits opens).
   */
  admitTap(cell: Cell): CreditReservation | null;
  /** The paint executed (or may have): hold its credits until a fresh chain read, then drop them. */
  settle(reservation: CreditReservation | null | undefined): void;
  /** Nothing was spent: give the credits back now. */
  release(reservation: CreditReservation | null | undefined): void;
  /**
   * The chain said PriceRoseAboveMax. Re-quote and ask the painter once.
   * Resolves with the total they accepted, or null (cancelled, read failed, left).
   */
  confirmRequote(cells: Cell[], accountId: string | null): Promise<number | null>;
  /** Chain balance minus every reservation. Null while unknown. */
  availableCredits(): bigint | null;
  /** Last quoted cost for a cell, unless the board shows it rewritten since. */
  knownCost(cell: Cell): number | undefined;
  /** After a paint settles, re-read the price for `cell`. */
  repriceCell(cell: Cell): void;
  /**
   * The board's tunables for the wall views (Price / Age), from the same session
   * cache the quotes use. Null on a board without paid pricing or when the read fails.
   */
  viewTunables(): Promise<unknown>;
  /** The board schema changed. */
  onSchemaChanged(): void;
  /** A snapshot was applied: the last quoted cell, and costs of rewritten cells, are stale. */
  onBoardUpdated(): void;
  /** Refresh was pressed with valid metadata. */
  manualRefresh(): void;
  dispose(): void;
}

/**
 * Credits and cell prices. The only place the credit balance lives on the
 * wall, and the only owner of the buy-credits sheet.
 *
 * Balance model: `chainCredits` is the last chain read (get_credits, or a
 * purchase result). Every paint between "asked" and "re-read from chain"
 * holds a reservation; what a new paint may spend is the chain balance minus
 * all of them. Reservations are released when nothing was spent, and dropped
 * by the first balance read that starts after the paint settled.
 */
export function createPricingController(deps: PricingControllerDeps): PricingController {
  const {
    scope,
    creditsDock,
    creditsBalance,
    buyCreditsButton,
    repaintChrome,
    result,
  } = deps;

  const buyCreditsSheet = mountBuyCreditsSheet(deps.buyCreditsHost, deps.services, {
    onCreditsChanged: (balance) => {
      if (scope.isDisposed()) return;
      // The cached balance, not just the dock text: the next tap checks it.
      if (balance !== undefined) applyChainBalance(balance, ++readEpoch);
      creditsBalance.textContent =
        balance === null
          ? "Credits: not registered · 0"
          : balance === undefined
            ? "Credits: …"
            : `Credits: ${balance}`;
    },
    // FE-4: every purchase outcome re-reads credits from chain here, so the
    // dock and the cached tap balance never trust the sheet's own numbers.
    onPurchaseSettled: () => {
      if (!scope.isDisposed()) void refreshCreditsDock();
    },
  });

  /** A failed get_cell_cost / get_tunables read. Submit stays off until a later read works. */
  let priceUnavailable = false;
  /** The wall's only credit balance: the last chain read. */
  let chainCredits: bigint | null = null;
  let creditsKnown = false;
  /**
   * Credits held by paints not yet reflected in `chainCredits`. A settled
   * entry is dropped by the first balance read that starts after it settled.
   */
  const reservations = new Map<number, { credits: number; settledAtEpoch: number | null }>();
  let nextReservationId = 1;
  /** Incremented as each balance read starts, so a read knows which settlements it covers. */
  let readEpoch = 0;
  /**
   * Cost last quoted for a cell, keyed "x,y", with the cell's write stamp in the
   * board cache at quote time. A different stamp means someone repainted it.
   */
  const cellCostCache = new Map<string, { credits: number; writtenAtNs: string | null }>();
  let pricedCellKey: string | null = null;
  let priceRequest = 0;
  let submitQuoteInFlight = false;
  const repaintReaders = chainRepaintReaders({
    writtenAtNsFromCache: (cell) => {
      const cached = deps.cachedPixel(cell);
      return cached ? cached.lastWriteTimestampNs : null;
    },
  });

  buyCreditsButton.addEventListener("click", () => {
    buyCreditsSheet.open();
  });

  function cellKey(cell: Cell): string {
    return `${cell.x},${cell.y}`;
  }

  function writeStamp(cell: Cell): string | null {
    return deps.cachedPixel(cell)?.lastWriteTimestampNs ?? null;
  }

  function knownCost(cell: Cell): number | undefined {
    const key = cellKey(cell);
    const entry = cellCostCache.get(key);
    if (!entry) return undefined;
    if (entry.writtenAtNs !== writeStamp(cell)) {
      cellCostCache.delete(key);
      return undefined;
    }
    return entry.credits;
  }

  function rememberCosts(quote: Extract<RepaintQuote, { ok: true }>): void {
    for (const row of quote.cells) {
      cellCostCache.set(cellKey(row.cell), {
        credits: row.credits,
        writtenAtNs: writeStamp(row.cell),
      });
    }
  }

  /** Drop cached costs for cells the board shows as rewritten since they were quoted. */
  function sweepCostCache(): void {
    for (const key of [...cellCostCache.keys()]) {
      const [x, y] = key.split(",").map(Number);
      knownCost({ x: x!, y: y! });
    }
  }

  function reservedCredits(except?: CreditReservation | null): number {
    let sum = 0;
    for (const [id, entry] of reservations) {
      if (id !== except?.id) sum += entry.credits;
    }
    return sum;
  }

  function availableCredits(except?: CreditReservation | null): bigint | null {
    if (!creditsKnown) return null;
    const left = (chainCredits ?? 0n) - BigInt(reservedCredits(except));
    return left > 0n ? left : 0n;
  }

  function reserve(credits: number): CreditReservation {
    const id = nextReservationId++;
    reservations.set(id, { credits, settledAtEpoch: null });
    return { id };
  }

  /** A chain balance that was read starting at `startedEpoch`. */
  function applyChainBalance(balance: bigint | null, startedEpoch: number): void {
    chainCredits = balance;
    creditsKnown = true;
    for (const [id, entry] of reservations) {
      if (entry.settledAtEpoch !== null && entry.settledAtEpoch < startedEpoch) {
        reservations.delete(id);
      }
    }
  }

  async function readCredits(accountId: string): Promise<bigint | null> {
    const epoch = ++readEpoch;
    const balance = await repaintReaders.credits(accountId);
    if (!scope.isDisposed()) applyChainBalance(balance, epoch);
    return balance;
  }

  function chainNowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }

  function paidBoard(): boolean {
    return deps.boardSchema() === PAID_BOARD_SCHEMA_VERSION;
  }

  function onSchemaChanged(): void {
    if (!paidBoard()) {
      priceUnavailable = false;
      pricedCellKey = null;
      repaintChrome.legend.hidden = true;
      repaintChrome.legend.textContent = "";
      repaintChrome.badge.textContent = "";
      repaintChrome.strokeTotal.textContent = "";
      repaintChrome.onQuote?.(null);
      creditsDock.hidden = true;
      buyCreditsSheet.setVisible(false);
      deps.syncSubmitEnabled();
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
    const walletAccount = scope.walletAccount();
    if (!walletAccount) {
      creditsBalance.textContent = "Credits: connect wallet";
      chainCredits = null;
      creditsKnown = false;
      reservations.clear();
      buyCreditsButton.disabled = true;
      buyCreditsSheet.setCredits(undefined);
      return;
    }
    buyCreditsButton.disabled = false;
    creditsBalance.textContent = "Credits: …";
    try {
      const balance = await readCredits(walletAccount);
      if (scope.isDisposed()) return;
      creditsBalance.textContent =
        balance === null ? "Credits: not registered · 0" : `Credits: ${balance}`;
      buyCreditsSheet.setCredits(balance);
    } catch {
      if (scope.isDisposed()) return;
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
    if (scope.isDisposed() || request !== priceRequest || submitQuoteInFlight) {
      return;
    }
    if (!quote.ok) {
      priceUnavailable = true;
      showPriceUnavailable(repaintChrome);
      deps.syncSubmitEnabled();
      return;
    }
    priceUnavailable = false;
    showRepaintQuote(repaintChrome, quote);
    deps.syncSubmitEnabled();
  }

  let previewBusy = false;
  let queuedPreview: Cell | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  scope.onDispose(() => { clearTimeout(previewTimer); queuedPreview = null; });

  // A pointer sweep keeps only the latest tile, never one queued RPC per pixel.
  function requestCellPrice(cell: Cell): void {
    if (scope.isDisposed() || document.visibilityState === "hidden") return;
    if (previewBusy) { queuedPreview = cell; return; }
    runCellPrice(cell);
  }

  function clearRecoveredPriceError(balanceRecovered = false): void {
    const heading = result.querySelector("h3")?.textContent;
    if (heading === "Price unavailable" || (balanceRecovered && heading === "Balance unavailable")) clearBlock(result);
  }

  function runCellPrice(cell: Cell): void {
    if (!paidBoard() || submitQuoteInFlight || deps.drawInFlight()) {
      return;
    }
    const key = cellKey(cell);
    if (pricedCellKey === key) {
      return;
    }
    pricedCellKey = key;
    previewBusy = true;
    const request = ++priceRequest;
    void quoteRepaint({
      readers: repaintReaders,
      cells: [cell],
      nowNs: chainNowNs(),
      accountId: scope.walletAccount(),
    }).then((quote) => {
      if (scope.isDisposed() || request !== priceRequest || submitQuoteInFlight) {
        return;
      }
      if (!quote.ok) {
        pricedCellKey = null;
        priceUnavailable = true;
        showPriceUnavailable(repaintChrome);
        deps.syncSubmitEnabled();
        return;
      }
      priceUnavailable = false;
      rememberCosts(quote);
      showRepaintQuote(repaintChrome, quote);
      clearRecoveredPriceError();
      deps.syncSubmitEnabled();
    }).finally(() => {
      if (scope.isDisposed()) return;
      previewTimer = setTimeout(() => {
        previewBusy = false;
        const next = queuedPreview;
        queuedPreview = null;
        if (next && !scope.isDisposed()) requestCellPrice(next);
      }, 200);
    });
  }

  function openBuyCredits(need: number, have: bigint | null): void {
    const haveCount = have === null ? 0 : Number(have);
    const quantity =
      Number.isFinite(haveCount) && need > haveCount ? need - haveCount : Math.max(1, need);
    buyCreditsSheet.open({ quantity: Math.max(1, quantity) });
  }

  function showQuoteUnavailable(what: "price" | "balance"): void {
    priceUnavailable = true;
    showPriceUnavailable(repaintChrome);
    fillBlock(
      result,
      what === "price" ? "Price unavailable" : "Balance unavailable",
      what === "price"
        ? "The network could not return a fresh paint price. Nothing was submitted. Wait a moment, then try again."
        : "The network could not return your credit balance. Nothing was submitted. Wait a moment, then try again.",
    );
    deps.syncSubmitEnabled();
  }

  /**
   * Price a stroke before anything is marked pending or sent to a wallet.
   * Returns null when the read failed or the account cannot afford the total
   * on top of every other paint still holding credits.
   */
  async function ensurePaidQuote(
    cells: Cell[],
    accountId: string | null,
    options: PaidQuoteOptions = {},
  ): Promise<PaidQuote | null> {
    if (!paidBoard()) {
      return { maxCredits: null, chunkMaxCredits: null, reservation: null };
    }
    submitQuoteInFlight = true;
    const request = ++priceRequest;
    // The balance does not depend on the price: read both at once, so a paint
    // waits one round trip for its quote instead of two.
    const balanceRead: Promise<{ ok: true } | { ok: false }> | null = accountId
      ? readCredits(accountId).then(() => ({ ok: true as const }), () => ({ ok: false as const }))
      : null;
    try {
      const quote = await quoteRepaint({
        readers: repaintReaders,
        cells,
        nowNs: chainNowNs(),
        accountId,
      });
      if (scope.isDisposed() || request !== priceRequest) {
        return null;
      }
      if (!quote.ok) {
        showQuoteUnavailable("price");
        return null;
      }
      priceUnavailable = false;
      rememberCosts(quote);
      showRepaintQuote(repaintChrome, quote);
      deps.syncSubmitEnabled();
      if (options.approvedMax !== undefined && quote.totalCredits > options.approvedMax) {
        // Asked once already. Say so and stop; never loop the prompt.
        const unit = quote.totalCredits === 1 ? "credit" : "credits";
        fillBlock(
          result,
          "Price changed again",
          `It now costs ${quote.totalCredits} ${unit}, more than the ${options.approvedMax} you agreed to. Nothing was submitted.`,
        );
        return null;
      }
      const priced = (reservation: CreditReservation | null): PaidQuote => ({
        maxCredits: quote.totalCredits,
        chunkMaxCredits: quote.chunkTotals,
        reservation,
      });
      if (!accountId) {
        return priced(null);
      }
      if (!(await balanceRead!).ok) {
        showQuoteUnavailable("balance");
        return null;
      }
      if (scope.isDisposed() || request !== priceRequest) {
        return null;
      }
      clearRecoveredPriceError(true);
      // What this paint may spend: the chain balance minus every other paint
      // still holding credits (queued taps, or executed but not yet re-read).
      const have = availableCredits(options.reservation);
      const shortfall = creditShortfall(have, quote.totalCredits);
      if (shortfall) {
        // Say it once (owner, 7 Nov). The tally keeps the stroke's size and cost; the
        // block says why nothing was sent and can be closed; the buy sheet opens, and
        // the dock's Buy stays. No second Buy credits button inside the block.
        fillBlock(result, "Not enough credits", shortfall);
        openBuyCredits(quote.totalCredits, have);
        void refreshCreditsDock();
        return null;
      }
      const held = options.reservation ? reservations.get(options.reservation.id) : undefined;
      if (held && options.reservation) {
        held.credits = quote.totalCredits;
        return priced(options.reservation);
      }
      return priced(reserve(quote.totalCredits));
    } finally {
      submitQuoteInFlight = false;
    }
  }

  // A tap is the core gesture and must never wait on the network. It is
  // checked against the balance minus every queued paint's reservation and the
  // last quoted cost for this cell (1 when unknown). The send-time quote
  // re-checks against the chain, and `max_credits` caps what the chain charges.
  function admitTap(cell: Cell): CreditReservation | null {
    if (!paidBoard()) {
      return { id: 0 };
    }
    const known = knownCost(cell);
    const have = availableCredits();
    if (have === null) {
      // An unknown balance never blocks; the send-time quote reads it.
      requestCellPrice(cell);
      return reserve(known ?? 0);
    }
    const needed = known ?? 1;
    if (have < BigInt(needed)) {
      // A blank cell may be a free first paint. Never answer it with a buy prompt
      // on a guess: admit it at 0 and let the send-time quote, which knows the
      // account's allowance and the real price, decide before any wallet call.
      const free = deps.freePaints?.() ?? { kind: "unknown" as const };
      const mayBeFree = known === undefined && (blankIsFree(free) || free.kind === "unknown");
      if (mayBeFree) {
        requestCellPrice(cell);
        return reserve(0);
      }
      const shortfall = creditShortfall(have, needed);
      if (shortfall) {
        fillBlock(result, "Not enough credits", shortfall);
      }
      openBuyCredits(needed, have);
      void refreshCreditsDock();
      return null;
    }
    // Price the badge in the background. It must never block the paint.
    requestCellPrice(cell);
    return reserve(needed);
  }

  function settle(reservation: CreditReservation | null | undefined): void {
    const entry = reservation ? reservations.get(reservation.id) : undefined;
    if (!entry) return;
    // Held until a balance read that starts after now: that read shows the spend.
    entry.settledAtEpoch = readEpoch;
    // A spent free paint changes which cells are free: re-quote zero-cost cells.
    for (const [key, cached] of cellCostCache) {
      if (cached.credits === 0) cellCostCache.delete(key);
    }
  }

  function release(reservation: CreditReservation | null | undefined): void {
    if (reservation) reservations.delete(reservation.id);
  }

  async function confirmRequote(cells: Cell[], accountId: string | null): Promise<number | null> {
    if (!paidBoard() || scope.isDisposed()) return null;
    const quote = await quoteRepaint({
      readers: repaintReaders,
      cells,
      nowNs: chainNowNs(),
      accountId,
    });
    if (scope.isDisposed()) return null;
    if (!quote.ok) {
      showQuoteUnavailable("price");
      return null;
    }
    rememberCosts(quote);
    showRepaintQuote(repaintChrome, quote);
    const total = quote.totalCredits;
    fillBlock(result, "Price changed", `${priceRoseCopy(total)} Nothing was charged.`);
    const actions = document.createElement("div");
    actions.className = "requote-actions";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "action place";
    accept.dataset.requote = "accept";
    accept.textContent = `Paint for ${total} ${total === 1 ? "credit" : "credits"}`;
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "action secondary";
    decline.dataset.requote = "cancel";
    decline.textContent = "Cancel";
    actions.append(accept, decline);
    result.append(actions);
    return new Promise<number | null>((resolve) => {
      let done = false;
      const finish = (value: number | null) => {
        if (done) return;
        done = true;
        actions.remove();
        resolve(value);
      };
      accept.addEventListener("click", () => finish(total));
      decline.addEventListener("click", () => {
        fillBlock(result, "Paint cancelled", "Nothing was painted or charged.");
        finish(null);
      });
      scope.onDispose(() => finish(null));
    });
  }

  return {
    paidBoard,
    viewTunables: async () => (paidBoard() ? repaintReaders.tunables() : null),
    priceUnavailable: () => priceUnavailable,
    allowGestureRetry() {
      // One failed price read must not dead-end painting. `priceUnavailable`
      // is a display state, but it also gated gesture start, so a single 4xx or
      // 429 left the board refusing every tap and drag until a full reload --
      // reported as "I click and nothing happens, then I am stuck". Clear it
      // here so each gesture gets its own attempt; a fresh failure re-latches.
      if (paidBoard() && priceUnavailable) {
        priceUnavailable = false;
      }
    },
    refreshCreditsDock,
    refreshPaidLegend,
    requestCellPrice,
    ensurePaidQuote,
    admitTap,
    settle,
    release,
    confirmRequote,
    availableCredits: () => availableCredits(),
    knownCost,
    repriceCell(cell) {
      if (paidBoard()) {
        pricedCellKey = null;
        requestCellPrice(cell);
      }
    },
    onSchemaChanged,
    onBoardUpdated() {
      pricedCellKey = null;
      sweepCostCache();
    },
    manualRefresh() {
      if (paidBoard()) {
        pricedCellKey = null;
        // Tunables only change on set_tunables; Refresh is the one deliberate re-read.
        repaintReaders.clearTunablesCache();
        void refreshPaidLegend();
      }
    },
    dispose() {
      buyCreditsSheet.dispose();
    },
  };
}
