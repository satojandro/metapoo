import { atomic, lessBps, shortfallBps } from './amount.js';
import { OUTCOME, REVENUE_REJECTED, errorDetail, logsOf, readResult } from './classify.js';
import { buildSwapTransaction, finalToken, fnCall, quoteRoute, quoteStep, routeTokens } from './route.js';
import { sizeChunk } from './sizing.js';

// The message the board accepts mPOO revenue with (contracts/paid-board, is_revenue_message).
export const REVENUE_MSG = '{"revenue":{}}';

// One run (spec K1), in order:
//   preflight  read the board and the account; sign nothing if anything is off
//   return     send any mPOO already on the account to the board (an earlier return failed)
//   recover    unwrap leftover wNEAR; finish a route left half-way (an intermediate token held)
//   size       one chunk: spendable - reserve, capped by max chunk and by price impact
//   swap       wrap + swap the chunk, each step with min out = fresh quote less slippage
//   return     send the mPOO received to the board
// One JSON line per step. A failure leaves value where it is: NEAR or wNEAR after a failed
// swap, an intermediate token after a failed later step, mPOO after a failed return. The next
// run picks each of those up.
//
// `client` is the chain: view(contractId, method, args), spendableNear(), send({receiverId, actions}).
export async function runBuyback({ config, client, log = (line) => console.log(line), now = () => new Date() }) {
  const { route } = config;
  const mpoo = finalToken(route);
  let failures = 0;
  let nearSwapped = 0n;
  let mpooReturned = 0n;

  const emit = (step, fields) => {
    if (fields.outcome === OUTCOME.FAILED) failures += 1;
    log(
      JSON.stringify({
        ts: now().toISOString(),
        network: config.network,
        board: config.boardId,
        buyback: config.accountId,
        route: route.id,
        step,
        ...fields,
      }),
    );
  };

  const ftBalance = async (token) => atomic(await client.view(token, 'ft_balance_of', { account_id: config.accountId }), `${token} balance`);

  // Sends one transaction. Never throws: a thrown error becomes `failure`, because what moved is
  // read from balances afterwards, not from whether the call returned.
  async function submit(tx) {
    try {
      const response = await client.send(tx);
      const { txHash, failure } = readResult(response);
      return { txHash, failure, logs: logsOf(response) };
    } catch (error) {
      return { txHash: error?.txHash ?? error?.transactionHash ?? null, failure: errorDetail(error), logs: [] };
    }
  }

  // --- preflight: nothing is signed unless the board names this account and the route fits it.
  try {
    const problems = [];
    const state = await client.view(config.boardId, 'get_revenue_state', {});
    if (state?.buyback_account !== config.accountId) problems.push('board buyback_account is not BUYBACK_ACCOUNT_ID');
    if (state?.mpoo_token !== mpoo) problems.push("route does not end in the board's mpoo_token");
    const unregistered = [];
    for (const token of routeTokens(route)) {
      const storage = await client.view(token, 'storage_balance_of', { account_id: config.accountId });
      if (storage === null || storage === undefined) unregistered.push(token);
    }
    if (unregistered.length) problems.push('buyback account has no storage registration on some route tokens');
    if (problems.length) {
      emit('preflight', { outcome: OUTCOME.FAILED, problems, ...(unregistered.length ? { unregistered } : {}) });
      return finish();
    }
    emit('preflight', { outcome: OUTCOME.OK });
  } catch (error) {
    emit('preflight', { outcome: OUTCOME.FAILED, detail: errorDetail(error) });
    return finish();
  }

  // --- return first
  await returnMpoo('before_swap');

  // --- recover
  let swapBroken = false;
  try {
    const wrapped = await ftBalance(config.wrapToken);
    if (wrapped > 0n) {
      const before = await client.spendableNear();
      const r = await submit({
        receiverId: config.wrapToken,
        actions: [fnCall('near_withdraw', { amount: wrapped.toString() }, config.gas.unwrapTgas, 1n)],
      });
      const left = await ftBalance(config.wrapToken);
      const after = await client.spendableNear();
      const ok = left < wrapped;
      emit('unwrap', {
        outcome: ok ? OUTCOME.UNWRAPPED : OUTCOME.FAILED,
        amount: wrapped.toString(),
        wrapLeft: left.toString(),
        nearGained: (after > before ? after - before : 0n).toString(),
        txHash: r.txHash,
        ...(r.failure ? { detail: r.failure } : {}),
      });
      if (!ok) swapBroken = true;
    }
    for (let i = 1; i < route.steps.length && !swapBroken; i += 1) {
      const token = route.steps[i].tokens[0];
      const held = await ftBalance(token);
      if (held > 0n) {
        const done = await swapFrom(i, held, { resumed: true });
        if (!done) swapBroken = true;
      }
    }
  } catch (error) {
    emit('recover', { outcome: OUTCOME.FAILED, detail: errorDetail(error) });
    swapBroken = true;
  }

  // --- size and swap one chunk
  if (swapBroken) {
    emit('size', { outcome: OUTCOME.SKIPPED, reason: 'earlier_failure' });
  } else {
    try {
      const spendable = await client.spendableNear();
      const sized = await sizeChunk({
        spendable,
        gasReserve: config.gasReserve,
        maxChunk: config.maxChunk,
        minChunk: config.minChunk,
        maxImpactBps: config.maxImpactBps,
        quote: (amount) => quoteRoute(client, route, amount),
      });
      emit('size', {
        outcome: sized.skipped ? OUTCOME.SKIPPED : OUTCOME.SIZED,
        ...(sized.skipped ? { reason: sized.skipped } : {}),
        spendable: spendable.toString(),
        gasReserve: config.gasReserve.toString(),
        available: sized.available.toString(),
        maxChunk: config.maxChunk.toString(),
        minChunk: config.minChunk.toString(),
        maxImpactBps: config.maxImpactBps,
        chunk: sized.chunk.toString(),
        binding: sized.binding,
        ...(sized.impactBps !== undefined ? { impactBps: sized.impactBps } : {}),
        ...(sized.quotedOut !== undefined ? { routeQuotedOut: sized.quotedOut.toString() } : {}),
      });
      if (!sized.skipped) await swapFrom(0, sized.chunk, { resumed: false });
    } catch (error) {
      emit('size', { outcome: OUTCOME.FAILED, detail: errorDetail(error) });
    }
  }

  // --- return what the swap bought
  await returnMpoo('after_swap');
  return finish();

  // Runs route steps from `start`, each in its own transaction with a fresh quote.
  async function swapFrom(start, amountIn, { resumed }) {
    let input = amountIn;
    for (let i = start; i < route.steps.length; i += 1) {
      const step = route.steps[i];
      const tokenIn = step.tokens[0];
      const tokenOut = step.tokens.at(-1);
      const isFinal = i === route.steps.length - 1;
      const base = {
        index: i + 1,
        resumed,
        venue: step.venue,
        exchange: step.exchange,
        pools: step.pools,
        tokenIn,
        tokenOut,
        amountIn: input.toString(),
      };
      try {
        const quoted = await quoteStep(client, step, input);
        const minAmountOut = lessBps(quoted, config.slippageBps);
        if (minAmountOut === 0n) {
          emit('swap', { ...base, outcome: OUTCOME.FAILED, quotedOut: quoted.toString(), detail: 'quote is zero: no liquidity for this amount', left: leftAt(i) });
          return false;
        }
        const outBefore = await ftBalance(tokenOut);
        const tx = buildSwapTransaction(step, {
          amountIn: input,
          minAmountOut,
          wrap: i === 0,
          gasSwapTgas: config.gas.swapTgas,
          gasWrapTgas: config.gas.wrapTgas,
        });
        const r = await submit(tx);
        const outAfter = await ftBalance(tokenOut);
        const received = outAfter > outBefore ? outAfter - outBefore : 0n;
        const inputLeft = await ftBalance(tokenIn);
        const entry = {
          ...base,
          quotedOut: quoted.toString(),
          minAmountOut: minAmountOut.toString(),
          received: received.toString(),
          differenceBps: shortfallBps(quoted, received),
          inputLeft: inputLeft.toString(),
          txHash: r.txHash,
        };
        if (received === 0n) {
          emit('swap', { ...entry, outcome: OUTCOME.FAILED, detail: r.failure ?? 'nothing received; the exchange refunded the input', left: leftAt(i) });
          return false;
        }
        // NEARLY's buy tax is taken after the exchange's minimum-output check, so the final
        // step normally lands below the quote (and can land below min out). Logged, not fatal.
        emit('swap', {
          ...entry,
          outcome: OUTCOME.SWAPPED,
          ...(received < quoted ? { warning: 'received_below_quote' } : {}),
          ...(isFinal && received < minAmountOut ? { belowMinimum: true } : {}),
          ...(r.failure ? { detail: r.failure } : {}),
        });
        if (i === 0) nearSwapped += input;
        input = received;
      } catch (error) {
        emit('swap', { ...base, outcome: OUTCOME.FAILED, detail: errorDetail(error), left: leftAt(i) });
        return false;
      }
    }
    return true;
  }

  function leftAt(i) {
    return i === 0 ? 'NEAR or wNEAR on the buyback account' : `${route.steps[i].tokens[0]} on the buyback account`;
  }

  async function returnMpoo(phase) {
    try {
      const held = await ftBalance(mpoo);
      if (held === 0n) {
        emit('return', { phase, outcome: OUTCOME.NOTHING, amount: '0' });
        return;
      }
      const r = await submit({
        receiverId: mpoo,
        actions: [fnCall('ft_transfer_call', { receiver_id: config.boardId, amount: held.toString(), msg: REVENUE_MSG }, config.gas.returnTgas, 1n)],
      });
      const left = await ftBalance(mpoo);
      const accepted = held > left ? held - left : 0n;
      mpooReturned += accepted;
      const rejected = r.logs.some((l) => typeof l === 'string' && l.includes(REVENUE_REJECTED));
      emit('return', {
        phase,
        outcome: accepted === held ? OUTCOME.RETURNED : OUTCOME.FAILED,
        amount: held.toString(),
        accepted: accepted.toString(),
        txHash: r.txHash,
        ...(accepted === held ? {} : { detail: rejected ? 'board refunded: revenue_rejected (NotBuybackAccount)' : (r.failure ?? 'board did not accept all of it; mPOO stays for the next run') }),
      });
    } catch (error) {
      emit('return', { phase, outcome: OUTCOME.FAILED, detail: errorDetail(error) });
    }
  }

  function finish() {
    const exitCode = failures > 0 ? 1 : 0;
    emit('summary', {
      outcome: exitCode === 0 ? OUTCOME.OK : 'had_failures',
      failures,
      nearSwapped: nearSwapped.toString(),
      mpooReturned: mpooReturned.toString(),
      exitCode,
    });
    return { exitCode };
  }
}
