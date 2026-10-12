import { describe, expect, it } from "vitest";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixelAtBlock,
  replaceCacheAtBlock,
} from "./board-cache";

describe("board-cache", () => {
  it("stores painted cells and removes empty reads at the same block", () => {
    const cache = createPixelCache();
    rememberPixelAtBlock(
      cache,
      {
        x: 1,
        y: 2,
        colorIndex: 3,
        artistAccountId: "alice.testnet",
        lastWriteTimestampNs: "9",
      },
      100,
    );
    expect(getCachedPixel(cache, 1, 2)?.colorIndex).toBe(3);
    expect(paintedPixels(cache)).toHaveLength(1);

    rememberPixelAtBlock(
      cache,
      {
        x: 1,
        y: 2,
        colorIndex: null,
        artistAccountId: null,
        lastWriteTimestampNs: null,
      },
      100,
    );
    expect(getCachedPixel(cache, 1, 2)).toBeUndefined();
    expect(paintedPixels(cache)).toHaveLength(0);
  });

  it("ignores an older block after a newer single-cell observation", () => {
    const cache = createPixelCache();
    rememberPixelAtBlock(
      cache,
      {
        x: 1,
        y: 1,
        colorIndex: 2,
        artistAccountId: "new.testnet",
        lastWriteTimestampNs: "5000",
      },
      200,
    );
    const applied = rememberPixelAtBlock(
      cache,
      {
        x: 1,
        y: 1,
        colorIndex: 4,
        artistAccountId: "old.testnet",
        lastWriteTimestampNs: "1000",
      },
      150,
    );
    expect(applied).toBe(false);
    expect(getCachedPixel(cache, 1, 1)?.artistAccountId).toBe("new.testnet");
  });

  it("full refresh at an older block cannot wipe newer cell evidence", () => {
    const cache = createPixelCache();
    rememberPixelAtBlock(
      cache,
      {
        x: 3,
        y: 4,
        colorIndex: 7,
        artistAccountId: "fresh.testnet",
        lastWriteTimestampNs: "9000",
      },
      300,
    );

    replaceCacheAtBlock(
      cache,
      [
        {
          x: 0,
          y: 0,
          colorIndex: 1,
          artistAccountId: "snapshot.testnet",
          lastWriteTimestampNs: "1000",
        },
      ],
      250,
    );

    expect(getCachedPixel(cache, 3, 4)?.artistAccountId).toBe("fresh.testnet");
    expect(getCachedPixel(cache, 0, 0)?.artistAccountId).toBe("snapshot.testnet");
  });

  it("replaceCacheAtBlock rebuilds from a full get_pixels walk", () => {
    const cache = createPixelCache();
    rememberPixelAtBlock(
      cache,
      {
        x: 0,
        y: 0,
        colorIndex: 1,
        artistAccountId: "old.testnet",
        lastWriteTimestampNs: "1",
      },
      10,
    );
    replaceCacheAtBlock(
      cache,
      [
        {
          x: 3,
          y: 4,
          colorIndex: 2,
          artistAccountId: "alice.testnet",
          lastWriteTimestampNs: "2",
        },
      ],
      20,
    );
    expect(getCachedPixel(cache, 0, 0)).toBeUndefined();
    expect(getCachedPixel(cache, 3, 4)?.artistAccountId).toBe("alice.testnet");
  });
});
