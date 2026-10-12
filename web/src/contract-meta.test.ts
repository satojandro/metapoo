import { describe, expect, it } from "vitest";
import type { ChainBoardView } from "./contract";
import { validateContractMetadata } from "./contract-meta";

function validBoard(): ChainBoardView {
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

describe("validateContractMetadata", () => {
  it("accepts a matching board", () => {
    const result = validateContractMetadata(validBoard());
    expect(result.ok).toBe(true);
  });

  it("rejects schema drift", () => {
    const board = validBoard();
    board.schema_version = 99;
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toMatch(/schema/i);
    }
  });

  it("rejects palette hex drift so stored colors are not reinterpreted", () => {
    const board = validBoard();
    board.palette[2] = { ...board.palette[2], hex: "#ff0000" };
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
  });
});
