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
  context: { imageSmoothingEnabled: boolean };
} {
  const fills: FillCall[] = [];
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: true,
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ style: this.fillStyle, x, y, width, height });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, fills, context };
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
});
