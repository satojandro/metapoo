import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rpcConnection } from '../src/near-client.js';

describe('rpcConnection', () => {
  it('sends no credential to a public endpoint', () => {
    assert.deepEqual(rpcConnection({ rpcUrl: 'https://rpc.testnet.near.org' }), {
      url: 'https://rpc.testnet.near.org',
    });
  });

  it('sends a paid RPC key as a bearer header, never in the URL', () => {
    const connection = rpcConnection({
      rpcUrl: 'https://rpc.testnet.fastnear.com',
      rpcApiKey: 'test-key',
    });
    assert.equal(connection.url, 'https://rpc.testnet.fastnear.com');
    assert.equal(connection.headers.Authorization, 'Bearer test-key');
    assert.ok(!connection.url.includes('test-key'));
  });
});
