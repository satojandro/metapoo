/**
 * `/wall?x=…&y=…&zoom=…` links that open the wall focused on one square.
 * A URL never supplies a trusted price or signable contract ID.
 */

export interface WallLinkInput {
  board: string;
  x: number;
  y: number;
  zoom: number;
}

export interface ParsedWallLink {
  board: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
}

const DEFAULT_ZOOM = 8;
const MIN_ZOOM = 1;
const MAX_ZOOM = 64;
const BOARD_MAX = 127;

/** Clamp integer board coordinates into the 128×128 range. */
export function clampBoardCoord(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return 0;
  }
  return Math.min(BOARD_MAX, Math.max(0, value));
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_ZOOM;
  }
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value)));
}

export function buildWallLink(input: WallLinkInput): string {
  const params = new URLSearchParams();
  params.set("board", input.board);
  params.set("x", String(clampBoardCoord(input.x)));
  params.set("y", String(clampBoardCoord(input.y)));
  params.set("zoom", String(clampZoom(input.zoom)));
  return `/wall?${params.toString()}`;
}

/** Parse wall location params. Rejects non-integer coordinates and empty board ids. */
export function parseWallLinkSearch(search: string): ParsedWallLink {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const boardRaw = params.get("board");
  return {
    board: boardRaw && boardRaw.trim() !== "" ? boardRaw.trim() : null,
    x: parseOptionalInt(params.get("x")),
    y: parseOptionalInt(params.get("y")),
    zoom: parseOptionalZoom(params.get("zoom")),
  };
}

function parseOptionalInt(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  if (!/^-?\d+$/.test(value.trim())) {
    return null;
  }
  return clampBoardCoord(Number(value));
}

function parseOptionalZoom(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  if (!/^\d+(\.\d+)?$/.test(value.trim())) {
    return null;
  }
  return clampZoom(Number(value));
}
