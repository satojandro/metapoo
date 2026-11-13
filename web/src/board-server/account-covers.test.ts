import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountCoversReader, parseAccountCovers } from "./account-covers";

const BASE = "https://board.unit.test";

afterEach(() => vi.useRealTimers());

describe("account covers: the response shape", () => {
  it("accepts the contract's shape", () => {
    expect(
      parseAccountCovers({
        count: 14,
        by: [{ account: "misfits-validator.near", tiles: 9 }, { account: "egg.near", tiles: 5 }],
        first: { x: 12, y: 40 },
      }),
    ).toEqual({
      count: 14,
      by: [{ account: "misfits-validator.near", tiles: 9 }, { account: "egg.near", tiles: 5 }],
      first: { x: 12, y: 40 },
    });
  });

  it("accepts nothing covered: count 0, no coverers, first null", () => {
    expect(parseAccountCovers({ count: 0, by: [], first: null })).toEqual({ count: 0, by: [], first: null });
  });

  it("accepts coverers adding up to more than the count (one tile covered by two accounts)", () => {
    const body = {
      count: 2,
      by: [
        { account: "a.near", tiles: 2 },
        { account: "b.near", tiles: 1 },
      ],
      first: { x: 1, y: 1 },
    };
    expect(parseAccountCovers(body)?.by).toEqual(body.by);
  });

  it("sorts coverers by tiles even if the server did not", () => {
    expect(
      parseAccountCovers({ count: 4, by: [{ account: "b.near", tiles: 1 }, { account: "a.near", tiles: 3 }], first: { x: 0, y: 0 } })?.by,
    ).toEqual([{ account: "a.near", tiles: 3 }, { account: "b.near", tiles: 1 }]);
  });

  it.each([
    ["not an object", "14"],
    ["null", null],
    ["an array", [1]],
    ["count missing", { by: [], first: null }],
    ["count as a string", { count: "3", by: [], first: { x: 1, y: 1 } }],
    ["negative count", { count: -1, by: [], first: null }],
    ["fractional count", { count: 1.5, by: [], first: { x: 1, y: 1 } }],
    ["by missing", { count: 0, first: null }],
    ["a coverer with no name", { count: 1, by: [{ account: "", tiles: 1 }], first: { x: 1, y: 1 } }],
    ["a coverer with zero tiles", { count: 1, by: [{ account: "a.near", tiles: 0 }], first: { x: 1, y: 1 } }],
    ["a coverer that is not an object", { count: 1, by: ["a.near"], first: { x: 1, y: 1 } }],
    ["one coverer with more tiles than the count", { count: 2, by: [{ account: "a.near", tiles: 3 }], first: { x: 1, y: 1 } }],
    ["a count with no first tile", { count: 3, by: [{ account: "a.near", tiles: 3 }], first: null }],
    ["a first tile with nothing covered", { count: 0, by: [], first: { x: 1, y: 1 } }],
    ["coverers with nothing covered", { count: 0, by: [{ account: "a.near", tiles: 1 }], first: null }],
    ["a first tile with a bad coordinate", { count: 1, by: [{ account: "a.near", tiles: 1 }], first: { x: -1, y: 1 } }],
    ["a first tile that is a string", { count: 1, by: [{ account: "a.near", tiles: 1 }], first: "1,1" }],
  ])("rejects %s", (_label, body) => {
    expect(parseAccountCovers(body)).toBeNull();
  });
});

describe("account covers: the request", () => {
  it("unset VITE_BOARD_SERVER_URL: no reader at all, so no request can be made", () => {
    expect(createAccountCoversReader({ baseUrl: "" })).toBeNull();
    expect(createAccountCoversReader({ baseUrl: "///" })).toBeNull();
  });

  it("asks for the account and since_ms, and returns the parsed answer", async () => {
    const fetcher = vi.fn(async () => Response.json({ count: 3, by: [{ account: "b.near", tiles: 3 }], first: { x: 4, y: 5 } }));
    const read = createAccountCoversReader({ baseUrl: `${BASE}/`, fetcher: fetcher as unknown as typeof fetch })!;
    expect(await read("me.near", 1_700_000_000_123.7)).toEqual({ count: 3, by: [{ account: "b.near", tiles: 3 }], first: { x: 4, y: 5 } });
    const url = new URL(String((fetcher.mock.calls[0] as unknown[])[0]));
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/api/account-covers`);
    expect(url.searchParams.get("account")).toBe("me.near");
    expect(url.searchParams.get("since_ms")).toBe("1700000000123");
  });

  it("escapes the account id in the query", async () => {
    const fetcher = vi.fn(async () => Response.json({ count: 0, by: [], first: null }));
    const read = createAccountCoversReader({ baseUrl: BASE, fetcher: fetcher as unknown as typeof fetch })!;
    await read("a&b=c.near", 0);
    const url = new URL(String((fetcher.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("account")).toBe("a&b=c.near");
    expect(url.searchParams.has("b")).toBe(false);
  });

  it("an HTTP error, a network error, a non-JSON body and a bad shape are all unavailable", async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => new Response("down", { status: 503 }),
      async () => { throw new TypeError("Failed to fetch"); },
      async () => new Response("<html>", { status: 200 }),
      async () => Response.json({ count: 3, by: [], first: null }),
    ];
    for (const answer of answers) {
      const read = createAccountCoversReader({ baseUrl: BASE, fetcher: answer as unknown as typeof fetch })!;
      await expect(read("me.near", 0)).resolves.toBeNull();
    }
  });

  it("a server that never answers is unavailable after the timeout, even if the fetcher ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const read = createAccountCoversReader({ baseUrl: BASE, fetcher: fetcher as unknown as typeof fetch, timeoutMs: 1_000 })!;
    const pending = read("me.near", 0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeNull();
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal?.aborted).toBe(true);
  });

  it("refuses a bad since or an empty account without a request", async () => {
    const fetcher = vi.fn();
    const read = createAccountCoversReader({ baseUrl: BASE, fetcher: fetcher as unknown as typeof fetch })!;
    expect(await read("", 0)).toBeNull();
    expect(await read("me.near", Number.NaN)).toBeNull();
    expect(await read("me.near", -5)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
