/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountWallHint, WALL_HINT_STORAGE_KEY } from "./wall-hint";

function storageWith(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}

describe("mountWallHint", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders the honest core loop only when the dismissal flag is absent", () => {
    const host = document.createElement("div");
    const storage = storageWith();
    document.body.append(host);

    mountWallHint(host, storage);

    const hint = host.querySelector<HTMLElement>(".wall-hint")!;
    expect(hint).not.toBeNull();
    expect([...hint.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Tap a cell to select it",
      "Pick a color, then press Place",
      "Pinch or scroll to zoom — drag to pan",
    ]);
    expect(hint.textContent).toContain("Open wall: anyone can paint over any cell.");
    expect(hint.textContent).not.toMatch(/payment|token|session/i);
    expect(hint.style.pointerEvents).toBe("none");
    expect(
      hint.querySelector<HTMLButtonElement>('[aria-label="Dismiss hint"]')?.style
        .pointerEvents,
    ).toBe("auto");

    const dismissedHost = document.createElement("div");
    mountWallHint(dismissedHost, storageWith("1"));
    expect(dismissedHost.childElementCount).toBe(0);
  });

  it("persists and removes the hint when its dismiss button is pressed", () => {
    const host = document.createElement("div");
    const storage = storageWith();
    document.body.append(host);
    mountWallHint(host, storage);

    host.querySelector<HTMLButtonElement>('[aria-label="Dismiss hint"]')!.click();

    expect(storage.setItem).toHaveBeenCalledWith(WALL_HINT_STORAGE_KEY, "1");
    expect(host.querySelector(".wall-hint")).toBeNull();
  });

  it("persists and removes the hint after the first successful selection", () => {
    const host = document.createElement("div");
    const storage = storageWith();
    document.body.append(host);
    const mounted = mountWallHint(host, storage);

    mounted.selectionSucceeded();
    mounted.selectionSucceeded();

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(WALL_HINT_STORAGE_KEY, "1");
    expect(host.querySelector(".wall-hint")).toBeNull();
  });

  it("shows once for the page load when localStorage access fails", () => {
    const host = document.createElement("div");
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
    };
    document.body.append(host);
    const mounted = mountWallHint(host, storage);

    expect(host.querySelector(".wall-hint")).not.toBeNull();
    expect(() => mounted.selectionSucceeded()).not.toThrow();
    expect(host.querySelector(".wall-hint")).toBeNull();

    const remountedHost = document.createElement("div");
    mountWallHint(remountedHost, storage);
    expect(remountedHost.childElementCount).toBe(0);
  });

  it("dispose removes the node and listener without marking it dismissed", () => {
    const host = document.createElement("div");
    const storage = storageWith();
    document.body.append(host);
    const mounted = mountWallHint(host, storage);
    const button = host.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss hint"]',
    )!;

    mounted.dispose();
    button.click();

    expect(host.querySelector(".wall-hint")).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
