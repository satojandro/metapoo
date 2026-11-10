import type { WallScope } from "./wall-scope";

/**
 * Full-screen wall: one button that lets the wall take the whole window, on top of
 * the normal page rather than instead of it (owner, 7 Nov: "Full window is an extra
 * feature, not a new direction"; docs/learning/2026-11-07-wall-journey.md).
 *
 * The mode is a `data-fullscreen` attribute on the wall page plus a class on <html>
 * that stops the page behind it scrolling. Everything else is CSS: the wall fills the
 * window, the panel floats over it (and can be hidden), and the minimap shows. The
 * camera is untouched: its ResizeObserver already re-clamps when the viewport grows.
 *
 * It is a full-*window* mode, not the browser Fullscreen API: a fullscreened element
 * hides everything outside it, including the wallet's sign-in popup, which is mounted
 * on <body>. Leaving the mode puts the page back where it was scrolled to.
 */

export const FULLSCREEN_ROOT_CLASS = "wall-fullscreen-open";

export interface WallFullscreenDeps {
  scope: WallScope;
  /** The `.wall-page` element; carries `data-fullscreen` and `data-panel`. */
  page: HTMLElement;
  /** Enters and leaves the mode. */
  toggleButton: HTMLButtonElement;
  /** Shows or hides the floating panel; only visible in the mode. */
  panelButton: HTMLButtonElement;
  /** Where focus goes on entering, so keyboard users land on the wall. */
  focusTarget?: HTMLElement;
  onChange?(active: boolean): void;
}

export interface WallFullscreen {
  active(): boolean;
  enter(): void;
  exit(): void;
  toggle(): void;
  panelOpen(): boolean;
  setPanelOpen(open: boolean): void;
}

const ENTER_LABEL = "Full screen";
const EXIT_LABEL = "Exit full screen";

export function createWallFullscreen(deps: WallFullscreenDeps): WallFullscreen {
  const { scope, page, toggleButton, panelButton } = deps;
  const root = page.ownerDocument.documentElement;
  const win = page.ownerDocument.defaultView;
  let active = false;
  let panelOpen = true;
  let savedScroll: { x: number; y: number } | null = null;

  function syncButtons(): void {
    toggleButton.setAttribute("aria-pressed", String(active));
    toggleButton.setAttribute("aria-label", active ? `${EXIT_LABEL} (Esc)` : ENTER_LABEL);
    toggleButton.title = active ? `${EXIT_LABEL} (Esc)` : ENTER_LABEL;
    toggleButton.dataset.state = active ? "on" : "off";
    panelButton.hidden = !active;
    panelButton.setAttribute("aria-expanded", String(panelOpen));
    panelButton.textContent = panelOpen ? "Hide panel" : "Panel";
  }

  function apply(): void {
    page.dataset.fullscreen = String(active);
    page.dataset.panel = panelOpen ? "open" : "closed";
    root.classList.toggle(FULLSCREEN_ROOT_CLASS, active);
    syncButtons();
  }

  function enter(): void {
    if (active || scope.isDisposed()) return;
    savedScroll = win ? { x: win.scrollX, y: win.scrollY } : null;
    active = true;
    apply();
    deps.focusTarget?.focus({ preventScroll: true });
    deps.onChange?.(true);
  }

  function exit(): void {
    if (!active) return;
    active = false;
    apply();
    // Back where the page was, not at the top of it.
    if (savedScroll && win) win.scrollTo(savedScroll.x, savedScroll.y);
    savedScroll = null;
    if (!scope.isDisposed()) {
      toggleButton.focus({ preventScroll: true });
      deps.onChange?.(false);
    }
  }

  function setPanelOpen(open: boolean): void {
    if (panelOpen === open) return;
    panelOpen = open;
    apply();
  }

  scope.listen(toggleButton, "click", () => (active ? exit() : enter()));
  scope.listen(panelButton, "click", () => setPanelOpen(!panelOpen));

  // Capture phase, so an open dialog (the buy-credits sheet closes on Escape in the
  // bubble phase) is still open when this runs: Escape closes the dialog first, and
  // only a second Escape leaves full screen.
  if (win) {
    scope.listen(
      win,
      "keydown",
      (event) => {
        const key = event as KeyboardEvent;
        if (key.key !== "Escape" || !active || key.defaultPrevented) return;
        if (page.querySelector(".buy-credits-sheet:not([hidden])")) return;
        if (page.ownerDocument.querySelector("dialog[open]")) return;
        exit();
      },
      { capture: true },
    );
  }

  // Navigating away must never leave <html> unable to scroll.
  scope.onDispose(() => {
    active = false;
    root.classList.remove(FULLSCREEN_ROOT_CLASS);
  });

  apply();

  return {
    active: () => active,
    enter,
    exit,
    toggle: () => (active ? exit() : enter()),
    panelOpen: () => panelOpen,
    setPanelOpen,
  };
}
