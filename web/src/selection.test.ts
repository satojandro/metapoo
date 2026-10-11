import { describe, expect, it } from "vitest";
import { cellFromOffset, clampCell, moveSelection } from "./selection";

describe("selection", () => {
  it("rejects squares outside the 128 by 128 board", () => {
    expect(clampCell(0, 0)).toEqual({ x: 0, y: 0 });
    expect(clampCell(127, 127)).toEqual({ x: 127, y: 127 });
    expect(clampCell(128, 0)).toBeNull();
    expect(clampCell(-1, 4)).toBeNull();
    expect(clampCell(1.5, 2)).toBeNull();
  });

  it("uses the first arrow key to select the top-left square", () => {
    expect(moveSelection(null, "ArrowRight")).toEqual({ x: 0, y: 0 });
  });

  it("stops at the edges instead of wrapping", () => {
    expect(moveSelection({ x: 0, y: 0 }, "ArrowLeft")).toEqual({ x: 0, y: 0 });
    expect(moveSelection({ x: 127, y: 10 }, "ArrowRight")).toEqual({
      x: 127,
      y: 10,
    });
    expect(moveSelection({ x: 4, y: 5 }, "ArrowDown")).toEqual({ x: 4, y: 6 });
  });

  it("maps a click in the bottom-right of the picture to the last square", () => {
    expect(cellFromOffset(99.9, 199.9, 100, 200)).toEqual({ x: 127, y: 127 });
  });
});
