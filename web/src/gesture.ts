/**
 * Pure pointer-gesture classification for the wall.
 *
 * The reducer contains no DOM or camera work. Callers provide pointer-shaped
 * values and decide what a completed gesture should do. A gesture can only be
 * a tap when it stayed within both thresholds, used exactly one pointer, was
 * not cancelled, and started over a paintable board cell.
 */

export type GestureKind = "tap" | "drag" | "pan" | "pinch";

export interface GestureThresholds {
  movementPx: number;
  tapMaxDurationMs: number;
}

export const DEFAULT_GESTURE_THRESHOLDS: GestureThresholds = {
  movementPx: 8,
  tapMaxDurationMs: 500,
};

export interface GesturePointerEvent {
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
  /** True when the initial pointer is outside the paintable board. */
  beganOnPanSurface?: boolean;
}

export interface GesturePoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface GestureState {
  points: readonly GesturePoint[];
  primaryId: number | null;
  startX: number;
  startY: number;
  startedAt: number;
  lastEventAt: number;
  maxDistancePx: number;
  maxPointerCount: number;
  beganOnPanSurface: boolean;
  cancelled: boolean;
}

export interface GestureUpdate {
  state: GestureState;
  activeKind: GestureKind | null;
  completedKind: GestureKind | null;
}

export function createGestureState(): GestureState {
  return {
    points: [],
    primaryId: null,
    startX: 0,
    startY: 0,
    startedAt: 0,
    lastEventAt: 0,
    maxDistancePx: 0,
    maxPointerCount: 0,
    beganOnPanSurface: false,
    cancelled: false,
  };
}

export function updateGesture(
  state: GestureState,
  event: GesturePointerEvent,
  thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS,
): GestureUpdate {
  if (event.type === "pointerdown") {
    return beginPointer(state, event, thresholds);
  }

  if (!state.points.some((point) => point.pointerId === event.pointerId)) {
    return {
      state,
      activeKind: activeGestureKind(state, event.timeStamp, thresholds),
      completedKind: null,
    };
  }

  const withPosition = updatePointAndDistance(state, event);
  if (event.type === "pointermove") {
    return {
      state: withPosition,
      activeKind: activeGestureKind(withPosition, event.timeStamp, thresholds),
      completedKind: null,
    };
  }

  const ending: GestureState = {
    ...withPosition,
    points: withPosition.points.filter(
      (point) => point.pointerId !== event.pointerId,
    ),
    cancelled: withPosition.cancelled || event.type === "pointercancel",
  };

  if (ending.points.length > 0) {
    return {
      state: ending,
      activeKind: activeGestureKind(ending, event.timeStamp, thresholds),
      completedKind: null,
    };
  }

  const completedKind = classifyCompletedGesture(
    ending,
    event.timeStamp,
    thresholds,
  );
  return {
    state: createGestureState(),
    activeKind: null,
    completedKind,
  };
}

export function activeGestureKind(
  state: GestureState,
  nowMs: number = state.lastEventAt,
  thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS,
): GestureKind | null {
  if (state.maxPointerCount === 0) return null;
  if (state.maxPointerCount > 1) return "pinch";
  if (state.beganOnPanSurface) return "pan";
  if (
    state.cancelled ||
    state.maxDistancePx >= thresholds.movementPx ||
    elapsedMs(state.startedAt, nowMs) > thresholds.tapMaxDurationMs
  ) {
    return "drag";
  }
  return "tap";
}

function beginPointer(
  state: GestureState,
  event: GesturePointerEvent,
  thresholds: GestureThresholds,
): GestureUpdate {
  const startingFresh = state.points.length === 0;
  const point = pointFromEvent(event);
  const points = [
    ...state.points.filter((item) => item.pointerId !== event.pointerId),
    point,
  ];
  const next: GestureState = startingFresh
    ? {
        points,
        primaryId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: event.timeStamp,
        lastEventAt: event.timeStamp,
        maxDistancePx: 0,
        maxPointerCount: 1,
        beganOnPanSurface: event.beganOnPanSurface === true,
        cancelled: false,
      }
    : {
        ...state,
        points,
        lastEventAt: event.timeStamp,
        maxPointerCount: Math.max(state.maxPointerCount, points.length),
      };
  return {
    state: next,
    activeKind: activeGestureKind(next, event.timeStamp, thresholds),
    completedKind: null,
  };
}

function updatePointAndDistance(
  state: GestureState,
  event: GesturePointerEvent,
): GestureState {
  const points = state.points.map((point) =>
    point.pointerId === event.pointerId ? pointFromEvent(event) : point,
  );
  const primary = points.find((point) => point.pointerId === state.primaryId);
  const distance = primary
    ? Math.hypot(primary.clientX - state.startX, primary.clientY - state.startY)
    : state.maxDistancePx;
  return {
    ...state,
    points,
    lastEventAt: event.timeStamp,
    maxDistancePx: Math.max(state.maxDistancePx, distance),
  };
}

function classifyCompletedGesture(
  state: GestureState,
  endedAt: number,
  thresholds: GestureThresholds,
): GestureKind {
  return activeGestureKind(state, endedAt, thresholds) ?? "drag";
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

function pointFromEvent(event: GesturePointerEvent): GesturePoint {
  return {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
  };
}
