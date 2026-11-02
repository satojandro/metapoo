/**
 * Look / Paint, and Move (Phase 1 step 1).
 *
 * Two modes of one wall. They only decide what a pointer gesture means; they never
 * change camera maths, pricing or submission:
 * - Look (default): drag moves the wall, a tap shows a tile. Taps never paint.
 * - Paint: the existing paint behaviour (tap chooses or paints, drag paints a stroke).
 * - Move (Paint only): drag moves the wall instead of painting, for touch users who
 *   can't hold space or use a middle button. Two fingers also move the wall.
 */

import type { WallScope } from "./wall-scope";

export type WallMode = "look" | "paint";

export interface WallModesDeps {
  scope: WallScope;
  /** `.wall-page` root: carries `data-mode` / `data-moving` for CSS. */
  page: HTMLElement;
  lookButton: HTMLButtonElement;
  paintButton: HTMLButtonElement;
  moveButton: HTMLButtonElement;
  /** Look-mode call to action that switches to Paint. */
  startPainting?: HTMLButtonElement | null;
  /** Paint-mode link back to Look. */
  backToLook?: HTMLButtonElement | null;
  onChange?: (mode: WallMode, moving: boolean) => void;
}

export interface WallModes {
  mode(): WallMode;
  moving(): boolean;
  /** Every drag pans: Look mode, or Paint with Move on. */
  panOnly(): boolean;
  /** A tap may paint: Paint mode with Move off. */
  tapMayPaint(): boolean;
  setMode(next: WallMode): void;
  setMoving(next: boolean): void;
}

export function createWallModes(deps: WallModesDeps): WallModes {
  const { scope, page, lookButton, paintButton, moveButton } = deps;
  let mode: WallMode = "look";
  let moving = false;

  function sync(): void {
    page.dataset.mode = mode;
    page.dataset.moving = String(moving);
    lookButton.setAttribute("aria-pressed", String(mode === "look"));
    paintButton.setAttribute("aria-pressed", String(mode === "paint"));
    moveButton.hidden = mode !== "paint";
    moveButton.setAttribute("aria-pressed", String(moving));
    moveButton.textContent = moving ? "Moving" : "Move";
    deps.onChange?.(mode, moving);
  }

  function setMode(next: WallMode): void {
    if (next === mode) return;
    mode = next;
    // Move is a Paint-mode tool; leaving Paint turns it off.
    if (mode === "look") moving = false;
    sync();
  }

  function setMoving(next: boolean): void {
    if (mode !== "paint") next = false;
    if (next === moving) return;
    moving = next;
    sync();
  }

  scope.listen(lookButton, "click", () => setMode("look"));
  scope.listen(paintButton, "click", () => setMode("paint"));
  scope.listen(moveButton, "click", () => setMoving(!moving));
  if (deps.startPainting) scope.listen(deps.startPainting, "click", () => setMode("paint"));
  if (deps.backToLook) scope.listen(deps.backToLook, "click", () => setMode("look"));

  sync();

  return {
    mode: () => mode,
    moving: () => moving,
    panOnly: () => mode === "look" || moving,
    tapMayPaint: () => mode === "paint" && !moving,
    setMode,
    setMoving,
  };
}
