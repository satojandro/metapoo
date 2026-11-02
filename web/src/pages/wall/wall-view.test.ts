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
    expect(deps.flowState.textContent).toBe("Approve or reject in your wallet.");
    expect(deps.flowState.dataset.phase).toBe("wallet_prompt");
    expect(deps.drawState.textContent).toBe("Approve or reject in your wallet.");
  });

  it("palette clicks pick a colour, press one swatch and update the preview", () => {
    const { view, deps } = setup();
    view.buildPalette();
    view.setPaletteLength(8);
    const swatches = deps.palette.querySelectorAll<HTMLButtonElement>(".swatch");
    // An 8-colour board (board3, the free board) gets exactly its 8 swatches.
    expect(swatches).toHaveLength(8);
    swatches[2]!.click();
    expect(view.selectedColor()).toBe(2);
    expect([...swatches].map((s) => s.getAttribute("aria-pressed"))).toEqual([
      ...PALETTE.slice(0, 8).map((_, i) => (i === 2 ? "true" : "false")),
    ]);
    expect(deps.preview.textContent).toBe("Your colour: Brick");
    expect(deps.render).toHaveBeenCalled();
    // No square yet, so the flow does not move to editing.
    expect(view.uiPhase()).toBe("disconnected");
  });

  it("shows the safe first 8 before the board's palette is known", () => {
    const { view, deps } = setup();
    view.buildPalette();
    expect(deps.palette.querySelectorAll(".swatch")).toHaveLength(8);
  });

  it("a 16-colour board gets 16 named swatches, an 8-colour board 8", () => {
    const { view, deps } = setup();
    view.buildPalette();
    const first = deps.palette.querySelector(".swatch");
    view.setPaletteLength(16);
    const swatches = [...deps.palette.querySelectorAll<HTMLButtonElement>(".swatch")];
    expect(swatches).toHaveLength(16);
    expect(swatches[0]).toBe(first);
    expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual(
      PALETTE.map((c) => `${c.name}, palette index ${c.index}, color ${c.hex}`),
    );
    expect(swatches[12]!.getAttribute("aria-label")).toBe("Bleach, palette index 12, color #9ccbdc");
    expect(deps.palette.dataset.count).toBe("16");
    view.setPaletteLength(8);
    expect(deps.palette.querySelectorAll(".swatch")).toHaveLength(8);
    expect(deps.palette.dataset.count).toBe("8");
  });

  it("resets a chosen colour the new board would reject to 0", () => {
    const { view, deps } = setup();
    view.buildPalette();
    view.setPaletteLength(16);
    deps.palette.querySelectorAll<HTMLButtonElement>(".swatch")[12]!.click();
    expect(view.selectedColor()).toBe(12);
    view.setPaletteLength(8);
    expect(view.selectedColor()).toBe(0);
    const swatches = [...deps.palette.querySelectorAll<HTMLButtonElement>(".swatch")];
    expect(swatches[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(deps.preview.textContent).toBe("Your colour: Ink");
    // A colour inside the palette survives a change.
    swatches[5]!.click();
    view.setPaletteLength(16);
    expect(view.selectedColor()).toBe(5);
  });

  it("arrow keys cross the row break; up and down move by a row of 8", () => {
    const { view, deps } = setup();
    view.buildPalette();
    view.setPaletteLength(16);
    const swatches = [...deps.palette.querySelectorAll<HTMLButtonElement>(".swatch")];
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event;
    };
    // One tab stop for the group.
    expect(swatches.filter((s) => s.tabIndex === 0)).toEqual([swatches[0]]);
    swatches[7]!.focus();
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(swatches[8]);
    press("ArrowLeft");
    expect(document.activeElement).toBe(swatches[7]);
    press("ArrowDown");
    expect(document.activeElement).toBe(swatches[15]);
    press("ArrowRight");
    expect(document.activeElement).toBe(swatches[0]);
    press("ArrowLeft");
    expect(document.activeElement).toBe(swatches[15]);
    press("ArrowUp");
    expect(document.activeElement).toBe(swatches[7]);
    press("ArrowUp");
    expect(document.activeElement).toBe(swatches[7]);
    expect(swatches.filter((s) => s.tabIndex === 0)).toEqual([swatches[7]]);
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
      "No square selected. Tap a square on the wall to choose it.",
    );
    expect(deps.requestCellPrice).not.toHaveBeenCalled();
    deps.cachedPixel.mockReturnValue({
      x: 5, y: 6, colorIndex: 4, artistAccountId: "bob.testnet", lastWriteTimestampNs: "1", blockHeight: 1,
    } as never);
    view.setSelected({ x: 5, y: 6 });
    view.showSelection();
    expect(deps.requestCellPrice).toHaveBeenCalledWith({ x: 5, y: 6 });
    expect(deps.selectionSummary.textContent).toBe(
      "Selected square x=5, y=6. Square chosen. Painted Moss by bob.testnet.",
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
