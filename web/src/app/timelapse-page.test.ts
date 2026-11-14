// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { createRouter } from "./router";
import { clearPageMounts, registerPageMount } from "./page-registry";
import { matchRoute } from "./routes";
import { daySegments, formatMoment, mountTimelapsePage, parseBlockParam, shareHref, startNotice, type TimelapsePageDeps } from "./timelapse-page";
import type { HistoryHead, HistoryLog, HistoryReader } from "../timelapse/history-client";
import type { HistoryRecord } from "../timelapse/history-wire";
import type { FrameScheduler } from "../timelapse/player";
import { headFor, syntheticRecords } from "../timelapse/test-support";
import { buildTimeline, frameAt, positionAtBlock } from "../timelapse/timeline";

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  window.history.replaceState(null, "", "/");
});

function services() {
  return {
    wallet: {
      getSession: () => ({ accountId: null, networkId: null }),
      connect: async () => {},
      disconnect: async () => {},
      subscribe: () => () => {},
      whenReady: Promise.resolve({ accountId: null, networkId: null }),
    },
    operations: createOperationsStore(),
  };
}

function ctx(search = ""): PageContext {
  return { services: services(), route: matchRoute("/timelapse", search), navigate: () => {} };
}

/** A scheduler the test steps by hand; `pending` is every timer the page holds. */
function clock() {
  let next = 1;
  let time = 0;
  const pending = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request(callback) {
      pending.set(next, callback);
      return next++;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  return {
    scheduler,
    pending,
    now: () => time,
    step(ms: number) {
      time += ms;
      const [handle, callback] = [...pending.entries()][0] ?? [];
      if (handle === undefined) return;
      pending.delete(handle);
      callback!();
    },
  };
}

function readerOf(log: HistoryLog | null): HistoryReader {
  return { readHead: async () => log?.head ?? null, loadLog: async () => log };
}

const RECORDS = syntheticRecords({ paints: 3000, expandAt: 1200 });

function logOf(records: HistoryRecord[] = RECORDS, over: Partial<HistoryHead> = {}): HistoryLog {
  return { head: headFor(records, over), records, requests: 2 };
}

async function mount(deps: Partial<TimelapsePageDeps>, search = "") {
  const root = document.createElement("div");
  document.body.append(root);
  const c = clock();
  const copied: string[] = [];
  const dispose = mountTimelapsePage(root, ctx(search), {
    reducedMotion: false,
    scheduler: c.scheduler,
    now: c.now,
    origin: "https://metapoo.example",
    copyText: async (text) => void copied.push(text),
    ...deps,
  });
  cleanup.push(() => {
    dispose();
    root.remove();
  });
  await new Promise((r) => setTimeout(r));
  const q = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-tl-${name}]`)!;
  return { root, dispose, clock: c, copied, q, page: root.querySelector<HTMLElement>(".tl")! };
}

describe("with nothing to play", () => {
  it("says there is no board server, makes no request and draws no wall", async () => {
    const { q } = await mount({ reader: null });
    expect(q("player").hidden).toBe(true);
    expect(q("state").textContent).toMatch(/not connected to one/);
    expect(q("state").querySelector("a")!.getAttribute("href")).toBe("/wall");
  });

  it("says the history did not load when the server is down, and offers to try again", async () => {
    let log: HistoryLog | null = null;
    const loadLog = vi.fn(async () => log);
    const { q, clock: c } = await mount({ reader: { readHead: async () => null, loadLog } });
    expect(q("player").hidden).toBe(true);
    expect(q("state").textContent).toMatch(/did not load/);
    expect(q("state").textContent).toMatch(/rather than a guess/);
    expect(c.pending.size).toBe(0);
    // Trying again once the server is back plays it.
    log = logOf();
    q("state").querySelector("button")!.click();
    await new Promise((r) => setTimeout(r));
    expect(loadLog).toHaveBeenCalledTimes(2);
    expect(q("player").hidden).toBe(false);
  });

  it("says nothing is recorded yet for an empty log", async () => {
    const { q } = await mount({ reader: readerOf(logOf([], { complete: false, startBlock: null, initialSide: null })) });
    expect(q("player").hidden).toBe(true);
    expect(q("state").textContent).toMatch(/Nothing recorded yet/);
  });
});

describe("where the recording starts", () => {
  it("says so plainly when the log is partial, and never calls it the whole story", async () => {
    const log = logOf(RECORDS, { complete: false, startBlock: null, initialSide: null });
    const { q } = await mount({ reader: readerOf(log) });
    const note = q("start");
    expect(note.dataset.tlPartial).toBe("true");
    expect(note.textContent).toContain(`block ${log.head.first!.block.toLocaleString("en-US")}`);
    expect(note.textContent).toContain(formatMoment(log.head.first!.atMs));
    expect(note.textContent).toMatch(/Paint from before then is not in it yet/);
    expect(note.textContent).not.toMatch(/whole story|every paint/i);
  });

  it("calls a partial log's first frame 'before this recording', not 'before the first paint'", async () => {
    const log = logOf(RECORDS, { complete: false, startBlock: null, initialSide: null });
    const { q } = await mount({ reader: readerOf(log) });
    expect(q("date").textContent).toBe("Before this recording");
  });

  it("claims the whole story only for a log the server certified from the deploy block", async () => {
    const log = logOf();
    const { q } = await mount({ reader: readerOf(log) });
    expect(q("start").dataset.tlPartial).toBeUndefined();
    expect(q("start").textContent).toContain(`since the board went live at block ${log.head.startBlock!.toLocaleString("en-US")}`);
    expect(q("date").textContent).toBe("Before the first paint");
    expect(startNotice({ ...log.head, complete: false })!.partial).toBe(true);
    expect(startNotice(headFor([]))).toBeNull();
  });
});

describe("playing", () => {
  it("plays from the first paint, showing the date, block, count and wall size of the frame", async () => {
    const log = logOf();
    const timeline = buildTimeline(log.records, log.head);
    const { q, clock: c, page } = await mount({ reader: readerOf(log) });
    expect(q("play").textContent).toBe("Pause");
    expect(c.pending.size).toBe(1);
    expect(q<HTMLInputElement>("range").max).toBe("3000");
    c.step(100);
    c.step(100);
    // 34 paints a second at 1× for 3,000 paints.
    const position = Number(page.dataset.tlPosition);
    expect(position).toBe(6);
    const frame = frameAt(timeline, position)!;
    expect(q("date").textContent).toBe(formatMoment(frame.atMs));
    expect(q("block").textContent).toBe(frame.block.toLocaleString("en-US"));
    expect(q("count").textContent).toBe("6 of 3,000");
    expect(q("size").textContent).toBe("64 × 64");
    expect(q<HTMLInputElement>("range").value).toBe("6");
    expect(q("range").getAttribute("aria-valuetext")).toContain(String(frame.block));
  });

  it("scrubbing pauses, follows the thumb both ways, and shows the wall growing", async () => {
    const { q, clock: c } = await mount({ reader: readerOf(logOf()) });
    const range = q<HTMLInputElement>("range");
    const scrub = (to: number) => {
      range.value = String(to);
      range.dispatchEvent(new Event("input"));
    };
    scrub(2500);
    expect(q("play").textContent).toBe("Play");
    expect(c.pending.size).toBe(0);
    expect(q("count").textContent).toBe("2,500 of 3,000");
    expect(q("size").textContent).toBe("96 × 96");
    scrub(1199);
    expect(q("size").textContent).toBe("64 × 64");
    scrub(1200);
    expect(q("size").textContent).toBe("96 × 96");
    scrub(0);
    expect(q("count").textContent).toBe("0 of 3,000");
  });

  it("changes speed from the chips", async () => {
    const { q, clock: c, page } = await mount({ reader: readerOf(logOf()) });
    const chips = [...q("speeds").querySelectorAll<HTMLButtonElement>("button")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["½×", "1×", "2×", "4×"]);
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false"]);
    chips[3]!.click();
    c.step(100);
    expect(Number(page.dataset.tlPosition)).toBe(13);
    expect(chips[3]!.getAttribute("aria-pressed")).toBe("true");
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not autoplay for someone who asked for reduced motion: it opens on the finished wall", async () => {
    const { q, clock: c } = await mount({ reader: readerOf(logOf()), reducedMotion: true });
    expect(c.pending.size).toBe(0);
    expect(q("play").textContent).toBe("Play");
    expect(q("count").textContent).toBe("3,000 of 3,000");
    // They can still press play: it starts over.
    q("play").click();
    expect(c.pending.size).toBe(1);
    expect(q("count").textContent).toBe("0 of 3,000");
  });

  it("pauses while the tab is hidden and picks up again when it is back", async () => {
    const { q, clock: c } = await mount({ reader: readerOf(logOf()) });
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(c.pending.size).toBe(0);
    expect(q("play").textContent).toBe("Play");
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(c.pending.size).toBe(1);
    // A tab that was paused by hand stays paused when it comes back.
    q("play").click();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(c.pending.size).toBe(0);
    hidden.mockRestore();
  });
});

describe("share this moment", () => {
  it("copies a link carrying the frame's block, and that link opens on the same frame, paused", async () => {
    const log = logOf();
    const timeline = buildTimeline(log.records, log.head);
    const first = await mount({ reader: readerOf(log) });
    const range = first.q<HTMLInputElement>("range");
    range.value = "1777";
    range.dispatchEvent(new Event("input"));
    first.q("share").click();
    await new Promise((r) => setTimeout(r));
    const block = frameAt(timeline, 1777)!.block;
    expect(first.copied).toEqual([`https://metapoo.example/timelapse?block=${block}`]);
    expect(first.q("share-status").textContent).toContain(block.toLocaleString("en-US"));
    expect(window.location.pathname + window.location.search).toBe(`/timelapse?block=${block}`);

    const opened = await mount({ reader: readerOf(log) }, `?block=${block}`);
    expect(opened.clock.pending.size).toBe(0);
    expect(opened.q("play").textContent).toBe("Play");
    expect(opened.q("block").textContent).toBe(block.toLocaleString("en-US"));
    expect(Number(opened.page.dataset.tlPosition)).toBe(positionAtBlock(timeline, block));
  });

  it("shows the link to copy by hand when the clipboard refuses", async () => {
    const { q } = await mount({ reader: readerOf(logOf()), reducedMotion: true, copyText: async () => Promise.reject(new Error("denied")) });
    q("share").click();
    await new Promise((r) => setTimeout(r));
    const field = q<HTMLInputElement>("share-url");
    expect(field.hidden).toBe(false);
    expect(field.value).toMatch(/^https:\/\/metapoo\.example\/timelapse\?block=\d+$/);
  });

  it("ignores a block parameter that is not a block height", () => {
    expect(parseBlockParam("223113576")).toBe(223113576);
    for (const bad of [undefined, "", "abc", "-5", "1e9", "12.5", "9".repeat(20)]) expect(parseBlockParam(bad)).toBeNull();
    expect(shareHref("https://metapoo.example/", 5)).toBe("https://metapoo.example/timelapse?block=5");
  });
});

describe("the day ruler", () => {
  it("cuts the log into UTC days that cover every paint once", () => {
    const timeline = buildTimeline(RECORDS, headFor(RECORDS));
    const days = daySegments(timeline);
    expect(days.length).toBeGreaterThan(1);
    expect(days[0]!.start).toBe(0);
    expect(days.at(-1)!.end).toBe(timeline.length);
    days.forEach((day, i) => {
      if (i > 0) expect(day.start).toBe(days[i - 1]!.end);
      expect(day.dayMs % 86_400_000).toBe(0);
      expect(day.end).toBeGreaterThan(day.start);
    });
  });
});

describe("leaving the page", () => {
  it("dispose stops the playback timer, the visibility listener and removes the page", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { root, dispose, clock: c } = await mount({ reader: readerOf(logOf()) });
    expect(c.pending.size).toBe(1);
    dispose();
    expect(c.pending.size).toBe(0);
    expect(root.querySelector(".tl")).toBeNull();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    // Nothing the tab does afterwards can start it again.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(c.pending.size).toBe(0);
    remove.mockRestore();
  });

  it("a log that arrives after the page was left starts nothing", async () => {
    let deliver!: (log: HistoryLog) => void;
    const signals: AbortSignal[] = [];
    const reader: HistoryReader = {
      readHead: async () => null,
      loadLog: (_progress, signal) => {
        signals.push(signal!);
        return new Promise((resolve) => (deliver = resolve));
      },
    };
    const { root, dispose, clock: c } = await mount({ reader });
    dispose();
    expect(signals[0]!.aborted).toBe(true);
    deliver(logOf());
    await new Promise((r) => setTimeout(r));
    expect(c.pending.size).toBe(0);
    expect(root.querySelector(".tl")).toBeNull();
  });

  it("the router disposes it on a route change", async () => {
    clearPageMounts();
    document.body.innerHTML = '<div id="outlet"></div>';
    window.history.replaceState(null, "", "/timelapse");
    const c = clock();
    registerPageMount("timelapse", (root, pageCtx) =>
      mountTimelapsePage(root, pageCtx, { reader: readerOf(logOf()), reducedMotion: false, scheduler: c.scheduler, now: c.now }),
    );
    registerPageMount("wall", (root) => {
      root.textContent = "wall";
      return () => root.replaceChildren();
    });
    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({ outlet, services: services() });
    router.start();
    await new Promise((r) => setTimeout(r));
    expect(c.pending.size).toBe(1);
    router.navigate("/wall");
    expect(c.pending.size).toBe(0);
    expect(outlet.querySelector(".tl")).toBeNull();
    router.stop();
    clearPageMounts();
    document.body.innerHTML = "";
  });
});
