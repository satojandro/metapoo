/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountWallZoomControls,
  type WallZoomControlsHost,
  type WallZoomState,
} from "./wall-zoom-controls";

function createHost(initial: WallZoomState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const host: WallZoomControlsHost = {
    getCurrentZoom: () => state,
    zoomBy: vi.fn((factor: number) => {
      state = {
        ...state,
        current: Math.min(state.maximum, Math.max(state.minimum, state.current * factor)),
        fitted: false,
      };
      notify();
    }),
    zoomToFit: vi.fn(() => {
      state = { ...state, current: 3, fitted: true };
      notify();
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    host,
    listeners,
    setState: (next: WallZoomState) => {
      state = next;
      notify();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("mountWallZoomControls", () => {
  it("creates accessible buttons and exposes no placement callback to the module", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const { host } = createHost({ current: 3, minimum: 0.25, maximum: 48, fit: 0.25, fitted: true });

    const dispose = mountWallZoomControls(container, host);

    expect(Object.keys(host).sort()).toEqual([
      "getCurrentZoom",
      "subscribe",
      "zoomBy",
      "zoomToFit",
    ]);
    for (const label of ["Zoom in", "Zoom out", "Fit wall to view"]) {
      const button = container.querySelector(`[aria-label="${label}"]`);
      expect(button).toBeInstanceOf(HTMLButtonElement);
    }
    dispose();
  });

  it("clamps zoom requests and disables controls at both limits and at fit", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const fixture = createHost({ current: 47, minimum: 0.25, maximum: 48, fit: 0.25, fitted: false });
    const dispose = mountWallZoomControls(container, fixture.host);
    const zoomIn = container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
    const zoomOut = container.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!;
    const fit = container.querySelector<HTMLButtonElement>('[aria-label="Fit wall to view"]')!;

    zoomIn.click();
    expect(fixture.host.zoomBy).toHaveBeenLastCalledWith(48 / 47);
    expect(zoomIn.disabled).toBe(true);

    fixture.setState({ current: 0.26, minimum: 0.25, maximum: 48, fit: 0.25, fitted: false });
    zoomOut.click();
    expect(fixture.host.zoomBy).toHaveBeenLastCalledWith(0.25 / 0.26);
    expect(zoomOut.disabled).toBe(true);

    expect(fit.disabled).toBe(false);
    fit.click();
    expect(fixture.host.zoomToFit).toHaveBeenCalledOnce();
    expect(fit.disabled).toBe(true);
    dispose();
  });

  it("stops control input before it reaches an enclosing canvas interaction path", () => {
    const canvasPath = document.createElement("div");
    const container = document.createElement("div");
    canvasPath.append(container);
    document.body.append(canvasPath);
    const seen = vi.fn();
    for (const eventType of ["pointerdown", "pointerup", "wheel", "beforeinput", "input", "keydown"]) {
      canvasPath.addEventListener(eventType, seen);
    }
    const { host } = createHost({ current: 3, minimum: 0.25, maximum: 48, fit: 0.25, fitted: false });
    const dispose = mountWallZoomControls(container, host);
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;

    for (const eventType of ["pointerdown", "pointerup", "wheel", "beforeinput", "input", "keydown"]) {
      button.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
    }

    expect(seen).not.toHaveBeenCalled();
    dispose();
  });

  it("disposal unsubscribes, removes listeners, and removes its nodes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const fixture = createHost({ current: 3, minimum: 0.25, maximum: 48, fit: 0.25, fitted: false });
    const dispose = mountWallZoomControls(container, fixture.host);
    const detachedZoomIn = container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;

    expect(fixture.listeners.size).toBe(1);
    dispose();
    dispose();

    expect(fixture.listeners.size).toBe(0);
    expect(container.childElementCount).toBe(0);
    detachedZoomIn.click();
    expect(fixture.host.zoomBy).not.toHaveBeenCalled();
  });

  it("shows how zoomed the wall is, with 100% meaning the whole board fits", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const fixture = createHost({ current: 3, minimum: 3, maximum: 48, fit: 3, fitted: true });
    mountWallZoomControls(container, fixture.host);

    const level = () => container.querySelector("#zoom-level")!.textContent;
    expect(level()).toBe("100%");

    // Double the fitted cell size: twice as big as "everything visible".
    fixture.setState({ current: 6, minimum: 3, maximum: 48, fit: 3, fitted: false });
    expect(level()).toBe("200%");

    fixture.setState({ current: 48, minimum: 3, maximum: 48, fit: 3, fitted: false });
    expect(level()).toBe("1600%");
  });
});
