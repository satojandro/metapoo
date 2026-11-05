import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT, BOARD_WIDTH, MAX_BOARD_SIDE, isValidBoardSide, setBoardSide, wallTiles,
} from "@shared/types.ts";
import { clampCell, moveSelection } from "./selection";
import { wallStats } from "./pages/wall/wall-invite";

afterEach(() => { setBoardSide(MAX_BOARD_SIDE); });

describe("live board side", () => {
  it("defaults to the legacy 128 × 128", () => {
    expect([BOARD_WIDTH, BOARD_HEIGHT, wallTiles()]).toEqual([128, 128, 16_384]);
  });

  it("changes every reader at call time, not at import", () => {
    expect(setBoardSide(64)).toBe(true);
    expect([BOARD_WIDTH, BOARD_HEIGHT, wallTiles()]).toEqual([64, 64, 4_096]);
    expect(wallStats([], 0n, null).neverPainted).toBe(4_096);
    expect(setBoardSide(64)).toBe(false);
  });

  it("ignores sizes the page cannot draw", () => {
    for (const side of [0, -1, 129, 64.5, Number.NaN]) {
      expect(isValidBoardSide(side)).toBe(false);
      expect(setBoardSide(side)).toBe(false);
    }
    expect(BOARD_WIDTH).toBe(128);
  });

  it("keeps cells and arrow keys inside the smaller board", () => {
    setBoardSide(64);
    expect(clampCell(64, 0)).toBeNull();
    expect(clampCell(63, 63)).toEqual({ x: 63, y: 63 });
    expect(moveSelection({ x: 63, y: 10 }, "ArrowRight")).toEqual({ x: 63, y: 10 });
  });
});
