/**
 * "Your tiles" (wall journey phase 3, owner 7 Nov): a reason to come back.
 *
 * Signed in, under the wall: how many tiles you hold, a way to see them, the TOILET
 * claim (the same panel as the wallet menu and /toilet), and, above them, a "While you
 * were away" card when someone covered your tiles (spec AWAY-A, §1.2).
 *
 * The card has two sources, and it never shows a number neither can back:
 *
 * 1. **The board server** (`VITE_BOARD_SERVER_URL`), which keeps cover events per account:
 *    `GET /api/account-covers?account=…&since_ms=…`. When it answers, its numbers are the
 *    card's, and nothing else is shown — not even while it is being asked.
 * 2. **This browser's memory**, used only when there is no server or it did not answer:
 *    the tiles this browser saw you hold are kept in localStorage per board and account,
 *    and compared with the wall the next time. A tile covered and won back in between is
 *    not counted, and the card says so.
 *
 * "Since" for the server is the later of 30 days ago (the server's retention) and the last
 * time this browser *showed* this account its summary (`VisitStore`). It advances to the
 * moment the server was asked, and only once the summary has been seen: the server said
 * nothing was covered, or the card was on screen for a moment, or the player used or
 * dismissed it. A reload before then shows the same card again instead of losing it.
 */

import type { PixelView } from "@shared/types.ts";
import type { AccountCovers, ReadAccountCovers } from "../../board-server/account-covers";
import { shortAccount } from "../../shared/short-account";
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

/** "{lead}, 14 of your tiles were covered, 9 by x.near." Account ids are shortened. */
export function awayLine(lead: string, count: number, top: { account: string; tiles: number } | null): string {
  const tiles = `${count.toLocaleString("en-US")} of your tiles ${count === 1 ? "was" : "were"}`;
  const who = top
    ? top.tiles === count
      ? `, all by ${shortAccount(top.account)}`
      : `, ${top.tiles.toLocaleString("en-US")} by ${shortAccount(top.account)}`
    : "";
  return `${lead}, ${tiles} covered${who}.`;
}

/** This browser's comparison as a line, or null when there is nothing to say. */
export function coveredLine(result: CoveredSince | null): string | null {
  if (!result || result.count === 0) return null;
  return awayLine("Since you last looked", result.count, result.top);
}

/** The server's answer as a line, or null when nothing was covered. */
export function serverCoveredLine(covers: AccountCovers, capped: boolean): string | null {
  if (covers.count === 0) return null;
  return awayLine(capped ? "In the last 30 days" : "Since your last visit", covers.count, covers.by[0] ?? null);
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

/** When this browser last showed `account` its "While you were away" summary (ms). */
export interface VisitStore {
  read(board: string, account: string): number | null;
  write(board: string, account: string, atMs: number): void;
}

const visitKey = (board: string, account: string) => `metapoo:away-seen:v1:${board}:${account}`;

export function localVisitStore(storage: () => Storage | null = () => window.localStorage): VisitStore {
  return {
    read(board, account) {
      try {
        const raw = storage()?.getItem(visitKey(board, account));
        if (!raw || !/^\d{1,16}$/.test(raw)) return null;
        return Number(raw);
      } catch {
        return null;
      }
    },
    write(board, account, atMs) {
      try {
        storage()?.setItem(visitKey(board, account), String(Math.floor(atMs)));
      } catch {
        // Blocked storage: the next visit asks from 30 days ago again. Not an error.
      }
    },
  };
}

/** The server keeps 30 days of cover events; "since" never reaches further back. */
export const AWAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The server's "since" for this visit: the later of the last seen summary and 30 days ago. */
export function awaySince(lastSeenMs: number | null, nowMs: number): { sinceMs: number; capped: boolean } {
  const floor = Math.max(0, nowMs - AWAY_WINDOW_MS);
  // A stored time in the future is a clock change or junk: it cannot back "since".
  if (lastSeenMs === null || lastSeenMs <= floor || lastSeenMs > nowMs) return { sinceMs: floor, capped: true };
  return { sinceMs: lastSeenMs, capped: false };
}

/** How long the card must be half on screen before it counts as read. */
export const AWAY_SEEN_DWELL_MS = 1_500;

/**
 * Call `onSeen` once `el` has been at least half visible for `dwellMs`. Without
 * IntersectionObserver nothing counts as seen; using or dismissing the card still does.
 */
export function observeSeen(el: HTMLElement, onSeen: () => void, dwellMs = AWAY_SEEN_DWELL_MS): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5);
      if (visible && timer === null) {
        timer = setTimeout(() => {
          observer.disconnect();
          onSeen();
        }, dwellMs);
      } else if (!visible && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    { threshold: [0, 0.5] },
  );
  observer.observe(el);
  return () => {
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
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
  /** The board server's cover history; null when `VITE_BOARD_SERVER_URL` is unset. */
  readCovers: ReadAccountCovers | null;
  visits: VisitStore;
  now(): number;
  /** Report once the card has been read; returns a stop. Defaults to `observeSeen`. */
  watchSeen?(el: HTMLElement, onSeen: () => void): () => void;
  /** Mount the TOILET claim panel into `host`; returns its dispose. */
  mountClaim(host: HTMLElement): () => void;
  showMine(): void;
  flyTo(cell: Cell): void;
  /** Open the paint flow on a tile, as the Tile card's "Paint over this" does. */
  paintBack(cell: Cell): void;
}

export interface WallYours {
  render(): void;
}

/** What the card shows, decided from both sources. Null: no card. */
export interface AwayCard {
  source: "server" | "browser";
  line: string;
  first: Cell | null;
}

export type AwayServerState =
  | { status: "none" }
  | { status: "pending"; capped: boolean }
  | { status: "answered"; capped: boolean; covers: AccountCovers }
  | { status: "unavailable" };

/**
 * The server's answer wins whenever there is one, including "nothing covered". While it is
 * being asked, nothing is shown: a browser number replaced a second later by a different
 * server number would be a number the page could not back.
 */
export function chooseAwayCard(server: AwayServerState, browser: CoveredSince | null): AwayCard | null {
  if (server.status === "pending") return null;
  if (server.status === "answered") {
    const line = serverCoveredLine(server.covers, server.capped);
    return line ? { source: "server", line, first: server.covers.first } : null;
  }
  const line = coveredLine(browser);
  return line && browser ? { source: "browser", line, first: browser.first } : null;
}

export const AWAY_BROWSER_NOTE = "From this browser’s memory: a tile covered and won back in between is not counted.";

export function createWallYours(deps: WallYoursDeps): WallYours {
  const { scope, section, store } = deps;
  const q = (s: string) => section.querySelector<HTMLElement>(s);
  const countEl = q("[data-yours-tiles]");
  const card = q("[data-away]");
  const cardText = q("[data-away-text]");
  const cardNote = q("[data-away-note]");
  const showCovered = section.querySelector<HTMLButtonElement>("[data-away-show]");
  const paintBack = section.querySelector<HTMLButtonElement>("[data-away-paint]");
  const dismiss = section.querySelector<HTMLButtonElement>("[data-away-dismiss]");
  const showMine = section.querySelector<HTMLButtonElement>("[data-yours-show-mine]");
  const claimHost = q("[data-yours-claim]");
  const watchSeen = deps.watchSeen ?? observeSeen;

  /** The comparison is made once per account per visit, then kept for the page's life. */
  let comparedFor: string | null = null;
  let result: CoveredSince | null = null;
  let lastSaved = "";
  let claimDispose: (() => void) | null = null;

  /** The server is asked once per account per visit too. */
  let askedFor: string | null = null;
  let visitStartedMs = 0;
  let server: AwayServerState = { status: "none" };
  let dismissed = false;
  let acknowledged = false;
  let shown: AwayCard | null = null;
  let stopWatching: (() => void) | null = null;

  function stopWatch(): void {
    stopWatching?.();
    stopWatching = null;
  }

  /**
   * The summary was read, so the next visit asks from the moment this one started. Only an
   * empty server answer or a card that was actually on screen counts: a visit where neither
   * source could say anything leaves "since" where it was.
   */
  function acknowledge(): void {
    if (acknowledged || !askedFor) return;
    if (server.status !== "answered" && !shown) return;
    acknowledged = true;
    stopWatch();
    deps.visits.write(deps.board, askedFor, visitStartedMs);
  }

  function ask(viewer: string): void {
    askedFor = viewer;
    dismissed = false;
    acknowledged = false;
    shown = null;
    stopWatch();
    visitStartedMs = deps.now();
    if (!deps.readCovers) {
      server = { status: "unavailable" };
      return;
    }
    const { sinceMs, capped } = awaySince(deps.visits.read(deps.board, viewer), visitStartedMs);
    server = { status: "pending", capped };
    void deps.readCovers(viewer, sinceMs).then(
      (covers) => settle(viewer, covers === null ? { status: "unavailable" } : { status: "answered", capped, covers }),
      () => settle(viewer, { status: "unavailable" }),
    );
  }

  function settle(viewer: string, next: AwayServerState): void {
    // A late answer for an account that has since signed out (or switched) is dropped.
    if (scope.isDisposed() || askedFor !== viewer || server.status !== "pending") return;
    server = next;
    // Nothing covered is read the moment it is known: there is no card to wait for.
    if (next.status === "answered" && next.covers.count === 0) acknowledge();
    render();
  }

  if (showMine) scope.listen(showMine, "click", () => deps.showMine());
  if (showCovered) {
    scope.listen(showCovered, "click", () => {
      if (!shown?.first) return;
      acknowledge();
      deps.flyTo(shown.first);
    });
  }
  if (paintBack) {
    scope.listen(paintBack, "click", () => {
      if (!shown?.first) return;
      acknowledge();
      deps.paintBack(shown.first);
    });
  }
  if (dismiss) {
    scope.listen(dismiss, "click", () => {
      acknowledge();
      dismissed = true;
      render();
    });
  }
  scope.onDispose(() => {
    claimDispose?.();
    stopWatch();
  });

  function renderCard(): void {
    const next = dismissed ? null : chooseAwayCard(server, result);
    shown = next;
    if (!card) return;
    card.hidden = next === null;
    if (cardText) cardText.textContent = next?.line ?? "";
    if (cardNote) {
      cardNote.hidden = next?.source !== "browser";
      cardNote.textContent = next?.source === "browser" ? AWAY_BROWSER_NOTE : "";
    }
    card.dataset.source = next?.source ?? "";
    if (showCovered) showCovered.hidden = !next?.first;
    if (paintBack) paintBack.hidden = !next?.first;
    if (!next) stopWatch();
    else if (!acknowledged && !stopWatching) stopWatching = watchSeen(card, acknowledge);
  }

  function render(): void {
    if (scope.isDisposed()) return;
    const viewer = deps.viewer();
    section.hidden = viewer === null;
    if (!viewer) {
      comparedFor = null;
      result = null;
      lastSaved = "";
      askedFor = null;
      server = { status: "none" };
      renderCard();
      return;
    }
    if (!claimDispose && claimHost) claimDispose = deps.mountClaim(claimHost);
    // The server needs no wall read, so it is asked straight away.
    if (askedFor !== viewer) ask(viewer);
    if (!deps.loaded()) {
      renderCard();
      return;
    }

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
    renderCard();
  }

  render();
  return { render };
}

