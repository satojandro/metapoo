import { describe, expect, it } from "vitest";
import { renderBoard } from "./render-board";

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
