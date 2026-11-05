import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTransport } from "./read-rpc";
const request = (method = "get_cell_cost", extra = {}) => ({ method: "POST", body: JSON.stringify({
  id: "test", method: "query", params: { account_id: "board5.metapoo-player1.testnet", method_name: method, block_id: 123, ...extra },
}) });
const reply = () => new Response('{"result":1}');
afterEach(() => vi.useRealTimers());
describe("read transport", () => {
  it("shares concurrent identical reads but never caches a completed price", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const read = createReadTransport({ fetcher, spacingMs: 0 });
    const [a, b] = await Promise.all([read("primary", request()), read("primary", request())]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await a.json()).toEqual(await b.json());
    await read("primary", request());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("backs off a CORS-hidden failure and preserves pinned block and account on fallback", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => reply());
    const read = createReadTransport({ fetcher, fallback: "backup", spacingMs: 0 });
    await read("primary", request());
    await read("primary", request("get_credits"));
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(["primary", "backup", "backup"]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).params).toEqual(JSON.parse(request().body).params);
  });
  it("fails promptly during shared cooldown and probes again after it expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("busy", {status:429, headers:{"Retry-After":"10"}}));
    const read = createReadTransport({ fetcher, spacingMs: 0 });
    await expect(read("primary", request())).rejects.toThrow("Network busy");
    await expect(read("primary", request())).rejects.toThrow("Network busy");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001);
    fetcher.mockImplementation(async () => reply());
    await read("primary", request());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never retries contract errors or sends a transaction", async () => {
    const fetcher = vi.fn(async () => new Response('{"error":{"message":"MethodNotFound"}}'));
    const read = createReadTransport({ fetcher, fallback: "backup", spacingMs: 0 });
    expect(await (await read("primary", request())).json()).toHaveProperty("error");
    await expect(read("primary", {body:JSON.stringify({method:"broadcast_tx_commit"})})).rejects.toThrow("refuses");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("prioritizes a paint read over queued background work", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const read = createReadTransport({ fetcher, spacingMs: 200 });
    const first = read("primary", request("get_board"), 1);
    const background = read("primary", request("get_pixels"), 1);
    const paint = read("primary", request("get_stroke_cost"));
    await vi.runAllTimersAsync();
    await Promise.all([first, background, paint]);
    expect(fetcher.mock.calls.map(c => JSON.parse(String(c[1]?.body)).params.method_name))
      .toEqual(["get_board", "get_stroke_cost", "get_pixels"]);
  });
  it("one aborted subscriber cannot cancel a shared read", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const read = createReadTransport({ fetcher, spacingMs: 0 });
    const controller = new AbortController();
    const first = read("primary", {...request(), signal: controller.signal});
    const other = read("primary", request());
    const rejected = expect(first).rejects.toThrow();
    controller.abort();
    finish(reply());
    await rejected;
    expect(await (await other).json()).toEqual({result:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("attaches the configured key to its own host and never to the fallback", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(async () => reply());
    const read = createReadTransport({
      fetcher,
      fallback: "https://rpc.testnet.near.org",
      spacingMs: 0,
      apiKey: "test-key",
    });
    await read("https://rpc.testnet.fastnear.com", request());
    const headersOf = (call: number) => fetcher.mock.calls[call]![1].headers as Headers;
    expect(headersOf(0).get("authorization")).toBe("Bearer test-key");
    expect(headersOf(1).get("authorization")).toBeNull();
  });
});
