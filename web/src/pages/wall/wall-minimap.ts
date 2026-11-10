import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import type { Cell } from "../../selection";
import type { Camera, ViewportSize } from "../../viewport";
import type { WallScope } from "./wall-scope";

/**
 * Minimap for the full-screen wall: the whole wall in a corner, with a frame for the
 * part on screen. Tap or drag on it to move the wall there. It only reads the board
 * canvas and the camera, and moves the camera through `centerOn`; it never paints.
 *
 * Shown by CSS only in full-screen mode, and only while zoomed in
 * (`data-whole-wall="true"` hides it when the frame would cover the whole map).
 */

export interface WallMinimapDeps {
  scope: WallScope;
  /** Where the minimap element is appended. */
  host: HTMLElement;
  /** The rendered board; drawn scaled down. */
  source: HTMLCanvasElement;
  camera(): Camera;
  viewport(): ViewportSize;
  /** Move the wall so `cell` is in the middle, keeping the zoom. */
  centerOn(cell: Cell): void;
  /** Whether the minimap is on screen at all; skips drawing when false. */
  visible(): boolean;
}

export interface WallMinimap {
  element: HTMLElement;
  /** Redraw: call after the board renders or the camera moves. */
  update(): void;
  /** The board cell under a point on the minimap, in its client coordinates. */
  cellAt(clientX: number, clientY: number): Cell;
}

/** The part of the board on screen, in cells, clipped to the board. */
export function visibleCells(camera: Camera, viewport: ViewportSize): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const size = camera.cellSize > 0 ? camera.cellSize : 1;
  const left = Math.max(0, -camera.panX / size);
  const top = Math.max(0, -camera.panY / size);
  const right = Math.min(BOARD_WIDTH, (viewport.width - camera.panX) / size);
  const bottom = Math.min(BOARD_HEIGHT, (viewport.height - camera.panY) / size);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** True when the whole board is on screen, so a minimap would add nothing. */
export function showsWholeWall(camera: Camera, viewport: ViewportSize): boolean {
  const view = visibleCells(camera, viewport);
  return view.width >= BOARD_WIDTH - 0.5 && view.height >= BOARD_HEIGHT - 0.5;
}

export function createWallMinimap(deps: WallMinimapDeps): WallMinimap {
  const { scope, host, source } = deps;
  const doc = host.ownerDocument;

  const element = doc.createElement("div");
  element.className = "wall-minimap";
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Minimap of the whole wall. Tap to move there.");
  element.dataset.wholeWall = "true";

  const canvas = doc.createElement("canvas");
  canvas.className = "wall-minimap-canvas";
  canvas.width = BOARD_WIDTH;
  canvas.height = BOARD_HEIGHT;
  canvas.setAttribute("aria-hidden", "true");

  const frame = doc.createElement("div");
  frame.className = "wall-minimap-frame";
  frame.setAttribute("aria-hidden", "true");

  element.append(canvas, frame);
  host.append(element);
  scope.onDispose(() => element.remove());

  function update(): void {
    const camera = deps.camera();
    const viewport = deps.viewport();
    element.dataset.wholeWall = String(showsWholeWall(camera, viewport));
    if (!deps.visible()) return;

    const ctx = canvas.getContext("2d");
    if (ctx && source.width > 0 && source.height > 0) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }

    const view = visibleCells(camera, viewport);
    frame.style.left = `${(view.x / BOARD_WIDTH) * 100}%`;
    frame.style.top = `${(view.y / BOARD_HEIGHT) * 100}%`;
    frame.style.width = `${(view.width / BOARD_WIDTH) * 100}%`;
    frame.style.height = `${(view.height / BOARD_HEIGHT) * 100}%`;
  }

  function cellAt(clientX: number, clientY: number): Cell {
    const rect = canvas.getBoundingClientRect();
    const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
    const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    return {
      x: Math.min(BOARD_WIDTH - 1, Math.max(0, Math.floor(fx * BOARD_WIDTH))),
      y: Math.min(BOARD_HEIGHT - 1, Math.max(0, Math.floor(fy * BOARD_HEIGHT))),
    };
  }

  // Tap or drag to move the wall. The events stop here so the board underneath
  // never sees them as a paint stroke or a pan.
  let dragging: number | null = null;
  const stop = (event: Event) => event.stopPropagation();
  scope.listen(element, "pointerdown", (event) => {
    const pointer = event as PointerEvent;
    pointer.stopPropagation();
    pointer.preventDefault();
    dragging = pointer.pointerId;
    element.setPointerCapture?.(pointer.pointerId);
    deps.centerOn(cellAt(pointer.clientX, pointer.clientY));
  });
  scope.listen(element, "pointermove", (event) => {
    const pointer = event as PointerEvent;
    pointer.stopPropagation();
    if (dragging !== pointer.pointerId) return;
    deps.centerOn(cellAt(pointer.clientX, pointer.clientY));
  });
  const end = (event: Event) => {
    const pointer = event as PointerEvent;
    pointer.stopPropagation();
    if (dragging === pointer.pointerId) dragging = null;
  };
  scope.listen(element, "pointerup", end);
  scope.listen(element, "pointercancel", end);
  for (const type of ["click", "dblclick", "contextmenu"]) scope.listen(element, type, stop);
  scope.listen(element, "wheel", stop, { passive: true });

  update();
  return { element, update, cellAt };
}
