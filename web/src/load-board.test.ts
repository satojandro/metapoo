import { describe, expect, it } from "vitest";
import type { PixelView, PixelsPageView } from "@shared/types.ts";
import { loadAllPaintedPixels } from "./load-board";

/**
 * Tiny in-memory stand-in for the contract's painted-cell list.
 * Used to prove a second reader can see what the first writer stored.
 */
function createSharedBoardStore() {
  const cells = new Map<string, PixelView>();

  return {
    /** Client A paints (overwrite replaces the same key — Open wall). */
    draw(
      x: number,
      y: number,
      colorIndex: number,
      artistAccountId: string,
      lastWriteTimestampNs: string,
    ): void {
      cells.set(`${x},${y}`, {
        x,
        y,
        colorIndex,
        artistAccountId,
        lastWriteTimestampNs,
      });
    },

    /** Client B (or A) reads one page — same shape as mapped `get_pixels`. */
    getPixels(fromIndex: number, limit: number): PixelsPageView {
      const list = [...cells.values()];
      const slice = list.slice(fromIndex, fromIndex + limit);
      const next = fromIndex + slice.length;
      return {
        pixels: slice,
        fromIndex,
        limit,
        total: list.length,
        nextFromIndex: next < list.length ? next : null,
      };
    },
  };
}

describe("loadAllPaintedPixels", () => {
  it("lets a second client see a pixel painted by the first", async () => {
    const store = createSharedBoardStore();

    // First client paints.
    store.draw(3, 4, 2, "alice.testnet", "1000");

    // Second client only reads, paging with a tiny limit so multiple pages run.
    const seenBySecondClient = await loadAllPaintedPixels(
      async (from, limit) => store.getPixels(from, limit),
      1,
    );

    expect(seenBySecondClient).toHaveLength(1);
    expect(seenBySecondClient[0]).toMatchObject({
      x: 3,
      y: 4,
      colorIndex: 2,
      artistAccountId: "alice.testnet",
    });
  });

  it("keeps only the latest color and artist after an overwrite", async () => {
    const store = createSharedBoardStore();
    store.draw(3, 4, 2, "alice.testnet", "1000");
    store.draw(3, 4, 5, "bob.testnet", "2000");

    const pixels = await loadAllPaintedPixels(async (from, limit) =>
      store.getPixels(from, limit),
    );

    expect(pixels).toHaveLength(1);
    expect(pixels[0]?.colorIndex).toBe(5);
    expect(pixels[0]?.artistAccountId).toBe("bob.testnet");
  });

  it("walks every page and rejects duplicate cells", async () => {
    const store = createSharedBoardStore();
    store.draw(0, 0, 1, "a.testnet", "1");
    store.draw(1, 0, 2, "a.testnet", "1");
    store.draw(2, 0, 3, "a.testnet", "1");

    const pixels = await loadAllPaintedPixels(
      async (from, limit) => store.getPixels(from, limit),
      2,
    );
    expect(pixels).toHaveLength(3);

    await expect(
      loadAllPaintedPixels(async () => ({
        pixels: [
          {
            x: 0,
            y: 0,
            colorIndex: 1,
            artistAccountId: "a.testnet",
            lastWriteTimestampNs: "1",
          },
        ],
        fromIndex: 0,
        limit: 1,
        total: 2,
        // Liar page: claims another page exists but will repeat the same cell.
        nextFromIndex: 0,
      })),
    ).rejects.toThrow(/more than once/);
  });
});
