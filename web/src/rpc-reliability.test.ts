import { afterEach, expect, it, vi } from "vitest";
import { viewFunction } from "./contract";
vi.mock("./config", () => ({ CONTRACT_ID: "board5.metapoo-player1.testnet", RPC_URL: "https://rpc.testnet.fastnear.com" }));
afterEach(() => vi.unstubAllGlobals());
it("reads board5 through a backup when the primary rate limits", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { result: [49] } })));
  vi.stubGlobal("fetch", fetcher);
  expect(await viewFunction("get_cell_cost", { x: 1, y: 1 })).toBe(1);
  expect(fetcher.mock.calls[1]?.[0]).toBe("https://rpc.testnet.near.org");
  const request = JSON.parse(fetcher.mock.calls[1]?.[1].body);
  expect(request.params.account_id).toBe("board5.metapoo-player1.testnet");
});
