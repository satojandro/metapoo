import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REVENUE_MSG, runBuyback } from '../src/buyback.js';
import { loadConfig } from '../src/config.js';
import { buildTransaction } from '../src/near-client.js';
import { BASE_ENV, BOARD, DCL, FAKE_KEY, MID, MPOO, N, T, WRAP, fakeChain } from './fake-chain.js';

const config = loadConfig(BASE_ENV);

async function run(chain, cfg = config) {
  const lines = [];
  const out = await runBuyback({ config: cfg, client: chain, log: (l) => lines.push(l), now: () => new Date('2026-11-02T10:00:00Z') });
  const entries = lines.map((l) => JSON.parse(l));
  return { ...out, lines, entries, of: (step) => entries.filter((e) => e.step === step) };
}

// Transactions the run sent, as [receiver, first method].
const sentKinds = (chain) => chain.sent.map((tx) => [tx.receiverId, tx.actions.at(-1).method === 'ft_transfer_call' ? tx.actions.at(-1).args.receiver_id : tx.actions[0].method]);

describe('runBuyback: the happy path', () => {
  it('sizes one chunk, wraps and swaps it over both steps, and returns all the mPOO to the board', async () => {
    const chain = fakeChain({ near: 20n * N });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 0);
    assert.deepEqual(sentKinds(chain), [
      [WRAP, 'ref.fakedex.testnet'], // near_deposit + ft_transfer_call to the classic exchange
      [MID, DCL],
      [MPOO, BOARD],
    ]);
    assert.equal(chain.near, 18n * N); // max chunk of 2 NEAR
    assert.equal(chain.balances.get(MPOO), 0n);
    assert.ok(chain.boardReceived > 0n);
    const [size] = of('size');
    assert.equal(size.binding, 'max_chunk');
    assert.equal(size.chunk, (2n * N).toString());
    const [ret] = of('return').filter((e) => e.phase === 'after_swap');
    assert.equal(ret.outcome, 'returned');
    assert.equal(ret.accepted, chain.boardReceived.toString());
    const [summary] = of('summary');
    assert.equal(summary.nearSwapped, (2n * N).toString());
    assert.equal(summary.mpooReturned, chain.boardReceived.toString());
  });

  it('returns mPOO with ft_transfer_call, msg {"revenue":{}}, 1 yocto, to the board', async () => {
    const chain = fakeChain({ near: 20n * N });
    await run(chain);
    const ret = chain.sent.at(-1);
    assert.equal(ret.receiverId, MPOO);
    assert.equal(ret.actions.length, 1);
    assert.equal(ret.actions[0].method, 'ft_transfer_call');
    assert.equal(ret.actions[0].args.receiver_id, BOARD);
    assert.equal(ret.actions[0].args.msg, REVENUE_MSG);
    assert.equal(ret.actions[0].depositYocto, 1n);
  });

  it('sets each step’s min out from a fresh quote less the slippage', async () => {
    const chain = fakeChain({ near: 20n * N });
    const { of } = await run(chain);
    for (const s of of('swap')) {
      assert.equal(BigInt(s.minAmountOut), (BigInt(s.quotedOut) * 9_900n) / 10_000n);
    }
    const dclMsg = JSON.parse(chain.sent[1].actions[0].args.msg);
    assert.equal(dclMsg.Swap.min_output_amount, of('swap')[1].minAmountOut);
  });

  it('skips the swap below the minimum chunk and signs nothing', async () => {
    const chain = fakeChain({ near: (14n * N) / 10n }); // 0.4 available after the 1 NEAR reserve
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 0);
    assert.equal(chain.sent.length, 0);
    assert.equal(of('size')[0].reason, 'below_minimum');
  });

  it('lets price impact cap the chunk on a shallow pool', async () => {
    const chain = fakeChain({ near: 50n * N, reserves: [[200n * N, 16_000n * T], [80_000n * T, 400_000_000n * T]] });
    const cfg = loadConfig({ ...BASE_ENV, BUYBACK_MAX_CHUNK_NEAR: '20' });
    const { of } = await run(chain, cfg);
    const [size] = of('size');
    assert.equal(size.binding, 'price_impact');
    assert.ok(size.impactBps <= 50);
    assert.ok(BigInt(size.chunk) < 20n * N);
    assert.equal(chain.near, 50n * N - BigInt(size.chunk));
  });
});

describe('runBuyback: return first', () => {
  it('sends mPOO left from an earlier run to the board before any swap', async () => {
    const chain = fakeChain({ near: 20n * N, balances: { [MPOO]: 1234n * T } });
    const { of } = await run(chain);
    assert.deepEqual(sentKinds(chain)[0], [MPOO, BOARD]);
    assert.equal(chain.sent[0].actions[0].args.amount, (1234n * T).toString());
    assert.equal(of('return')[0].phase, 'before_swap');
    assert.equal(of('return')[0].outcome, 'returned');
    assert.equal(sentKinds(chain).length, 4); // return, swap 1, swap 2, return
  });
});

describe('runBuyback: failures leave value where it is', () => {
  it('a swap that never lands leaves the NEAR on the account and sends nothing to the board', async () => {
    const chain = fakeChain({ near: 20n * N, fail: { swap1: 'throw' } });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 1);
    assert.equal(chain.near, 20n * N);
    assert.equal(chain.balances.get(WRAP), 0n);
    assert.equal(chain.boardReceived, 0n);
    const [swap] = of('swap');
    assert.equal(swap.outcome, 'failed');
    assert.match(swap.left, /NEAR or wNEAR/);
    assert.match(swap.detail, /RPC timeout/);
  });

  it('a refunded swap leaves wNEAR; the next run unwraps it and swaps again', async () => {
    const chain = fakeChain({ near: 20n * N, fail: { swap1: 'refund' } });
    const first = await run(chain);
    assert.equal(first.exitCode, 1);
    assert.equal(chain.balances.get(WRAP), 2n * N);
    assert.equal(first.of('swap')[0].inputLeft, (2n * N).toString());

    delete chain.fail.swap1;
    const second = await run(chain);
    assert.equal(second.exitCode, 0);
    assert.equal(second.of('unwrap')[0].outcome, 'unwrapped');
    assert.equal(chain.balances.get(WRAP), 0n);
    assert.equal(chain.near, 18n * N);
    assert.ok(chain.boardReceived > 0n);
  });

  it('a failed second step leaves the intermediate token; the next run finishes the route first', async () => {
    const chain = fakeChain({ near: 20n * N, fail: { swap2: 'throw' } });
    const first = await run(chain);
    assert.equal(first.exitCode, 1);
    const stranded = chain.balances.get(MID);
    assert.ok(stranded > 0n);
    assert.match(first.of('swap')[1].left, new RegExp(MID.replaceAll('.', '\\.')));

    delete chain.fail.swap2;
    const second = await run(chain);
    assert.equal(second.exitCode, 0);
    const [resumed, ...rest] = second.of('swap');
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.amountIn, stranded.toString());
    assert.equal(rest.length, 2); // then the new chunk, both steps
    assert.equal(chain.balances.get(MID), 0n);
  });

  it('a failed return leaves the mPOO for the next run, which returns it first', async () => {
    const chain = fakeChain({ near: 20n * N, fail: { return: 'throw' } });
    const first = await run(chain);
    assert.equal(first.exitCode, 1);
    const held = chain.balances.get(MPOO);
    assert.ok(held > 0n);
    assert.equal(first.of('return').at(-1).outcome, 'failed');

    delete chain.fail.return;
    chain.near = (12n * N) / 10n; // nothing new to swap this time
    const second = await run(chain);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(sentKinds(chain).slice(-1)[0], [MPOO, BOARD]);
    assert.equal(second.of('return')[0].phase, 'before_swap');
    assert.equal(second.of('return')[0].accepted, held.toString());
    assert.equal(chain.balances.get(MPOO), 0n);
  });

  it('a return the board refunds (not the buyback account) is a failure and keeps the mPOO', async () => {
    const chain = fakeChain({ near: (12n * N) / 10n, balances: { [MPOO]: 5n * T }, fail: { return: 'reject' } });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 1);
    assert.equal(chain.balances.get(MPOO), 5n * T);
    assert.match(of('return')[0].detail, /revenue_rejected/);
  });
});

describe('runBuyback: received versus quote', () => {
  it('logs the shortfall when the token tax lands the mPOO below the quote', async () => {
    const chain = fakeChain({ near: 20n * N, taxBps: 200n });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 0);
    const final = of('swap').at(-1);
    assert.equal(final.outcome, 'swapped');
    assert.equal(final.warning, 'received_below_quote');
    assert.equal(final.differenceBps, 200);
    assert.equal(final.belowMinimum, true); // 2% tax is more than the 1% slippage
    assert.equal(BigInt(final.received), BigInt(final.quotedOut) - (BigInt(final.quotedOut) * 200n) / 10_000n);
    assert.equal(of('return').at(-1).accepted, final.received);
  });

  it('logs no warning when the swap delivers the quote', async () => {
    const chain = fakeChain({ near: 20n * N });
    const { of } = await run(chain);
    assert.ok(of('swap').every((s) => s.warning === undefined && s.differenceBps === 0));
  });

  it('a price move beyond the slippage makes the exchange refund; the NEAR stays as wNEAR', async () => {
    const chain = fakeChain({ near: 20n * N, driftBps: 150n });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 1);
    assert.equal(of('swap')[0].outcome, 'failed');
    assert.equal(chain.near + chain.balances.get(WRAP), 20n * N);
  });
});

describe('runBuyback: preflight signs nothing when something is off', () => {
  it('the board names a different buyback account', async () => {
    const chain = fakeChain({ revenueState: { buyback_account: 'someone-else.testnet' }, balances: { [MPOO]: T } });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 1);
    assert.equal(chain.sent.length, 0);
    assert.match(of('preflight')[0].problems[0], /buyback_account/);
  });

  it("the route does not end in the board's mPOO token", async () => {
    const chain = fakeChain({ revenueState: { mpoo_token: 'other-token.testnet' } });
    const { exitCode } = await run(chain);
    assert.equal(exitCode, 1);
    assert.equal(chain.sent.length, 0);
  });

  it('the account is not registered on a route token', async () => {
    const chain = fakeChain({ registered: [WRAP, MPOO] });
    const { exitCode, of } = await run(chain);
    assert.equal(exitCode, 1);
    assert.equal(chain.sent.length, 0);
    assert.ok(of('preflight')[0].unregistered.includes(MID));
  });
});

describe('logging', () => {
  it('writes one parseable JSON line per step and never the private key', async () => {
    const chain = fakeChain({ near: 20n * N, balances: { [MPOO]: T } });
    const { lines, entries } = await run(chain);
    assert.deepEqual(
      entries.map((e) => e.step),
      ['preflight', 'return', 'size', 'swap', 'swap', 'return', 'summary'],
    );
    assert.ok(entries.every((e) => e.ts === '2026-11-02T10:00:00.000Z' && e.route === 'test-route'));
    assert.ok(entries.filter((e) => e.step === 'swap').every((e) => typeof e.txHash === 'string'));
    assert.ok(!lines.join('\n').includes(FAKE_KEY));
  });
});

describe('buildTransaction', () => {
  it('maps descriptors to near-api-js function calls, waits for FINAL, returns failures', () => {
    const tx = buildTransaction({
      receiverId: WRAP,
      actions: [
        { method: 'near_deposit', args: {}, gasTgas: 10, depositYocto: 2n * N },
        { method: 'ft_transfer_call', args: { receiver_id: 'x.testnet', amount: '1', msg: '{}' }, gasTgas: 200, depositYocto: 1n },
      ],
    });
    assert.equal(tx.receiverId, WRAP);
    assert.equal(tx.waitUntil, 'FINAL');
    assert.equal(tx.throwOnFailure, false);
    const [wrap, transfer] = tx.actions.map((a) => a.functionCall);
    assert.equal(wrap.methodName, 'near_deposit');
    assert.equal(BigInt(wrap.deposit), 2n * N);
    assert.equal(BigInt(wrap.gas), 10_000_000_000_000n);
    assert.equal(transfer.methodName, 'ft_transfer_call');
    assert.equal(BigInt(transfer.deposit), 1n);
    assert.deepEqual(JSON.parse(Buffer.from(transfer.args).toString()), { receiver_id: 'x.testnet', amount: '1', msg: '{}' });
  });
});
