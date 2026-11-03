#!/usr/bin/env node
// K3 route evidence: public, read-only NEAR mainnet view calls. Loads no key, signs nothing.
// Prints one JSON document (every read with its block height, plus candidate quotes) to stdout.
//
//   node scripts/discover-route.js > evidence/<date>-mainnet-route.json
//   DISCOVER_RPC_URL=https://... node scripts/discover-route.js   # another public RPC
//
// It answers: which pools can take wNEAR to mPOO, how deep they are, and what each candidate
// route quotes at chunk sizes the keeper would use. A quote is not a swap: see README "Route".

const RPC = process.env.DISCOVER_RPC_URL || 'https://rpc.mainnet.near.org';
const W = 'wrap.near';
const RHEA = 'token.rhealab.near';
const REF_TOKEN = 'token.v2.ref-finance.near';
const DIA = 'diarhea.nearlytrade.near';
const MPOO = 'mpoo.nearlytrade.near';
const STNEAR = 'meta-pool.near';
const CLASSIC = 'v2.ref-finance.near';
const DCL = 'dclv2.ref-labs.near';
const FEES = [100, 400, 2000, 10000];
const N = 10n ** 24n;
const PACE_MS = Number(process.env.DISCOVER_PACE_MS ?? 250);

const reads = [];

async function rpc(params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'buyback-route', method: 'query', params: { finality: 'final', ...params } });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const json = await res.json();
      // -429 / HTTP 429 is the public endpoint's rate limit: back off and retry.
      const limited = res.status === 429 || json.error?.code === -429;
      if (json.error && !limited) throw Object.assign(new Error(JSON.stringify(json.error).slice(0, 300)), { rpcError: true });
      if (!limited) {
        await new Promise((r) => setTimeout(r, PACE_MS));
        return json.result;
      }
      if (attempt >= 5) throw new Error('rate limited by the RPC; set DISCOVER_RPC_URL to another public endpoint');
    } catch (error) {
      if (error.rpcError || attempt >= 5) throw error;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function view(account, method, args = {}, { record = true } = {}) {
  const entry = { account, method, args };
  try {
    const r = await rpc({
      request_type: 'call_function',
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    const raw = Buffer.from(r.result).toString();
    entry.block_height = r.block_height;
    entry.value = raw ? JSON.parse(raw) : null;
  } catch (error) {
    entry.error = String(error.message ?? error);
  }
  if (record) reads.push(entry);
  return entry;
}

async function codeHash(account) {
  try {
    const r = await rpc({ request_type: 'view_account', account_id: account });
    reads.push({ account, method: 'view_account', block_height: r.block_height, value: { code_hash: r.code_hash } });
  } catch (error) {
    reads.push({ account, method: 'view_account', error: String(error.message ?? error) });
  }
}

const sortedPool = (a, b, fee) => `${[a, b].sort().join('|')}|${fee}`;

async function dclPool(a, b, fee) {
  const e = await view(DCL, 'get_pool', { pool_id: sortedPool(a, b, fee) });
  if (e.value && typeof e.value === 'object') {
    // Keep the depth fields; drop the bulky ones.
    const { token_x, token_y, fee: f, state, liquidity, total_x, total_y, current_point, total_liquidity } = e.value;
    e.value = { token_x, token_y, fee: f, state, liquidity, total_x, total_y, current_point, total_liquidity };
  }
  return e.value;
}

// Quote helpers throw on an RPC or contract error, so an error is never recorded as "0 out".
function amountOf(entry, pick) {
  if (entry.error) throw new Error(entry.error);
  return BigInt(pick(entry.value));
}
const classicReturn = async (pool, tokenIn, tokenOut, amount) =>
  amountOf(await view(CLASSIC, 'get_return', { pool_id: pool, token_in: tokenIn, amount_in: amount.toString(), token_out: tokenOut }, { record: false }), (v) => v);
const dclQuote = async (pools, tokenIn, tokenOut, amount) =>
  amountOf(await view(DCL, 'quote', { pool_ids: pools, input_token: tokenIn, output_token: tokenOut, input_amount: amount.toString() }, { record: false }), (v) => v.amount);

const FINAL = `${DIA}|${MPOO}|10000`;
const DIA_RHEA = `${DIA}|${RHEA}|10000`;

// Candidate routes as quote functions: wNEAR in, gross mPOO out (before mPOO's 2% buy tax).
function candidates(classicPools) {
  const list = [
    {
      id: 'near-ref6458-rhea-dcl-diarhea-mpoo',
      description: 'classic wNEAR->RHEA (pool 6458), then DCL RHEA->DIARHEA->mPOO (two pools, one transaction)',
      quote: async (x) => dclQuote([DIA_RHEA, FINAL], RHEA, MPOO, await classicReturn(6458, W, RHEA, x)),
    },
    ...FEES.map((fee) => ({
      id: `near-dcl-rhea${fee}-diarhea-mpoo`,
      description: `DCL only: wNEAR->RHEA (fee ${fee}), RHEA->DIARHEA, DIARHEA->mPOO`,
      quote: (x) => dclQuote([sortedPool(W, RHEA, fee), DIA_RHEA, FINAL], W, MPOO, x),
    })),
  ];
  for (const p of classicPools.filter((p) => p.tokens.includes(DIA) && p.tokens.includes(W) && p.nonEmpty)) {
    list.push({
      id: `near-ref${p.index}-diarhea-dcl-mpoo`,
      description: `classic wNEAR->DIARHEA (pool ${p.index}, fee ${p.total_fee} bps), then DCL DIARHEA->mPOO`,
      quote: async (x) => dclQuote([FINAL], DIA, MPOO, await classicReturn(p.index, W, DIA, x)),
    });
  }
  return list;
}

async function main() {
  const capturedAt = new Date().toISOString();
  for (const t of [MPOO, DIA]) await view(t, 'get_tax');
  for (const t of [MPOO, DIA]) {
    const e = await view('nearlytrade.near', 'get_launch_by_token', { token: t });
    if (e.value) for (const k of ['icon', 'description', 'links']) delete e.value[k];
  }
  for (const t of [W, RHEA, DIA, MPOO, STNEAR]) {
    const e = await view(t, 'ft_metadata');
    if (e.value) e.value = { symbol: e.value.symbol, decimals: e.value.decimals };
  }
  for (const a of [CLASSIC, DCL, W, RHEA, DIA, MPOO]) await codeHash(a);

  await dclPool(DIA, MPOO, 10000);
  await dclPool(DIA, RHEA, 10000);
  for (const fee of FEES) {
    await dclPool(W, RHEA, fee);
    await dclPool(W, MPOO, fee);
    await dclPool(W, DIA, fee);
    await dclPool(STNEAR, MPOO, fee);
    await dclPool(REF_TOKEN, DIA, fee);
  }

  // Every Ref classic pool holding mPOO or DIARHEA, or RHEA against wNEAR.
  const count = Number((await view(CLASSIC, 'get_number_of_pools')).value);
  const classicPools = [];
  let scanHeight = null;
  for (let i = 0; i < count; i += 400) {
    const e = await view(CLASSIC, 'get_pools', { from_index: i, limit: 400 }, { record: false });
    scanHeight = e.block_height ?? scanHeight;
    (e.value ?? []).forEach((p, k) => {
      const ids = p.token_account_ids;
      if (ids.includes(MPOO) || ids.includes(DIA) || (ids.includes(RHEA) && ids.includes(W))) {
        classicPools.push({ index: i + k, kind: p.pool_kind, tokens: ids, amounts: p.amounts, total_fee: p.total_fee, nonEmpty: p.amounts.every((a) => a !== '0') });
      }
    });
  }

  const sizes = [N / 100n, N / 10n, N, 2n * N, 5n * N, 10n * N];
  const quotes = [];
  for (const c of candidates(classicPools)) {
    const rows = [];
    try {
      const reference = await c.quote(sizes[0]);
      for (const x of sizes) {
        const out = await c.quote(x);
        const linear = (reference * x) / sizes[0];
        const impactBps = linear === 0n ? null : out >= linear ? 0 : Number(((linear - out) * 10_000n + linear - 1n) / linear);
        rows.push({ nearIn: x.toString(), mpooGrossOut: out.toString(), impactBpsVs0_01Near: impactBps });
      }
    } catch (error) {
      rows.push({ error: String(error.message ?? error).slice(0, 300) });
    }
    quotes.push({ id: c.id, description: c.description, rows });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        version: 1,
        captured_at: capturedAt,
        rpc_url: RPC,
        scope: 'read-only public RPC view calls; no key loaded, nothing signed',
        reads,
        classic_scan: { pools_total: count, block_height: scanHeight, matching: classicPools },
        candidate_quotes: quotes,
        not_established: [
          'any executed swap on this route (no transaction was sent)',
          'Ref classic instant swap via ft_transfer_call returning the output to an account with no Ref deposit',
          'DCL multi-pool Swap returning output to the sender and refunding all input on a min-out failure',
          "mPOO's 2% buy tax rounding and whether it is taken on a DCL multi-pool output exactly once",
          'whether DIARHEA tax applies to DIARHEA that never leaves the DCL inside a multi-pool swap',
          'gas used by each step',
        ],
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
