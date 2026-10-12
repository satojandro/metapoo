import { describe, expect, it } from "vitest";
import type { ChainBoardView } from "./contract";
import { validateContractMetadata } from "./contract-meta";

function validFreeBoard(): ChainBoardView {
  return {
    schema_version: 2,
    width: 128,
    height: 128,
    origin: "top-left",
    overwrite_rule: "open_wall",
    sponsorship_enabled: false,
    palette: [
      { index: 0, name: "Ink", hex: "#1c1917" },
      { index: 1, name: "Paper", hex: "#f4efe4" },
      { index: 2, name: "Brick", hex: "#b23a2f" },
      { index: 3, name: "Marigold", hex: "#e0a100" },
      { index: 4, name: "Moss", hex: "#3d7a4a" },
      { index: 5, name: "River", hex: "#2f6f8f" },
      { index: 6, name: "Grape", hex: "#6b4c7a" },
      { index: 7, name: "Clay", hex: "#c47b5a" },
    ],
  };
}

function validPaidBoard(): ChainBoardView {
  return {
    ...validFreeBoard(),
    schema_version: 3,
    pricing_version: "pressure-v1-fixture",
    ledger_unit: "TOILET",
    pressure: {
      version: "pressure-v1-fixture",
      region_size: 8,
      base_cost: "10",
      max_cost: "50",
    },
  };
}

describe("validateContractMetadata", () => {
  it("accepts a matching free schema 2 board", () => {
    const result = validateContractMetadata(validFreeBoard());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toMatch(/free/);
      expect(result.summary).toMatch(/schema 2/);
    }
  });

  it("accepts schema 3 when size/origin/overwrite/palette match and paid markers exist", () => {
    const result = validateContractMetadata(validPaidBoard());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toMatch(/paid/);
      expect(result.summary).toMatch(/schema 3/);
    }
  });

  it("rejects schema 3 without paid markers", () => {
    const board = validFreeBoard();
    board.schema_version = 3;
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toMatch(/paid/i);
    }
  });

  it("does not require paid markers on free schema 2", () => {
    const board = validFreeBoard();
    expect(board.pricing_version).toBeUndefined();
    expect(board.pressure).toBeUndefined();
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(true);
  });

  it("rejects schema drift outside 2 and 3", () => {
    const board = validFreeBoard();
    board.schema_version = 99;
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toMatch(/schema/i);
    }
  });

  it("rejects palette hex drift so stored colors are not reinterpreted", () => {
    const board = validFreeBoard();
    board.palette[2] = { ...board.palette[2], hex: "#ff0000" };
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
  });
});
