/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWallFullscreen, FULLSCREEN_ROOT_CLASS } from "./wall-fullscreen";
import { createWallScope } from "./wall-scope";

function setup() {
  document.body.innerHTML = `
    <div class="wall-page">
      <div id="board-focus" tabindex="0"></div>
      <button id="fs"></button>
      <button id="panel"></button>
      <div class="buy-credits-sheet" hidden></div>
    </div>`;
  const page = document.querySelector<HTMLElement>(".wall-page")!;
  const toggleButton = document.querySelector<HTMLButtonElement>("#fs")!;
  const panelButton = document.querySelector<HTMLButtonElement>("#panel")!;
  const scope = createWallScope();
  const changes: boolean[] = [];
  const fullscreen = createWallFullscreen({
    scope,
    page,
    toggleButton,
    panelButton,
    focusTarget: document.querySelector<HTMLElement>("#board-focus")!,
    onChange: (active) => changes.push(active),
  });
  return { page, toggleButton, panelButton, scope, fullscreen, changes };
}

const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("createWallFullscreen", () => {
  beforeEach(() => {
    document.documentElement.classList.remove(FULLSCREEN_ROOT_CLASS);
  });

  it("starts as the normal page, with the panel button hidden", () => {
    const { page, toggleButton, panelButton } = setup();
    expect(page.dataset.fullscreen).toBe("false");
    expect(toggleButton.getAttribute("aria-pressed")).toBe("false");
    expect(toggleButton.getAttribute("aria-label")).toBe("Full screen");
    expect(panelButton.hidden).toBe(true);
    expect(document.documentElement.classList.contains(FULLSCREEN_ROOT_CLASS)).toBe(false);
  });

  it("the button enters full screen, locks page scroll and focuses the wall", () => {
    const { page, toggleButton, panelButton, changes } = setup();
    toggleButton.click();
    expect(page.dataset.fullscreen).toBe("true");
    expect(document.documentElement.classList.contains(FULLSCREEN_ROOT_CLASS)).toBe(true);
    expect(toggleButton.getAttribute("aria-pressed")).toBe("true");
    expect(toggleButton.getAttribute("aria-label")).toContain("Exit full screen");
    expect(panelButton.hidden).toBe(false);
    expect(document.activeElement?.id).toBe("board-focus");
    expect(changes).toEqual([true]);
  });

  it("the button again, or Escape, leaves and restores the scroll position", () => {
    const { page, toggleButton, fullscreen, changes } = setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "scrollY", { value: 420, configurable: true });
    toggleButton.click();
    escape();
    expect(page.dataset.fullscreen).toBe("false");
    expect(document.documentElement.classList.contains(FULLSCREEN_ROOT_CLASS)).toBe(false);
    expect(scrollTo).toHaveBeenCalledWith(expect.any(Number), 420);
    fullscreen.enter();
    toggleButton.click();
    expect(fullscreen.active()).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    scrollTo.mockRestore();
  });

  it("Escape with the buy-credits sheet open closes the sheet only", () => {
    const { page, fullscreen } = setup();
    fullscreen.enter();
    page.querySelector<HTMLElement>(".buy-credits-sheet")!.hidden = false;
    escape();
    expect(fullscreen.active()).toBe(true);
  });

  it("the panel button hides and shows the panel", () => {
    const { page, panelButton } = setup();
    expect(page.dataset.panel).toBe("open");
    panelButton.click();
    expect(page.dataset.panel).toBe("closed");
    expect(panelButton.getAttribute("aria-expanded")).toBe("false");
    panelButton.click();
    expect(page.dataset.panel).toBe("open");
  });

  it("dispose while in full screen gives the page its scroll back", () => {
    const { scope, fullscreen } = setup();
    fullscreen.enter();
    scope.markDisposed();
    scope.runCleanups();
    expect(document.documentElement.classList.contains(FULLSCREEN_ROOT_CLASS)).toBe(false);
    escape();
  });
});
