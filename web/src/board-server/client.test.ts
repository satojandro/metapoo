import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardServerSocketUrl, createBoardServerClient, parseServerMessage, type ServerDraw } from "./client";
import { decodeRegionBlob } from "./region-blob";
import { memoryRegionStore } from "./region-store";
import { buildRegion, fakeSockets } from "./test-support";

const BASE = "https://board.unit.test";

function stubServer(options: { lastUpdated: number; tiles?: Parameters<typeof buildRegion>[0]; accounts?: Record<number, string> }) {
  const paths: string[] = [];
  const state = { lastUpdated: options.lastUpdated };
  const region = buildRegion(options.tiles ?? []);
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    paths.push(path);
    const headers = { "x-last-updated": String(state.lastUpdated), "x-last-block": "500", "x-board-side": "64" };
    if (path === "/api/regions?coords=0,0") return Response.json([{ rx: 0, ry: 0, last_updated: state.lastUpdated }]);
    if (path === "/api/region/0/0") return new Response(region.bytes.slice(), { headers });
    if (path === "/api/region/0/0/written-at") return new Response(region.writtenAt.slice(), { headers });
    const account = /^\/api\/account\/(\d+)$/.exec(path);
    if (account) {
      const name = options.accounts?.[Number(account[1])];
      return name ? new Response(name) : new Response("not found", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  });
  return { fetcher: fetcher as unknown as typeof fetch, paths, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("board server client: load", () => {
  it("fetches the blob and its written-at, and names each painter once", async () => {
    const server = stubServer({
      lastUpdated: 10,
      tiles: [
        { x: 1, y: 2, colorIndex: 3, ownerId: 7, writtenAtNs: "1762500000123456789" },
        { x: 4, y: 2, colorIndex: 5, ownerId: 7 },
      ],
      accounts: { 7: "alice.testnet" },
    });
    const client = createBoardServerClient({ baseUrl: `${BASE}/`, fetcher: server.fetcher, store: memoryRegionStore() });
    const region = await client.loadRegion();
    expect(region.pixels).toEqual([
      { x: 1, y: 2, colorIndex: 3, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1762500000123456789" },
      { x: 4, y: 2, colorIndex: 5, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1000" },
    ]);
    expect(region).toMatchObject({ lastUpdatedMs: 10, lastBlock: 500, side: 64, hasWrittenAt: true, fromCache: false });
    expect(server.paths.filter((p) => p.startsWith("/api/account/"))).toEqual(["/api/account/7"]);
  });

  it("uses the cached blob when the server's last_updated is not newer, and refetches when it is", async () => {
    const store = memoryRegionStore();
    const server = stubServer({ lastUpdated: 10, tiles: [{ x: 0, y: 0, colorIndex: 1, ownerId: 1 }], accounts: { 1: "a.testnet" } });
    await createBoardServerClient({ baseUrl: BASE, fetcher: server.fetcher, store }).loadRegion();
    server.paths.length = 0;

    // A new page with the same store (a reload): only the meta request, no blob, no account.
    const again = await createBoardServerClient({ baseUrl: BASE, fetcher: server.fetcher, store }).loadRegion();
    expect(again.fromCache).toBe(true);
    expect(again.pixels).toHaveLength(1);
    expect(server.paths).toEqual(["/api/regions?coords=0,0"]);

    server.state.lastUpdated = 11;
    server.paths.length = 0;
    const newer = await createBoardServerClient({ baseUrl: BASE, fetcher: server.fetcher, store }).loadRegion();
    expect(newer.fromCache).toBe(false);
    expect(server.paths).toContain("/api/region/0/0");
  });

  it("refuses the ages when the written-at blob describes a different write", async () => {
    const server = stubServer({ lastUpdated: 10 });
    const fetcher = (async (input: RequestInfo | URL) => {
      const response = await server.fetcher(input);
      if (String(input).endsWith("/written-at")) {
        return new Response(await response.arrayBuffer(), { headers: { "x-last-updated": "9" } });
      }
      return response;
    }) as typeof fetch;
    const region = await createBoardServerClient({ baseUrl: BASE, fetcher, store: memoryRegionStore() }).loadRegion();
    expect(region.hasWrittenAt).toBe(false);
  });
});

describe("board server client: socket", () => {
  const draw = (receipt: string, ts: number, x = 1) =>
    `{"type":"draw","signer":"alice.near","block_height":${600 + ts},"block_timestamp_ms":${ts},"receipt_id":"${receipt}",` +
    `"pixels":[{"x":${x},"y":2,"color":4,"rgb":"3d7a4a","owner_id":9,"account_id":"alice.near","previous_owner_id":0,` +
    `"previous_account_id":null,"free":true,"credits":0,"written_at_ns":1762500000123456789}]}`;

  it("asks for catch_up from the last message seen, reconnects with backoff, and drops replays", async () => {
    const sockets = fakeSockets();
    const draws: ServerDraw[] = [];
    const client = createBoardServerClient({
      baseUrl: "http://board.unit.test", fetcher: stubServer({ lastUpdated: 1 }).fetcher,
      store: memoryRegionStore(), socketFactory: sockets.factory, backoffMs: 1_000,
    });
    vi.setSystemTime(1_000_000);
    client.connect({ onDraw: (d) => draws.push(d) });
    expect(sockets.last().url).toBe("ws://board.unit.test/ws");
    sockets.last().accept();
    // Nothing seen yet: two minutes back.
    expect(sockets.last().sent).toEqual([{ type: "catch_up", since_timestamp_ms: 1_000_000 - 120_000 }]);

    sockets.last().push(draw("r1", 50));
    expect(draws).toHaveLength(1);
    // Every digit of the u64 survives, which JSON.parse alone would round.
    expect(draws[0]!.pixels[0]).toMatchObject({ x: 1, y: 2, colorIndex: 4, artistAccountId: "alice.near", lastWriteTimestampNs: "1762500000123456789", free: true });

    sockets.last().drop();
    expect(client.isOpen()).toBe(false);
    expect(sockets.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.sockets).toHaveLength(2);
    sockets.last().accept();
    expect(sockets.last().sent).toEqual([{ type: "catch_up", since_timestamp_ms: 50 }]);

    // catch_up is inclusive: r1 comes back and must not apply twice.
    sockets.last().push(draw("r1", 50));
    sockets.last().push(draw("r2", 51));
    expect(draws.map((d) => d.receiptId)).toEqual(["r1", "r2"]);
    client.close();
  });

  it("pause closes the socket and cancels reconnects until resume, which catches up", async () => {
    const sockets = fakeSockets();
    const closes = vi.fn();
    const client = createBoardServerClient({
      baseUrl: "http://board.unit.test", fetcher: stubServer({ lastUpdated: 1 }).fetcher,
      store: memoryRegionStore(), socketFactory: sockets.factory, backoffMs: 1_000,
    });
    client.connect({ onClose: closes });
    sockets.last().accept();
    sockets.last().push(draw("r1", 70));
    client.pause();
    expect(client.isPaused()).toBe(true);
    expect(client.isOpen()).toBe(false);
    expect(sockets.last().readyState).toBe(3);
    expect(closes).toHaveBeenCalledTimes(1);
    client.reconnect(); // a paused client ignores it
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sockets.sockets).toHaveLength(1);

    // A pause while a reconnect is pending cancels it too.
    client.resume();
    expect(sockets.sockets).toHaveLength(2);
    sockets.last().drop();
    client.pause();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sockets.sockets).toHaveLength(2);

    client.resume();
    expect(sockets.sockets).toHaveLength(3);
    sockets.last().accept();
    expect(sockets.last().sent).toEqual([{ type: "catch_up", since_timestamp_ms: 70 }]);
    client.close();
  });

  it("a replay never lets an older write overwrite a newer tile", async () => {
    const store = memoryRegionStore();
    const server = stubServer({
      lastUpdated: 10,
      tiles: [{ x: 1, y: 2, colorIndex: 3, ownerId: 9, writtenAtNs: "1762500000200000000" }],
      accounts: { 9: "alice.near" },
    });
    const sockets = fakeSockets();
    const client = createBoardServerClient({
      baseUrl: BASE, fetcher: server.fetcher, store, socketFactory: sockets.factory,
    });
    await client.loadRegion();
    client.connect({});
    sockets.last().accept();
    const tile = async () => {
      const stored = await store.getRegion(`${BASE}|region|0,0`);
      return decodeRegionBlob(stored!.bytes).find((p) => p.x === 1 && p.y === 2);
    };
    const pushed = (receipt: string, color: number, ns: string) =>
      `{"type":"draw","signer":"bob.near","block_height":700,"block_timestamp_ms":9000,"receipt_id":"${receipt}",` +
      `"pixels":[{"x":1,"y":2,"color":${color},"rgb":"000000","owner_id":9,"account_id":"alice.near",` +
      `"previous_owner_id":0,"previous_account_id":null,"free":false,"credits":1,"written_at_ns":${ns}}]}`;

    // An out-of-order catch-up replay of a write older than the tile's: dropped.
    sockets.last().push(pushed("older", 4, "1762500000100000000"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await tile())?.colorIndex).toBe(3);

    // A write newer than the tile's: applied.
    sockets.last().push(pushed("newer", 5, "1762500000300000000"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await tile())?.colorIndex).toBe(5);
    client.close();
  });

  it("backs off further after each failed attempt", async () => {
    const sockets = fakeSockets();
    const client = createBoardServerClient({
      baseUrl: BASE, fetcher: stubServer({ lastUpdated: 1 }).fetcher,
      store: memoryRegionStore(), socketFactory: sockets.factory, backoffMs: 1_000,
    });
    client.connect({});
    sockets.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.sockets).toHaveLength(2);
    sockets.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.sockets).toHaveLength(3);
    client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.sockets).toHaveLength(3);
  });

  it("uses wss for an https server", () => {
    expect(boardServerSocketUrl("https://board.example.org")).toBe("wss://board.example.org/ws");
  });

  it("reads board_expanded and ignores messages it does not know", () => {
    expect(parseServerMessage('{"type":"board_expanded","from":64,"to":96,"block_height":5,"block_timestamp_ms":6}'))
      .toEqual({ type: "board_expanded", event: { from: 64, to: 96, blockHeight: 5, blockTimestampMs: 6 } });
    expect(parseServerMessage('{"type":"state_migrated","block_height":5,"block_timestamp_ms":6}')).toBeNull();
    expect(parseServerMessage("not json")).toBeNull();
  });
});
