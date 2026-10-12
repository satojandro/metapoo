import type { BountyCrop } from "./types";

export interface HelpPaintDeepLinkInput {
  board: string;
  /** Top-left of the bounty crop (or clamped focus cell). */
  x: number;
  y: number;
  zoom: number;
  bounty: string;
  template?: string | null;
}

export interface ParsedHelpPaintParams {
  board: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  bounty: string | null;
  template: string | null;
}

const DEFAULT_ZOOM = 8;
const MIN_ZOOM = 1;
const MAX_ZOOM = 64;
const BOARD_MAX = 127;

/** Clamp integer board coordinates into the 128×128 prototype range. */
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

/**
 * Build a `/wall` Help-paint deep link with explicit query params.
 * A URL never supplies a trusted price or signable contract ID.
 */
export function buildHelpPaintDeepLink(input: HelpPaintDeepLinkInput): string {
  const params = new URLSearchParams();
  params.set("board", input.board);
  params.set("x", String(clampBoardCoord(input.x)));
  params.set("y", String(clampBoardCoord(input.y)));
  params.set("zoom", String(clampZoom(input.zoom)));
  params.set("bounty", input.bounty);
  if (input.template) {
    params.set("template", input.template);
  }
  return `/wall?${params.toString()}`;
}

/** Focus the crop origin for Help paint. */
export function deepLinkForBountyCrop(
  bountyId: string,
  boardId: string,
  crop: BountyCrop,
  templateId: string | null,
  zoom = DEFAULT_ZOOM,
): string {
  return buildHelpPaintDeepLink({
    board: boardId,
    x: crop.x,
    y: crop.y,
    zoom,
    bounty: bountyId,
    template: templateId,
  });
}

/**
 * Parse Help-paint / wall context query params.
 * Rejects non-integer coordinates and unsupported empty board ids.
 */
export function parseHelpPaintSearch(search: string): ParsedHelpPaintParams {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);

  const boardRaw = params.get("board");
  const bountyRaw = params.get("bounty");
  const templateRaw = params.get("template");

  return {
    board: boardRaw && boardRaw.trim() !== "" ? boardRaw.trim() : null,
    x: parseOptionalInt(params.get("x")),
    y: parseOptionalInt(params.get("y")),
    zoom: parseOptionalZoom(params.get("zoom")),
    bounty: bountyRaw && bountyRaw.trim() !== "" ? bountyRaw.trim() : null,
    template:
      templateRaw && templateRaw.trim() !== "" ? templateRaw.trim() : null,
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
