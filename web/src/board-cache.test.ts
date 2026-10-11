import { describe, expect, it } from "vitest";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixel,
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
});
