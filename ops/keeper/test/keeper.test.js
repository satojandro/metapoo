import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOO_SOON_CODE } from '../src/classify.js';
import { loadConfig } from '../src/config.js';
import { runKeeper } from '../src/keeper.js';
import { buildCall } from '../src/near-client.js';

const FAKE_KEY = `ed25519:${'1'.repeat(64)}`;
const config = loadConfig({
  KEEPER_NETWORK: 'testnet',
  KEEPER_BOARD_CONTRACT_ID: 'board3.metapoo.testnet',
  KEEPER_ACCOUNT_ID: 'keeper.metapoo.testnet',
  KEEPER_PRIVATE_KEY: FAKE_KEY,
});

const ok = (hash) => ({ status: { SuccessValue: '' }, transaction: { hash } });
const tooSoon = (hash) => ({
  status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `panicked: ${TOO_SOON_CODE}` } } } } },
  transaction: { hash },
});

// Mock NEAR client: answers per method from a table; a function value is called (may throw).
function mockClient(answers) {
  const calls = [];
  return {
    calls,
    async call(method, gasTgas) {
      calls.push({ method, gasTgas });
      const a = answers[method];
      return typeof a === 'function' ? a() : a;
    },
  };
}

async function run(answers) {
  const lines = [];
  const client = mockClient(answers);
  const out = await runKeeper({ config, client, log: (l) => lines.push(l), now: () => new Date('2026-11-02T10:00:00Z') });
  return { ...out, lines, client };
}

describe('runKeeper', () => {
  it('calls distribute_near then distribute_mpoo with the configured gas', async () => {
    const { client, exitCode } = await run({ distribute_near: ok('h1'), distribute_mpoo: ok('h2') });
    assert.deepEqual(client.calls, [
      { method: 'distribute_near', gasTgas: 50 },
      { method: 'distribute_mpoo', gasTgas: 150 },
    ]);
    assert.equal(exitCode, 0);
  });

  it('logs one parseable JSON line per call with tx hash and outcome', async () => {
    const { lines } = await run({ distribute_near: ok('h1'), distribute_mpoo: tooSoon('h2') });
    assert.equal(lines.length, 2);
    const [a, b] = lines.map((l) => JSON.parse(l));
    assert.equal(a.method, 'distribute_near');
    assert.equal(a.outcome, 'distributed');
    assert.equal(a.txHash, 'h1');
    assert.equal(a.ts, '2026-11-02T10:00:00.000Z');
    assert.equal(b.outcome, 'too_soon');
    assert.equal(b.txHash, 'h2');
  });

  it('still calls the second method when the first throws', async () => {
    const { client, results, exitCode } = await run({
      distribute_near: () => {
        throw new Error('fetch failed');
      },
      distribute_mpoo: ok('h2'),
    });
    assert.equal(client.calls.length, 2);
    assert.equal(results[0].outcome, 'failed');
    assert.equal(exitCode, 0);
  });

  it('exits 0 when both calls are too soon', async () => {
    const { exitCode } = await run({ distribute_near: tooSoon('a'), distribute_mpoo: tooSoon('b') });
    assert.equal(exitCode, 0);
  });

  it('exits 1 when both calls fail for another reason', async () => {
    const boom = () => {
      throw new Error('Access Key does not have enough allowance');
    };
    const { exitCode } = await run({ distribute_near: boom, distribute_mpoo: boom });
    assert.equal(exitCode, 1);
  });

  it('never writes the private key to the log', async () => {
    const { lines } = await run({ distribute_near: ok('h1'), distribute_mpoo: ok('h2') });
    assert.ok(!lines.join('\n').includes(FAKE_KEY));
  });
});

describe('buildCall', () => {
  it('builds a no-arg, no-deposit function call that returns failures instead of throwing', () => {
    const tx = buildCall('board3.metapoo.testnet', 'distribute_mpoo', 100);
    assert.equal(tx.receiverId, 'board3.metapoo.testnet');
    assert.equal(tx.throwOnFailure, false);
    assert.equal(tx.actions.length, 1);
    const fc = tx.actions[0].functionCall;
    assert.equal(fc.methodName, 'distribute_mpoo');
    assert.equal(Buffer.from(fc.args).toString(), '{}');
    assert.equal(BigInt(fc.gas), 100_000_000_000_000n);
    assert.equal(BigInt(fc.deposit), 0n);
  });
});
