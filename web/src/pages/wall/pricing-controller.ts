import { mountBuyCreditsSheet } from "../../app/buy-credits-sheet";
import type { AppServices } from "../../app/services";
import type { CachedPixel } from "../../board-cache";
import { PAID_BOARD_SCHEMA_VERSION } from "../../contract-meta";
import type { Cell } from "../../selection";
import {
  chainRepaintReaders,
  creditShortfall,
  quoteRepaint,
  showPriceUnavailable,
  showRepaintQuote,
  tapAffordability,
  type RepaintChrome,
} from "./repaint-price";
import { fillBlock } from "./wall-view";
import type { WallScope } from "./wall-scope";

export interface PricingControllerDeps {
  scope: WallScope;
  services: AppServices;
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
  /** Price cells before anything is pending or sent. False: do not submit. */
  ensurePaidQuote(cells: Cell[], accountId: string | null): Promise<boolean>;
  /** Courtesy check for a direct tap against the cached balance. False: blocked. */
  admitTap(cell: Cell): boolean;
  /** After a paint settles, re-read the price for `cell`. */
  repriceCell(cell: Cell): void;
  /** The board schema changed. */
  onSchemaChanged(): void;
  /** A full snapshot was applied; the last quoted cell is stale. */
  onBoardUpdated(): void;
  /** Refresh was pressed with valid metadata. */
  manualRefresh(): void;
  dispose(): void;
}

/**
 * Credits and cell prices. The only place the credit balance lives on the
 * wall, and the only owner of the buy-credits sheet.
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
      creditsBalance.textContent =
        balance === null
          ? "Credits: not registered · 0"
          : balance === undefined
            ? "Credits: …"
            : `Credits: ${balance}`;
    },
  });

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
      const cached = deps.cachedPixel(cell);
      return cached ? cached.lastWriteTimestampNs : null;
    },
  });

  buyCreditsButton.addEventListener("click", () => {
    buyCreditsSheet.open();
  });

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
      if (scope.isDisposed()) return;
      creditsBalance.textContent =
        balance === null ? "Credits: not registered · 0" : `Credits: ${balance}`;
      buyCreditsSheet.setCredits(balance);
      cachedCredits = balance;
      creditsKnown = true;
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

  function requestCellPrice(cell: Cell): void {
    if (!paidBoard() || submitQuoteInFlight || deps.drawInFlight()) {
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
      for (const row of quote.cells) {
        cellCostCache.set(`${row.cell.x},${row.cell.y}`, row.credits);
      }
      showRepaintQuote(repaintChrome, quote);
      deps.syncSubmitEnabled();
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
      if (scope.isDisposed() || request !== priceRequest) {
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
        deps.syncSubmitEnabled();
        return false;
      }
      priceUnavailable = false;
      for (const row of quote.cells) {
        cellCostCache.set(`${row.cell.x},${row.cell.y}`, row.credits);
      }
      showRepaintQuote(repaintChrome, quote);
      deps.syncSubmitEnabled();
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
        deps.syncSubmitEnabled();
        return false;
      }
      if (scope.isDisposed() || request !== priceRequest) {
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

  // A tap is the core gesture and must never wait on the network. The old
  // pre-flight quote put two sequential reads in front of every direct paint,
  // which is why this board felt worse than the free one. Affordability is
  // checked against the cached dock balance and the last quoted cost for this
  // cell; the contract enforces the rest, because `draw` takes no max_cost.
  function admitTap(cell: Cell): boolean {
    if (!paidBoard()) {
      return true;
    }
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
      return false;
    }
    // Price the badge in the background. It must never block the paint.
    requestCellPrice(cell);
    return true;
  }

  return {
    paidBoard,
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
    repriceCell(cell) {
      if (paidBoard()) {
        pricedCellKey = null;
        requestCellPrice(cell);
      }
    },
    onSchemaChanged,
    onBoardUpdated() {
      pricedCellKey = null;
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
