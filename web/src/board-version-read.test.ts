import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  CONTRACT_ID: "board.unit.testnet",
  RPC_URL: "https://rpc.unit.test",
  rpcHeaders: () => ({ "Content-Type": "application/json" }),
}));

type Rpc = { method: string; params: Record<string, unknown> };

/** A one-page board at block 100, whose `get_board_version` is `version` (or missing). */
function stubChain(version: number | "missing") {
  const calls: Rpc[] = [];
  const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Rpc;
    calls.push(body);
    if (body.method === "block") {
      return new Response(JSON.stringify({ result: { header: { height: 120 } } }));
    }
    const method = body.params.method_name;
    if (method === "get_board_version") {
      if (version === "missing") {
        return new Response(JSON.stringify({
          result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", block_height: 100 },
        }));
      }
      return new Response(JSON.stringify({ result: { result: bytes(version), block_height: 100 } }));
    }
    if (method === "get_pixels") {
      const page = {
        pixels: [{ x: 1, y: 2, color: 3, artist: "a.testnet", written_at_ns: "5" }],
        from_index: 0, limit: 256, total: 1, next_from_index: null,
      };
      return new Response(JSON.stringify({ result: { result: bytes(page), block_height: Number(body.params.block_id) } }));
    }
    throw new Error(`unexpected ${body.method} ${String(method)}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const named = (name: string) => calls.filter(c => c.params?.method_name === name || c.method === name);
  return { calls, named };
}

// The shared read transport keeps per-endpoint health; a fresh module keeps tests apart.
async function load() {
  vi.resetModules();
  return import("./contract");
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe("fetchAllPaintedPixels with the board version", () => {
  it("stops after one small call when the version is the one the caller holds", async () => {
    const chain = stubChain(12);
    const { fetchAllPaintedPixels } = await load();
    const read = await fetchAllPaintedPixels({ knownVersion: 12 });
    expect(read).toEqual({ unchanged: true, blockHeight: 100, version: 12 });
    expect(chain.calls).toHaveLength(1);
    expect(chain.named("get_pixels")).toHaveLength(0);
    expect(chain.named("block")).toHaveLength(0);
  });

  it("walks the pixels at the block the new version was read at, with no separate block call", async () => {
    const chain = stubChain(13);
    const { fetchAllPaintedPixels } = await load();
    const read = await fetchAllPaintedPixels({ knownVersion: 12 });
    expect(read.unchanged).toBeFalsy();
    if (read.unchanged) throw new Error("unreachable");
    expect(read.version).toBe(13);
    expect(read.blockHeight).toBe(100);
    expect(read.pixels).toHaveLength(1);
    expect(chain.named("block")).toHaveLength(0);
    // Pinned to the version's block: the version and the cells describe the same moment.
    expect(chain.named("get_pixels").map(c => c.params.block_id)).toEqual([100]);
  });

  it("always walks on a first load, even when it learns the version", async () => {
    const chain = stubChain(12);
    const { fetchAllPaintedPixels } = await load();
    const read = await fetchAllPaintedPixels();
    expect(read.unchanged).toBeFalsy();
    expect(chain.named("get_pixels")).toHaveLength(1);
  });

  it("falls back to the full walk on a board without the view, and stops asking for it", async () => {
    const chain = stubChain("missing");
    const { fetchAllPaintedPixels } = await load();
    const first = await fetchAllPaintedPixels({ knownVersion: 12 });
    expect(first.unchanged).toBeFalsy();
    if (first.unchanged) throw new Error("unreachable");
    expect(first.version).toBeNull();
    // The old pin: a block call first, then the pages at that height.
    expect(chain.named("block")).toHaveLength(1);
    expect(chain.named("get_pixels").map(c => c.params.block_id)).toEqual([120]);
    await fetchAllPaintedPixels({ knownVersion: null });
    expect(chain.named("get_board_version")).toHaveLength(1);
  });
});
