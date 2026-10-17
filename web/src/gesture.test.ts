import { describe, expect, it } from "vitest";
import {
  createGestureState,
  updateGesture,
  type GesturePointerEvent,
  type GestureState,
} from "./gesture";

function pointer(
  type: GesturePointerEvent["type"],
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
  beganOnPanSurface = false,
): GesturePointerEvent {
  return { type, pointerId, clientX, clientY, timeStamp, beganOnPanSurface };
}

function apply(
  events: readonly GesturePointerEvent[],
): ReturnType<typeof updateGesture> {
  let state: GestureState = createGestureState();
  let result = updateGesture(state, events[0]);
  state = result.state;
  for (const event of events.slice(1)) {
    result = updateGesture(state, event);
    state = result.state;
  }
  return result;
}

describe("pointer gesture classification", () => {
  it("classifies a short, stationary single-pointer action as a tap", () => {
    const result = apply([
      pointer("pointerdown", 1, 20, 30, 100),
      pointer("pointermove", 1, 24, 33, 180),
      pointer("pointerup", 1, 24, 33, 220),
    ]);

    expect(result.completedKind).toBe("tap");
  });

  it("classifies threshold movement as a drag even when release returns", () => {
    const result = apply([
      pointer("pointerdown", 1, 20, 30, 100),
      pointer("pointermove", 1, 29, 30, 140),
      pointer("pointerup", 1, 20, 30, 180),
    ]);

    expect(result.completedKind).toBe("drag");
  });

  it("uses the release position when no move event was delivered", () => {
    const result = apply([
      pointer("pointerdown", 1, 20, 30, 100),
      pointer("pointerup", 1, 40, 30, 150),
    ]);

    expect(result.completedKind).toBe("drag");
  });

  it("classifies a long stationary press as a drag, never a tap", () => {
    const result = apply([
      pointer("pointerdown", 1, 20, 30, 100),
      pointer("pointerup", 1, 20, 30, 601),
    ]);

    expect(result.completedKind).toBe("drag");
  });

  it("classifies any gesture that used multiple pointers as a pinch", () => {
    const result = apply([
      pointer("pointerdown", 1, 20, 30, 100),
      pointer("pointerdown", 2, 40, 30, 110),
      pointer("pointerup", 2, 40, 30, 130),
      pointer("pointerup", 1, 20, 30, 140),
    ]);

    expect(result.completedKind).toBe("pinch");
  });

  it("classifies starts on the non-paintable pan surface as pan", () => {
    const result = apply([
      pointer("pointerdown", 1, 2, 2, 100, true),
      pointer("pointerup", 1, 2, 2, 140),
    ]);

    expect(result.completedKind).toBe("pan");
  });

  it("never turns pointer cancellation into a tap", () => {
    const result = apply([
      pointer("pointerdown", 1, 20, 30, 100),
      pointer("pointercancel", 1, 20, 30, 110),
    ]);

    expect(result.completedKind).toBe("drag");
  });
});
