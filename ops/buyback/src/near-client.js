import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from 'near-api-js';

// Turns the plain descriptors built in route.js / buyback.js into near-api-js actions.
// waitUntil FINAL: the keeper reads balances straight after each transaction to measure what
// moved, so every receipt (including refunds and ft_resolve_transfer) must be final first.
// Failures are returned, not thrown, so the hash and the error are both logged.
export function buildTransaction({ receiverId, actions: descriptors }) {
  return {
    receiverId,
    actions: descriptors.map((d) => actions.functionCall(d.method, d.args, teraToGas(d.gasTgas), d.depositYocto)),
    waitUntil: 'FINAL',
    throwOnFailure: false,
  };
}

export function rpcConnection(config) {
  return config.rpcApiKey
    ? { url: config.rpcUrl, headers: { Authorization: `Bearer ${config.rpcApiKey}` } }
    : { url: config.rpcUrl };
}

export function createNearClient(config) {
  // `headers` is part of the provider's ConnectionInfo: near-api-js forwards it to fetch.
  // A paid RPC meters requests by key, and the header keeps the key out of the URL and logs.
  const provider = new JsonRpcProvider(rpcConnection(config));
  const signer = KeyPairSigner.fromSecretKey(config.privateKey);
  const account = new Account(config.accountId, provider, signer);
  const final = { finality: 'final' };
  return {
    view: (contractId, method, args) => provider.callFunction({ contractId, method, args, blockQuery: final }),
    // Spendable NEAR: total less what storage staking locks.
    spendableNear: async () => (await account.getState()).balance.available,
    send: (tx) => account.signAndSendTransaction(buildTransaction(tx)),
  };
}
