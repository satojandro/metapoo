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
    // Phase 1: the wall is framed by a thin stall border; the mural scene and the
    // old Focus canvas / Paint zoom controls are gone (step 4).
    expect(root.querySelector(".wall-legacy")).toBeNull();
    expect(root.querySelectorAll("[data-stall-scenery]")).toHaveLength(0);
    expect(root.querySelector("#focus-canvas")).toBeNull();
    expect(root.querySelector("#zoom-paint")).toBeNull();
    expect(root.querySelector(".wall-frame")?.contains(board)).toBe(true);
    // Look is the default mode and there is no Look / Paint toggle: signing in
    // opens Paint. The dock is the Paint-mode card in the side panel.
    expect(root.querySelector<HTMLElement>(".wall-page")?.dataset.mode).toBe("look");
    expect(root.querySelector("#wall-mode-look")).toBeNull();
    expect(root.querySelector("#wall-mode-paint")).toBeNull();
    expect(root.querySelector(".wall-dock")?.closest(".wall-panel")).not.toBeNull();
    // The wall's controls float over it, inside the frame.
    expect(root.querySelector(".wall-frame .wall-bar [data-wall-view]")).not.toBeNull();
    expect(root.querySelector(".wall-frame #refresh-board")).not.toBeNull();
    // The primary action, its status and its result sit in the pinned footer.
    const foot = root.querySelector(".wall-panel-foot");
    for (const selector of ["#start-painting", "#dock-primary", "#draw-button", "#draw-state", "#result"]) {
      expect(foot?.querySelector(selector), selector).not.toBeNull();
    }
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

  it("keeps the paint panel quiet: key above the palette, the tally in the footer", () => {
    const root = document.createElement("div");
    root.innerHTML = wallPageHtml();
    const legend = root.querySelector("#wall-view-legend")!;
    const palette = root.querySelector("#palette")!;
    // The active view's key describes the wall, so it comes before the palette.
    expect(legend.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // What this stroke costs and what you have sit with the button, not the palette.
    const foot = root.querySelector(".wall-panel-foot")!;
    for (const selector of ["#stroke-total", "#credits-balance", "#buy-credits-button"]) {
      expect(foot.querySelector(selector), selector).not.toBeNull();
    }
    // Duplicates of the Price key and of the wall's hint chip are spoken, not shown.
    for (const selector of ["#repaint-legend", "#cell-price", "#tap-to-paint-status"]) {
      expect(root.querySelector(selector)?.classList.contains("visually-hidden"), selector).toBe(true);
    }
    // The tap-to-paint setting is a detail, not a fixture of the dock.
    expect(root.querySelector("#direct-paint-toggle")?.closest("details.wall-about")).not.toBeNull();
    expect(root.querySelector(".wall-dock #direct-paint-toggle")).toBeNull();
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
