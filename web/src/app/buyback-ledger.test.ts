import { describe, expect, it, vi } from "vitest";
import {
  aggregateLedger,
  createIndexedLedgerSource,
  eventsFromTxStatus,
  isRevenueTransferArgs,
  LedgerUnavailable,
  loadBuybackLedger,
  parseLedgerLog,
  type LedgerEvent,
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
    expect(aggregateLedger(scan.events)).toMatchObject({ nearToBuyback: 9n * NEAR, mpooReturned: 7n * MPOO });
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

describe("loadBuybackLedger", () => {
  it("lets the history and the balance fail independently", async () => {
    const source = { label: "x", scan: async () => ({ events: [], complete: true, transactions: 0, indexedThroughMs: null }) };
    expect(await loadBuybackLedger(source, async () => { throw new Error("rpc"); }, BUYBACK)).toMatchObject({
      history: { totals: { nearToBuyback: 0n }, complete: true }, waiting: null,
    });
    const broken = { label: "x", scan: async () => { throw new Error("index"); } };
    expect(await loadBuybackLedger(broken, async () => 3n, BUYBACK))
      .toEqual({ buybackAccount: BUYBACK, history: null, historyError: null, waiting: 3n });
    const stalled = { label: "x", scan: async () => { throw new LedgerUnavailable("stopped"); } };
    expect(await loadBuybackLedger(stalled, async () => 3n, BUYBACK)).toMatchObject({ history: null, historyError: "stopped" });
    expect(await loadBuybackLedger(null, async () => 3n, BUYBACK)).toMatchObject({
      history: null, historyError: expect.stringMatching(/no public event index/), waiting: 3n,
    });
  });
});
