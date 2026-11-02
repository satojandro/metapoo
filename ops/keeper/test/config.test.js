import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_GAS_TGAS, DEFAULT_RPC, loadConfig } from '../src/config.js';

// Obviously fake: valid base58 shape, not a real key.
const FAKE_KEY = `ed25519:${'1'.repeat(64)}`;

const base = {
  KEEPER_NETWORK: 'testnet',
  KEEPER_BOARD_CONTRACT_ID: 'board3.metapoo.testnet',
  KEEPER_ACCOUNT_ID: 'keeper.metapoo.testnet',
  KEEPER_PRIVATE_KEY: FAKE_KEY,
};

function problemsFor(env) {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  assert.fail('expected ConfigError');
}

describe('loadConfig', () => {
  it('accepts a minimal testnet config and fills defaults', () => {
    const c = loadConfig(base);
    assert.equal(c.network, 'testnet');
    assert.equal(c.rpcUrl, DEFAULT_RPC.testnet);
    assert.equal(c.contractId, 'board3.metapoo.testnet');
    assert.equal(c.accountId, 'keeper.metapoo.testnet');
    assert.deepEqual(c.gasTgas, { ...DEFAULT_GAS_TGAS });
    assert.equal(c.privateKey, FAKE_KEY);
  });

  it('defaults distribute_mpoo to 150 TGas and distribute_near to 50 TGas', () => {
    // Three ft_transfer legs plus callbacks (REV-G). Literal numbers, not DEFAULT_GAS_TGAS:
    // comparing the default with itself pins nothing.
    assert.deepEqual(loadConfig(base).gasTgas, { distribute_near: 50, distribute_mpoo: 150 });
  });

  it('never exposes the private key through serialisation', () => {
    const c = loadConfig(base);
    assert.ok(!JSON.stringify(c).includes(FAKE_KEY));
    assert.ok(!Object.keys(c).includes('privateKey'));
  });

  it('reports every missing variable at once', () => {
    const p = problemsFor({});
    assert.equal(p.length, 4);
    assert.ok(p.some((m) => m.includes('KEEPER_NETWORK')));
    assert.ok(p.some((m) => m.includes('KEEPER_BOARD_CONTRACT_ID')));
    assert.ok(p.some((m) => m.includes('KEEPER_ACCOUNT_ID')));
    assert.ok(p.some((m) => m.includes('KEEPER_PRIVATE_KEY')));
  });

  it('rejects unknown networks, including prototype keys', () => {
    assert.ok(problemsFor({ ...base, KEEPER_NETWORK: 'betanet' }).some((m) => m.includes('testnet or mainnet')));
    assert.ok(problemsFor({ ...base, KEEPER_NETWORK: 'toString' }).some((m) => m.includes('testnet or mainnet')));
  });

  it('rejects a malformed key without echoing it', () => {
    const bad = 'ed25519:0OIl-not-base58';
    const p = problemsFor({ ...base, KEEPER_PRIVATE_KEY: bad });
    assert.ok(p.some((m) => m.includes('KEEPER_PRIVATE_KEY')));
    assert.ok(!p.join(' ').includes(bad));
  });

  it('rejects invalid account ids', () => {
    assert.ok(problemsFor({ ...base, KEEPER_ACCOUNT_ID: 'Keeper.Testnet' }).some((m) => m.includes('KEEPER_ACCOUNT_ID')));
    assert.ok(problemsFor({ ...base, KEEPER_BOARD_CONTRACT_ID: 'a' }).some((m) => m.includes('KEEPER_BOARD_CONTRACT_ID')));
  });

  it('catches a network / account suffix mismatch', () => {
    const p = problemsFor({ ...base, KEEPER_NETWORK: 'mainnet' });
    assert.ok(p.some((m) => m.includes('KEEPER_BOARD_CONTRACT_ID') && m.includes('.testnet')));
    const q = problemsFor({ ...base, KEEPER_BOARD_CONTRACT_ID: 'board.metapoo.near' });
    assert.ok(q.some((m) => m.includes('.near')));
  });

  it('allows implicit (64-hex) account ids on either network', () => {
    const implicit = 'a'.repeat(64);
    assert.equal(loadConfig({ ...base, KEEPER_ACCOUNT_ID: implicit }).accountId, implicit);
  });

  it('uses KEEPER_RPC_URL when given and validates it', () => {
    assert.equal(loadConfig({ ...base, KEEPER_RPC_URL: 'https://rpc.example.org' }).rpcUrl, 'https://rpc.example.org');
    assert.ok(problemsFor({ ...base, KEEPER_RPC_URL: 'not a url' }).some((m) => m.includes('KEEPER_RPC_URL')));
    assert.ok(problemsFor({ ...base, KEEPER_RPC_URL: 'ftp://x.org' }).some((m) => m.includes('KEEPER_RPC_URL')));
  });

  it('accepts gas overrides within bounds and rejects others', () => {
    const c = loadConfig({ ...base, KEEPER_GAS_NEAR_TGAS: '30', KEEPER_GAS_MPOO_TGAS: '150' });
    assert.deepEqual(c.gasTgas, { distribute_near: 30, distribute_mpoo: 150 });
    assert.ok(problemsFor({ ...base, KEEPER_GAS_MPOO_TGAS: '301' }).some((m) => m.includes('KEEPER_GAS_MPOO_TGAS')));
    assert.ok(problemsFor({ ...base, KEEPER_GAS_NEAR_TGAS: '2.5' }).some((m) => m.includes('KEEPER_GAS_NEAR_TGAS')));
  });

  it('trims whitespace (e.g. a trailing newline pasted into a secret)', () => {
    const c = loadConfig({ ...base, KEEPER_PRIVATE_KEY: `${FAKE_KEY}\n`, KEEPER_NETWORK: ' testnet ' });
    assert.equal(c.privateKey, FAKE_KEY);
    assert.equal(c.network, 'testnet');
  });
});
