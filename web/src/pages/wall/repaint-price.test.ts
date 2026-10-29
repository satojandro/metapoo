/**
 * @vitest-environment happy-dom
 *
 * The stroke-total test is the one that fails on 0a3e284 (current main when
 * this task was written). That page priced every cell as 1 credit. A cell
 * painted 2 minutes ago is more expensive on the paid board, and the rendered
 * total has to be chain cost × cells.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wallPageHtml } from "./wall-template";
import {
  PRICE_UNAVAILABLE,
  chainRepaintReaders,
  creditShortfall,
  quoteRepaint,
  showPriceUnavailable,
  showRepaintQuote,
  uniqueCells,
  type RepaintChrome,
  type RepaintReaders,
  type RepaintTunables,
} from "./repaint-price";

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    viewFunction: vi.fn(),
  };
});

import { viewFunction } from "../../contract";

/** What `get_tunables` returns on a fresh paid board. Fixture input, not a pricing formula. */
const DEFAULT_TUNABLES: RepaintTunables = {
  repaint_mid_ns: 3_600_000_000_000,
  repaint_base_credits: 1,
};

const LEGEND = "Fresh cells cost more to repaint. Wait an hour and it is 1 credit again.";

function mount(): { root: HTMLElement; chrome: RepaintChrome } {
  const root = document.createElement("div");
  root.innerHTML = wallPageHtml();
  const chrome: RepaintChrome = {
    legend: root.querySelector("#repaint-legend") as HTMLElement,
    badge: root.querySelector("#cell-price") as HTMLElement,
    strokeTotal: root.querySelector("#stroke-total") as HTMLElement,
    submit: root.querySelector("#draw-button") as HTMLButtonElement,
  };
  return { root, chrome };
}

function readers(overrides: Partial<RepaintReaders> = {}): RepaintReaders {
  return {
    cellCost: async () => 4,
    tunables: async () => DEFAULT_TUNABLES,
    pixel: async () => ({ writtenAtNs: null }),
    credits: async () => 100n,
    ...overrides,
  };
}

describe("repaint price", () => {
  it("renders a schema-4 stroke total as chain cost times cells for a cell painted 2 minutes ago", async () => {
    const nowNs = 5_000_000_000_000_000n;
    const twoMinutesAgo = (nowNs - 2n * 60n * 1_000_000_000n).toString();
    // The contract's get_cell_cost for a 2-minute-old cell is 4. The page must
    // display that number. Multiplying by 1 (the old flat price) yields 2.
    const quote = await quoteRepaint({
      readers: readers({
        cellCost: async () => 4,
        pixel: async () => ({ writtenAtNs: twoMinutesAgo }),
      }),
      cells: [
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
      nowNs,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }
    expect(quote.totalCredits).toBe(8);

    const { root, chrome } = mount();
    showRepaintQuote(chrome, quote);

    expect(chrome.strokeTotal.textContent).toBe("this stroke: 2 cells · 8 credits");
    expect(chrome.strokeTotal.textContent).not.toBe("this stroke: 2 cells · 2 credits");
    expect(chrome.badge.textContent).toBe("repaint 2 min ago · 4 credits");
    expect(chrome.submit.disabled).toBe(false);
    expect(root.querySelector("#stroke-total")?.textContent).toContain("8 credits");
  });

  it("adds mixed cell costs instead of charging 1 credit per cell", async () => {
    const nowNs = 5_000_000_000_000_000n;
    const twoMinutesAgo = (nowNs - 2n * 60n * 1_000_000_000n).toString();
    const quote = await quoteRepaint({
      readers: readers({
        cellCost: async (cell) => (cell.x === 1 ? 4 : 1),
        pixel: async (cell) => ({
          writtenAtNs: cell.x === 1 ? twoMinutesAgo : null,
        }),
      }),
      cells: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      nowNs,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }
    const { chrome } = mount();
    showRepaintQuote(chrome, quote);
    expect(chrome.strokeTotal.textContent).toBe("this stroke: 2 cells · 5 credits");
    expect(chrome.badge.textContent).toBe("repaint 2 min ago · 4 credits");
  });

  it("puts the legend string outside any details element", async () => {
    const quote = await quoteRepaint({
      readers: readers(),
      cells: [],
      nowNs: 1n,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }
    const { root, chrome } = mount();
    showRepaintQuote(chrome, quote);

    expect(chrome.legend.textContent).toBe(LEGEND);
    expect(chrome.legend.closest("details")).toBeNull();
    for (const details of root.querySelectorAll("details")) {
      expect(details.textContent).not.toContain(LEGEND);
    }
    expect(chrome.legend.compareDocumentPosition(root.querySelector("details")!) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("disables submit and shows price unavailable when get_cell_cost fails", async () => {
    const quote = await quoteRepaint({
      readers: readers({
        cellCost: async () => {
          throw new Error("rpc down");
        },
      }),
      cells: [{ x: 1, y: 1 }],
      nowNs: 1n,
    });
    expect(quote).toEqual({ ok: false, message: PRICE_UNAVAILABLE });

    const { root, chrome } = mount();
    expect(chrome.submit.disabled).toBe(false);
    showPriceUnavailable(chrome);

    expect(chrome.submit.disabled).toBe(true);
    expect(chrome.strokeTotal.textContent).toBe(PRICE_UNAVAILABLE);
    expect(chrome.badge.textContent).toBe(PRICE_UNAVAILABLE);
    expect(root.textContent).toContain(PRICE_UNAVAILABLE);
    expect(chrome.strokeTotal.textContent).not.toMatch(/1 credit/);
    expect(chrome.legend.textContent).toBe("");
  });

  it("treats a failed get_tunables read as price unavailable too", async () => {
    const quote = await quoteRepaint({
      readers: readers({
        tunables: async () => {
          throw new Error("missing method");
        },
      }),
      cells: [{ x: 0, y: 0 }],
      nowNs: 1n,
    });
    expect(quote.ok).toBe(false);
  });

  it("says unpainted with the chain's base cost, and explains a shortfall before submit", async () => {
    const quote = await quoteRepaint({
      readers: readers({
        cellCost: async () => 1,
        pixel: async () => ({ writtenAtNs: null }),
      }),
      cells: [{ x: 8, y: 8 }],
      nowNs: 1n,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }
    expect(quote.cells[0]?.line).toBe("unpainted · 1 credit");
    expect(quote.strokeText).toBe("this stroke: 1 cell · 1 credit");
    expect(creditShortfall(0n, quote.totalCredits)).toMatch(/needs 1 credit/);
    expect(creditShortfall(0n, quote.totalCredits)).toMatch(/Nothing was submitted/);
    expect(creditShortfall(1n, quote.totalCredits)).toBeNull();
    expect(creditShortfall(null, 4)).toMatch(/has 0 credits/);
  });

  it("de-duplicates cells so a revisited square is priced once", async () => {
    const cellCost = vi.fn(async () => 1);
    const pixel = vi.fn(async () => ({ writtenAtNs: null }));
    const quote = await quoteRepaint({
      readers: readers({ cellCost, pixel }),
      cells: [
        { x: 1, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 1 },
      ],
      nowNs: 1n,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect(uniqueCells([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(cellCost).toHaveBeenCalledTimes(2);
    expect(pixel).toHaveBeenCalledTimes(2);
    expect(quote.totalCredits).toBe(2);
    expect(quote.strokeText).toBe("this stroke: 2 cells · 2 credits");
  });
});

describe("chainRepaintReaders RPC budget", () => {
  afterEach(() => {
    vi.mocked(viewFunction).mockReset();
  });

  it("caches get_tunables for the session and reads written_at from the wall cache", async () => {
    vi.mocked(viewFunction).mockImplementation(async (method: string) => {
      if (method === "get_tunables") {
        return DEFAULT_TUNABLES;
      }
      if (method === "get_cell_cost") {
        return 1;
      }
      throw new Error(`unexpected ${method}`);
    });
    const written = new Map<string, string | null>([["3,4", "99"]]);
    const readersLive = chainRepaintReaders({
      writtenAtNsFromCache: (cell) => written.get(`${cell.x},${cell.y}`) ?? null,
    });

    await readersLive.tunables();
    await readersLive.tunables();
    expect(
      vi.mocked(viewFunction).mock.calls.filter((call) => call[0] === "get_tunables"),
    ).toHaveLength(1);

    expect(await readersLive.pixel({ x: 3, y: 4 })).toEqual({ writtenAtNs: "99" });
    expect(await readersLive.pixel({ x: 0, y: 0 })).toEqual({ writtenAtNs: null });
    expect(
      vi.mocked(viewFunction).mock.calls.some((call) => call[0] === "get_pixel"),
    ).toBe(false);

    readersLive.clearTunablesCache();
    await readersLive.tunables();
    expect(
      vi.mocked(viewFunction).mock.calls.filter((call) => call[0] === "get_tunables"),
    ).toHaveLength(2);
  });

  it("quotes 64 unique cells with one tunables read and no get_pixel", async () => {
    vi.mocked(viewFunction).mockImplementation(async (method: string) => {
      if (method === "get_tunables") return DEFAULT_TUNABLES;
      if (method === "get_cell_cost") return 1;
      throw new Error(`unexpected ${method}`);
    });
    const readersLive = chainRepaintReaders({
      writtenAtNsFromCache: () => null,
    });
    const cells = Array.from({ length: 64 }, (_, i) => ({ x: i, y: 0 }));
    const quote = await quoteRepaint({
      readers: readersLive,
      cells,
      nowNs: 1n,
    });
    expect(quote.ok).toBe(true);
    const methods = vi.mocked(viewFunction).mock.calls.map((call) => call[0]);
    expect(methods.filter((m) => m === "get_tunables")).toHaveLength(1);
    expect(methods.filter((m) => m === "get_cell_cost")).toHaveLength(64);
    expect(methods.filter((m) => m === "get_pixel")).toHaveLength(0);
    // Before: 1 + 64 + 64 = 129. After: 1 + 64 = 65 (8 parallel waves of cell_cost).
    expect(methods).toHaveLength(65);
  });
});
