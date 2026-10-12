import { describe, expect, it } from "vitest";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixel,
  rememberPixelIfNewer,
  replaceCache,
} from "./board-cache";

describe("board-cache", () => {
  it("stores painted cells and removes empty reads", () => {
    const cache = createPixelCache();
    rememberPixel(cache, {
      x: 1,
      y: 2,
      colorIndex: 3,
      artistAccountId: "alice.testnet",
      lastWriteTimestampNs: "9",
    });
    expect(getCachedPixel(cache, 1, 2)?.colorIndex).toBe(3);
    expect(paintedPixels(cache)).toHaveLength(1);

    rememberPixel(cache, {
      x: 1,
      y: 2,
      colorIndex: null,
      artistAccountId: null,
      lastWriteTimestampNs: null,
    });
    expect(getCachedPixel(cache, 1, 2)).toBeUndefined();
    expect(paintedPixels(cache)).toHaveLength(0);
  });

  it("rememberPixelIfNewer ignores an older write timestamp", () => {
    const cache = createPixelCache();
    rememberPixel(cache, {
      x: 1,
      y: 1,
      colorIndex: 2,
      artistAccountId: "new.testnet",
      lastWriteTimestampNs: "5000",
    });
    const applied = rememberPixelIfNewer(cache, {
      x: 1,
      y: 1,
      colorIndex: 4,
      artistAccountId: "old.testnet",
      lastWriteTimestampNs: "1000",
    });
    expect(applied).toBe(false);
    expect(getCachedPixel(cache, 1, 1)?.artistAccountId).toBe("new.testnet");
  });

  it("replaceCache rebuilds from a full get_pixels walk", () => {
    const cache = createPixelCache();
    rememberPixel(cache, {
      x: 0,
      y: 0,
      colorIndex: 1,
      artistAccountId: "old.testnet",
      lastWriteTimestampNs: "1",
    });
    replaceCache(cache, [
      {
        x: 3,
        y: 4,
        colorIndex: 2,
        artistAccountId: "alice.testnet",
        lastWriteTimestampNs: "2",
      },
    ]);
    expect(getCachedPixel(cache, 0, 0)).toBeUndefined();
    expect(getCachedPixel(cache, 3, 4)?.artistAccountId).toBe("alice.testnet");
  });
});
