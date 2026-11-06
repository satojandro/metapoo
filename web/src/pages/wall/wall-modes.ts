/**
 * Look / Paint, and Move.
 *
 * Two modes of one wall. They only decide what a pointer gesture means; they never
 * change camera maths, pricing or submission:
 * - Look (default, signed out): drag moves the wall, a tap shows a tile. Taps never paint.
 * - Paint: the existing paint behaviour (tap chooses or paints, drag paints a stroke).
 *
 * There is no Look / Paint toggle (owner, 6 Nov). Signing in switches to Paint and
 * signing out back to Look (mount-wall drives that); signed out, Start painting
 * opens Paint with Connect as its action, and Just looking returns to Look.
 * - Move (Paint only): drag moves the wall instead of painting, for touch users who
 *   can't hold space or use a middle button. Two fingers also move the wall.
 */

import type { WallScope } from "./wall-scope";

export type WallMode = "look" | "paint";

export interface WallModesDeps {
  scope: WallScope;
  /** `.wall-page` root: carries `data-mode` / `data-moving` for CSS. */
  page: HTMLElement;
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
  const { scope, page, moveButton } = deps;
  let mode: WallMode = "look";
  let moving = false;

  function sync(): void {
    page.dataset.mode = mode;
    page.dataset.moving = String(moving);
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
