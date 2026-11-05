import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from 'near-api-js';

// Transaction parameters for one distribute call: no arguments, no deposit (a function-call
// access key cannot attach one anyway), and failures returned rather than thrown so the
// keeper can read the error code and the transaction hash.
export function buildCall(contractId, method, gasTgas) {
  return {
    receiverId: contractId,
    actions: [actions.functionCall(method, {}, teraToGas(gasTgas), 0n)],
    waitUntil: 'EXECUTED_OPTIMISTIC',
    throwOnFailure: false,
  };
}

// `headers` is part of the provider's ConnectionInfo: near-api-js forwards it to fetch.
// A paid RPC meters requests by key, and the header keeps the key out of the URL and logs.
export function rpcConnection(config) {
  return config.rpcApiKey
    ? { url: config.rpcUrl, headers: { Authorization: `Bearer ${config.rpcApiKey}` } }
    : { url: config.rpcUrl };
}

export function createNearClient(config) {
  const provider = new JsonRpcProvider(rpcConnection(config));
  const signer = KeyPairSigner.fromSecretKey(config.privateKey);
  const account = new Account(config.accountId, provider, signer);
  const client = {
    call: (method, gasTgas) => account.signAndSendTransaction(buildCall(config.contractId, method, gasTgas)),
  };
  if (config.staking) {
    // Same keeper account, its second function-call key (receiver: the staking contract).
    const stakingAccount = new Account(config.accountId, provider, KeyPairSigner.fromSecretKey(config.staking.privateKey));
    client.callStaking = (method, gasTgas) =>
      stakingAccount.signAndSendTransaction(buildCall(config.staking.contractId, method, gasTgas));
  }
  return client;
}
