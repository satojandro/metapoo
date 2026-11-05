import { describe, expect, it } from "vitest";
import type { ChainBoardView } from "./contract";
import { contractMetaBlockCopy, validateContractMetadata } from "./contract-meta";
import { PALETTE } from "@shared/palette.ts";

function validFreeBoard(): ChainBoardView {
  return {
    schema_version: 2,
    width: 128,
    height: 128,
    origin: "top-left",
    overwrite_rule: "open_wall",
    sponsorship_enabled: false,
    palette: PALETTE.map((color) => ({ ...color })),
  };
}

function validPaidBoard(): ChainBoardView {
  // Schema 4 deliberately reports the same shape as the free board: the paid marker
  // is the schema number plus `get_payment_config`, not extra `get_board` fields.
  // No pricing_version / pressure / ledger_unit here, on purpose.
  return { ...validFreeBoard(), schema_version: 4 };
}

describe("validateContractMetadata board size", () => {
  it("accepts a 64 × 64 paid board and reports its side", () => {
    const result = validateContractMetadata({ ...validPaidBoard(), width: 64, height: 64 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.side).toBe(64);
  });

  it("accepts any square up to 128, the largest a board can grow", () => {
    for (const side of [1, 96, 128]) {
      expect(validateContractMetadata({ ...validPaidBoard(), width: side, height: side }).ok).toBe(true);
    }
  });

  it("rejects a non-square, oversized or empty board", () => {
    for (const [width, height] of [[64, 32], [256, 256], [0, 0], [64.5, 64.5]]) {
      const result = validateContractMetadata({ ...validPaidBoard(), width, height });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.title).toBe("Incompatible board size");
    }
  });
});

describe("validateContractMetadata", () => {
  it("accepts a matching free schema 2 board", () => {
    const result = validateContractMetadata(validFreeBoard());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toMatch(/free/);
      expect(result.summary).toMatch(/schema 2/);
    }
  });

  it("accepts the paid schema 4 board without any extra get_board markers", () => {
    const result = validateContractMetadata(validPaidBoard());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toMatch(/paid/);
      expect(result.summary).toMatch(/schema 4/);
    }
  });

  it("rejects the retired schema 3 and says so", () => {
    const board = validFreeBoard();
    board.schema_version = 3;
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toMatch(/schema/i);
      expect(result.message).toMatch(/retired/i);
    }
  });

  it("does not require paid markers on free schema 2", () => {
    const board = validFreeBoard();
    expect(board.pricing_version).toBeUndefined();
    expect(board.pressure).toBeUndefined();
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(true);
  });

  it("rejects schema drift outside 2 and 4", () => {
    const board = validFreeBoard();
    board.schema_version = 99;
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toMatch(/schema/i);
    }
  });

  it("accepts today's 8-colour boards (a prefix of the shared palette)", () => {
    const board = validFreeBoard();
    board.palette = PALETTE.slice(0, 8).map((color) => ({ ...color }));
    for (const view of [board, { ...board, schema_version: 4 }]) {
      const result = validateContractMetadata(view);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.paletteLength).toBe(8);
    }
  });

  it("accepts the 16-colour paid board", () => {
    const result = validateContractMetadata(validPaidBoard());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.paletteLength).toBe(16);
  });

  it("rejects a 12-colour palette with the palette size reason", () => {
    const board = validFreeBoard();
    board.palette = PALETTE.slice(0, 12).map((color) => ({ ...color }));
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.title).toBe("Incompatible palette size");
  });

  it("rejects an 8-colour palette with a wrong hex", () => {
    const board = validFreeBoard();
    board.palette = PALETTE.slice(0, 8).map((color) => ({ ...color }));
    board.palette[5] = { ...board.palette[5], hex: "#000000" };
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.title).toBe("Incompatible palette entry");
  });

  it("rejects palette hex drift so stored colors are not reinterpreted", () => {
    const board = validFreeBoard();
    board.palette[2] = { ...board.palette[2], hex: "#ff0000" };
    const result = validateContractMetadata(board);
    expect(result.ok).toBe(false);
  });
});

describe("contractMetaBlockCopy", () => {
  it("calls a failed read a read failure and points at Refresh", () => {
    const copy = contractMetaBlockCopy({ kind: "read", detail: "rpc rate limited" });
    expect(copy.title).toMatch(/not read/i);
    expect(copy.message).toMatch(/could not be read/i);
    expect(copy.message).toMatch(/not a contract mismatch/i);
    expect(copy.message).toMatch(/Refresh board/);
  });

  it("reports a real mismatch with the specific field that differed", () => {
    const copy = contractMetaBlockCopy({
      kind: "mismatch",
      detail: "Palette index 3 differs (page Marigold #e0a100 vs contract Brick #b23a2f).",
    });
    expect(copy.title).toMatch(/contract metadata/i);
    expect(copy.message).toMatch(/Palette index 3 differs/);
    expect(copy.message).not.toMatch(/not a contract mismatch/i);
  });
});
