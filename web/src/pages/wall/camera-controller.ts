import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import { createGestureState, updateGesture, type GestureKind } from "../../gesture";
import type { PendingPaint } from "../../pending-paint";
import { renderBoard, type TilePainter } from "../../render-board";
import { moveSelection, type Cell } from "../../selection";
import {
  createCameraTransform,
  fitCamera,
  fitCellSize,
  isPaintZoom,
  MAX_CELL_PX,
  paintZoomCamera,
  panBy,
  wheelZoomFactor,
  zoomAt,
  type Camera,
  type CameraTransform,
  type ViewportSize,
} from "../../viewport";
import { mountWallZoomControls, type WallZoomState } from "../../wall-zoom-controls";
import type { WallScope } from "./wall-scope";

/**
 * How the camera hands a one-pointer gesture to the drawing session. The
 * camera decides what kind of gesture it is; the paint side decides whether a
 * stroke may start and what happens to it.
 */
export interface CameraStrokeHooks {
  active(): boolean;
  /** First pointer down on the board. `cell` is null over the margin. */
  begin(cell: Cell | null, wantsPan: boolean): void;
  extend(cell: Cell | null): void;
  /** Pointer up with a stroke live. `selectHere` selects the release cell. */
  finish(cell: Cell | null, completedKind: GestureKind | null, selectHere: () => void): void;
  /** Drop the live stroke (pinch, wheel, cancel, lost capture). */
  cancel(): void;
}

export interface CameraSelectionHooks {
  selected(): Cell | null;
  selectedColor(): number | null;
  /** Make `cell` the selection (and say so in the flow strip). */
  select(cell: Cell | null): void;
  showSelection(): void;
  refreshSelectedPixel(): void;
}

export interface CameraControllerDeps {
  scope: WallScope;
  canvas: HTMLCanvasElement;
  boardViewport: HTMLElement;
  boardStage: HTMLElement;
  boardToolbar: HTMLElement;
  boardFocus: HTMLElement;
  selectionRing: HTMLElement;
  hoverSummary: HTMLElement;
  zoomPaintButton: HTMLButtonElement;
  /** Confirmed pixels to draw. */
  paintedPixels(): PixelView[];
  /** Pending paints and the live stroke, drawn over the confirmed pixels. */
  overlayPixels(): PendingPaint[];
  selection: CameraSelectionHooks;
  strokes: CameraStrokeHooks;
  updateCompactStatus(): void;
  /** Enter on the focused board. */
  attemptDraw(): void;
  /** A deliberate tap selected `cell`; direct paint may follow. */
  tapSelected(cell: Cell, options: { paintZoom: boolean }): void;
  /** Hovering a cell with a fine pointer; the price badge may follow. */
  hoverCell(cell: Cell): void;
  /**
   * Every one-pointer drag moves the wall (Look mode, or Paint with Move on).
   * Same meaning as holding space; omitted means "only the usual pan gestures".
   */
  panOnly?(): boolean;
  /** Art / Price / Age / Turf colouring. Null or omitted draws the art. */
  tilePainter?(): TilePainter | null;
}

export interface CameraController {
  render(): void;
  applyCamera(next: Camera): void;
  camera(): Camera;
  readViewportSize(): ViewportSize;
  readZoomState(): WallZoomState;
  zoomFromCenter(factor: number): void;
  fitWallToView(): void;
  positionSelection(): void;
  updatePositionReadout(): void;
  cellAtClientPoint(clientX: number, clientY: number): Cell | null;
  dispose(): void;
}

/**
 * Zoom, pan, gestures and the pointer preview. Owns the camera and every bit
 * of pointer state; never paints, only reports gestures through `strokes`.
 */
export function createCameraController(deps: CameraControllerDeps): CameraController {
  const {
    scope,
    canvas,
    boardViewport,
    boardStage,
    boardToolbar,
    boardFocus,
    selectionRing,
    hoverSummary,
    zoomPaintButton,
    selection,
    strokes,
  } = deps;
  const listen = scope.listen;

  // The pointer preview is mount-owned so the wall template remains presentation-only.
  // It is deliberately separate from selection: moving or dragging never paints.
  const pointerPreview = document.createElement("div");
  pointerPreview.className = "pointer-preview";
  pointerPreview.hidden = true;
  pointerPreview.setAttribute("aria-hidden", "true");
  boardViewport.append(pointerPreview);

  const positionReadout = document.createElement("div");
  positionReadout.className = "position-readout";
  positionReadout.setAttribute("role", "status");
  positionReadout.setAttribute("aria-live", "off");
  // In the toolbar, not under the board: inside the stall frame it was clipped.
  boardToolbar.append(positionReadout);

  let camera: Camera = { cellSize: 4, panX: 0, panY: 0 };
  let viewTransform: CameraTransform = createCameraTransform(camera);
  const zoomStateListeners = new Set<() => void>();

  scope.onDispose(
    mountWallZoomControls(boardToolbar, {
      getCurrentZoom: readZoomState,
      zoomBy: zoomFromCenter,
      zoomToFit: fitWallToView,
      subscribe: (listener) => {
        zoomStateListeners.add(listener);
        return () => zoomStateListeners.delete(listener);
      },
    }),
  );

  const resizeObserver = new ResizeObserver(() => {
    if (scope.isDisposed()) return;
    camera = clampToViewport(camera);
    applyCamera(camera);
    positionSelection();
  });
  resizeObserver.observe(boardViewport);

  listen(zoomPaintButton, "click", () => {
    const focus = selection.selected() ?? {
      x: Math.floor(BOARD_WIDTH / 2),
      y: Math.floor(BOARD_HEIGHT / 2),
    };
    applyCamera(paintZoomCamera(readViewportSize(), focus));
    positionSelection();
    deps.updateCompactStatus();
  });

  wirePointerGestures();

  listen(
    boardViewport,
    "wheel",
    (event) => {
      const wheelEvent = event as WheelEvent;
      wheelEvent.preventDefault();
      const rect = boardViewport.getBoundingClientRect();
      const factor = wheelZoomFactor(wheelEvent.deltaY, wheelEvent.deltaMode);
      if (factor === 1) {
        return;
      }
      applyCamera(
        zoomAt(
          camera,
          readViewportSize(),
          factor,
          wheelEvent.clientX - rect.left,
          wheelEvent.clientY - rect.top,
        ),
      );
      positionSelection();
      deps.updateCompactStatus();
    },
    { passive: false },
  );

  listen(boardFocus, "keydown", (event) => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === "Enter") {
      keyEvent.preventDefault();
      deps.attemptDraw();
      return;
    }
    if (keyEvent.key === "+" || keyEvent.key === "=") {
      keyEvent.preventDefault();
      zoomFromCenter(1.25);
      return;
    }
    if (keyEvent.key === "-" || keyEvent.key === "_") {
      keyEvent.preventDefault();
      zoomFromCenter(1 / 1.25);
      return;
    }
    if (keyEvent.key === "0") {
      keyEvent.preventDefault();
      fitWallToView();
      return;
    }
    const current = selection.selected();
    const next = moveSelection(current, keyEvent.key);
    if (next === current) {
      return;
    }
    if (
      keyEvent.key === "ArrowUp" ||
      keyEvent.key === "ArrowDown" ||
      keyEvent.key === "ArrowLeft" ||
      keyEvent.key === "ArrowRight"
    ) {
      keyEvent.preventDefault();
      selection.select(next);
      if (next) {
        applyCamera(paintZoomCamera(readViewportSize(), next, camera.cellSize));
      }
      render();
      selection.showSelection();
      selection.refreshSelectedPixel();
    }
  });

  function render(): void {
    renderBoard(canvas, deps.paintedPixels(), deps.overlayPixels(), undefined, deps.tilePainter?.() ?? null);
    positionSelection();
    updatePositionReadout();
    deps.updateCompactStatus();
  }

  function updatePositionReadout(): void {
    const fitCellSize = fitCamera(readViewportSize()).cellSize;
    const zoomPercent = Math.max(1, Math.round((camera.cellSize / fitCellSize) * 100));
    const selected = selection.selected();
    const cellLabel = selected
      ? `Cell (${selected.x}, ${selected.y})`
      : "Cell: none selected";
    positionReadout.textContent = `Zoom ${zoomPercent}% · ${cellLabel}`;
    positionReadout.setAttribute(
      "aria-label",
      selected
        ? `Zoom ${zoomPercent} percent of whole-wall view. Selected cell: column ${selected.x}, row ${selected.y}.`
        : `Zoom ${zoomPercent} percent of whole-wall view. No cell selected.`,
    );
  }

  function positionSelection(): void {
    const selected = selection.selected();
    if (!selected) {
      selectionRing.hidden = true;
      return;
    }
    const rect = viewTransform.cellRect(selected);
    selectionRing.hidden = false;
    selectionRing.style.left = `${rect.left}px`;
    selectionRing.style.top = `${rect.top}px`;
    selectionRing.style.width = `${rect.width}px`;
    selectionRing.style.height = `${rect.height}px`;
    selectionRing.dataset.hasColor = selection.selectedColor() !== null ? "true" : "false";
  }

  function applyCamera(next: Camera): void {
    viewTransform = createCameraTransform(next);
    camera = viewTransform.camera;
    boardStage.style.width = `${viewTransform.stage.width}px`;
    boardStage.style.height = `${viewTransform.stage.height}px`;
    boardStage.style.transform = viewTransform.stage.transform;
    positionSelection();
    updatePositionReadout();
    for (const listener of zoomStateListeners) listener();
  }

  function readZoomState(): WallZoomState {
    const viewport = readViewportSize();
    const fittedCamera = fitCamera(viewport);
    const fitted =
      Math.abs(camera.cellSize - fittedCamera.cellSize) < 1e-6 &&
      Math.abs(camera.panX - fittedCamera.panX) < 1e-6 &&
      Math.abs(camera.panY - fittedCamera.panY) < 1e-6;
    return {
      current: camera.cellSize,
      // The floor is the fitted size, not the smallest representable cell: a
      // board smaller than the viewport is only empty space with a picture in it.
      minimum: fitCellSize(viewport),
      maximum: MAX_CELL_PX,
      fitted,
    };
  }

  function clampToViewport(current: Camera): Camera {
    const viewport = readViewportSize();
    // Re-fit if we were essentially in overview; otherwise keep zoom and reclamps.
    if (current.cellSize <= fitCamera(viewport).cellSize * 1.05) {
      return fitCamera(viewport);
    }
    return panBy(current, viewport, 0, 0);
  }

  function readViewportSize(): ViewportSize {
    const rect = boardViewport.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  }

  function zoomFromCenter(factor: number): void {
    const viewport = readViewportSize();
    applyCamera(zoomAt(camera, viewport, factor, viewport.width / 2, viewport.height / 2));
    positionSelection();
    deps.updateCompactStatus();
  }

  function fitWallToView(): void {
    applyCamera(fitCamera(readViewportSize()));
    positionSelection();
    deps.updateCompactStatus();
  }

  /**
   * Pointer rules:
   * - direct paint armed (session + colour + consent): one pointer paints a stroke
   * - panning while armed is a deliberate gesture: middle/right button, held
   *   space, two fingers, or a drag that starts outside the board
   * - otherwise one finger / mouse drag past threshold → pan (never paint)
   * - release without much movement → select cell
   * - two pointers → pinch zoom (never paint)
   *
   * Paint zoom is deliberately NOT part of arming. Requiring a zoom level to be
   * allowed to drag-paint was an invented precondition: it made drag silently
   * pan for every user who had not discovered the zoom button, and the button
   * carried no state to discover.
   */
  function wirePointerGestures(): void {
    let gesture = createGestureState();
    let strokeCancelled = false;
    let spaceHeld = false;
    const cancelStroke = () => { strokes.cancel(); strokeCancelled = true; render(); };
    listen(boardViewport, "wheel", () => { if (gesture.points.length) cancelStroke(); });
    listen(boardViewport, "lostpointercapture", cancelStroke);

    // Space is the conventional "temporarily pan" modifier. Ignore it while a
    // control is focused so the keyboard path for the palette keeps working.
    listen(window, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== " " || (event as KeyboardEvent).repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
      spaceHeld = true;
    });
    listen(window, "keyup", (event) => {
      if ((event as KeyboardEvent).key === " ") spaceHeld = false;
    });
    // Right-drag is a pan gesture here, so the browser menu must not interrupt it.
    listen(boardViewport, "contextmenu", (event) => event.preventDefault());

    let lastX = 0;
    let lastY = 0;
    let pinchStartDistance = 0;
    let pinchStartCamera: Camera | null = null;
    // Two fingers both zoom (distance) and move the wall (midpoint). The frame is
    // the existing zoomAt about the starting midpoint, then panBy the midpoint's
    // travel: the same camera functions, composed; no new camera maths.
    let pinchStartMidX = 0;
    let pinchStartMidY = 0;
    // The reducer decides whether a sequence is a tap. Keep its originating
    // cell alongside that state so a sub-threshold move across tiny fitted
    // cells cannot turn a touch scroll/pan into a placement on another cell.
    let tapStartCell: Cell | null = null;

    const gestureEvent = (
      event: PointerEvent,
      beganOnPanSurface = false,
    ) => ({
      type: event.type as
        | "pointerdown"
        | "pointermove"
        | "pointerup"
        | "pointercancel",
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      timeStamp: event.timeStamp,
      beganOnPanSurface,
    });

    listen(boardViewport, "pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      boardViewport.setPointerCapture(pointerEvent.pointerId);
      const rect = boardViewport.getBoundingClientRect();
      const beganCell = viewTransform.cellAt(
        pointerEvent.clientX - rect.left,
        pointerEvent.clientY - rect.top,
      );
      const beganOnPanSurface = beganCell === null;
      if (gesture.points.length === 0) {
        tapStartCell = beganCell;
      }
      const update = updateGesture(
        gesture,
        gestureEvent(pointerEvent, beganOnPanSurface),
      );
      gesture = update.state;

      if (gesture.points.length === 1) {
        strokeCancelled = false;
        const cell = cellAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
        // A non-primary button or a held space means "I want to move the board",
        // not "I want to paint here". That is the only way drag-painting can be
        // unconditional at every zoom level.
        const wantsPan =
          pointerEvent.button === 1 ||
          pointerEvent.button === 2 ||
          spaceHeld ||
          beganOnPanSurface ||
          (deps.panOnly?.() ?? false);
        strokes.begin(cell, wantsPan);
        lastX = pointerEvent.clientX;
        lastY = pointerEvent.clientY;
      } else if (gesture.points.length === 2) {
        cancelStroke();
        const pts = gesture.points;
        pinchStartDistance = Math.hypot(
          pts[0].clientX - pts[1].clientX,
          pts[0].clientY - pts[1].clientY,
        );
        // Every pinch frame derives from the same camera. Mixing a prior frame's
        // pan with the initial cell size makes the board jump under two fingers.
        pinchStartCamera = { ...camera };
        const startRect = boardViewport.getBoundingClientRect();
        pinchStartMidX = (pts[0].clientX + pts[1].clientX) / 2 - startRect.left;
        pinchStartMidY = (pts[0].clientY + pts[1].clientY) / 2 - startRect.top;
        boardViewport.classList.add("is-panning");
      }
    });

    listen(boardViewport, "pointermove", (event) => {
      const pointerEvent = event as PointerEvent;
      if (!gesture.points.some((point) => point.pointerId === pointerEvent.pointerId)) {
        updatePointerPreview(pointerEvent);
        return;
      }
      const update = updateGesture(gesture, gestureEvent(pointerEvent));
      gesture = update.state;

      if (update.activeKind === "pinch" && gesture.points.length >= 2) {
        const pts = gesture.points;
        const distance = Math.hypot(
          pts[0].clientX - pts[1].clientX,
          pts[0].clientY - pts[1].clientY,
        );
        if (pinchStartDistance > 0 && pinchStartCamera) {
          const rect = boardViewport.getBoundingClientRect();
          const midX = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
          const midY = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
          const factor = distance / pinchStartDistance;
          const size = readViewportSize();
          applyCamera(
            panBy(
              zoomAt(pinchStartCamera, size, factor, pinchStartMidX, pinchStartMidY),
              size,
              midX - pinchStartMidX,
              midY - pinchStartMidY,
            ),
          );
          positionSelection();
          deps.updateCompactStatus();
        }
        updatePointerPreview(pointerEvent);
        return;
      }

      if (pointerEvent.pointerId !== gesture.primaryId) {
        return;
      }

      if (strokes.active()) {
        strokes.extend(cellAtClientPoint(pointerEvent.clientX, pointerEvent.clientY));
        updatePointerPreview(pointerEvent);
        return;
      }
      if (update.activeKind === "drag" || update.activeKind === "pan") {
        boardViewport.classList.add("is-panning");
        applyCamera(
          panBy(
            camera,
            readViewportSize(),
            pointerEvent.clientX - lastX,
            pointerEvent.clientY - lastY,
          ),
        );
        positionSelection();
        lastX = pointerEvent.clientX;
        lastY = pointerEvent.clientY;
      }
      updatePointerPreview(pointerEvent);
    });

    const endPointer = (event: Event): void => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.type === "pointercancel") {
        cancelStroke();
        clearPointerPreview();
      }
      if (!gesture.points.some((point) => point.pointerId === pointerEvent.pointerId)) {
        return;
      }
      const update = updateGesture(gesture, gestureEvent(pointerEvent));
      gesture = update.state;

      if (gesture.points.length < 2) {
        pinchStartDistance = 0;
        pinchStartCamera = null;
      }

      if (update.completedKind !== null) {
        boardViewport.classList.remove("is-panning");

        if (strokes.active()) {
          const cell = cellAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
          strokes.finish(cell, update.completedKind, () =>
            selectAtClientPoint(pointerEvent.clientX, pointerEvent.clientY),
          );
          render();
          return;
        }
        if (strokeCancelled) { deps.updateCompactStatus(); return; }
        // Only the pure classifier's deliberate-tap result may reach selection
        // or direct paint. It must also end in the cell where it started:
        // fitted cells can be smaller than the movement threshold. Drag, pan,
        // pinch, long press, cancel, and cross-cell releases are discarded.
        const beganCell = tapStartCell;
        tapStartCell = null;
        const rect = boardViewport.getBoundingClientRect();
        const endedCell = viewTransform.cellAt(
          pointerEvent.clientX - rect.left,
          pointerEvent.clientY - rect.top,
        );
        if (
          update.completedKind === "tap" &&
          beganCell !== null &&
          endedCell !== null &&
          beganCell.x === endedCell.x &&
          beganCell.y === endedCell.y
        ) {
          selectAtClientPoint(pointerEvent.clientX, pointerEvent.clientY);
        } else {
          deps.updateCompactStatus();
        }
        return;
      }

      if (gesture.points.length === 1) {
        const remaining = gesture.points[0];
        lastX = remaining.clientX;
        lastY = remaining.clientY;
        boardViewport.classList.add("is-panning");
      }
    };

    listen(boardViewport, "pointerup", endPointer);
    listen(boardViewport, "pointercancel", endPointer);
    listen(boardViewport, "pointerleave", clearPointerPreview);
  }

  function cellAtClientPoint(clientX: number, clientY: number): Cell | null {
    const rect = boardViewport.getBoundingClientRect();
    return viewTransform.cellAt(clientX - rect.left, clientY - rect.top);
  }

  function selectAtClientPoint(clientX: number, clientY: number): void {
    const next = cellAtClientPoint(clientX, clientY);
    if (!next) {
      return;
    }
    selection.select(next);
    render();
    selection.showSelection();
    boardFocus.focus();
    selection.refreshSelectedPixel();
    // Paint zoom is the deliberate, r/place-style direct-placement mode. It
    // relaxes the two-step form (tap = place), but NEVER the consent toggle:
    // direct submission requires the user to have opted in, same as 2-step
    // mode, plus the pre-authorized local drawing session. A gesture never
    // routes through a form submission, and never submits unrequested.
    deps.tapSelected(next, { paintZoom: isPaintZoom(camera) });
  }

  function updatePointerPreview(event: PointerEvent): void {
    // Hover is a fine-pointer affordance only. On a touch pointer, or on a
    // surface that owns touch gestures, it must neither show a prospective cell
    // nor participate in the tap-to-paint route.
    // Gate on the pointer, not on `touch-action`. `.board-viewport` sets
    // `touch-action: none`, so the old check meant this branch always ran and the
    // per-cell price could never appear on hover on any desktop.
    if (event.pointerType === "touch") {
      clearPointerPreview();
      return;
    }
    const rect = boardViewport.getBoundingClientRect();
    const cell = viewTransform.cellAt(event.clientX - rect.left, event.clientY - rect.top);
    if (!cell) {
      clearPointerPreview();
      return;
    }
    const cellRect = viewTransform.cellRect(cell);
    pointerPreview.hidden = false;
    pointerPreview.style.left = `${cellRect.left}px`;
    pointerPreview.style.top = `${cellRect.top}px`;
    pointerPreview.style.width = `${cellRect.width}px`;
    pointerPreview.style.height = `${cellRect.height}px`;
    hoverSummary.textContent = `x ${cell.x} · y ${cell.y}`;
    deps.hoverCell(cell);
  }

  function clearPointerPreview(): void {
    pointerPreview.hidden = true;
    hoverSummary.textContent = "";
  }

  return {
    render,
    applyCamera,
    camera: () => camera,
    readViewportSize,
    readZoomState,
    zoomFromCenter,
    fitWallToView,
    positionSelection,
    updatePositionReadout,
    cellAtClientPoint,
    dispose() {
      resizeObserver.disconnect();
    },
  };
}
