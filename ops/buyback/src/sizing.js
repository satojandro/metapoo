// Chunk sizing (spec K1 step 2):
//   available = spendable NEAR - BUYBACK_GAS_RESERVE
//   chunk     = min(available, BUYBACK_MAX_CHUNK_NEAR, largest amount with impact <= BUYBACK_MAX_IMPACT_BPS)
//   skip when chunk < BUYBACK_MIN_CHUNK_NEAR
//
// Price impact is measured against a small reference quote of the same route: the reference
// rate times the amount is what the route would pay with no impact, and the shortfall of the
// real quote from that is the impact. Pool fees scale with the amount, so they cancel out.
// The reference is BUYBACK_MIN_CHUNK_NEAR / 100, small enough to move no pool noticeably.

import { minBig, shortfallBps } from './amount.js';

export const SEARCH_STEPS = 12;

export const BINDING = Object.freeze({
  BALANCE: 'balance',
  MAX_CHUNK: 'max_chunk',
  PRICE_IMPACT: 'price_impact',
});

// `quote(amountIn: bigint) => Promise<bigint>` is the route's gross output.
export async function sizeChunk({ spendable, gasReserve, maxChunk, minChunk, maxImpactBps, quote }) {
  const available = spendable > gasReserve ? spendable - gasReserve : 0n;
  const cap = minBig(available, maxChunk);
  const capBinding = available < maxChunk ? BINDING.BALANCE : BINDING.MAX_CHUNK;
  const base = { available, cap, capBinding };
  if (cap < minChunk) return { ...base, chunk: 0n, skipped: 'below_minimum', binding: capBinding };

  const referenceIn = minChunk / 100n > 0n ? minChunk / 100n : 1n;
  const referenceOut = await quote(referenceIn);
  if (referenceOut === 0n) return { ...base, chunk: 0n, skipped: 'no_liquidity', binding: BINDING.PRICE_IMPACT };

  const measure = async (amount) => {
    const out = await quote(amount);
    const linear = (referenceOut * amount) / referenceIn;
    return { amount, out, impactBps: out === 0n ? 10_000 : shortfallBps(linear, out) };
  };

  const atCap = await measure(cap);
  if (atCap.impactBps <= maxImpactBps) {
    return { ...base, chunk: cap, binding: capBinding, impactBps: atCap.impactBps, quotedOut: atCap.out };
  }
  let good = await measure(minChunk);
  if (good.impactBps > maxImpactBps) {
    return { ...base, chunk: 0n, skipped: 'price_impact', binding: BINDING.PRICE_IMPACT, impactBps: good.impactBps, quotedOut: good.out };
  }
  // Impact grows with size, so bisect between a size that passes and one that doesn't.
  let bad = cap;
  for (let i = 0; i < SEARCH_STEPS && bad - good.amount > cap / 200n; i += 1) {
    const mid = await measure((good.amount + bad) / 2n);
    if (mid.impactBps <= maxImpactBps) good = mid;
    else bad = mid.amount;
  }
  return { ...base, chunk: good.amount, binding: BINDING.PRICE_IMPACT, impactBps: good.impactBps, quotedOut: good.out };
}
