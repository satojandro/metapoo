import type { PaletteColor } from "./types.ts";

/**
 * Sixteen named colors: the original eight, then Grime & Gum at 8–15.
 * Indices are the values a contract stores. Keep this list identical to
 * `shared/board.json` and `contracts/paid-board`. The free board
 * (`contracts/board`, deployed) still accepts only indices 0–7.
 * A shared test fails if they drift.
 */
export const PALETTE: readonly PaletteColor[] = [
  { index: 0, name: "Ink", hex: "#1c1917" },
  { index: 1, name: "Paper", hex: "#f4efe4" },
  { index: 2, name: "Brick", hex: "#b23a2f" },
  { index: 3, name: "Marigold", hex: "#e0a100" },
  { index: 4, name: "Moss", hex: "#3d7a4a" },
  { index: 5, name: "River", hex: "#2f6f8f" },
  { index: 6, name: "Grape", hex: "#6b4c7a" },
  { index: 7, name: "Clay", hex: "#c47b5a" },
  { index: 8, name: "Grout", hex: "#8a857c" },
  { index: 9, name: "Rust", hex: "#7a4528" },
  { index: 10, name: "Nicotine", hex: "#ecd9a0" },
  { index: 11, name: "Bubblegum", hex: "#ec8fb0" },
  { index: 12, name: "Bleach", hex: "#9ccbdc" },
  { index: 13, name: "Bruise", hex: "#263552" },
  { index: 14, name: "Bile", hex: "#9fb53a" },
  { index: 15, name: "Cone", hex: "#ef7a2c" },
];

export function isPaletteIndex(colorIndex: number): boolean {
  return Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex < PALETTE.length;
}

export function paletteColor(colorIndex: number): PaletteColor | null {
  if (!isPaletteIndex(colorIndex)) {
    return null;
  }
  return PALETTE[colorIndex] ?? null;
}
