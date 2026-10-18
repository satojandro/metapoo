export const WALL_HINT_STORAGE_KEY = "metapoo.wallHint.dismissed.v1";

type HintStorage = Pick<Storage, "getItem" | "setItem">;

// A Set also tolerates DOM shims that expose an unavailable storage sentinel
// instead of a real object; the set is naturally reset on the next page load.
const unavailableStorageDismissals = new Set<HintStorage>();
let noStorageDismissed = false;

export interface WallHint {
  selectionSucceeded: () => void;
  dispose: () => void;
}

function defaultStorage(): HintStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function wasDismissed(storage: HintStorage | null): boolean {
  if (storage === null) {
    return noStorageDismissed;
  }
  if (unavailableStorageDismissals.has(storage)) {
    return true;
  }
  try {
    return storage.getItem(WALL_HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissal(storage: HintStorage | null): void {
  if (storage === null) {
    noStorageDismissed = true;
    return;
  }
  try {
    storage.setItem(WALL_HINT_STORAGE_KEY, "1");
  } catch {
    // Storage can be unavailable in private or restricted contexts. The
    // in-memory marker still keeps the hint dismissed for this page load.
    unavailableStorageDismissals.add(storage);
  }
}

/** Mount the first-visit guide. The returned lifecycle is safe when hidden. */
export function mountWallHint(
  host: HTMLElement,
  storage: HintStorage | null = defaultStorage(),
): WallHint {
  if (wasDismissed(storage)) {
    return {
      selectionSucceeded: () => undefined,
      dispose: () => undefined,
    };
  }

  const hint = document.createElement("aside");
  hint.className = "wall-hint";
  hint.setAttribute("aria-label", "How to paint");
  hint.style.pointerEvents = "none";

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "wall-hint-dismiss";
  dismissButton.setAttribute("aria-label", "Dismiss hint");
  dismissButton.style.pointerEvents = "auto";
  dismissButton.textContent = "×";

  const title = document.createElement("strong");
  title.textContent = "Paint the wall";

  const steps = [
    "Tap a cell to select it",
    "Pick a color, then press Place",
    "Pinch or scroll to zoom — drag to pan",
  ];
  const list = document.createElement("ol");
  for (const step of steps) {
    const item = document.createElement("li");
    item.textContent = step;
    list.append(item);
  }

  const rule = document.createElement("p");
  rule.className = "wall-hint-rule";
  rule.textContent = "Open wall: anyone can paint over any cell.";

  hint.append(dismissButton, title, list, rule);
  host.append(hint);

  let active = true;
  const dismissPermanently = (): void => {
    if (!active) return;
    active = false;
    rememberDismissal(storage);
    dismissButton.removeEventListener("click", dismissPermanently);
    hint.remove();
  };
  dismissButton.addEventListener("click", dismissPermanently);

  return {
    selectionSucceeded: dismissPermanently,
    dispose: () => {
      if (!active) return;
      active = false;
      dismissButton.removeEventListener("click", dismissPermanently);
      hint.remove();
    },
  };
}
