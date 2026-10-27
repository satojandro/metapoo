import { describe, expect, it } from "vitest";
import { CELL, renderBoard, bitmapHex, renderScale } from "./render-board";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";

interface FillCall {
  style: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function createCanvas(): {
  canvas: HTMLCanvasElement;
  fills: FillCall[];
  strokes: FillCall[];
  context: { imageSmoothingEnabled: boolean };
} {
  const fills: FillCall[] = [];
  const strokes: FillCall[] = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    imageSmoothingEnabled: true,
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ style: this.fillStyle, x, y, width, height });
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      strokes.push({ style: this.strokeStyle, x, y, width, height });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, fills, strokes, context };
}

describe("renderBoard", () => {
  it("fills each adjacent painted cell as its complete bitmap rectangle", () => {
    const { canvas, fills, context } = createCanvas();

    renderBoard(canvas, [
      { x: 10, y: 7, colorIndex: 1, artistAccountId: "a", lastWriteTimestampNs: "1" },
      { x: 11, y: 7, colorIndex: 2, artistAccountId: "b", lastWriteTimestampNs: "2" },
    ]);

    // The final calls are confirmed paint. Every rectangle reaches exactly to
    // its neighbour's edge: [x * CELL, x * CELL + CELL), with no inset gap.
    expect(fills.slice(-2)).toEqual([
      expect.objectContaining({ x: 40, y: 28, width: 4, height: 4 }),
      expect.objectContaining({ x: 44, y: 28, width: 4, height: 4 }),
    ]);
    expect(context.imageSmoothingEnabled).toBe(false);
  });

  it("never paints over the chosen colour inside a pending cell", () => {
    // Regression: an inset 1px outline on a 4px bitmap cell leaves a 2x2
    // interior, so an unconfirmed Marigold cell read as the marker's yellow
    // rather than as Marigold. The marker may mark the edge, never the art.
    const CELL = 4;
    const MARIGOLD = "#e0a100";
    const x = 10;
    const y = 13;
    for (const phase of ["submitted", "confirmation_delayed"] as const) {
      const { canvas, fills, strokes } = createCanvas();

      renderBoard(canvas, [], [
        { x, y, colorIndex: 3, accountId: "a", transactionId: null, phase },
      ]);

      expect(strokes).toEqual([]);

      const cellFills = fills.filter(
        (fill) =>
          fill.x >= x * CELL &&
          fill.x < (x + 1) * CELL &&
          fill.y >= y * CELL &&
          fill.y < (y + 1) * CELL,
      );
      // The paint itself, filling the whole cell.
      expect(cellFills).toContainEqual(
        expect.objectContaining({
          style: MARIGOLD,
          x: x * CELL,
          y: y * CELL,
          width: CELL,
          height: CELL,
        }),
      );
      // Anything else is a marker, and it may cover at most one device pixel.
      // (The empties are the checkerboard the cell is drawn over.)
      const EMPTIES = ["#242629", "#292b2e"];
      const markers = cellFills.filter(
        (fill) =>
          !EMPTIES.includes(fill.style) &&
          !(
            fill.style === MARIGOLD &&
            fill.width === CELL &&
            fill.height === CELL
          ),
      );
      expect(markers.length).toBeGreaterThan(0);
      for (const marker of markers) {
        expect(marker.width * marker.height).toBeLessThanOrEqual(1);
      }
    }
  });
});


describe("device-pixel rendering", () => {
  function createScaleCanvas(dpr: number) {
    const fills: Array<{ style: string; x: number; y: number; width: number; height: number }> = [];
    const painted = new Map<string, string>();
    const context = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      imageSmoothingEnabled: true,
      fillRect(x: number, y: number, width: number, height: number) {
        fills.push({ style: this.fillStyle, x, y, width, height });
        if (width > 1) {
          for (let dx = 0; dx < width; dx += 1) {
            for (let dy = 0; dy < height; dy += 1) {
              painted.set(`${x + dx},${y + dy}`, this.fillStyle);
            }
          }
        }
      },
      strokeRect() {},
      getImageData(x: number, y: number) {
        const style = painted.get(`${x},${y}`) ?? "#000000";
        const hex = style.replace("#", "");
        return {
          data: [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
            255,
          ],
        };
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    return { canvas, fills, dpr };
  }

  it("sizes the backing store to the device pixel ratio", () => {
    // Fails on the previous build: canvas.width was BOARD_WIDTH * CELL (512)
    // regardless of the display, so CSS stretched a 1x bitmap over 2x pixels.
    const { canvas } = createScaleCanvas(2);
    renderBoard(canvas, [], [], 2);
    expect(canvas.width).toBe(BOARD_WIDTH * CELL * 2);
    expect(canvas.height).toBe(BOARD_HEIGHT * CELL * 2);
  });

  it("draws a cell across its whole device-pixel block, with no gap", () => {
    const { canvas, fills } = createScaleCanvas(2);
    renderBoard(
      canvas,
      [{ x: 3, y: 5, colorIndex: 3, artistAccountId: "a", lastWriteTimestampNs: "1" }],
      [],
      2,
    );
    // CELL=4 at scale 2 => 8 device pixels, starting at 3*8 / 5*8.
    expect(fills).toContainEqual(
      expect.objectContaining({ style: "#e0a100", x: 24, y: 40, width: 8, height: 8 }),
    );
  });

  it("keeps the bitmapHex read seam working at device resolution", () => {
    const { canvas } = createScaleCanvas(2);
    renderBoard(
      canvas,
      [{ x: 3, y: 5, colorIndex: 3, artistAccountId: "a", lastWriteTimestampNs: "1" }],
      [],
      2,
    );
    expect(bitmapHex(canvas, 3, 5)).toBe("#e0a100");
  });

  it("clamps the scale to 3 and never below 1", () => {
    // A 4x display renders a 512*4 bitmap per repaint; 3x is the ceiling.
    expect(renderScale(4)).toBe(3);
    expect(renderScale(2.4)).toBe(2);
    expect(renderScale(0.5)).toBe(1);
    expect(renderScale(Number.NaN)).toBe(1);
  });
});
