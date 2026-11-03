import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortfallBps } from '../src/amount.js';
import { BINDING, sizeChunk } from '../src/sizing.js';

const N = 10n ** 24n;

// Constant-product pool: 1000 NEAR deep. Impact for x NEAR is about x/1000.
const pool = (depth = 1000n * N, rout = 400_000_000n * 10n ** 18n) => async (x) => (x * rout) / (depth + x);

const base = { gasReserve: 1n * N, maxChunk: 2n * N, minChunk: N / 2n, maxImpactBps: 50, quote: pool() };

describe('sizeChunk', () => {
  it('balance binds: spendable less the gas reserve is below the max chunk', async () => {
    const s = await sizeChunk({ ...base, spendable: (25n * N) / 10n });
    assert.equal(s.binding, BINDING.BALANCE);
    assert.equal(s.chunk, (15n * N) / 10n);
    assert.equal(s.skipped, undefined);
  });

  it('max chunk binds: plenty of balance, impact under the limit at the cap', async () => {
    const s = await sizeChunk({ ...base, spendable: 50n * N });
    assert.equal(s.binding, BINDING.MAX_CHUNK);
    assert.equal(s.chunk, 2n * N);
    assert.ok(s.impactBps <= 50);
  });

  it('price impact binds: the chunk is the largest size whose impact is under the limit', async () => {
    const quote = pool();
    const s = await sizeChunk({ ...base, spendable: 50n * N, maxChunk: 20n * N, quote });
    assert.equal(s.binding, BINDING.PRICE_IMPACT);
    assert.ok(s.chunk < 20n * N && s.chunk >= base.minChunk);
    assert.ok(s.impactBps <= 50, `impact ${s.impactBps}`);
    // About 5 NEAR for a 1000 NEAR pool at 50 bps; within the bisection's resolution.
    assert.ok(s.chunk > (45n * N) / 10n && s.chunk < (52n * N) / 10n, `chunk ${s.chunk}`);
    // A little more would breach the limit.
    const ref = await quote(base.minChunk / 100n);
    const bigger = s.chunk + (20n * N) / 100n;
    assert.ok(shortfallBps((ref * bigger) / (base.minChunk / 100n), await quote(bigger)) > 50);
  });

  it('skips below the minimum chunk, before quoting anything', async () => {
    let quotes = 0;
    const s = await sizeChunk({ ...base, spendable: (14n * N) / 10n, quote: async () => (quotes += 1, 1n) });
    assert.equal(s.skipped, 'below_minimum');
    assert.equal(s.chunk, 0n);
    assert.equal(quotes, 0);
  });

  it('skips when the reserve exceeds the balance', async () => {
    const s = await sizeChunk({ ...base, spendable: N / 2n });
    assert.equal(s.skipped, 'below_minimum');
    assert.equal(s.available, 0n);
  });

  it('skips when even the minimum chunk moves the price too much', async () => {
    const s = await sizeChunk({ ...base, spendable: 50n * N, quote: pool(10n * N) });
    assert.equal(s.skipped, 'price_impact');
    assert.equal(s.chunk, 0n);
  });

  it('skips when the route has no liquidity', async () => {
    const s = await sizeChunk({ ...base, spendable: 50n * N, quote: async () => 0n });
    assert.equal(s.skipped, 'no_liquidity');
  });
});
