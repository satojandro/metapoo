import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ConfigError, DEFAULT_RPC, loadConfig } from '../src/config.js';
import { BASE_ENV, BOARD, FAKE_KEY, ROUTE } from './fake-chain.js';

const N = 10n ** 24n;

function problemsFor(env) {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  assert.fail('expected ConfigError');
}

const named = (problems, variable) => problems.some((m) => m.includes(variable));

describe('loadConfig', () => {
  it('accepts a testnet config and fills the spec K2 defaults', () => {
    const c = loadConfig(BASE_ENV);
    assert.equal(c.network, 'testnet');
    assert.equal(c.rpcUrl, DEFAULT_RPC.testnet);
    assert.equal(c.wrapToken, 'wrap.testnet');
    assert.equal(c.gasReserve, 1n * N);
    assert.equal(c.maxChunk, 2n * N);
    assert.equal(c.minChunk, N / 2n);
    assert.equal(c.maxImpactBps, 50);
    assert.equal(c.slippageBps, 100);
    assert.equal(c.route.steps.length, 2);
    assert.equal(c.privateKey, FAKE_KEY);
  });

  it('never exposes the private key through inspection or key listing', () => {
    const c = loadConfig(BASE_ENV);
    assert.ok(!inspect(c, { depth: 5 }).includes(FAKE_KEY));
    assert.ok(!Object.keys(c).includes('privateKey'));
  });

  it('names every missing required variable at once', () => {
    const p = problemsFor({});
    for (const v of [
      'BUYBACK_NETWORK',
      'BUYBACK_BOARD_CONTRACT_ID',
      'BUYBACK_ACCOUNT_ID',
      'BUYBACK_PRIVATE_KEY',
      'BUYBACK_MAX_CHUNK_NEAR',
      'BUYBACK_MIN_CHUNK_NEAR',
      'BUYBACK_ROUTE',
    ]) {
      assert.ok(named(p, v), `missing ${v} not reported`);
    }
  });

  it('names the variable and never echoes the value, for every kind of bad value', () => {
    const marker = 'zz9-plural-z-alpha';
    const cases = {
      BUYBACK_NETWORK: marker,
      BUYBACK_RPC_URL: `${marker} not a url`,
      BUYBACK_BOARD_CONTRACT_ID: `${marker}!`,
      BUYBACK_ACCOUNT_ID: `${marker}!`,
      BUYBACK_WRAP_TOKEN_ID: `${marker}!`,
      BUYBACK_PRIVATE_KEY: `ed25519:0OIl${marker}`,
      BUYBACK_GAS_RESERVE: marker,
      BUYBACK_MAX_CHUNK_NEAR: marker,
      BUYBACK_MIN_CHUNK_NEAR: marker,
      BUYBACK_MAX_IMPACT_BPS: marker,
      BUYBACK_SLIPPAGE_BPS: marker,
      BUYBACK_GAS_SWAP_TGAS: marker,
      BUYBACK_GAS_RETURN_TGAS: marker,
      BUYBACK_ROUTE: `{"id":"${marker}!","steps":[]}`,
    };
    for (const [variable, value] of Object.entries(cases)) {
      const p = problemsFor({ ...BASE_ENV, [variable]: value });
      assert.ok(named(p, variable), `${variable} not named: ${p.join('; ')}`);
      assert.ok(!p.join(' ').includes(marker), `${variable} value echoed`);
    }
  });

  it('route errors name the step and field, not the configured ids', () => {
    const secretish = 'pool-owner-private-name.testnet';
    const route = structuredClone(ROUTE);
    route.steps[1].tokens[0] = secretish; // disconnected from step 1
    const p = problemsFor({ ...BASE_ENV, BUYBACK_ROUTE: JSON.stringify(route) });
    assert.ok(p.some((m) => m.startsWith('BUYBACK_ROUTE step 2')));
    assert.ok(!p.join(' ').includes(secretish));
  });

  it('rejects unknown networks, including prototype keys', () => {
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_NETWORK: 'toString' }), 'BUYBACK_NETWORK'));
  });

  it('catches a network / account suffix mismatch, including inside the route', () => {
    const p = problemsFor({ ...BASE_ENV, BUYBACK_NETWORK: 'mainnet' });
    assert.ok(p.some((m) => m.includes('BUYBACK_BOARD_CONTRACT_ID') && m.includes('.testnet')));
    assert.ok(p.some((m) => m.startsWith('BUYBACK_ROUTE step 1') && m.includes('.testnet')));
  });

  it('on mainnet only accepts the allowlisted Ref exchanges', () => {
    const route = {
      id: 'x',
      steps: [{ venue: 'classic', exchange: 'some-other-dex.near', tokens: ['wrap.near', 'mpoo.nearlytrade.near'], pools: [1] }],
    };
    const p = problemsFor({
      ...BASE_ENV,
      BUYBACK_NETWORK: 'mainnet',
      BUYBACK_BOARD_CONTRACT_ID: 'board.metapoo.near',
      BUYBACK_ACCOUNT_ID: 'buyback.metapoo.near',
      BUYBACK_ROUTE: JSON.stringify(route),
    });
    assert.deepEqual(p, ['BUYBACK_ROUTE step 1 "exchange" is not the allowlisted classic exchange for mainnet']);
  });

  it('requires a dedicated account, not the board itself', () => {
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_ACCOUNT_ID: BOARD }), 'BUYBACK_ACCOUNT_ID'));
  });

  it('checks amounts: min not above max, reserve at least 0.1 NEAR, no zero chunk', () => {
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_MIN_CHUNK_NEAR: '3' }), 'BUYBACK_MIN_CHUNK_NEAR'));
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_GAS_RESERVE: '0.05' }), 'BUYBACK_GAS_RESERVE'));
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_MAX_CHUNK_NEAR: '0' }), 'BUYBACK_MAX_CHUNK_NEAR'));
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_MAX_CHUNK_NEAR: '1.0000000000000000000000001' }), 'BUYBACK_MAX_CHUNK_NEAR'));
  });

  it('checks basis-point and gas bounds', () => {
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_MAX_IMPACT_BPS: '0' }), 'BUYBACK_MAX_IMPACT_BPS'));
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_SLIPPAGE_BPS: '501' }), 'BUYBACK_SLIPPAGE_BPS'));
    assert.ok(named(problemsFor({ ...BASE_ENV, BUYBACK_GAS_SWAP_TGAS: '295' }), 'BUYBACK_GAS_SWAP_TGAS'));
    const c = loadConfig({ ...BASE_ENV, BUYBACK_MAX_IMPACT_BPS: '80', BUYBACK_SLIPPAGE_BPS: '150', BUYBACK_GAS_RESERVE: '0.5' });
    assert.equal(c.maxImpactBps, 80);
    assert.equal(c.slippageBps, 150);
    assert.equal(c.gasReserve, N / 2n);
  });

  it('trims whitespace (e.g. a trailing newline pasted into a secret)', () => {
    const c = loadConfig({ ...BASE_ENV, BUYBACK_PRIVATE_KEY: `${FAKE_KEY}\n`, BUYBACK_NETWORK: ' testnet ' });
    assert.equal(c.privateKey, FAKE_KEY);
    assert.equal(c.network, 'testnet');
  });

  it('keeps a paid RPC key off the printed config but available to the client', () => {
    assert.equal(loadConfig(BASE_ENV).rpcApiKey, undefined);
    const c = loadConfig({ ...BASE_ENV, BUYBACK_RPC_API_KEY: '  test-key  ' });
    assert.equal(c.rpcApiKey, 'test-key');
    assert.equal(inspect(c, { depth: null }).includes('test-key'), false);
    assert.equal(Object.keys(c).includes('rpcApiKey'), false);
  });
});
