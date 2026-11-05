import { describe, expect, it, vi } from "vitest";
import {
  aggregateLedger,
  BOARD_TOTALS_LABEL,
  createBoardTotalsSource,
  createFastNearLedgerSource,
  createIndexedLedgerSource,
  createPreferredLedgerSource,
  FASTNEAR_ACCOUNT_PAGE,
  FASTNEAR_TX_BATCH,
  eventsFromTxStatus,
  fastnearTxBase,
  isRevenueTransferArgs,
  LedgerUnavailable,
  loadBuybackLedger,
  parseBuybackTotals,
  parseLedgerLog,
  type LedgerEvent,
  type LedgerHistory,
  type LedgerSource,
} from "./buyback-ledger";

const BOARD = "board3.metapoo-player1.testnet";
const BUYBACK = "buyback.metapoo-player1.testnet";
const TEAM = "team.metapoo-player1.testnet";
const TOKEN = "metapoo-mpoo.testnet";
const NEAR = 10n ** 24n;
const MPOO = 10n ** 18n;

/** The exact line `Board::safety_event` writes (contracts/paid-board/src/safety.rs). */
const eventLog = (event: string, data: Record<string, unknown>, version = "1.0.0") =>
  `EVENT_JSON:${JSON.stringify({ standard: "mpoo_payments", version, event, data: [data] })}`;
const distributed = (amount: bigint, buyback = BUYBACK) => {
  const team = amount / 10n;
  return eventLog("near_distributed", {
    amount: String(amount), team_account: TEAM, team: String(team),
    buyback_account: buyback, buyback: String(amount - team), status: "scheduled",
  });
};
const legFailed = (account: string, amount: bigint) =>
  eventLog("near_distribution_leg_failed", { account, amount: String(amount) });
const legSent = (account: string, amount: bigint) =>
  eventLog("near_distribution_leg_sent", { account, amount: String(amount) });
const returned = (amount: bigint) => eventLog("mpoo_revenue_received", { sender_id: BUYBACK, amount: String(amount) });

const receipt = (id: string, executor: string, logs: string[], status: Record<string, unknown> = { SuccessValue: "" }) =>
  ({ id, outcome: { executor_id: executor, logs, status } });
const txStatus = (...receipts: unknown[]) => ({ receipts_outcome: receipts });

describe("parseLedgerLog", () => {
  it("reads the board's near_distributed and mpoo_revenue_received shapes exactly", () => {
    expect(parseLedgerLog(distributed(10n * NEAR))).toEqual([{
      kind: "near_distributed", amount: 10n * NEAR, team: NEAR, buyback: 9n * NEAR, teamAccount: TEAM, buybackAccount: BUYBACK,
    }]);
    expect(parseLedgerLog(returned(5n * MPOO))).toEqual([{ kind: "mpoo_revenue_received", senderId: BUYBACK, amount: 5n * MPOO }]);
    expect(parseLedgerLog(legFailed(BUYBACK, 9n))).toEqual([{ kind: "near_leg_failed", account: BUYBACK, amount: 9n }]);
  });

  it("ignores ordinary logs, other standards and payment events it doesn't count", () => {
    expect(parseLedgerLog("revenue_rejected: NotBuybackAccount")).toEqual([]);
    expect(parseLedgerLog(legSent(BUYBACK, 9n))).toEqual([]);
    expect(parseLedgerLog(`EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{}] })}`)).toEqual([]);
    expect(parseLedgerLog(`EVENT_JSON:${JSON.stringify({ standard: "mpoo_board", version: "1.0.0", event: "near_distributed", data: [{}] })}`)).toEqual([]);
  });

  it("refuses a counted event in a shape it doesn't know rather than undercounting", () => {
    expect(() => parseLedgerLog(returned(1n).replace('"1.0.0"', '"2.0.0"'))).toThrow(/unknown event version/);
    expect(() => parseLedgerLog(eventLog("mpoo_revenue_received", { sender_id: BUYBACK, amount: 5 }))).toThrow(/U128/);
    expect(() => parseLedgerLog(eventLog("near_distributed", {
      amount: "10", team_account: TEAM, team: "1", buyback_account: BUYBACK, buyback: "8", status: "scheduled",
    }))).toThrow(/differs/);
  });
});

describe("eventsFromTxStatus", () => {
  it("counts only successful receipts executed by the board", () => {
    const events = eventsFromTxStatus(txStatus(
      receipt("r1", BOARD, ["hello", distributed(10n * NEAR)]),
      receipt("r2", TOKEN, [returned(MPOO)]), // somebody else's log
      receipt("r3", BOARD, [returned(MPOO)], { Failure: { ActionError: {} } }), // rolled back
      receipt("r4", BOARD, [returned(2n * MPOO)], { SuccessReceiptId: "x" }),
    ), BOARD, "tx1");
    expect(events.map(e => [e.kind, e.receiptId, e.txHash])).toEqual([
      ["near_distributed", "r1", "tx1"], ["mpoo_revenue_received", "r4", "tx1"],
    ]);
  });
  it("throws on a result with no receipts", () => {
    expect(() => eventsFromTxStatus({}, BOARD, "tx")).toThrow(/receipts_outcome/);
  });
});

describe("aggregateLedger", () => {
  const ev = (tx: string, ...logs: string[]): LedgerEvent[] =>
    eventsFromTxStatus(txStatus(...logs.map((l, i) => receipt(`${tx}-r${i}`, BOARD, [l]))), BOARD, tx);

  it("sums the buyback share of every split and every accepted return", () => {
    const totals = aggregateLedger([
      ...ev("a", distributed(10n * NEAR), legSent(TEAM, NEAR), legSent(BUYBACK, 9n * NEAR)),
      ...ev("b", distributed(20n * NEAR)),
      ...ev("c", returned(100n * MPOO)),
      ...ev("d", returned(50n * MPOO)),
    ]);
    expect(totals).toEqual({ nearToBuyback: 27n * NEAR, nearDistributions: 2, mpooReturned: 150n * MPOO, mpooReturns: 2 });
  });

  it("takes out a failed buyback leg (it is refunded and resent later), not a failed team leg", () => {
    const totals = aggregateLedger([
      ...ev("a", distributed(10n * NEAR), legFailed(BUYBACK, 9n * NEAR)),
      ...ev("b", distributed(10n * NEAR), legFailed(TEAM, NEAR)),
      // The resend: the same NEAR, counted once.
      ...ev("c", distributed(10n * NEAR)),
    ]);
    expect(totals.nearToBuyback).toBe(18n * NEAR);
    expect(totals.nearDistributions).toBe(3);
  });

  it("only matches a failure to the split in its own transaction", () => {
    const totals = aggregateLedger([...ev("a", distributed(10n * NEAR)), ...ev("b", legFailed(BUYBACK, 9n * NEAR))]);
    expect(totals.nearToBuyback).toBe(9n * NEAR);
  });

  it("counts a transaction read twice once", () => {
    const a = ev("a", distributed(10n * NEAR), returned(MPOO));
    expect(aggregateLedger([...a, ...a])).toEqual({ nearToBuyback: 9n * NEAR, nearDistributions: 1, mpooReturned: MPOO, mpooReturns: 1 });
  });

  it("no events is a real zero", () => {
    expect(aggregateLedger([])).toEqual({ nearToBuyback: 0n, nearDistributions: 0, mpooReturned: 0n, mpooReturns: 0 });
  });
});

it("recognises the board's revenue message in ft_on_transfer args", () => {
  expect(isRevenueTransferArgs(JSON.stringify({ sender_id: BUYBACK, amount: "1", msg: '{"revenue":{}}' }))).toBe(true);
  expect(isRevenueTransferArgs(JSON.stringify({ sender_id: "a.testnet", amount: "1", msg: '{"credits":{}}' }))).toBe(false);
  expect(isRevenueTransferArgs(JSON.stringify({ sender_id: "a.testnet", amount: "1", msg: "" }))).toBe(null);
  expect(isRevenueTransferArgs(undefined)).toBe(null);
});

describe("createIndexedLedgerSource", () => {
  const hash = (n: number) => String(n).padStart(2, "1").repeat(22).slice(0, 44).replace(/0/g, "z");
  const row = (n: number, method: string, extra: Record<string, unknown> = {}) => ({
    transaction_hash: hash(n), receiver_account_id: BOARD, predecessor_account_id: method === "ft_on_transfer" ? TOKEN : "keeper.testnet",
    receipt_outcome: { status: true },
    actions: [{ action: "FUNCTION_CALL", method, args: method === "ft_on_transfer"
      ? JSON.stringify({ sender_id: BUYBACK, amount: "1", msg: '{"revenue":{}}' }) : "{}" }],
    ...extra,
  });

  const NOW_MS = 1_793_000_000_000;
  const head = (lagMs: number) => ({ ok: true, json: async () => ({ blocks: [{ block_timestamp: `${BigInt(NOW_MS - lagMs) * 1_000_000n}` }] }) });
  const source = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof createIndexedLedgerSource>[0]> = {}) =>
    createIndexedLedgerSource({ network: "testnet", board: BOARD, mpooToken: TOKEN, fetch, now: () => NOW_MS, ...extra })!;

  function stubFetch(index: Record<string, unknown[]>, txs: Record<string, unknown>, lagMs = 5_000) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/blocks/latest")) return head(lagMs);
      if (url.includes("nearblocks")) {
        const method = new URL(url).searchParams.get("method")!;
        return { ok: true, json: async () => ({ txns: index[method] ?? [] }) };
      }
      const { params } = JSON.parse(String(init!.body)) as { params: { tx_hash: string; sender_account_id: string } };
      expect(params.sender_account_id).toBe(BOARD);
      return { ok: true, json: async () => ({ result: txs[params.tx_hash] }) };
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }

  it("reads logs only for splits and revenue returns, skipping mPOO purchases and other receivers", async () => {
    const purchase = row(3, "ft_on_transfer", { actions: [{ method: "ft_on_transfer", args: JSON.stringify({ sender_id: "p.testnet", amount: "1", msg: '{"credits":{}}' }) }] });
    const fetch = stubFetch(
      {
        distribute_near: [row(1, "distribute_near"), row(9, "distribute_near", { receiver_account_id: "other.testnet" })],
        ft_on_transfer: [row(2, "ft_on_transfer"), purchase, row(4, "ft_on_transfer", { predecessor_account_id: "fake-token.testnet" })],
      },
      {
        [hash(1)]: txStatus(receipt("r1", BOARD, [distributed(10n * NEAR)])),
        [hash(2)]: txStatus(receipt("r2", BOARD, [returned(7n * MPOO)])),
      },
    );
    const s = source(fetch);
    const scan = await s.scan();
    expect(scan.complete).toBe(true);
    expect(scan.transactions).toBe(2);
    expect(scan.indexedThroughMs).toBe(NOW_MS - 5_000);
    expect(scan.origin).toBe("index");
    expect(scan.totals).toMatchObject({ nearToBuyback: 9n * NEAR, mpooReturned: 7n * MPOO, nearDistributions: 1, mpooReturns: 1 });
    const urls = fetch.mock.calls.map(c => String(c[0]));
    expect(urls.filter(u => u.includes("api-testnet.nearblocks.io/v1/account/")).length).toBe(2);
    expect(urls.filter(u => u.includes("archival-rpc.testnet.near.org")).length).toBe(2);
    // Logs are final: a second scan reads the index again but no transaction twice.
    await s.scan();
    expect(fetch.mock.calls.map(c => String(c[0])).filter(u => u.includes("archival")).length).toBe(2);
  });

  it("marks a scan incomplete when the index has more than it pages through", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i + 10, "distribute_near"));
    const paged = vi.fn(async (url: string) => url.includes("/v1/blocks/latest") ? head(0) : url.includes("nearblocks")
      ? { ok: true, json: async () => ({ txns: url.includes("distribute_near") ? full : [], cursor: "next" }) }
      : { ok: true, json: async () => ({ result: txStatus() }) }) as unknown as typeof fetch;
    const scan = await source(paged, { maxPages: 1, maxTransactions: 5 }).scan();
    expect(scan.complete).toBe(false);
    expect(scan.transactions).toBe(5);
  });

  it("an index a few hours behind gives lower bounds; one that has stopped gives no figure", async () => {
    const rows = { distribute_near: [row(1, "distribute_near")] };
    const txs = { [hash(1)]: txStatus(receipt("r1", BOARD, [distributed(10n * NEAR)])) };
    expect((await source(stubFetch(rows, txs, 3 * 3_600_000)).scan()).complete).toBe(false);
    // Testnet NearBlocks on 2026-11-02 had stopped at 2026-09-27: totals from it would read 0.
    const stalledFetch = stubFetch(rows, txs, 36 * 86_400_000);
    const stalled = source(stalledFetch);
    await expect(stalled.scan()).rejects.toBeInstanceOf(LedgerUnavailable);
    await expect(stalled.scan()).rejects.toThrow(/stopped at/);
    // Nothing else is asked of a stopped index.
    expect(stalledFetch.mock.calls.every(c => String(c[0]).includes("/v1/blocks/latest"))).toBe(true);
  });

  it("fails the scan when the index or a transaction can't be read", async () => {
    const down = vi.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(source(down).scan()).rejects.toThrow(/429/);
    const gone = stubFetch({ distribute_near: [row(1, "distribute_near")] }, {});
    await expect(source(gone).scan()).rejects.toThrow(/receipts_outcome/);
  });

  it("has no source where there is no public index", () => {
    expect(createIndexedLedgerSource({ network: "localnet", board: BOARD, mpooToken: TOKEN })).toBeNull();
  });
});


describe("createFastNearLedgerSource", () => {
  // Base58 has no 0, O, I or l: skip them so the hash passes the real TX_HASH check.
  const B58 = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const txHash = (n: number) => (B58[Math.floor(n / B58.length)] + B58[n % B58.length]).repeat(20).slice(0, 40);
  const NOW_MS = 1_793_000_000_000;
  const statusHead = (lagMs: number) => ({
    ok: true,
    json: async () => ({ status: "ok", latest_block_timestamp: `${BigInt(NOW_MS - lagMs) * 1_000_000n}` }),
  });
  /** One transaction as the index returns it: RPC-shaped, receipts carry their own outcome. */
  const indexTx = (hash: string, receipts: unknown[], top: unknown = receipt("top", "keeper.testnet", [])) => ({
    transaction: { hash, signer_id: "keeper.testnet", receiver_id: BOARD },
    execution_outcome: top,
    receipts: receipts.map(r => ({ execution_outcome: r })),
  });
  const accountRow = (hash: string, ok = true) => ({ transaction_hash: hash, is_success: ok });

  const source = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof createFastNearLedgerSource>[0]> = {}) =>
    createFastNearLedgerSource({ network: "testnet", board: BOARD, buybackAccount: BUYBACK, fetch, now: () => NOW_MS, ...extra })!;

  function stubFetch(
    pages: Array<{ rows: unknown[]; resume_token?: string }>,
    txs: Record<string, unknown>,
    lagMs = 5_000,
  ) {
    const bodies: unknown[] = [];
    const statusHeaders: Array<Record<string, string>> = [];
    const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) {
        statusHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return statusHead(lagMs);
      }
      if (url.endsWith("/v0/account")) {
        const page = pages.shift() ?? { rows: [] };
        bodies.push(JSON.parse(String(init!.body)));
        return { ok: true, json: async () => ({ account_txs: page.rows, txs_count: page.rows.length, resume_token: page.resume_token }) };
      }
      const body = JSON.parse(String(init!.body)) as { tx_hashes: string[] };
      bodies.push(body);
      return { ok: true, json: async () => ({ transactions: body.tx_hashes.map(h => txs[h]).filter(Boolean) }) };
    }) as unknown as typeof globalThis.fetch & { mock: { calls: Array<[string, RequestInit?]> } };
    return { fetch: doFetch, bodies, statusHeaders };
  }

  it("counts a split whose event data never names the board, and never relies on is_event_log", async () => {
    // The bug this replaces: `is_event_log` means "named in an event", and a split's data
    // holds team_account + buyback_account, never the board. On 2026-11-05 board5's 23
    // board-emitted event logs were flagged zero times.
    const h1 = txHash(1);
    const { fetch, bodies } = stubFetch(
      [{ rows: [{ ...accountRow(h1), is_event_log: false }] }],
      { [h1]: indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])]) },
    );
    const scan = await source(fetch).scan();
    expect(scan.totals.nearToBuyback).toBe(9n * NEAR);
    expect(scan.totals.nearDistributions).toBe(1);
    expect(scan.complete).toBe(true);
    // The listing is the buyback account's history, and it carries no event-log filter.
    expect(bodies[0]).toMatchObject({ account_id: BUYBACK, desc: true });
    expect((bodies[0] as Record<string, unknown>).is_event_log).toBeUndefined();
  });

  it("falls back to the board's function calls when the buyback account is unknown", async () => {
    const h1 = txHash(2);
    const { fetch, bodies } = stubFetch(
      [{ rows: [accountRow(h1)] }],
      { [h1]: indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])]) },
    );
    const scan = await createFastNearLedgerSource({
      network: "testnet", board: BOARD, fetch, now: () => NOW_MS,
    })!.scan();
    expect(scan.totals.nearToBuyback).toBe(9n * NEAR);
    expect(bodies[0]).toMatchObject({ account_id: BOARD, is_function_call: true });
  });

  it("sends no Content-Type on the status GET, so the scan needs no CORS preflight", async () => {
    const { fetch, statusHeaders } = stubFetch([{ rows: [] }], {});
    await source(fetch).scan();
    expect(statusHeaders).toHaveLength(1);
    expect(Object.keys(statusHeaders[0]!).map(k => k.toLowerCase())).not.toContain("content-type");
  });

  it("reads the split from event-log transactions in batches, not one request each", async () => {
    const h1 = txHash(3), h2 = txHash(4);
    const { fetch, bodies } = stubFetch(
      [{ rows: [accountRow(h1), accountRow(h2)] }],
      {
        [h1]: indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])]),
        [h2]: indexTx(h2, [receipt("r2", BOARD, [returned(7n * MPOO)])]),
      },
    );
    const scan = await source(fetch).scan();
    expect(scan.origin).toBe("index");
    expect(scan.transactions).toBe(2);
    expect(scan.indexedThroughMs).toBe(NOW_MS - 5_000);
    expect(scan.totals).toMatchObject({ nearToBuyback: 9n * NEAR, nearDistributions: 1, mpooReturned: 7n * MPOO, mpooReturns: 1 });
    // One listing page plus one batch for both transactions — no per-hash request.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ tx_hashes: [h1, h2] });
  });

  it("skips a transaction the index marks failed, and never re-reads a cached one", async () => {
    const h1 = txHash(5), h2 = txHash(6);
    const { fetch, bodies } = stubFetch(
      [{ rows: [accountRow(h1), accountRow(h2, false)] }],
      { [h1]: indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])]) },
    );
    const s = source(fetch);
    expect((await s.scan()).transactions).toBe(1);
    expect(bodies[1]).toEqual({ tx_hashes: [h1] });
    await s.scan();
    // Logs are final: the listing is read again, the transaction is not.
    expect(fetch.mock.calls.filter(c => String(c[0]).endsWith("/v0/transactions"))).toHaveLength(1);
  });

  it("leaves a split mid-flight out of the total, and re-reads it once its callback lands", async () => {
    const h1 = txHash(7);
    // The scheduled split has landed; the callback receipt that reports the failed buyback
    // leg has not been indexed yet, so `r2` is referenced but absent.
    const pending = indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])], {
      id: "top", outcome: { executor_id: "keeper.testnet", logs: [], status: { SuccessValue: "" }, receipt_ids: ["r1", "r2"] },
    });
    const settled = indexTx(
      h1,
      [receipt("r1", BOARD, [distributed(10n * NEAR)]), receipt("r2", BOARD, [legFailed(BUYBACK, 9n * NEAR)])],
      { id: "top", outcome: { executor_id: "keeper.testnet", logs: [], status: { SuccessValue: "" }, receipt_ids: ["r1", "r2"] } },
    );
    const replies = [pending, settled, settled];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) return statusHead(0);
      if (url.endsWith("/v0/account")) return { ok: true, json: async () => ({ account_txs: [accountRow(h1)] }) };
      JSON.parse(String(init!.body));
      return { ok: true, json: async () => ({ transactions: [replies.shift()] }) };
    }) as unknown as typeof globalThis.fetch & { mock: { calls: Array<[string, RequestInit?]> } };
    const s = source(fetch);

    const first = await s.scan();
    // Counted as nothing, not as a 9 NEAR split whose failure simply has not been seen yet.
    expect(first.totals.nearToBuyback).toBe(0n);
    expect(first.complete).toBe(false);
    expect(first.transactions).toBe(0);

    const second = await s.scan();
    expect(second.complete).toBe(true);
    expect(second.transactions).toBe(1);
    // 9 NEAR scheduled minus the 9 NEAR leg that failed: the callback was read because the
    // unfinished transaction was never cached.
    expect(second.totals.nearToBuyback).toBe(0n);
    expect(fetch.mock.calls.filter(c => String(c[0]).endsWith("/v0/transactions"))).toHaveLength(2);
  });

  it("pages with the index's own resume token and says when it stopped early", async () => {
    const h1 = txHash(8);
    const rows = Array.from({ length: FASTNEAR_ACCOUNT_PAGE }, () => accountRow(h1));
    const { fetch } = stubFetch(
      [{ rows, resume_token: "next" }, { rows, resume_token: "next" }],
      { [h1]: indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])]) },
    );
    const first = await source(fetch, { maxPages: 1 }).scan();
    expect(first.complete).toBe(false);
    expect(first.transactions).toBe(1);
    expect(first.totals.nearToBuyback).toBe(9n * NEAR);
  });

  it("stops at 20 hashes per transaction request", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => accountRow(txHash(i + 10)));
    const txs = Object.fromEntries(rows.map((r, i) => [r.transaction_hash, indexTx(r.transaction_hash, [receipt(`r${i}`, BOARD, [])])]));
    const { fetch, bodies } = stubFetch([{ rows }], txs);
    const scan = await source(fetch).scan();
    expect(scan.transactions).toBe(25);
    const batches = bodies.filter(b => (b as { tx_hashes?: unknown }).tx_hashes) as Array<{ tx_hashes: string[] }>;
    expect(batches.map(b => b.tx_hashes.length)).toEqual([FASTNEAR_TX_BATCH, 5]);
  });

  it("gives a lower bound when the index is hours behind, and no figure when it has stopped", async () => {
    const h1 = txHash(1);
    const rows = [{ rows: [accountRow(h1)] }];
    const txs = { [h1]: indexTx(h1, [receipt("r1", BOARD, [distributed(10n * NEAR)])]) };
    const behind = stubFetch([...rows], txs, 3 * 3_600_000);
    expect((await source(behind.fetch).scan()).complete).toBe(false);
    const stalledFetch = stubFetch([...rows], txs, 36 * 86_400_000);
    const stalled = source(stalledFetch.fetch);
    await expect(stalled.scan()).rejects.toBeInstanceOf(LedgerUnavailable);
    await expect(stalled.scan()).rejects.toThrow(/stopped at/);
    // A stopped index is not paged through at all.
    expect(stalledFetch.fetch.mock.calls.every(c => String(c[0]).endsWith("/status"))).toBe(true);
  });

  it("fails the scan when a listed hash comes back without its transaction", async () => {
    const { fetch } = stubFetch([{ rows: [accountRow(txHash(9))] }], {});
    await expect(source(fetch).scan()).rejects.toThrow(/no transaction for 1 of 1/);
  });

  it("has no source where FastNEAR does not index the network", () => {
    expect(createFastNearLedgerSource({ network: "localnet", board: BOARD })).toBeNull();
    expect(fastnearTxBase("mainnet")).toBe("https://tx.main.fastnear.com");
    expect(fastnearTxBase("testnet")).toBe("https://tx.test.fastnear.com");
  });
});

/** `createRpcView`'s error for a board deployed before the view existed (seen live on board3, 2026-11-03). */
const METHOD_NOT_FOUND = new Error("wasm execution failed with error: MethodResolveError(MethodNotFound)");
const boardView = (result: unknown | Error) => vi.fn(async (account: string, method: string) => {
  expect([account, method]).toEqual([BOARD, "get_buyback_totals"]);
  if (result instanceof Error) throw result;
  return result;
});
const fakeIndex = (): LedgerSource & { scan: ReturnType<typeof vi.fn> } => ({
  scan: vi.fn(async (): Promise<LedgerHistory> => ({
    origin: "index", label: "index", complete: false, transactions: 1, indexedThroughMs: 1,
    totals: { nearToBuyback: 1n, nearDistributions: 1, mpooReturned: 1n, mpooReturns: 1 },
  })),
});

describe("board totals (get_buyback_totals)", () => {
  it("parses decimal U128 strings exactly", () => {
    expect(parseBuybackTotals({ near_to_buyback: "340282366920938463463374607431768211455", mpoo_returned: "0" }))
      .toEqual({ nearToBuyback: (1n << 128n) - 1n, mpooReturned: 0n });
  });

  it.each([
    ["a number", { near_to_buyback: 5, mpoo_returned: "1" }],
    ["a negative", { near_to_buyback: "-5", mpoo_returned: "1" }],
    ["a decimal point", { near_to_buyback: "1.5", mpoo_returned: "1" }],
    ["hex", { near_to_buyback: "0x10", mpoo_returned: "1" }],
    ["an empty string", { near_to_buyback: "", mpoo_returned: "1" }],
    ["a missing field", { near_to_buyback: "1" }],
    ["not an object", ["1", "1"]],
    ["null", null],
  ])("refuses %s", (_, raw) => {
    expect(() => parseBuybackTotals(raw)).toThrow(/get_buyback_totals/);
  });

  it("view present: exact all-time figures, no lower bound, the index never asked", async () => {
    const index = fakeIndex();
    const source = createPreferredLedgerSource(
      createBoardTotalsSource(boardView({ near_to_buyback: `${27n * NEAR + 1n}`, mpoo_returned: `${150n * MPOO}` }), BOARD), index);
    const history = await source.scan();
    expect(history).toEqual({
      origin: "board", label: BOARD_TOTALS_LABEL, complete: true, transactions: null, indexedThroughMs: null,
      totals: { nearToBuyback: 27n * NEAR + 1n, nearDistributions: null, mpooReturned: 150n * MPOO, mpooReturns: null },
    });
    expect(source.lastTried).toBe("board");
    expect(index.scan).not.toHaveBeenCalled();
  });

  it("method missing: falls back to the index, with its own honesty rules", async () => {
    const index = fakeIndex();
    const source = createPreferredLedgerSource(createBoardTotalsSource(boardView(METHOD_NOT_FOUND), BOARD), index);
    expect(await source.scan()).toMatchObject({ origin: "index", complete: false });
    expect(source.lastTried).toBe("index");
    expect(index.scan).toHaveBeenCalledTimes(1);
  });

  it("method missing and no index on this network: unavailable, explained", async () => {
    const source = createPreferredLedgerSource(createBoardTotalsSource(boardView(METHOD_NOT_FOUND), BOARD), null);
    await expect(source.scan()).rejects.toThrow(/keeps no buyback totals/);
  });

  it.each([
    ["a network error", new Error("RPC HTTP 503 while calling get_buyback_totals")],
    ["a timeout", new DOMException("The operation was aborted.", "AbortError")],
    ["a contract panic", new Error("wasm execution failed with error: FunctionCallError(ExecutionError(\"Smart contract panicked\"))")],
  ])("view errors (%s): Unavailable, and no silent fall back to the index", async (_, error) => {
    const index = fakeIndex();
    const source = createPreferredLedgerSource(createBoardTotalsSource(boardView(error), BOARD), index);
    await expect(source.scan()).rejects.toBeInstanceOf(LedgerUnavailable);
    expect(index.scan).not.toHaveBeenCalled();
    expect(source.lastTried).toBe("board");
  });

  it.each([
    ["a non-decimal string", { near_to_buyback: "12abc", mpoo_returned: "1" }],
    ["a JSON number", { near_to_buyback: 12, mpoo_returned: "1" }],
    ["not an object", "oops"],
  ])("malformed values (%s): Unavailable, and no fall back", async (_, raw) => {
    const index = fakeIndex();
    const source = createPreferredLedgerSource(createBoardTotalsSource(boardView(raw), BOARD), index);
    await expect(source.scan()).rejects.toThrow(/Couldn’t read the board’s buyback totals/);
    expect(index.scan).not.toHaveBeenCalled();
  });

  it("through loadBuybackLedger: a failed view is Unavailable with its reason; the balance still shows", async () => {
    const source = createPreferredLedgerSource(createBoardTotalsSource(boardView(new Error("503")), BOARD), fakeIndex());
    expect(await loadBuybackLedger(source, async () => 3n, BUYBACK)).toEqual({
      buybackAccount: BUYBACK, history: null, historyError: "Couldn’t read the board’s buyback totals.", tried: "board", waiting: 3n,
    });
  });
});

describe("loadBuybackLedger", () => {
  it("lets the history and the balance fail independently", async () => {
    const source = fakeIndex();
    expect(await loadBuybackLedger(source, async () => { throw new Error("rpc"); }, BUYBACK)).toMatchObject({
      history: { totals: { nearToBuyback: 1n } }, tried: "index", waiting: null,
    });
    const broken = { scan: async () => { throw new Error("index"); } };
    expect(await loadBuybackLedger(broken, async () => 3n, BUYBACK))
      .toEqual({ buybackAccount: BUYBACK, history: null, historyError: null, tried: null, waiting: 3n });
    const stalled = { scan: async () => { throw new LedgerUnavailable("stopped"); } };
    expect(await loadBuybackLedger(stalled, async () => 3n, BUYBACK)).toMatchObject({ history: null, historyError: "stopped" });
    expect(await loadBuybackLedger(null, async () => 3n, BUYBACK)).toMatchObject({
      history: null, historyError: expect.stringMatching(/no public event index/), waiting: 3n,
    });
  });
});
