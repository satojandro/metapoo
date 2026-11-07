/**
 * @vitest-environment happy-dom
 *
 * The board server's cost promise (spec done-when #4): with the socket open, a touched
 * tab makes ≤ ~60 chain requests an hour, counted in read-rpc.ts. And its safety
 * promise: when the socket drops or the server falls behind, today's poll comes back.
 *
 * Real contract.ts and read-rpc.ts underneath, a stubbed fetch for the chain and the
 * server, and a scripted WebSocket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_CATCH_UP_SAFE_MS, SERVER_MAX_LAG_BLOCKS, SERVER_RESUME_GRACE_MS } from "./board-controller";
import { BOARD_IDLE_PAUSE_MS, BOARD_POLL_BASE_MS } from "../../board-sync";
import { memoryRegionStore } from "../../board-server/region-store";
import { buildRegion, fakeSockets } from "../../board-server/test-support";

/**
 * Fresh modules per test: the read transport and the board-version support flag are
 * module state, and a transport wedged by one test's fake clock would starve the next.
 */
async function loadModules() {
  vi.resetModules();
  const [controller, scope, rpc, client] = await Promise.all([
    import("./board-controller"),
    import("./wall-scope"),
    import("../../read-rpc"),
    import("../../board-server/client"),
  ]);
  return {
    createBoardController: controller.createBoardController,
    createWallScope: scope.createWallScope,
    chainRequestCount: rpc.chainRequestCount,
    createBoardServerClient: client.createBoardServerClient,
  };
}
let mods: Awaited<ReturnType<typeof loadModules>>;
const chainRequestCount = () => mods.chainRequestCount();

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    CONTRACT_ID: "board.unit.testnet",
    PAGE_NETWORK: "testnet",
    RPC_URL: "https://rpc.unit.test",
    rpcHeaders: () => ({ "Content-Type": "application/json" }),
  };
});

const SERVER = "https://board.unit.test";
const BOARD = {
  schema_version: 4, width: 128, height: 128, origin: "top-left", overwrite_rule: "open_wall",
  sponsorship_enabled: false,
  palette: [
    ["Ink", "#1c1917"], ["Paper", "#f4efe4"], ["Brick", "#b23a2f"], ["Marigold", "#e0a100"],
    ["Moss", "#3d7a4a"], ["River", "#2f6f8f"], ["Grape", "#6b4c7a"], ["Clay", "#c47b5a"],
  ].map(([name, hex], index) => ({ index, name, hex })),
};

type Rpc = { method: string; params: Record<string, unknown> };

/** Chain + board server behind one fetch. The chain advances one block a second. */
function stubWorld() {
  const start = Date.now();
  const world = {
    version: 3,
    serverLagBlocks: 2,
    /** How far the consumer's applied watermark trails the chain. Null: the same as the indexer. */
    appliedLagBlocks: null as number | null,
    queueLength: 0,
    /** The consumer's own liveness, as the server derives it. */
    healthStatus: "ok" as "ok" | "degraded" | "stalled",
    chainCalls: [] as Rpc[],
    /** Every get_pixels call: when (fake ms since start) and the wall's status line, which names the load's reason. */
    walks: [] as Array<{ atMs: number; status: string }>,
    serverPaths: [] as string[],
    height: () => 10_000 + Math.floor((Date.now() - start) / 1000),
    applied: () => 10_000 + Math.floor((Date.now() - start) / 1000) - (world.appliedLagBlocks ?? world.serverLagBlocks),
  };
  const region = buildRegion([{ x: 1, y: 2, colorIndex: 3, ownerId: 1, writtenAtNs: "1762500000000000000" }]);
  const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(SERVER)) {
      const path = url.slice(SERVER.length);
      world.serverPaths.push(path);
      const headers = { "x-last-updated": "5000", "x-last-block": "9990", "x-board-side": "128" };
      if (path === "/api/regions?coords=0,0") return Response.json([{ rx: 0, ry: 0, last_updated: 5000 }]);
      if (path === "/api/region/0/0") return new Response(region.bytes.slice(), { headers });
      if (path === "/api/region/0/0/written-at") return new Response(region.writtenAt.slice(), { headers });
      if (path === "/api/account/1") return new Response("alice.testnet");
      if (path === "/api/health") {
        return Response.json({
          status: world.healthStatus,
          last_processed_block: world.height() - world.serverLagBlocks,
          last_applied_block: world.applied(),
          queue_length: world.queueLength,
          side: 128,
        });
      }
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as Rpc;
    world.chainCalls.push(body);
    if (body.method === "block") return Response.json({ result: { header: { height: world.height() } } });
    const method = body.params.method_name;
    const block_height = typeof body.params.block_id === "number" ? body.params.block_id : world.height();
    if (method === "get_board") return Response.json({ result: { result: bytes(BOARD), block_height } });
    if (method === "get_board_version") return Response.json({ result: { result: bytes(world.version), block_height } });
    if (method === "get_pixels") {
      world.walks.push({ atMs: Date.now() - start, status: document.getElementById("status")?.textContent ?? "" });
      const page = { pixels: [{ x: 1, y: 2, color: 3, artist: "a.testnet", written_at_ns: "5" }], from_index: 0, limit: 256, total: 1, next_from_index: null };
      return Response.json({ result: { result: bytes(page), block_height } });
    }
    throw new Error(`unexpected ${body.method} ${String(method)}`);
  }));
  const named = (name: string) => world.chainCalls.filter((c) => c.params?.method_name === name || c.method === name).length;
  return { world, named };
}

function mount(withServer: boolean) {
  document.body.innerHTML = `
    <p id="evidence"></p><p id="line"></p><p id="status"></p><p id="fresh"></p>
    <button id="refresh"></button><p id="sponsor"></p>`;
  const el = (id: string) => document.getElementById(id)!;
  const scope = mods.createWallScope();
  const sockets = fakeSockets();
  const reconcilePending = vi.fn();
  const controller = mods.createBoardController({
    scope,
    evidence: el("evidence"),
    contractLine: el("line"),
    boardLoadStatus: el("status"),
    boardFreshness: el("fresh"),
    refreshButton: el("refresh") as HTMLButtonElement,
    sponsorNote: el("sponsor"),
    sponsorship: { flagEnabled: false, message: "No sponsor." } as never,
    routeFocusesCell: false,
    selected: () => null,
    fillResult: vi.fn(),
    render: vi.fn(),
    showSelection: vi.fn(),
    updateCompactStatus: vi.fn(),
    updateDirectPaintAvailability: vi.fn(),
    applyRoutePaintingContext: vi.fn(),
    reconcilePending,
    onBoardUpdated: vi.fn(),
    onSchemaChanged: vi.fn(),
    onManualRefresh: vi.fn(),
    onPaletteChanged: vi.fn(),
    onBoardSizeChanged: vi.fn(),
    boardServer: withServer
      ? mods.createBoardServerClient({ baseUrl: SERVER, store: memoryRegionStore(), socketFactory: sockets.factory })
      : undefined,
  });
  return {
    controller, sockets, reconcilePending,
    dispose: () => { controller.dispose(); scope.markDisposed(); scope.runCleanups(); },
  };
}

/** Advance time with someone at the page: a pointer move every 5 minutes. */
async function touchedFor(ms: number): Promise<void> {
  // 10 s steps, not 60 s. The stub derives both the chain height and the server's watermark
  // from the fake clock when each request is made. A trust check's chain read goes through the
  // paced read transport, so on a slow runner it could land at a later timer within one jump.
  // A 60 s jump then made a lag of 62 blocks out of a server 2 blocks behind: one false
  // "behind", one chain walk (seen on CI for PR #90). Real requests are a few seconds apart.
  const step = 10_000;
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left));
    if ((ms - left) % 300_000 === 0) window.dispatchEvent(new Event("pointermove"));
  }
}

/** The read transport spaces requests with timers, so a load needs the clock to move. */
async function settle(work: Promise<unknown>): Promise<void> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(50);
  await work;
}

/** Mount, bootstrap, open the socket and let the first trust check make the server live. */
async function liveWall() {
  const chain = stubWorld();
  const wall = mount(true);
  await settle(wall.controller.bootstrap());
  wall.controller.scheduleBoardPoll();
  wall.sockets.last().accept();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wall.controller.serverLive()).toBe(true);
  return { ...chain, ...wall };
}

let liveDispose: (() => void) | null = null;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  mods = await loadModules();
});

afterEach(() => {
  liveDispose?.();
  liveDispose = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("board server: chain polling while the socket is open", () => {
  it("without VITE_BOARD_SERVER_URL the wall polls every 4 s and never contacts a server", async () => {
    const { world, named } = stubWorld();
    const wall = mount(false);
    liveDispose = wall.dispose;
    await settle(wall.controller.bootstrap());
    wall.controller.scheduleBoardPoll();
    const before = named("get_board_version");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(named("get_board_version") - before).toBeGreaterThanOrEqual(12);
    expect(world.serverPaths).toEqual([]);
    expect(wall.sockets.sockets).toEqual([]);
  });

  it("loads from the server blob, with no get_pixels walk", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
    expect(wall.controller.cachedPixel({ x: 1, y: 2 })).toMatchObject({
      colorIndex: 3, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1762500000000000000",
    });
  });

  it("a touched tab with the socket open makes at most ~60 chain requests an hour", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const before = chainRequestCount();
    await touchedFor(60 * 60_000);
    const spent = chainRequestCount() - before;
    expect(spent).toBeLessThanOrEqual(61);
    expect(spent).toBeGreaterThanOrEqual(55); // the trust check really runs
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
    expect(wall.controller.serverLive()).toBe(true);
  });

  it("applies a pushed draw to the wall, last entry winning for a repeated tile", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const px = (color: number, ns: string) =>
      `{"x":5,"y":6,"color":${color},"rgb":"000000","owner_id":2,"account_id":"bob.testnet","previous_owner_id":0,"previous_account_id":null,"free":false,"credits":1,"written_at_ns":${ns}}`;
    wall.sockets.last().push(
      `{"type":"draw","signer":"bob.testnet","block_height":20000,"block_timestamp_ms":9000,"receipt_id":"r9","pixels":[${px(2, "1762500000000000001")},${px(4, "1762500000000000001")}]}`,
    );
    expect(wall.controller.cachedPixel({ x: 5, y: 6 })).toMatchObject({
      colorIndex: 4, artistAccountId: "bob.testnet", lastWriteTimestampNs: "1762500000000000001",
    });
    expect(wall.reconcilePending).toHaveBeenCalled();
  });

  it("resumes the 4 s poll when the socket drops, and pauses it again once the server is back", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    await touchedFor(5 * 60_000);
    const quiet = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wall.named("get_board_version") - quiet).toBeLessThanOrEqual(1);

    wall.sockets.last().drop();
    expect(wall.controller.serverLive()).toBe(false);
    // The copy came from the server, so the fallback walks the chain once...
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.named("get_pixels")).toBe(1);
    // ...and then polls the version every 4 s, as today.
    const dropped = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(10 * BOARD_POLL_BASE_MS);
    expect(wall.named("get_board_version") - dropped).toBeGreaterThanOrEqual(8);

    // The client reconnects by itself; a passing trust check makes it live again.
    await vi.advanceTimersByTimeAsync(2_000);
    wall.sockets.last().accept();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.controller.serverLive()).toBe(true);
    const back = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wall.named("get_board_version") - back).toBeLessThanOrEqual(1);
  });

  it("falls back to polling when /api/health trails the chain by more than 60 blocks", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    wall.world.serverLagBlocks = SERVER_MAX_LAG_BLOCKS + 5;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wall.controller.serverLive()).toBe(false);
    const behind = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(10 * BOARD_POLL_BASE_MS);
    expect(wall.named("get_board_version") - behind).toBeGreaterThanOrEqual(8);

    wall.world.serverLagBlocks = 2;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wall.controller.serverLive()).toBe(true);
  });

  it("stops trusting a server that stays silent while the chain's version moves", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    await vi.advanceTimersByTimeAsync(2 * 60_000); // quiet, and the version is steady
    expect(wall.controller.serverLive()).toBe(true);
    wall.world.version += 1; // a paint the server never pushes
    await vi.advanceTimersByTimeAsync(60_000); // first check: suspicious
    expect(wall.controller.serverLive()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); // second check: still nothing
    expect(wall.controller.serverLive()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.named("get_pixels")).toBe(1);
  });

  it("a pushed draw explains a version change, so the server stays live", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    wall.world.version += 1;
    await vi.advanceTimersByTimeAsync(60_000);
    wall.sockets.last().push(
      `{"type":"draw","signer":"bob.testnet","block_height":20000,"block_timestamp_ms":9000,"receipt_id":"late","pixels":[]}`,
    );
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(wall.controller.serverLive()).toBe(true);
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
  });

  it("measures lag from the applied watermark, so a dead consumer is not live", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    // The indexer stays current; only the consumer has stopped applying. A check that reads
    // last_processed_block alone would call this server healthy and freeze the wall.
    wall.world.appliedLagBlocks = SERVER_MAX_LAG_BLOCKS + 200;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wall.controller.serverLive()).toBe(false);
    const behind = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(10 * BOARD_POLL_BASE_MS);
    expect(wall.named("get_board_version") - behind).toBeGreaterThanOrEqual(8);
  });

  it("stops trusting a server whose consumer reports degraded or stalled", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    wall.world.healthStatus = "stalled";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wall.controller.serverLive()).toBe(false);
    // Back to today's path: the copy came from the server, so the fallback walks the chain.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.named("get_pixels")).toBe(1);

    // The server recovers: a passing check makes it live again.
    wall.world.healthStatus = "ok";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wall.controller.serverLive()).toBe(true);
  });
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const HOUR = 60 * 60_000;

describe("board server: paint hint", () => {
  it("a confirmed paint hints the server once per stroke, so its indexer looks now", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const hints = () => wall.world.serverPaths.filter((p) => p === "/api/hint").length;
    expect(hints()).toBe(0);
    const pixel = { x: 3, y: 4, color: 2, artist: "me.testnet", written_at_ns: "9" } as never;
    wall.controller.rememberPixel(pixel, 10_100);
    wall.controller.rememberPixel(pixel, 10_100);
    wall.controller.rememberPixel(pixel, 10_101);
    await vi.advanceTimersByTimeAsync(100);
    expect(hints()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    wall.controller.rememberPixel(pixel, 10_110);
    await vi.advanceTimersByTimeAsync(100);
    expect(hints()).toBe(2);
  });

  it("without a server, a paint sends no hint anywhere", async () => {
    const { world } = stubWorld();
    const wall = mount(false);
    liveDispose = wall.dispose;
    await settle(wall.controller.bootstrap());
    wall.controller.rememberPixel({ x: 3, y: 4, color: 2, artist: "me.testnet", written_at_ns: "9" } as never, 10_100);
    await vi.advanceTimersByTimeAsync(100);
    expect(world.serverPaths).toEqual([]);
  });
});

describe("board server: the socket closes when nobody is watching", () => {
  // The server counts open sockets as viewers and polls the chain only while it has one,
  // so a hidden or forgotten tab must not hold its socket open.

  it("a hidden tab closes the socket, never reconnects, reads no chain; visible reopens and catches up", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const socket = wall.sockets.last();
    const created = wall.sockets.sockets.length;
    const chainBefore = chainRequestCount();

    setVisibility("hidden");
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(wall.sockets.sockets.length).toBe(created);
    expect(chainRequestCount() - chainBefore).toBe(0);
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);

    setVisibility("visible");
    expect(wall.sockets.sockets.length).toBe(created + 1);
    wall.sockets.last().accept();
    expect(wall.sockets.last().sent).toEqual([{ type: "catch_up", since_timestamp_ms: 5000 }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.controller.serverLive()).toBe(true);
    // Resumed exactly as a reconnect: the trust check, not a chain walk.
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
  });

  it("an untouched visible tab closes the socket after BOARD_IDLE_PAUSE_MS and stays closed until input", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const socket = wall.sockets.last();
    await vi.advanceTimersByTimeAsync(BOARD_IDLE_PAUSE_MS);
    expect(socket.readyState).toBe(3);

    const created = wall.sockets.sockets.length;
    const chainBefore = chainRequestCount();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(wall.sockets.sockets.length).toBe(created);
    expect(chainRequestCount() - chainBefore).toBe(0);

    window.dispatchEvent(new Event("pointermove"));
    expect(wall.sockets.sockets.length).toBe(created + 1);
    wall.sockets.last().accept();
    expect(wall.sockets.last().sent).toEqual([{ type: "catch_up", since_timestamp_ms: 5000 }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.controller.serverLive()).toBe(true);
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
  });

  it("a deliberate idle close does not switch the wall to chain-polling fallback", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const status = document.getElementById("status")!;
    await vi.advanceTimersByTimeAsync(BOARD_IDLE_PAUSE_MS);
    expect(wall.sockets.last().readyState).toBe(3);
    const versions = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(20 * BOARD_POLL_BASE_MS);
    expect(wall.named("get_board_version")).toBe(versions);
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
    expect(status.textContent).not.toMatch(/polling the chain/);
    expect(document.getElementById("fresh")!.textContent).toMatch(/paused while you're away/);
  });

  it("falls back to polling if the reopened socket never opens within the grace period", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility("visible");
    // The new socket is never accepted: the server is down now.
    await vi.advanceTimersByTimeAsync(SERVER_RESUME_GRACE_MS + 1_000);
    expect(wall.controller.serverLive()).toBe(false);
    expect(wall.named("get_pixels")).toBe(1);
    const polled = wall.named("get_board_version");
    await vi.advanceTimersByTimeAsync(10 * BOARD_POLL_BASE_MS);
    expect(wall.named("get_board_version") - polled).toBeGreaterThanOrEqual(8);
  });

  it("after a gap longer than catch-up history covers, re-checks /api/regions on resume", async () => {
    const wall = await liveWall();
    liveDispose = wall.dispose;
    const metaReads = () => wall.world.serverPaths.filter((p) => p === "/api/regions?coords=0,0").length;
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(metaReads()).toBe(1); // a short gap trusts catch_up alone
    wall.sockets.last().accept();
    await vi.advanceTimersByTimeAsync(1_000);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(SERVER_CATCH_UP_SAFE_MS + 60_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(metaReads()).toBe(2);
    wall.sockets.last().accept();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wall.controller.serverLive()).toBe(true);
    expect(wall.named("get_pixels"), JSON.stringify(wall.world.walks)).toBe(0);
  });
});
