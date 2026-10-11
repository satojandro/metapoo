import type { PaletteColor } from "./types.ts";

/**
 * Eight named colors. Indices are the values a contract would store.
 * Keep this list identical to `shared/board.json` and `contracts/board`.
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
