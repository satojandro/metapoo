export interface WallZoomState {
  current: number;
  minimum: number;
  maximum: number;
  /** Cell size at which the whole board is visible. 100% on the readout. */
  fit: number;
  fitted: boolean;
}

export interface WallZoomControlsHost {
  getCurrentZoom: () => WallZoomState;
  zoomBy: (factor: number) => void;
  zoomToFit: () => void;
  subscribe: (listener: () => void) => () => void;
}

// One click of the arrow buttons. 1.25 was too coarse: two clicks overshot the
// zoom level the user wanted, which is why they asked for manual stepping.
const ZOOM_STEP = 1.15;
const LIMIT_EPSILON = 1e-6;

/**
 * Mount controls for the wall camera. The host deliberately exposes no draw or
 * placement capability, so this module can only update the existing camera.
 */
export function mountWallZoomControls(
  container: HTMLElement,
  host: WallZoomControlsHost,
): () => void {
  const controls = document.createElement("div");
  controls.className = "wall-zoom-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Wall zoom");

  const zoomOut = createButton("zoom-out", "Zoom out", "−");
  const level = document.createElement("span");
  level.id = "zoom-level";
  level.className = "wall-zoom-level";
  level.setAttribute("role", "status");
  level.setAttribute("aria-live", "polite");
  const zoomIn = createButton("zoom-in", "Zoom in", "+");
  const fit = createButton("zoom-fit", "Fit wall to view", "Fit wall");
  controls.append(zoomOut, level, zoomIn, fit);
  container.prepend(controls);

  const cleanups: Array<() => void> = [];
  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  };

  const readState = (): WallZoomState | null => {
    const state = host.getCurrentZoom();
    if (
      !Number.isFinite(state.current) ||
      !Number.isFinite(state.minimum) ||
      !Number.isFinite(state.maximum) ||
      state.minimum <= 0 ||
      state.maximum < state.minimum
    ) {
      return null;
    }
    return state;
  };

  const syncDisabledState = (): void => {
    const state = readState();
    zoomOut.disabled = !state || state.current <= state.minimum + LIMIT_EPSILON;
    zoomIn.disabled = !state || state.current >= state.maximum - LIMIT_EPSILON;
    fit.disabled = !state || state.fitted;
    // 100% means "the whole board fits". Absolute cell size is meaningless to
    // a player; "how much of the wall am I looking at" is the useful number.
    level.textContent = state
      ? `${Math.round((state.current / state.fit) * 100)}%`
      : "—";
    level.title = state
      ? `Cell size ${state.current.toFixed(2)} px · fitted ${state.fit.toFixed(2)} px`
      : "";
  };

  const requestZoom = (factor: number): void => {
    const state = readState();
    if (!state) return;
    const target = Math.min(
      state.maximum,
      Math.max(state.minimum, state.current * factor),
    );
    if (Math.abs(target - state.current) <= LIMIT_EPSILON) return;
    host.zoomBy(target / state.current);
    syncDisabledState();
  };

  listen(zoomOut, "click", () => requestZoom(1 / ZOOM_STEP));
  listen(zoomIn, "click", () => requestZoom(ZOOM_STEP));
  listen(fit, "click", () => {
    const state = readState();
    if (!state || state.fitted) return;
    host.zoomToFit();
    syncDisabledState();
  });

  // Keep every interaction with this UI out of any enclosing board gesture,
  // hit-test, keyboard-placement, or wheel-zoom listener.
  const stopPropagation = (event: Event): void => event.stopPropagation();
  for (const eventType of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "wheel",
    "beforeinput",
    "input",
    "keydown",
    "keyup",
    "click",
    "dblclick",
    "contextmenu",
  ]) {
    listen(controls, eventType, stopPropagation, { passive: eventType === "wheel" });
  }

  const unsubscribe = host.subscribe(syncDisabledState);
  cleanups.push(unsubscribe);
  syncDisabledState();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    controls.remove();
  };
}

function createButton(id: string, ariaLabel: string, text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = id;
  button.type = "button";
  button.className = "action secondary wall-zoom-control";
  button.setAttribute("aria-label", ariaLabel);
  button.textContent = text;
  return button;
}
