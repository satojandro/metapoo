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

    expect(root.querySelector(".wall-runtime-status")?.textContent).toMatch(
      /Testnet[\s\S]*No app fee/,
    );
    expect(root.querySelectorAll(".wall-layout details")).toHaveLength(1);
    expect(root.querySelector(".scene-label")?.textContent).toMatch(
      /DEMO STALL ART[\s\S]*LIVE BOARD/,
    );
    const sceneryLayers = [
      ...root.querySelectorAll<HTMLElement>("[data-stall-scenery]"),
    ];
    expect(sceneryLayers.length).toBeGreaterThanOrEqual(7);
    expect(sceneryLayers.every((layer) => !layer.contains(board))).toBe(true);
    expect(
      root
        .querySelector('[data-stall-scenery="back-wall-art"]')!
        .compareDocumentPosition(board!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      board!.compareDocumentPosition(
        root.querySelector('[data-stall-scenery="toilet"]')!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(about?.contains(root.querySelector("#palette"))).toBe(false);
    expect(about?.contains(root.querySelector("#draw-button"))).toBe(false);
    expect(
      board!.compareDocumentPosition(root.querySelector("#palette")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      board!.compareDocumentPosition(root.querySelector("#draw-button")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
