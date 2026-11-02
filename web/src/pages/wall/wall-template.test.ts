/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { wallPageHtml } from "./wall-template";

describe("wallPageHtml", () => {
  it("keeps the wall primary and implementation detail in a collapsed About panel", () => {
    const root = document.createElement("div");
    root.innerHTML = wallPageHtml();

    const board = root.querySelector("#board");
    const about = root.querySelector<HTMLDetailsElement>("details.wall-about");

    expect(board).not.toBeNull();
    expect(about).not.toBeNull();
    expect(about?.open).toBe(false);
    expect(about?.firstElementChild?.textContent).toMatch(/About \/ details/);
    expect(
      board!.compareDocumentPosition(about!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    for (const selector of [
      '[data-wall-detail="instructions"] #board-help',
      '[data-wall-detail="bootstrap"] #lede',
      '[data-wall-detail="board-state"] #board-load-status',
      '[data-wall-detail="contract-schema"] #evidence',
      '[data-wall-detail="rules"] #rules',
    ]) {
      expect(about?.querySelector(selector), selector).not.toBeNull();
    }

    expect(root.querySelector(".wall-runtime-status")?.textContent).toMatch(/Testnet/);
    expect(root.querySelectorAll(".wall-page details")).toHaveLength(1);
    // Phase 0: no "DEMO STALL ART / LIVE BOARD" label over the scene.
    expect(root.querySelector(".scene-label")).toBeNull();
    // Phase 1 step 1: the wall is framed by a thin stall border, not the mural scene.
    // The old scenery stays mounted but hidden until step 4 deletes it.
    const legacy = root.querySelector<HTMLElement>(".wall-legacy")!;
    expect(legacy.hidden).toBe(true);
    const sceneryLayers = [
      ...root.querySelectorAll<HTMLElement>("[data-stall-scenery]"),
    ];
    expect(sceneryLayers.length).toBeGreaterThanOrEqual(6);
    expect(sceneryLayers.every((layer) => legacy.contains(layer))).toBe(true);
    expect(legacy.contains(board)).toBe(false);
    expect(root.querySelector(".wall-frame")?.contains(board)).toBe(true);
    // Look is the default mode; the dock is the Paint-mode card in the side panel.
    expect(root.querySelector<HTMLElement>(".wall-page")?.dataset.mode).toBe("look");
    expect(root.querySelector("#wall-mode-look")?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("#wall-mode-paint")?.getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector(".wall-dock")?.closest(".wall-panel")).not.toBeNull();
    for (const view of ["art", "price", "age", "turf"]) {
      expect(root.querySelector(`[data-wall-view="${view}"]`), view).not.toBeNull();
    }
    expect(about?.contains(root.querySelector("#palette"))).toBe(false);
    expect(about?.contains(root.querySelector("#draw-button"))).toBe(false);
    expect(root.querySelector("#buy-credits-button")?.closest(".paint-dock")).not.toBeNull();
    expect(root.querySelector("#credits-balance")?.closest(".paint-dock")).not.toBeNull();
    const drawState = root.querySelector("#draw-state");
    expect(drawState).not.toBeNull();
    expect(drawState?.getAttribute("role")).toBe("status");
    expect(drawState?.closest(".paint-dock")).not.toBeNull();
    expect(
      board!.compareDocumentPosition(root.querySelector("#palette")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      board!.compareDocumentPosition(root.querySelector("#draw-button")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("labels the network it is configured for, and claims no fee", () => {
    const root = document.createElement("div");
    root.innerHTML = wallPageHtml("mainnet");
    const status = root.querySelector(".wall-runtime-status")?.textContent ?? "";
    expect(status).toMatch(/Mainnet/);
    expect(status).not.toMatch(/Testnet/);
    expect(status).not.toMatch(/No app fee/);
  });

  it("says the drawing key can spend paint credits but not wallet funds", () => {
    const root = document.createElement("div");
    root.innerHTML = wallPageHtml();
    const body = root.querySelector(".paint-unlock-body")?.textContent ?? "";
    expect(body).toMatch(/spend your paint credits/);
    expect(body).toMatch(/cannot send NEAR or tokens/);
    expect(body).not.toMatch(/cannot move your funds/);
  });
});
