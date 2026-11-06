import { afterEach, describe, expect, it, vi } from "vitest";
import { FinalBlockJsonRpcProvider } from "./final-block-provider";
import { fetchLatestBlockHeight } from "./contract";

/**
 * Both cases fix the same failure (2026-11-06): the wall signed and pinned reads at
 * `finality: "optimistic"`, and a node that had not stored that block answered
 * `UNKNOWN_BLOCK: DB Not Found Error: BLOCK_HEIGHT: …`. A transaction signed against
 * such a hash is rejected after signing; a page pinned to such a height cannot load.
 * Both now ask for `final`.
 */
describe("signing and pinning use a finalized block", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("turns near-api-js's optimistic block query into a final one", async () => {
    const provider = new FinalBlockJsonRpcProvider({ url: "https://rpc.example" });
    const send = vi
      .spyOn(provider, "sendJsonRpc")
      .mockResolvedValue({ header: { height: 1, hash: "h" } } as never);

    await provider.viewBlock({ finality: "optimistic" });
    expect(send).toHaveBeenLastCalledWith("block", { block_id: undefined, finality: "final" });

    // A finality the caller chose explicitly is left alone, and so is a hash query.
    await provider.viewBlock({ finality: "final" });
    expect(send).toHaveBeenLastCalledWith("block", { block_id: undefined, finality: "final" });

    await provider.viewBlock({ blockId: "abc" });
    expect(send).toHaveBeenLastCalledWith("block", { block_id: "abc", finality: undefined });
  });

  it("asks the RPC for a final block height before pinning a board walk", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "metapoo-block",
      result: { header: { height: 223258600 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchLatestBlockHeight()).toBe(223258600);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ method: "block", params: { finality: "final" } });
  });
});
