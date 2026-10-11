import { describe, expect, it } from "vitest";
import { mapChainPixel, pixelMatchesDraw } from "./contract";

describe("mapChainPixel", () => {
  it("maps chain field names into page types and stringifies timestamps", () => {
    const pixel = mapChainPixel({
      x: 3,
      y: 4,
      color: 2,
      artist: "alice.testnet",
      written_at_ns: 1700000000000000000,
    });
    expect(pixel).toEqual({
      x: 3,
      y: 4,
      colorIndex: 2,
      artistAccountId: "alice.testnet",
      lastWriteTimestampNs: "1700000000000000000",
    });
  });

  it("keeps nulls for an empty cell", () => {
    const pixel = mapChainPixel({
      x: 0,
      y: 0,
      color: null,
      artist: null,
      written_at_ns: null,
    });
    expect(pixel.colorIndex).toBeNull();
    expect(pixel.artistAccountId).toBeNull();
    expect(pixel.lastWriteTimestampNs).toBeNull();
  });
});

describe("pixelMatchesDraw", () => {
  it("requires coordinates, color, and artist to match", () => {
    const pixel = mapChainPixel({
      x: 3,
      y: 4,
      color: 2,
      artist: "alice.testnet",
      written_at_ns: "1",
    });
    expect(pixelMatchesDraw(pixel, 3, 4, 2, "alice.testnet")).toBe(true);
    expect(pixelMatchesDraw(pixel, 3, 4, 2, "bob.testnet")).toBe(false);
    expect(pixelMatchesDraw(pixel, 3, 4, 1, "alice.testnet")).toBe(false);
  });
});
