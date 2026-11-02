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

export function createNearClient(config) {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(config.privateKey);
  const account = new Account(config.accountId, provider, signer);
  return {
    call: (method, gasTgas) => account.signAndSendTransaction(buildCall(config.contractId, method, gasTgas)),
  };
}
