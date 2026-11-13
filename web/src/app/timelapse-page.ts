/**
 * /timelapse — the wall replayed from its draw log (return/growth spec §4.3).
 *
 * The page reads the board server's log (`timelapse/history-client.ts`), compiles it
 * (`timelapse/timeline.ts`) and plays it on a canvas: a scrubber, play/pause, speed, the
 * date and block of the frame on screen, and "Share this moment", a link that opens at
 * that block (`/timelapse?block=N`).
 *
 * What it will not do is draw a wall it cannot back. With no board server configured, the
 * server down, or a log that does not decode, it says so and draws nothing. And when the log
 * does not start at the board's first paint (the server's backfill has not run), it says
 * where the recording starts instead of presenting a partial log as the whole story.
 *
 * It is not in the menu (owner, §4.4); the Hall of Fame links to it once it has data.
 */

import { BOARD_SERVER_URL } from "../config";
import type { PageContext, PageDispose } from "./page-registry";
import { createHistoryReader, type HistoryHead, type HistoryLog, type HistoryReader } from "../timelapse/history-client";
import { baseRate, createPlayer, type FrameScheduler, type Player } from "../timelapse/player";
import { createWallCanvas } from "../timelapse/render";
import { buildTimeline, createReplay, frameAt, positionAtBlock, type Timeline } from "../timelapse/timeline";
import "./timelapse.css";

export interface TimelapsePageDeps {
  /** Null when no board server is configured. */
  reader: HistoryReader | null;
  /** `prefers-reduced-motion: reduce`: open on the finished wall, paused. */
  reducedMotion: boolean;
  scheduler?: FrameScheduler;
  now?: () => number;
  /** Origin for shared links. */
  origin: string;
  copyText(text: string): Promise<void>;
}

export const SPEEDS = [0.5, 1, 2, 4] as const;

const TEMPLATE = `
<article class="tl" aria-labelledby="tl-title">
  <header class="tl-head">
    <h2 id="tl-title" data-route-heading="true">Watch the wall fill.</h2>
    <p class="tl-lede">Every tile anyone has painted, in the order the chain recorded it.</p>
  </header>

  <section class="tl-state" data-tl-state role="status"></section>

  <div class="tl-player" data-tl-player hidden>
    <div class="tl-stage">
      <canvas class="tl-canvas" data-tl-canvas role="img" aria-label="The wall at the moment shown below"></canvas>
    </div>

    <div class="tl-side">
      <dl class="tl-now">
        <div class="tl-when"><dt class="visually-hidden">Date</dt><dd data-tl-date></dd></div>
        <div><dt>Block</dt><dd data-tl-block></dd></div>
        <div><dt>Paints so far</dt><dd data-tl-count></dd></div>
        <div><dt>Wall size</dt><dd data-tl-size></dd></div>
      </dl>
      <p class="tl-start" data-tl-start></p>
      <div class="tl-share">
        <button type="button" class="mp-btn" data-tl-share>Share this moment</button>
        <p class="tl-share-status" data-tl-share-status role="status"></p>
        <input class="tl-share-url" data-tl-share-url type="text" readonly hidden aria-label="Link to this moment">
      </div>
    </div>

    <div class="tl-transport">
      <button type="button" class="mp-btn mp-btn-primary tl-play" data-tl-play aria-pressed="false">Play</button>
      <div class="tl-scrub">
        <div class="tl-days" data-tl-days aria-hidden="true"></div>
        <input class="tl-range" data-tl-range type="range" min="0" step="1" value="0" aria-label="Moment in the wall's history">
        <div class="tl-day-labels" data-tl-day-labels aria-hidden="true"></div>
      </div>
      <div class="tl-speeds" role="group" aria-label="Speed" data-tl-speeds></div>
    </div>
  </div>
</article>`;

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const DAY_MS = 86_400_000;

export function formatMoment(atMs: number): string {
  return `${DATE.format(atMs)}, ${TIME.format(atMs)} UTC`;
}

const count = (n: number) => n.toLocaleString("en-US");

export interface DaySegment {
  /** UTC midnight that starts the day. */
  dayMs: number;
  /** First position painted that day, and one past the last. */
  start: number;
  end: number;
}

/** The log cut into UTC days: the scrubber's ruler. A busy day is a wide segment. */
export function daySegments(timeline: Timeline): DaySegment[] {
  const days: DaySegment[] = [];
  timeline.frames.forEach((frame, i) => {
    const dayMs = Math.floor(frame.atMs / DAY_MS) * DAY_MS;
    const end = timeline.frames[i + 1]?.start ?? timeline.length;
    const last = days.at(-1);
    // Times can step back a few milliseconds between blocks; never open an earlier day.
    if (last && dayMs <= last.dayMs) last.end = end;
    else days.push({ dayMs, start: frame.start, end });
  });
  return days;
}

/** `?block=` as a block height, or null for anything that is not one. */
export function parseBlockParam(value: string | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

export function shareHref(origin: string, block: number): string {
  return `${origin.replace(/\/+$/, "")}/timelapse?block=${block}`;
}

/** Where the recording starts, in the page's words. Null for an empty log. */
export function startNotice(head: HistoryHead): { partial: boolean; text: string } | null {
  if (!head.first) return null;
  if (head.complete && head.startBlock !== null) {
    return { partial: false, text: `The whole story: every paint since the board went live at block ${count(head.startBlock)}.` };
  }
  return {
    partial: true,
    text: `This recording starts on ${formatMoment(head.first.atMs)} (block ${count(head.first.block)}). Paint from before then is not in it yet, so the wall starts empty here when it was not.`,
  };
}

function defaultDeps(): TimelapsePageDeps {
  return {
    reader: createHistoryReader({ baseUrl: BOARD_SERVER_URL }),
    reducedMotion: typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    origin: window.location.origin,
    copyText: (text) => navigator.clipboard.writeText(text),
  };
}

export function mountTimelapsePage(root: HTMLElement, ctx: PageContext, overrides: Partial<TimelapsePageDeps> = {}): PageDispose {
  const deps: TimelapsePageDeps = { ...defaultDeps(), ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".tl")!;
  const $ = <T extends HTMLElement>(name: string) => page.querySelector<T>(`[data-tl-${name}]`)!;
  const stateBox = $("state");
  const playerBox = $("player");

  const abort = new AbortController();
  let disposed = false;
  let player: Player | null = null;
  let onVisibility: (() => void) | null = null;

  function showState(title: string, body: string, action?: { label: string; run(): void } | { label: string; href: string }): void {
    stateBox.replaceChildren();
    stateBox.hidden = false;
    playerBox.hidden = true;
    const strong = document.createElement("strong");
    strong.textContent = title;
    const text = document.createElement("p");
    text.append(strong, document.createTextNode(` ${body}`));
    stateBox.append(text);
    if (action) {
      if ("href" in action) {
        const link = document.createElement("a");
        link.className = "mp-btn mp-btn-primary";
        link.href = action.href;
        link.textContent = action.label;
        stateBox.append(link);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mp-btn";
        button.textContent = action.label;
        button.addEventListener("click", action.run);
        stateBox.append(button);
      }
    }
  }

  function start(log: HistoryLog): void {
    const timeline = buildTimeline(log.records, log.head);
    if (timeline.length === 0) {
      showState("Nothing recorded yet.", "The first paint starts the film.", { label: "Go paint something", href: "/wall" });
      return;
    }
    stateBox.hidden = true;
    stateBox.replaceChildren();
    playerBox.hidden = false;

    const replay = createReplay(timeline);
    const wall = createWallCanvas($<HTMLCanvasElement>("canvas"), timeline.maxSide);
    const range = $<HTMLInputElement>("range");
    const play = $<HTMLButtonElement>("play");
    const dateEl = $("date");
    const blockEl = $("block");
    const countEl = $("count");
    const sizeEl = $("size");
    range.max = String(timeline.length);

    const notice = startNotice(log.head);
    const startEl = $("start");
    startEl.textContent = notice?.text ?? "";
    startEl.classList.toggle("is-partial", notice?.partial ?? false);
    if (notice?.partial) startEl.dataset.tlPartial = "true";

    // The ruler: one segment per UTC day, as wide as that day's share of the paint.
    const days = daySegments(timeline);
    const ruler = $("days");
    const labels = $("day-labels");
    let lastLabelAt = -100;
    days.forEach((day, i) => {
      const segment = document.createElement("span");
      segment.className = "tl-day";
      segment.style.flexGrow = String(day.end - day.start);
      ruler.append(segment);
      const at = (day.start / timeline.length) * 100;
      // Label a day only where there is room for it.
      if (at - lastLabelAt >= 16 && at <= 86) {
        const label = document.createElement("span");
        label.className = "tl-day-label";
        label.style.left = `${at}%`;
        label.textContent = DATE.format(day.dayMs).replace(/ \d{4}$/, i === 0 ? "$&" : "");
        labels.append(label);
        lastLabelAt = at;
      }
    });
    for (const grown of timeline.expansions) {
      const mark = document.createElement("span");
      mark.className = "tl-grew";
      mark.style.left = `${(grown.at / timeline.length) * 100}%`;
      mark.title = `The wall grew to ${grown.to} × ${grown.to}`;
      ruler.append(mark);
    }

    function show(position: number): void {
      replay.seek(position);
      const side = replay.side;
      wall.draw(replay.state, side);
      const frame = frameAt(timeline, replay.position);
      const when = frame ? formatMoment(frame.atMs) : notice?.partial ? "Before this recording" : "Before the first paint";
      dateEl.textContent = when;
      blockEl.textContent = frame ? count(frame.block) : "—";
      countEl.textContent = `${count(replay.position)} of ${count(timeline.length)}`;
      sizeEl.textContent = `${side} × ${side}`;
      range.value = String(replay.position);
      range.setAttribute("aria-valuetext", frame ? `${when}, block ${frame.block}` : when);
      page.dataset.tlPosition = String(replay.position);
    }

    player = createPlayer({
      length: timeline.length,
      rate: baseRate(timeline.length),
      onFrame: show,
      onState(playing) {
        play.textContent = playing ? "Pause" : "Play";
        play.setAttribute("aria-pressed", String(playing));
        page.dataset.tlPlaying = String(playing);
      },
      scheduler: deps.scheduler,
      now: deps.now,
    });
    const live = player;

    play.addEventListener("click", () => live.toggle());
    // Scrubbing takes over: the wall follows the thumb, and stays where it is let go.
    range.addEventListener("input", () => {
      live.pause();
      live.seek(Number(range.value));
    });

    const speeds = $("speeds");
    for (const speed of SPEEDS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mp-chip";
      chip.textContent = speed === 0.5 ? "½×" : `${speed}×`;
      chip.setAttribute("aria-pressed", String(speed === 1));
      chip.addEventListener("click", () => {
        live.setSpeed(speed);
        for (const other of speeds.children) other.setAttribute("aria-pressed", String(other === chip));
      });
      speeds.append(chip);
    }

    const shareStatus = $("share-status");
    const shareUrl = $<HTMLInputElement>("share-url");
    $("share").addEventListener("click", () => {
      live.pause();
      const frame = frameAt(timeline, live.position);
      if (!frame) {
        shareStatus.textContent = "Move to a moment after the first paint to share it.";
        return;
      }
      const url = shareHref(deps.origin, frame.block);
      // The address bar becomes the link too, so a copied URL or a reload lands here.
      try {
        window.history.replaceState(window.history.state, "", `/timelapse?block=${frame.block}`);
      } catch {
        // A sandboxed frame may refuse; the link below still works.
      }
      shareUrl.value = url;
      deps.copyText(url).then(
        () => {
          if (disposed) return;
          shareUrl.hidden = true;
          shareStatus.textContent = `Link copied. It opens at block ${count(frame.block)}.`;
        },
        () => {
          if (disposed) return;
          // No clipboard (permissions, an old browser): show the link to copy by hand.
          shareUrl.hidden = false;
          shareUrl.select();
          shareStatus.textContent = "Copy this link:";
        },
      );
    });

    // A hidden tab plays for nobody: stop the clock, and pick up where it was on return.
    let pausedByHiding = false;
    onVisibility = () => {
      if (document.hidden) {
        pausedByHiding = live.playing;
        live.pause();
      } else if (pausedByHiding) {
        pausedByHiding = false;
        live.play();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const shared = parseBlockParam(ctx.route.query.block);
    if (shared !== null) {
      // A shared moment opens on that moment, still.
      live.seek(positionAtBlock(timeline, shared));
    } else if (deps.reducedMotion) {
      live.seek(timeline.length);
    } else {
      live.seek(0);
      if (!document.hidden) live.play();
    }
  }

  function load(): void {
    const reader = deps.reader;
    if (!reader) {
      showState(
        "No recording to play here.",
        "The timelapse is read from the board server, and this site is not connected to one. The wall itself is live.",
        { label: "Go to the wall", href: "/wall" },
      );
      return;
    }
    showState("Loading the wall's history…", "");
    void reader
      .loadLog((rows, head) => {
        if (disposed) return;
        showState("Loading the wall's history…", `${count(Math.min(rows, head.entries))} of ${count(head.entries)} paints.`);
      }, abort.signal)
      .then((log) => {
        if (disposed) return;
        if (!log) {
          showState("The wall's history did not load.", "The board server did not answer, or sent something this page could not read. Nothing is shown rather than a guess.", {
            label: "Try again",
            run: load,
          });
          return;
        }
        start(log);
      });
  }

  load();

  return () => {
    disposed = true;
    abort.abort();
    player?.dispose();
    player = null;
    if (onVisibility) document.removeEventListener("visibilitychange", onVisibility);
    page.remove();
  };
}
