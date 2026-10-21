import { describe, expect, it } from "vitest";
import {
  boardCellToScreenPoint,
  boardToScreenPoint,
  clampBoardCell,
  clampCamera,
  fitCameraToContainer,
  isTap,
  panCameraBy,
  screenToBoardCell,
  screenToBoardPoint,
  zoomCameraAtPoint,
} from "./camera";

const board = { width: 512, height: 512 };
const cells = { width: 128, height: 128 };

describe("camera", () => {
  it("round-trips corner and centre cells through a transformed screen", () => {
    const camera = { scale: 3.5, offsetX: -280, offsetY: -420 };
    for (const cell of [
      { x: 0, y: 0 },
      { x: 127, y: 0 },
      { x: 0, y: 127 },
      { x: 127, y: 127 },
      { x: 64, y: 64 },
    ]) {
      const topLeft = boardCellToScreenPoint(cell, camera, 4);
      expect(
        screenToBoardCell(
          { x: topLeft.x + 7, y: topLeft.y + 7 },
          camera,
          board,
          4,
        ),
      ).toEqual(cell);
    }
  });

  it("keeps the board coordinate under an unconstrained zoom focal point", () => {
    const bounds = { board, container: { width: 390, height: 600 }, maxScale: 8 };
    const before = { scale: 2, offsetX: -300, offsetY: -180 };
    const focalPoint = { x: 195, y: 300 };
    const focalBoardPoint = screenToBoardPoint(focalPoint, before);

    const after = zoomCameraAtPoint(before, focalPoint, 1.5, bounds);
    expect(after.scale).toBe(3);
    expect(screenToBoardPoint(focalPoint, after)).toEqual(focalBoardPoint);
  });

  it("fits and clamps portrait, landscape, and 390px-wide viewports", () => {
    expect(fitCameraToContainer(board, { width: 390, height: 844 })).toEqual({
      scale: 390 / 512,
      offsetX: 0,
      offsetY: (844 - 390) / 2,
    });
    expect(fitCameraToContainer(board, { width: 844, height: 390 })).toEqual({
      scale: 390 / 512,
      offsetX: (844 - 390) / 2,
      offsetY: 0,
    });

    const bounds = { board, container: { width: 390, height: 844 }, minScale: 1 };
    expect(clampCamera({ scale: 2, offsetX: 500, offsetY: 500 }, bounds)).toEqual({
      scale: 2,
      offsetX: 0,
      offsetY: 0,
    });
    expect(panCameraBy({ scale: 2, offsetX: -600, offsetY: -600 }, { x: -900, y: -900 }, bounds)).toEqual({
      scale: 2,
      offsetX: 390 - 1024,
      offsetY: 844 - 1024,
    });
  });

  it("clamps cells and rejects screen points outside the board", () => {
    expect(clampBoardCell({ x: -2, y: 200 }, cells)).toEqual({ x: 0, y: 127 });
    expect(screenToBoardCell({ x: -1, y: 10 }, { scale: 1, offsetX: 0, offsetY: 0 }, board, 4)).toBeNull();
    expect(boardToScreenPoint({ x: 10, y: 20 }, { scale: 2, offsetX: 3, offsetY: 4 })).toEqual({ x: 23, y: 44 });
  });

  it("distinguishes taps from drags at configurable thresholds", () => {
    expect(isTap({ x: 10, y: 10 }, { x: 16, y: 18 }, 10)).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 16.1, y: 18 }, 10)).toBe(false);
    expect(isTap({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(true);
    expect(isTap({ x: 0, y: 0 }, { x: 3, y: 4 }, 4.9)).toBe(false);
  });
});
