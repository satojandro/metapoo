// The swap route is configuration (BUYBACK_ROUTE, JSON), not code. This module validates it,
// quotes it with read-only view calls, and builds the swap transactions. Nothing here signs.
//
// A route is 1-4 steps. Each step is one transaction: an ft_transfer_call of the step's first
// token to one exchange contract, which swaps through one or more pools and sends the output
// back to the buyback account. A new step starts wherever the route crosses to another
// exchange contract, because each contract checks its own minimum output.
//
//   {"id": "...", "steps": [
//     {"venue": "classic", "exchange": "v2.ref-finance.near",
//      "tokens": ["wrap.near", "token.rhealab.near"], "pools": [6458]},
//     {"venue": "dcl", "exchange": "dclv2.ref-labs.near",
//      "tokens": ["token.rhealab.near", "diarhea.nearlytrade.near", "mpoo.nearlytrade.near"],
//      "pools": ["diarhea.nearlytrade.near|token.rhealab.near|10000",
//                "diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000"]}]}
//
// `tokens` lists every token the step passes through, in order; `pools[k]` swaps tokens[k] to
// tokens[k+1]. classic = Ref v2 (pool ids are integers), dcl = RHEA DCL (pool id
// "tokenX|tokenY|fee"). Error messages name the step and field, never a configured value.

import { atomic } from './amount.js';

export const VENUES = Object.freeze(['classic', 'dcl']);

// On mainnet only these two exchange contracts are accepted. A route through anything else is
// a code change with review, not a configuration change.
export const MAINNET_EXCHANGES = Object.freeze({
  classic: 'v2.ref-finance.near',
  dcl: 'dclv2.ref-labs.near',
});

export const MAX_STEPS = 4;
export const MAX_POOLS_PER_STEP = 4;

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_RE = /^[0-9a-f]{64}$/;
const ROUTE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isAccountId(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && ACCOUNT_ID_RE.test(value);
}

// The problem with an account id's network suffix, or null. Implicit accounts fit either network.
export function networkMismatch(value, network) {
  if (IMPLICIT_RE.test(value) || !network) return null;
  if (network === 'mainnet' && value.endsWith('.testnet')) return 'ends with .testnet but BUYBACK_NETWORK is mainnet';
  if (network === 'testnet' && value.endsWith('.near')) return 'ends with .near but BUYBACK_NETWORK is testnet';
  return null;
}

// Parse and validate BUYBACK_ROUTE. Returns { route, problems }; route is null when invalid.
export function parseRoute(raw, { network, wrapToken }) {
  const V = 'BUYBACK_ROUTE';
  const problems = [];
  if (raw === undefined || raw === '') return { route: null, problems: [`${V} is required (JSON, see README)`] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { route: null, problems: [`${V} is not valid JSON`] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { route: null, problems: [`${V} must be a JSON object with "id" and "steps"`] };
  }
  if (typeof value.id !== 'string' || !ROUTE_ID_RE.test(value.id)) {
    problems.push(`${V} "id" must be 1-64 characters of letters, digits, . _ -`);
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_STEPS) {
    problems.push(`${V} "steps" must be an array of 1 to ${MAX_STEPS} steps`);
    return { route: null, problems };
  }

  const steps = [];
  const seen = new Set();
  value.steps.forEach((s, i) => {
    const at = `${V} step ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const before = problems.length;
    if (!VENUES.includes(s.venue)) problems.push(`${at} "venue" must be classic or dcl`);
    if (!isAccountId(s.exchange)) problems.push(`${at} "exchange" is not a valid NEAR account id`);
    else {
      const mismatch = networkMismatch(s.exchange, network);
      if (mismatch) problems.push(`${at} "exchange" ${mismatch}`);
      if (network === 'mainnet' && VENUES.includes(s.venue) && s.exchange !== MAINNET_EXCHANGES[s.venue]) {
        problems.push(`${at} "exchange" is not the allowlisted ${s.venue} exchange for mainnet`);
      }
    }
    const tokens = s.tokens;
    if (!Array.isArray(tokens) || tokens.length < 2 || tokens.length > MAX_POOLS_PER_STEP + 1) {
      problems.push(`${at} "tokens" must list 2 to ${MAX_POOLS_PER_STEP + 1} token account ids`);
      return;
    }
    tokens.forEach((t, k) => {
      if (!isAccountId(t)) problems.push(`${at} token ${k + 1} is not a valid NEAR account id`);
      else {
        const mismatch = networkMismatch(t, network);
        if (mismatch) problems.push(`${at} token ${k + 1} ${mismatch}`);
      }
    });
    if (new Set(tokens).size !== tokens.length) problems.push(`${at} "tokens" must not repeat a token`);
    const pools = s.pools;
    if (!Array.isArray(pools) || pools.length !== tokens.length - 1) {
      problems.push(`${at} "pools" must have exactly one pool per hop (tokens minus one)`);
      return;
    }
    const normalised = pools.map((p, k) => {
      if (s.venue === 'classic') {
        const n = typeof p === 'string' && /^(0|[1-9]\d*)$/.test(p) ? Number(p) : p;
        if (!Number.isSafeInteger(n) || n < 0) {
          problems.push(`${at} pool ${k + 1} must be a Ref classic pool index (integer)`);
          return null;
        }
        return n;
      }
      if (s.venue === 'dcl') {
        const parts = typeof p === 'string' ? p.split('|') : [];
        const ok =
          parts.length === 3 &&
          /^[1-9]\d{0,5}$/.test(parts[2]) &&
          parts[0] !== parts[1] &&
          [parts[0], parts[1]].includes(tokens[k]) &&
          [parts[0], parts[1]].includes(tokens[k + 1]);
        if (!ok) {
          problems.push(`${at} pool ${k + 1} must be a DCL pool id "tokenX|tokenY|fee" joining tokens ${k + 1} and ${k + 2}`);
          return null;
        }
        return p;
      }
      return null;
    });

    // Steps must connect, start at the wrap token, and not loop back through a token.
    if (i === 0 && tokens[0] !== wrapToken) problems.push(`${at} must start with the wrap token (BUYBACK_WRAP_TOKEN_ID)`);
    if (i > 0 && steps[i - 1] && tokens[0] !== steps[i - 1].tokens.at(-1)) {
      problems.push(`${at} must start with the token step ${i} ends with`);
    }
    tokens.forEach((t, k) => {
      if (i > 0 && k === 0) return; // shared with the previous step's last token
      if (seen.has(t)) problems.push(`${at} token ${k + 1} already appears earlier in the route`);
      seen.add(t);
    });
    if (i > 0 && tokens.includes(wrapToken)) problems.push(`${at} must not pass through the wrap token again`);
    if (problems.length === before) {
      steps.push(Object.freeze({ venue: s.venue, exchange: s.exchange, tokens: Object.freeze([...tokens]), pools: Object.freeze(normalised) }));
    } else {
      steps.push(null);
    }
  });

  if (problems.length > 0) return { route: null, problems };
  return { route: Object.freeze({ id: value.id, steps: Object.freeze(steps) }), problems: [] };
}

export const finalToken = (route) => route.steps.at(-1).tokens.at(-1);

// The tokens that land on the buyback account: each step's input and the final output. The
// account must hold a storage registration on each, or the token refuses the transfer.
// Tokens inside a multi-pool step never leave the exchange, so they need none.
export function routeTokens(route) {
  return [...new Set([...route.steps.map((s) => s.tokens[0]), finalToken(route)])];
}

// Read-only quote of one step: gross output for `amountIn` (bigint). 0n means no liquidity.
export async function quoteStep(client, step, amountIn) {
  if (amountIn <= 0n) return 0n;
  if (step.venue === 'dcl') {
    const result = await client.view(step.exchange, 'quote', {
      pool_ids: step.pools,
      input_token: step.tokens[0],
      output_token: step.tokens.at(-1),
      input_amount: amountIn.toString(),
    });
    return atomic(result?.amount, 'DCL quote');
  }
  // Ref classic: one get_return per pool, each fed the previous output, as the swap executes.
  let amount = amountIn;
  for (let k = 0; k < step.pools.length; k += 1) {
    const out = await client.view(step.exchange, 'get_return', {
      pool_id: step.pools[k],
      token_in: step.tokens[k],
      amount_in: amount.toString(),
      token_out: step.tokens[k + 1],
    });
    amount = atomic(out, 'classic quote');
    if (amount === 0n) return 0n;
  }
  return amount;
}

// End-to-end gross quote, ignoring token taxes (the tax applies after the exchange).
export async function quoteRoute(client, route, amountIn, fromStep = 0) {
  let amount = amountIn;
  for (const step of route.steps.slice(fromStep)) {
    amount = await quoteStep(client, step, amount);
    if (amount === 0n) return 0n;
  }
  return amount;
}

// The ft_transfer_call message for one step. min_amount_out applies to the step's final output,
// which the exchange checks before the token's own transfer tax is taken.
export function swapMessage(step, amountIn, minAmountOut) {
  if (step.venue === 'dcl') {
    return JSON.stringify({
      Swap: { pool_ids: step.pools, output_token: step.tokens.at(-1), min_output_amount: minAmountOut.toString() },
    });
  }
  const last = step.pools.length - 1;
  return JSON.stringify({
    actions: step.pools.map((pool_id, k) => ({
      pool_id,
      token_in: step.tokens[k],
      token_out: step.tokens[k + 1],
      ...(k === 0 ? { amount_in: amountIn.toString() } : {}),
      // Intermediate hops inside one exchange are atomic with the last; only the end is checked.
      min_amount_out: k === last ? minAmountOut.toString() : '0',
    })),
  });
}

// Plain action descriptors; near-client.js turns them into near-api-js actions.
export function fnCall(method, args, gasTgas, depositYocto = 0n) {
  return { method, args, gasTgas, depositYocto };
}

// One swap step as a transaction. The first step also wraps the NEAR in the same transaction,
// so a failure anywhere leaves NEAR or wNEAR on the account, never anything in flight.
export function buildSwapTransaction(step, { amountIn, minAmountOut, wrap, gasSwapTgas, gasWrapTgas }) {
  const actions = [];
  if (wrap) actions.push(fnCall('near_deposit', {}, gasWrapTgas, amountIn));
  actions.push(
    fnCall(
      'ft_transfer_call',
      { receiver_id: step.exchange, amount: amountIn.toString(), msg: swapMessage(step, amountIn, minAmountOut) },
      gasSwapTgas,
      1n,
    ),
  );
  return { receiverId: step.tokens[0], actions };
}
