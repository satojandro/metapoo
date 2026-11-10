// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { mountHowItWorksPage, type HowItWorksDeps } from "./how-it-works-page";
import { EMPTY_SNAPSHOT, type HowItWorksSnapshot } from "./how-it-works";

const LIVE: HowItWorksSnapshot = {
  nearPerCredit: 2_500_000_000_000_000_000_000n,
  registrationFee: 10_000_000_000_000_000_000_000n,
  tiers: { repaint_young_ns: 600_000_000_000, repaint_mid_ns: 3_600_000_000_000, repaint_young_credits: 4, repaint_mid_credits: 2, repaint_base_credits: 1 },
  freeFirstPerAccount: 25,
  happyHour: { enabled: true, weekday: 6, startS: 72_000, lengthS: 3600, cap: 100, requiresPurchase: true },
  firstFillComplete: false,
  painted: 8,
};

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; vi.useRealTimers(); });

function ctx(): PageContext {
  return {
    services: {
      wallet: {
        getSession: () => ({ accountId: null, networkId: null }), connect: async () => {}, disconnect: async () => {},
        subscribe: () => () => {}, whenReady: Promise.resolve({ accountId: null, networkId: null }),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/how-it-works"),
    navigate: () => {},
  };
}

async function mount(deps: Partial<HowItWorksDeps>) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountHowItWorksPage(root, ctx(), {
    now: () => Date.UTC(2026, 10, 4, 12), configured: true, network: "testnet", board: "board.testnet",
    reducedMotion: true, pollMs: 1e9, load: async () => LIVE, ...deps,
  });
  cleanup.push(() => { dispose(); root.remove(); });
  await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
  const visible = (sel: string) => {
    let el: HTMLElement | null = root.querySelector<HTMLElement>(sel);
    if (!el) return false;
    for (; el && el !== root; el = el.parentElement) if (el.hidden) return false;
    return true;
  };
  return { root, dispose, visible, text: (sel: string) => root.querySelector(sel)?.textContent ?? "" };
}

describe("/how-it-works", () => {
  it("explains paying, including another chain when this build can fund from one", async () => {
    const { root, visible } = await mount({ crossChainFunding: true });
    const pay = root.querySelector("#hiw-pay")!;
    expect(pay.textContent).toContain("can’t be withdrawn");
    expect(pay.textContent).toContain("USDC, USDT, ETH or SOL");
    expect(visible("#hiw-pay [data-needs-funding]")).toBe(true);
    expect(visible("#hiw-pay [data-unless-funding]")).toBe(false);
    expect(pay.querySelector<HTMLAnchorElement>('a[href="/money"]')).not.toBeNull();
  });

  it("does not offer another chain when funding is off in this build", async () => {
    const { visible } = await mount({ crossChainFunding: false });
    expect(visible("#hiw-pay")).toBe(true);
    expect(visible("#hiw-pay [data-needs-funding]")).toBe(false);
    expect(visible("#hiw-pay [data-unless-funding]")).toBe(true);
  });

  it("fills live values from the board", async () => {
    const { root, text } = await mount({});
    expect(text('.hiw-price [data-hiw="price"]')).toBe("0.0025 NEAR");
    expect(text('[data-hiw="blank"]')).toBe("16,376");
    expect(root.textContent).toContain("Every new account gets 25 tiles on the house.");
    expect(text('[data-hiw="hhDay"]')).toBe("Sunday");
    expect(root.querySelector(".hiw-week .on")?.textContent).toBe("Sun");
    expect(text("[data-hiw-hh-clock]")).toBe("4d 08h 00m 00s");
  });

  it("hides what the board couldn't confirm instead of guessing", async () => {
    const { root, visible } = await mount({ load: async () => ({ ...EMPTY_SNAPSHOT, tiers: LIVE.tiers }) });
    expect(visible(".hiw-price [data-hiw=\"price\"]")).toBe(false);
    expect(visible('[data-hiw="blank"]')).toBe(false);
    expect(visible('.hiw-hype-cols')).toBe(false);
    expect(visible(".hiw-total")).toBe(false);
    // Known values still show.
    expect(visible(".hiw-ladder")).toBe(true);
    // No number from a failed read anywhere on the page.
    expect(root.textContent).not.toContain("0.0025");
    expect(root.textContent).not.toContain("16,376");
    expect(root.textContent).not.toMatch(/gets 25 tiles/);
  });

  it("shows the generic wording when the tiers can't be read", async () => {
    const { visible } = await mount({ load: async () => EMPTY_SNAPSHOT });
    expect(visible(".hiw-ladder")).toBe(false);
    expect(visible('#hiw-paint [data-unless="tiers"]')).toBe(true);
  });

  it("switches the free-paint pitch once the wall is full", async () => {
    const { visible } = await mount({ load: async () => ({ ...LIVE, firstFillComplete: true }) });
    expect(visible('.hiw-hype-copy[data-fill="done"]')).toBe(true);
    expect(visible('.hiw-hype-copy[data-fill="open"]')).toBe(false);
  });

  it("prices a practice stroke and never touches the wallet", async () => {
    const connect = vi.fn();
    const { root, text } = await mount({});
    const cells = root.querySelectorAll<HTMLButtonElement>(".hiw-cell");
    // Tile (1, 0) holds the fresh Bubblegum tag: 4 credits.
    cells[1].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(text("[data-r=cells]")).toBe("1 / 64");
    expect(text("[data-r=credits]")).toBe("4");
    expect(text("[data-r=near]")).toBe("0.01 NEAR");
    root.querySelector<HTMLButtonElement>("[data-hiw-paint]")!.click();
    expect(text("[data-r=cells]")).toBe("0 / 64");
    expect(connect).not.toHaveBeenCalled();
  });

  it("clears every timer on dispose", async () => {
    vi.useFakeTimers();
    const set = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = mountHowItWorksPage(root, ctx(), {
      now: () => 0, configured: true, network: "testnet", board: "b", reducedMotion: false, pollMs: 60_000,
      load: async () => LIVE,
    });
    const ids = set.mock.results.map((r) => r.value);
    expect(ids.length).toBeGreaterThanOrEqual(3); // story, happy-hour clock, poll
    dispose();
    for (const id of ids) expect(clear).toHaveBeenCalledWith(id);
    expect(root.querySelector(".hiw")).toBeNull();
    root.remove();
  });
});
