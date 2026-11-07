/**
 * "Your tiles" (wall journey phase 3, owner 7 Nov): a reason to come back.
 *
 * Signed in, under the wall: how many tiles you hold, a way to see them, the TOILET
 * claim (the same panel as the wallet menu and /toilet), and what happened to your
 * tiles since you last looked.
 *
 * "Since you last looked" is this browser's memory, not chain history: the tiles this
 * browser saw you hold are kept in localStorage per board and account, and compared
 * with the wall the next time. A tile covered and won back in between is not counted.
 * The copy says so. Storage that is blocked or empty simply means nothing to compare.
 */

import type { PixelView } from "@shared/types.ts";
import type { WallScope } from "./wall-scope";

export interface Cell {
  x: number;
  y: number;
}

const key = (x: number, y: number) => `${x}.${y}`;

/** The tiles `viewer` holds now, as "x.y" keys, sorted so the stored value is stable. */
export function heldKeys(pixels: readonly PixelView[], viewer: string): string[] {
  const out: string[] = [];
  for (const p of pixels) {
    if (p.colorIndex !== null && p.artistAccountId === viewer) out.push(key(p.x, p.y));
  }
  return out.sort();
}

export interface CoveredSince {
  /** Your tiles last time that someone else holds now. */
  count: number;
  /** Who covered the most of them. */
  top: { account: string; tiles: number } | null;
  /** One of the top coverer's tiles, to show on the wall. */
  first: Cell | null;
}

export function coveredSince(previous: readonly string[], pixels: readonly PixelView[], viewer: string): CoveredSince {
  const now = new Map<string, PixelView>();
  for (const p of pixels) now.set(key(p.x, p.y), p);
  const by = new Map<string, { tiles: number; first: Cell }>();
  let count = 0;
  for (const k of previous) {
    const p = now.get(k);
    // A tile only "covered" when someone else's paint is on it now. Missing from the
    // cache (not loaded, or the wall shrank) is not evidence of anything.
    if (!p || p.colorIndex === null || !p.artistAccountId || p.artistAccountId === viewer) continue;
    count += 1;
    const entry = by.get(p.artistAccountId);
    if (entry) entry.tiles += 1;
    else by.set(p.artistAccountId, { tiles: 1, first: { x: p.x, y: p.y } });
  }
  let top: CoveredSince["top"] = null;
  let first: Cell | null = null;
  for (const [account, entry] of by) {
    if (!top || entry.tiles > top.tiles || (entry.tiles === top.tiles && account < top.account)) {
      top = { account, tiles: entry.tiles };
      first = entry.first;
    }
  }
  return { count, top, first };
}

export function coveredLine(result: CoveredSince | null): string | null {
  if (!result) return null;
  if (result.count === 0) return "None of your tiles were painted over since you last looked.";
  const tiles = `${result.count.toLocaleString("en-US")} of your tiles ${result.count === 1 ? "was" : "were"}`;
  const who = result.top
    ? result.top.tiles === result.count
      ? `, all by ${result.top.account}`
      : `, ${result.top.tiles.toLocaleString("en-US")} by ${result.top.account}`
    : "";
  return `Since you last looked, ${tiles} painted over${who}.`;
}

/* ---------- Storage (this browser only) ---------- */

export interface HeldStore {
  read(board: string, account: string): string[] | null;
  write(board: string, account: string, keys: readonly string[]): void;
}

const storageKey = (board: string, account: string) => `metapoo:held:v1:${board}:${account}`;

export function localHeldStore(storage: () => Storage | null = () => window.localStorage): HeldStore {
  return {
    read(board, account) {
      try {
        const raw = storage()?.getItem(storageKey(board, account));
        if (raw === null || raw === undefined) return null;
        return raw === "" ? [] : raw.split(";").filter((k) => /^\d{1,3}\.\d{1,3}$/.test(k));
      } catch {
        return null;
      }
    },
    write(board, account, keys) {
      try {
        storage()?.setItem(storageKey(board, account), keys.join(";"));
      } catch {
        // Blocked or full storage: next visit has nothing to compare. Not an error.
      }
    },
  };
}

/* ---------- DOM ---------- */

export interface WallYoursDeps {
  scope: WallScope;
  section: HTMLElement;
  board: string;
  pixels(): readonly PixelView[];
  /** True once the whole wall has been read: a half-read wall must not look like covered tiles. */
  loaded(): boolean;
  viewer(): string | null;
  store: HeldStore;
  /** Mount the TOILET claim panel into `host`; returns its dispose. */
  mountClaim(host: HTMLElement): () => void;
  showMine(): void;
  flyTo(cell: Cell): void;
}

export interface WallYours {
  render(): void;
}

export function createWallYours(deps: WallYoursDeps): WallYours {
  const { scope, section, store } = deps;
  const q = (s: string) => section.querySelector<HTMLElement>(s);
  const countEl = q("[data-yours-tiles]");
  const covered = q("[data-yours-covered]");
  const coveredText = q("[data-yours-covered-text]");
  const showCovered = section.querySelector<HTMLButtonElement>("[data-yours-show-covered]");
  const showMine = section.querySelector<HTMLButtonElement>("[data-yours-show-mine]");
  const claimHost = q("[data-yours-claim]");

  /** The comparison is made once per account per visit, then kept for the page's life. */
  let comparedFor: string | null = null;
  let result: CoveredSince | null = null;
  let lastSaved = "";
  let claimDispose: (() => void) | null = null;

  if (showMine) scope.listen(showMine, "click", () => deps.showMine());
  if (showCovered) {
    scope.listen(showCovered, "click", () => {
      if (result?.first) deps.flyTo(result.first);
    });
  }
  scope.onDispose(() => claimDispose?.());

  function render(): void {
    if (scope.isDisposed()) return;
    const viewer = deps.viewer();
    section.hidden = viewer === null;
    if (!viewer) {
      comparedFor = null;
      result = null;
      lastSaved = "";
      return;
    }
    if (!claimDispose && claimHost) claimDispose = deps.mountClaim(claimHost);
    if (!deps.loaded()) return;

    const pixels = deps.pixels();
    const held = heldKeys(pixels, viewer);
    if (comparedFor !== viewer) {
      comparedFor = viewer;
      const previous = store.read(deps.board, viewer);
      result = previous === null ? null : coveredSince(previous, pixels, viewer);
    }
    // Remember what this browser saw, for the next visit.
    const signature = held.join(";");
    if (signature !== lastSaved) {
      lastSaved = signature;
      store.write(deps.board, viewer, held);
    }

    if (countEl) countEl.textContent = held.length.toLocaleString("en-US");
    if (showMine) showMine.hidden = held.length === 0;
    const line = coveredLine(result);
    if (covered && coveredText) {
      covered.hidden = line === null;
      coveredText.textContent = line ?? "";
      covered.dataset.tone = result && result.count > 0 ? "covered" : "calm";
    }
    if (showCovered) showCovered.hidden = !result?.first;
  }

  render();
  return { render };
}
