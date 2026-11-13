import { describe, expect, it, vi } from "vitest";
import { createHistoryReader, parseHistoryHead, type HistoryHead } from "./history-client";
import { headFor, paginate, syntheticRecords } from "./test-support";
import { buildTimeline, createReplay } from "./timeline";

const BASE = "https://board.example";

/** A response body from bytes (a fresh ArrayBuffer, which every `Response` accepts). */
const body = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;

function headJson(head: HistoryHead): Record<string, unknown> {
  return {
    epoch: head.epoch,
    complete: head.complete,
    start_block: head.startBlock,
    initial_side: head.initialSide,
    entries: head.entries,
    first: head.first && { block: head.first.block, at_ms: head.first.atMs },
    last: head.last && { block: head.last.block, at_ms: head.last.atMs },
    side: head.side,
    page_limit: 20000,
  };
}

/** A server holding `pages`, answering by cursor like the real one. Records every URL. */
function server(head: HistoryHead, pages: Uint8Array[]) {
  const urls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    if (url.pathname === "/api/history/head") return Response.json(headJson(head));
    if (url.searchParams.get("epoch") !== String(head.epoch)) return new Response("stale", { status: 409 });
    const after = url.searchParams.get("after");
    const index = after ? Number(after.split("-")[0]) / 1_000_000 : 0;
    return new Response(body(pages[index] ?? new Uint8Array()), { status: pages[index] ? 200 : 404 });
  });
  return { urls, fetcher: fetcher as unknown as typeof fetch };
}

describe("parseHistoryHead", () => {
  const good = headJson(headFor(syntheticRecords({ paints: 50 })));

  it("accepts the server's shape", () => {
    expect(parseHistoryHead(good)).toMatchObject({ complete: true, initialSide: 64, entries: 50, side: 64 });
    expect(parseHistoryHead({ ...good, complete: false, start_block: null, initial_side: null })).toMatchObject({
      complete: false,
      initialSide: null,
    });
  });

  it("refuses a head that does not hold together", () => {
    for (const bad of [
      null,
      [],
      "ok",
      { ...good, entries: -1 },
      { ...good, entries: "50" },
      { ...good, side: 0 },
      { ...good, side: 4096 },
      { ...good, complete: "yes" },
      // Entries with no first, or a first with no entries.
      { ...good, first: null },
      { ...good, entries: 0 },
      // "Complete" without saying from where.
      { ...good, initial_side: null },
      { ...good, start_block: null },
      { ...good, first: { block: 1 } },
    ]) {
      expect(parseHistoryHead(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("createHistoryReader", () => {
  it("is null with no board server configured, so no request can be made", () => {
    expect(createHistoryReader({ baseUrl: "" })).toBeNull();
    expect(createHistoryReader({ baseUrl: "   ".trim() })).toBeNull();
  });

  it("loads a log of several pages in one request per page plus the head, following cursors", async () => {
    const records = syntheticRecords({ paints: 2500, expandAt: 900 });
    const head = headFor(records);
    const { urls, fetcher } = server(head, paginate(records, 1000));
    const progress: number[] = [];
    const log = (await createHistoryReader({ baseUrl: `${BASE}/`, fetcher })!.loadLog((rows) => progress.push(rows)))!;
    expect(urls).toEqual([
      "/api/history/head",
      `/api/history?epoch=${head.epoch}`,
      `/api/history?epoch=${head.epoch}&after=1000000-0`,
      `/api/history?epoch=${head.epoch}&after=2000000-0`,
    ]);
    expect(log.requests).toBe(4);
    expect(progress).toEqual([1000, 2000, 2501]);
    // What arrived replays to the same wall as the records it was cut from.
    const loaded = createReplay(buildTimeline(log.records, log.head));
    const original = createReplay(buildTimeline(records, head));
    loaded.seek(Infinity);
    original.seek(Infinity);
    expect(loaded.position).toBe(2500);
    expect(loaded.state).toEqual(original.state);
    expect(loaded.side).toBe(96);
  });

  it("asks for no pages when the head says the log is empty", async () => {
    const head = headFor([], { complete: false, startBlock: null, initialSide: null });
    const { urls, fetcher } = server(head, []);
    const log = await createHistoryReader({ baseUrl: BASE, fetcher })!.loadLog();
    expect(log).toMatchObject({ records: [], requests: 1 });
    expect(urls).toEqual(["/api/history/head"]);
  });

  it("starts again from the head once when the log was rewritten under it (409)", async () => {
    const records = syntheticRecords({ paints: 300 });
    let head = headFor(records, { epoch: 5 });
    const pages = paginate(records, 1000);
    const urls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      if (url.pathname.endsWith("/head")) {
        const body = Response.json(headJson(head));
        // The backfill runs between the head and the first page.
        if (head.epoch === 5) head = { ...head, epoch: 6 };
        return body;
      }
      return url.searchParams.get("epoch") === "6" ? new Response(body(pages[0]!)) : new Response("stale", { status: 409 });
    }) as typeof fetch;
    const log = await createHistoryReader({ baseUrl: BASE, fetcher })!.loadLog();
    expect(log?.head.epoch).toBe(6);
    expect(urls).toEqual(["/api/history/head", "/api/history?epoch=5", "/api/history/head", "/api/history?epoch=6"]);
  });

  it("reads every failure as unavailable, never as an empty or shorter log", async () => {
    const records = syntheticRecords({ paints: 2500 });
    const head = headFor(records);
    const pages = paginate(records, 1000);
    const failing: Array<[string, typeof fetch]> = [
      ["network error", (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch],
      ["server error", (async () => new Response("no", { status: 503 })) as typeof fetch],
      ["head is not JSON", (async () => new Response("<html>")) as typeof fetch],
      ["second page is HTML", (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/head")) return Response.json(headJson(head));
        return url.searchParams.get("after") ? new Response("<html>bad gateway</html>") : new Response(body(pages[0]!));
      }) as typeof fetch],
      ["a page cut off in transit", (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/head")) return Response.json(headJson(head));
        return new Response(body(pages[0]!.subarray(0, 700)));
      }) as typeof fetch],
      ["stale twice", (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/head")) return Response.json(headJson(head));
        return new Response("stale", { status: 409 });
      }) as typeof fetch],
    ];
    for (const [name, fetcher] of failing) {
      expect(await createHistoryReader({ baseUrl: BASE, fetcher })!.loadLog(), name).toBeNull();
    }
  });

  it("gives up at the deadline, and stops when the caller aborts", async () => {
    const hang = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    expect(await createHistoryReader({ baseUrl: BASE, fetcher: hang, timeoutMs: 20 })!.readHead()).toBeNull();
    const controller = new AbortController();
    const pending = createHistoryReader({ baseUrl: BASE, fetcher: hang, timeoutMs: 60_000 })!.loadLog(undefined, controller.signal);
    controller.abort();
    // The fetcher ignores the signal; the reader still must not hang past its own deadline.
    const aborted = createHistoryReader({ baseUrl: BASE, fetcher: hang })!.loadLog(undefined, controller.signal);
    expect(await aborted).toBeNull();
    void pending;
  });
});
