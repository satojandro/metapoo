/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTE } from "@shared/palette.ts";
import { matchRoute } from "../../app/routes";
import { createWallScope } from "./wall-scope";
import {
  clearBlock,
  colorName,
  createWallView,
  fillBlock,
  fillResultWithLink,
} from "./wall-view";

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return { ...actual, CONTRACT_ID: "board.view.testnet", PAGE_NETWORK: "testnet" };
});
vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return { ...actual, isContractConfigured: () => true };
});

function setup(options: { route?: string; wallet?: string | null } = {}) {
  document.body.innerHTML = `
    <div class="wall-layout"></div>
    <p id="summary"></p><div id="preview"></div><div id="palette"></div><div id="rules"></div>
    <p id="lede"></p><p id="sponsor"></p><p id="draw-state"></p><p id="status"></p>
    <button id="focus"></button><p id="flow"></p><p id="compact"></p>
  `;
  const el = (id: string) => document.getElementById(id)!;
  const scope = createWallScope();
  scope.setWallet(options.wallet === undefined ? "alice.testnet" : options.wallet, "testnet");
  const route = options.route
    ? matchRoute("/wall", options.route)
    : null;
  const deps = {
    scope,
    pageRoot: document.body,
    selectionSummary: el("summary"),
    preview: el("preview"),
    palette: el("palette"),
    rules: el("rules"),
    lede: el("lede"),
    sponsorNote: el("sponsor"),
    drawState: el("draw-state"),
    boardLoadStatus: el("status"),
    focusCanvas: el("focus") as HTMLButtonElement,
    flowState: el("flow"),
    compactStatus: el("compact"),
    sponsorship: { flagEnabled: false, message: "Sponsorship is off." } as never,
    route,
    wallHint: { selectionSucceeded: vi.fn() },
    render: vi.fn(),
    positionSelection: vi.fn(),
    applyCamera: vi.fn(),
    readViewportSize: () => ({ width: 512, height: 512 }),
    cellSize: () => 3.875,
    requestCellPrice: vi.fn(),
    cachedPixel: vi.fn(() => undefined as never),
    refreshSelectedPixel: vi.fn(),
    pendingCount: () => 0,
    boardSync: () => ({ nextLoadId: 0, appliedLoadId: 0, appliedBlockHeight: 0, lastAppliedAtMs: null, consecutiveFailures: 0 }),
  };
  const view = createWallView(deps);
  return { view, deps, scope };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("wall view", () => {
  it("writes the static copy and the rules at mount", () => {
    const { view, deps } = setup();
    view.fillRules();
    expect(deps.sponsorNote.textContent).toBe("Sponsorship is off.");
    expect(deps.lede.textContent).toMatch(/^A live communal pixel wall on NEAR/);
    expect(deps.rules.querySelectorAll("li")).toHaveLength(8);
    expect(deps.rules.textContent).toContain("Game contract: board.view.testnet on testnet.");
  });

  it("setFlow writes the shell strip and the dock line", () => {
    const { view, deps } = setup();
    view.setFlow("wallet_prompt");
    expect(view.uiPhase()).toBe("wallet_prompt");
    expect(deps.flowState.textContent).toBe("State: wallet prompt — approve or reject in your wallet.");
    expect(deps.flowState.dataset.phase).toBe("wallet_prompt");
    expect(deps.drawState.textContent).toBe("wallet prompt — approve or reject in your wallet.");
  });

  it("palette clicks pick a colour, press one swatch and update the preview", () => {
    const { view, deps } = setup();
    view.buildPalette();
    const swatches = deps.palette.querySelectorAll<HTMLButtonElement>(".swatch");
    // The dock still builds the whole shared palette; FE-1 makes it follow the board's palette.
    expect(swatches).toHaveLength(PALETTE.length);
    swatches[2]!.click();
    expect(view.selectedColor()).toBe(2);
    expect([...swatches].map((s) => s.getAttribute("aria-pressed"))).toEqual([
      ...PALETTE.map((_, i) => (i === 2 ? "true" : "false")),
    ]);
    expect(deps.preview.textContent).toBe("Paint preview: Brick (palette index 2)");
    expect(deps.render).toHaveBeenCalled();
    // No square yet, so the flow does not move to editing.
    expect(view.uiPhase()).toBe("disconnected");
  });

  it("select() dismisses the hint and moves to editing only with a wallet", () => {
    const { view, deps } = setup();
    view.select({ x: 3, y: 4 });
    expect(view.selected()).toEqual({ x: 3, y: 4 });
    expect(deps.wallHint.selectionSucceeded).toHaveBeenCalled();
    expect(view.uiPhase()).toBe("editing");

    const loggedOut = setup({ wallet: null });
    loggedOut.view.select({ x: 1, y: 1 });
    expect(loggedOut.view.uiPhase()).toBe("disconnected");
  });

  it("setSelected has no side effects", () => {
    const { view, deps } = setup();
    view.setSelected({ x: 9, y: 9 });
    expect(view.selected()).toEqual({ x: 9, y: 9 });
    expect(deps.wallHint.selectionSucceeded).not.toHaveBeenCalled();
    expect(view.uiPhase()).toBe("disconnected");
  });

  it("showSelection describes the square, asks for its price and reads the cache", () => {
    const { view, deps } = setup();
    view.showSelection();
    expect(deps.selectionSummary.textContent).toBe(
      "No square selected. Chosen paint: none yet. Unpainted squares have no artist.",
    );
    expect(deps.requestCellPrice).not.toHaveBeenCalled();
    deps.cachedPixel.mockReturnValue({
      x: 5, y: 6, colorIndex: 4, artistAccountId: "bob.testnet", lastWriteTimestampNs: "1", blockHeight: 1,
    } as never);
    view.setSelected({ x: 5, y: 6 });
    view.showSelection();
    expect(deps.requestCellPrice).toHaveBeenCalledWith({ x: 5, y: 6 });
    expect(deps.selectionSummary.textContent).toBe(
      "Selected square x=5, y=6. Chosen paint: none yet. Counting starts at the top-left. On-chain credit: Moss (index 4) by bob.testnet. Credit is the latest writer, not legal ownership.",
    );
  });

  it("updateCompactStatus summarises network, account, zoom and pending", () => {
    const { view, deps } = setup();
    view.updateCompactStatus();
    expect(deps.compactStatus.textContent).toBe("testnet · alice.testnet · ~3.9 px/cell · no app fee");
  });

  it("applies a wall link: selects, zooms and notes a board mismatch", () => {
    const { view, deps } = setup({ route: "?board=other.testnet&x=40&y=20&zoom=16" });
    view.applyRoutePaintingContext();
    expect(view.selected()).toEqual({ x: 40, y: 20 });
    expect(deps.applyCamera).toHaveBeenCalledTimes(1);
    expect(deps.boardLoadStatus.textContent).toBe(
      'Focused square x=40, y=20 from the link. Link board "other.testnet" differs from configured contract board.view.testnet; coordinates were still applied.',
    );
    expect(view.uiPhase()).toBe("editing");
    expect(deps.refreshSelectedPixel).toHaveBeenCalled();
  });

  it("focus canvas toggles the layout and its own label", () => {
    const { deps } = setup();
    deps.focusCanvas.click();
    expect(document.querySelector(".wall-layout")!.classList.contains("is-focused")).toBe(true);
    expect(deps.focusCanvas.textContent).toBe("Back to the stall ↙");
  });
});

describe("wall view helpers", () => {
  it("fillBlock, fillResultWithLink and clearBlock write text only", () => {
    const host = document.createElement("div");
    fillBlock(host, "<b>Title</b>", "Body");
    expect(host.querySelector("h3")?.textContent).toBe("<b>Title</b>");
    expect(host.querySelector("b")).toBeNull();
    fillResultWithLink(host, "Done", "Msg", "tx-1", "https://x.test/tx-1");
    expect(host.textContent).toContain("Transaction id: tx-1");
    expect(host.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    clearBlock(host);
    expect(host.childElementCount).toBe(0);
  });

  it("colorName falls back to the index", () => {
    expect(colorName(0)).toBe("Ink");
    expect(colorName(99)).toBe("index 99");
  });
});
