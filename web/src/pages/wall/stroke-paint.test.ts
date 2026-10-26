import { describe, expect, it } from "vitest";
import {
  chunkArgs,
  chunkCells,
  lineCells,
  MAX_BATCH,
  MAX_STROKE_CELLS,
  strokeBegin,
  strokeExtend,
} from "./stroke-paint";

describe("stroke painting", () => {
  it("a tap (begin, no extend) is a single-cell stroke", () => {
    const s = strokeBegin({ x: 5, y: 5 });
    expect(s.cells).toEqual([{ x: 5, y: 5 }]);
    expect(s.truncated).toBe(false);
  });

  it("interpolates the gap between two far-apart move samples", () => {
    let s = strokeBegin({ x: 10, y: 10 });
    s = strokeExtend(s, { x: 14, y: 10 });
    expect(s.cells).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 13, y: 10 },
      { x: 14, y: 10 },
    ]);
  });

  it("interpolates diagonals without holes or duplicates", () => {
    let s = strokeBegin({ x: 0, y: 0 });
    s = strokeExtend(s, { x: 4, y: 2 });
    const keys = s.cells.map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Bresenham(0,0)->(4,2) must be 5 cells long and end on the target.
    expect(s.cells.length).toBe(5);
    expect(s.cells.at(-1)).toEqual({ x: 4, y: 2 });
    // No cell may be absent from its predecessor's 8-neighbourhood.
    for (let i = 1; i < s.cells.length; i += 1) {
      const a = s.cells[i - 1];
      const b = s.cells[i];
      expect(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))).toBeLessThanOrEqual(1);
    }
  });

  it("lineCells excludes the start and includes the end", () => {
    expect(lineCells({ x: 1, y: 1 }, { x: 1, y: 4 })).toEqual([
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 1, y: 4 },
    ]);
  });

  it("re-entering a cell already inside the stroke paints it once", () => {
    let s = strokeBegin({ x: 20, y: 20 });
    s = strokeExtend(s, { x: 22, y: 20 });
    s = strokeExtend(s, { x: 21, y: 20 });
    s = strokeExtend(s, { x: 20, y: 20 });
    const keys = s.cells.map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stops extending at the cap and reports truncation", () => {
    let s = strokeBegin({ x: 0, y: 0 });
    s = strokeExtend(s, { x: MAX_STROKE_CELLS + 40, y: 0 });
    expect(s.truncated).toBe(true);
    expect(s.cells.length).toBe(MAX_STROKE_CELLS);
    const after = strokeExtend(s, { x: 0, y: 1 });
    expect(after.cells.length).toBe(MAX_STROKE_CELLS);
  });

  it("chunks a stroke into call-sized batches", () => {
    const cells = Array.from({ length: MAX_BATCH * 2 + 5 }, (_, i) => ({ x: i % 128, y: Math.floor(i / 128) }));
    const chunks = chunkCells(cells);
    expect(chunks.map((c) => c.length)).toEqual([MAX_BATCH, MAX_BATCH, 5]);
  });

  it("chunkArgs shapes the exact draw_many payload", () => {
    const args = chunkArgs(
      [
        { x: 3, y: 7 },
        { x: 4, y: 7 },
      ],
      6,
    );
    expect(args).toEqual({
      cells: [
        { x: 3, y: 7, color: 6 },
        { x: 4, y: 7, color: 6 },
      ],
    });
  });
});
