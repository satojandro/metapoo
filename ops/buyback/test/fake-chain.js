// A fake chain for the buyback tests: one buyback account, constant-product pools per route
// step, a board that accepts mPOO revenue from its buyback_account only, and an optional token
// tax taken after the exchange's minimum-output check (as NEARLY's mPOO does on RHEA DCL).
// Nothing here touches the network.

export const N = 10n ** 24n; // 1 NEAR in yocto
export const T = 10n ** 18n; // 1 whole 18-decimal token

export const ACCOUNT = 'buyback.metapoo.testnet';
export const BOARD = 'board3.metapoo.testnet';
export const WRAP = 'wrap.testnet';
export const MID = 'rhea.fakedex.testnet';
export const DIA = 'diarhea.fakedex.testnet';
export const MPOO = 'mpoo.fakedex.testnet';
export const CLASSIC = 'ref.fakedex.testnet';
export const DCL = 'dcl.fakedex.testnet';

// Two steps on two exchanges, like the mainnet candidate: classic wNEAR->MID, DCL MID->DIA->MPOO.
export const ROUTE = {
  id: 'test-route',
  steps: [
    { venue: 'classic', exchange: CLASSIC, tokens: [WRAP, MID], pools: [7] },
    { venue: 'dcl', exchange: DCL, tokens: [MID, DIA, MPOO], pools: [`${DIA}|${MID}|10000`, `${DIA}|${MPOO}|10000`] },
  ],
};

// Obviously fake: valid base58 shape, not a real key.
export const FAKE_KEY = `ed25519:${'1'.repeat(64)}`;

export const BASE_ENV = Object.freeze({
  BUYBACK_NETWORK: 'testnet',
  BUYBACK_BOARD_CONTRACT_ID: BOARD,
  BUYBACK_ACCOUNT_ID: ACCOUNT,
  BUYBACK_PRIVATE_KEY: FAKE_KEY,
  BUYBACK_MAX_CHUNK_NEAR: '2',
  BUYBACK_MIN_CHUNK_NEAR: '0.5',
  BUYBACK_ROUTE: JSON.stringify(ROUTE),
});

export function fakeChain(opts = {}) {
  const chain = {
    near: opts.near ?? 20n * N,
    balances: new Map(Object.entries({ [WRAP]: 0n, [MID]: 0n, [DIA]: 0n, [MPOO]: 0n, ...(opts.balances ?? {}) })),
    registered: new Set(opts.registered ?? [WRAP, MID, DIA, MPOO]),
    revenueState: { buyback_account: ACCOUNT, mpoo_token: MPOO, ...(opts.revenueState ?? {}) },
    // Step reserves [in, out]. Step 1: 1000 NEAR : 80_000 MID. Step 2: 80_000 MID : 400M MPOO.
    reserves: opts.reserves ?? [
      [1000n * N, 80_000n * T],
      [80_000n * T, 400_000_000n * T],
    ],
    taxBps: opts.taxBps ?? 0n, // mPOO tax taken after the min-out check
    driftBps: opts.driftBps ?? 0n, // price moves against us between quote and execution
    fail: { ...(opts.fail ?? {}) }, // { swap1: 'throw'|'refund', swap2: ..., return: 'throw'|'reject', unwrap: 'throw' }
    boardReceived: 0n,
    sent: [],
    views: [],
  };

  const bal = (t) => chain.balances.get(t) ?? 0n;
  const add = (t, v) => chain.balances.set(t, bal(t) + v);
  const out = (step, amountIn) => {
    const [rin, rout] = chain.reserves[step];
    return (amountIn * rout) / (rin + amountIn);
  };
  const ok = (hash, logs = []) => ({
    status: { SuccessValue: '' },
    transaction: { hash },
    receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs } }],
  });

  chain.view = async (contractId, method, args) => {
    chain.views.push({ contractId, method, args });
    if (method === 'get_revenue_state' && contractId === BOARD) return chain.revenueState;
    if (method === 'storage_balance_of') return chain.registered.has(contractId) ? { total: '1250000000000000000000', available: '0' } : null;
    if (method === 'ft_balance_of') {
      if (args.account_id !== ACCOUNT) throw new Error('unexpected account');
      return bal(contractId).toString();
    }
    if (method === 'get_return' && contractId === CLASSIC) return out(0, BigInt(args.amount_in)).toString();
    if (method === 'quote' && contractId === DCL) return { amount: out(1, BigInt(args.input_amount)).toString(), tag: null };
    throw new Error(`unexpected view ${contractId}.${method}`);
  };

  chain.spendableNear = async () => chain.near;

  chain.send = async (tx) => {
    chain.sent.push(tx);
    const hash = `h${chain.sent.length}`;
    const [first, last] = [tx.actions[0], tx.actions.at(-1)];

    if (tx.receiverId === WRAP && first.method === 'near_withdraw') {
      if (chain.fail.unwrap === 'throw') throw new Error('fetch failed');
      const amount = BigInt(first.args.amount);
      add(WRAP, -amount);
      chain.near += amount;
      return ok(hash);
    }

    if (tx.receiverId === MPOO && last.args.receiver_id === BOARD) {
      if (chain.fail.return === 'throw') throw new Error('fetch failed');
      if (chain.fail.return === 'reject') return ok(hash, ['revenue_rejected: NotBuybackAccount']);
      const amount = BigInt(last.args.amount);
      add(MPOO, -amount);
      chain.boardReceived += amount;
      return ok(hash, ['EVENT_JSON:{"event":"mpoo_revenue_received"}']);
    }

    const stepIndex = tx.receiverId === WRAP ? 0 : tx.receiverId === MID ? 1 : -1;
    if (stepIndex < 0) throw new Error(`unexpected transaction to ${tx.receiverId}`);
    const failMode = chain.fail[`swap${stepIndex + 1}`];
    if (failMode === 'throw') throw new Error('Transaction failed: RPC timeout');
    const amountIn = BigInt(last.args.amount);
    if (first.method === 'near_deposit') {
      chain.near -= first.depositYocto;
      add(WRAP, first.depositYocto);
    }
    const tokenIn = ROUTE.steps[stepIndex].tokens[0];
    const tokenOut = ROUTE.steps[stepIndex].tokens.at(-1);
    const msg = JSON.parse(last.args.msg);
    const minOut = BigInt(stepIndex === 0 ? msg.actions.at(-1).min_amount_out : msg.Swap.min_output_amount);
    const gross = (out(stepIndex, amountIn) * (10_000n - chain.driftBps)) / 10_000n;
    if (failMode === 'refund' || gross < minOut) {
      // ft_transfer_call succeeds at the top level; the exchange panicked and the token refunded.
      return {
        status: { SuccessValue: 'IjAi' },
        transaction: { hash },
        receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E68: slippage error' } } } } }, logs: [] } }],
      };
    }
    add(tokenIn, -amountIn);
    const [rin, rout] = chain.reserves[stepIndex];
    chain.reserves[stepIndex] = [rin + amountIn, rout - gross];
    const tax = tokenOut === MPOO ? (gross * chain.taxBps) / 10_000n : 0n;
    add(tokenOut, gross - tax);
    return ok(hash);
  };

  return chain;
}
