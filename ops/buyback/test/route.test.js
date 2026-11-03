import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSwapTransaction, parseRoute, quoteRoute, routeTokens, swapMessage } from '../src/route.js';
import { MID, MPOO, ROUTE, WRAP, fakeChain } from './fake-chain.js';

// The mainnet candidate recorded in the README (route evidence, 2 Nov 2026). Parsing it here
// keeps the README's JSON valid; it is not a claim that the route works.
const MAINNET_CANDIDATE = {
  id: 'near-ref6458-rhea-dcl-diarhea-mpoo',
  steps: [
    { venue: 'classic', exchange: 'v2.ref-finance.near', tokens: ['wrap.near', 'token.rhealab.near'], pools: [6458] },
    {
      venue: 'dcl',
      exchange: 'dclv2.ref-labs.near',
      tokens: ['token.rhealab.near', 'diarhea.nearlytrade.near', 'mpoo.nearlytrade.near'],
      pools: ['diarhea.nearlytrade.near|token.rhealab.near|10000', 'diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000'],
    },
  ],
};

const parse = (route, network = 'testnet', wrapToken = WRAP) => parseRoute(JSON.stringify(route), { network, wrapToken });

describe('parseRoute', () => {
  it('accepts the test route and the mainnet candidate', () => {
    assert.deepEqual(parse(ROUTE).problems, []);
    assert.deepEqual(parse(MAINNET_CANDIDATE, 'mainnet', 'wrap.near').problems, []);
  });

  it('accepts classic pool ids given as strings', () => {
    const r = structuredClone(ROUTE);
    r.steps[0].pools = ['7'];
    assert.equal(parse(r).route.steps[0].pools[0], 7);
  });

  it('requires the first step to start with the wrap token', () => {
    const r = structuredClone(ROUTE);
    r.steps = [r.steps[1]];
    assert.ok(parse(r).problems.some((m) => m.includes('wrap token')));
  });

  it('rejects a DCL pool id that does not join its two tokens', () => {
    const r = structuredClone(ROUTE);
    r.steps[1].pools[1] = r.steps[1].pools[0];
    assert.ok(parse(r).problems.some((m) => m.includes('step 2 pool 2')));
  });

  it('rejects a pool count that does not match the hops', () => {
    const r = structuredClone(ROUTE);
    r.steps[1].pools.pop();
    assert.ok(parse(r).problems.some((m) => m.includes('one pool per hop')));
  });

  it('rejects a route that loops back through a token', () => {
    const r = structuredClone(ROUTE);
    r.steps.push({ venue: 'classic', exchange: r.steps[0].exchange, tokens: [r.steps[1].tokens.at(-1), r.steps[1].tokens[1]], pools: [9] });
    assert.ok(parse(r).problems.some((m) => m.includes('already appears')));
  });

  it('needs storage only on tokens that land on the account, not inside a multi-pool step', () => {
    assert.deepEqual(routeTokens(parse(ROUTE).route), [WRAP, MID, MPOO]);
  });

  it('rejects invalid JSON and too many steps', () => {
    assert.deepEqual(parseRoute('{', { network: 'testnet', wrapToken: WRAP }).problems, ['BUYBACK_ROUTE is not valid JSON']);
    const r = structuredClone(ROUTE);
    r.steps = [r.steps[0], r.steps[1], r.steps[1], r.steps[1], r.steps[1]];
    assert.ok(parse(r).problems.some((m) => m.includes('1 to 4 steps')));
  });
});

describe('quoting and messages', () => {
  it('quotes step by step, feeding each output into the next step', async () => {
    const chain = fakeChain();
    const { route } = parse(ROUTE);
    const out = await quoteRoute(chain, route, 10n ** 24n);
    assert.ok(out > 0n);
    assert.deepEqual(
      chain.views.map((v) => v.method),
      ['get_return', 'quote'],
    );
    assert.equal(chain.views[1].args.input_amount, String(await chain.view(ROUTE.steps[0].exchange, 'get_return', { amount_in: '1000000000000000000000000' })));
  });

  it('builds a Ref classic message with amount_in on the first action and min out on the last', () => {
    const step = { venue: 'classic', exchange: 'v2.ref-finance.near', tokens: ['wrap.near', 'a.near', 'b.near'], pools: [1, 2] };
    assert.deepEqual(JSON.parse(swapMessage(step, 100n, 90n)), {
      actions: [
        { pool_id: 1, token_in: 'wrap.near', token_out: 'a.near', amount_in: '100', min_amount_out: '0' },
        { pool_id: 2, token_in: 'a.near', token_out: 'b.near', min_amount_out: '90' },
      ],
    });
  });

  it('builds a DCL Swap message over every pool with one final minimum', () => {
    const step = parse(ROUTE).route.steps[1];
    assert.deepEqual(JSON.parse(swapMessage(step, 100n, 90n)), {
      Swap: { pool_ids: ROUTE.steps[1].pools, output_token: ROUTE.steps[1].tokens.at(-1), min_output_amount: '90' },
    });
  });

  it('wraps and swaps in one transaction on the wrap token, 1 yocto on the transfer', () => {
    const step = parse(ROUTE).route.steps[0];
    const tx = buildSwapTransaction(step, { amountIn: 5n, minAmountOut: 4n, wrap: true, gasSwapTgas: 200, gasWrapTgas: 10 });
    assert.equal(tx.receiverId, WRAP);
    assert.deepEqual(
      tx.actions.map((a) => [a.method, a.depositYocto, a.gasTgas]),
      [
        ['near_deposit', 5n, 10],
        ['ft_transfer_call', 1n, 200],
      ],
    );
    assert.equal(tx.actions[1].args.receiver_id, ROUTE.steps[0].exchange);
    assert.equal(tx.actions[1].args.amount, '5');
  });
});
