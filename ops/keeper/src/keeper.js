import { OUTCOME, classifyError, classifyResult, exitCodeFor } from './classify.js';
import { METHODS, SYNC_INFLOW_METHOD } from './config.js';

// Calls each distribute method once, in order, and logs one JSON line per call.
// `client.call(method, gasTgas)` returns the RPC transaction response or throws.
// A failure of the first call never stops the second.
export async function runKeeper({ config, client, log = (line) => console.log(line), now = () => new Date() }) {
  const results = [];
  // Free pre-read: skip a call the contract would only panic on. `NothingToDistribute`
  // and an empty mPOO side are the normal idle state between revenue events; signing
  // anyway would spend fee money every hour to learn nothing. No read (undefined) or an
  // unexpected shape signs as before.
  const state = await client.revenueState?.();
  const nearWorthTrying = !state || state.withdrawable_near !== '0';
  const mpooWorthTrying = !state
    || state.mpoo_undistributed !== '0'
    || state.mpoo_staker_reserve !== '0';
  for (const method of METHODS) {
    if (method === 'distribute_near' && !nearWorthTrying) {
      const entry = {
        ts: now().toISOString(),
        network: config.network,
        contract: config.contractId,
        keeper: config.accountId,
        method,
        outcome: 'skipped',
        reason: 'withdrawable_near_is_0',
      };
      results.push(entry);
      log(JSON.stringify(entry));
      continue;
    }
    if (method === 'distribute_mpoo' && !mpooWorthTrying) {
      const entry = {
        ts: now().toISOString(),
        network: config.network,
        contract: config.contractId,
        keeper: config.accountId,
        method,
        outcome: 'skipped',
        reason: 'no_mpoo_waiting',
      };
      results.push(entry);
      log(JSON.stringify(entry));
      continue;
    }
    const gasTgas = config.gasTgas[method];
    let classified;
    try {
      classified = classifyResult(await client.call(method, gasTgas));
    } catch (error) {
      classified = classifyError(error);
    }
    const entry = {
      ts: now().toISOString(),
      network: config.network,
      contract: config.contractId,
      keeper: config.accountId,
      method,
      gasTgas,
      ...classified,
    };
    results.push(entry);
    log(JSON.stringify(entry));
  }
  // TR-S: count the stakers' share the board just sent. Only after a distribute_mpoo that
  // went through; a missed sync loses nothing (the next one, by anyone, counts it).
  const mpoo = results.find((r) => r.method === 'distribute_mpoo');
  if (config.staking && mpoo?.outcome === OUTCOME.DISTRIBUTED) {
    const { contractId, gasTgas } = config.staking;
    let classified;
    try {
      classified = classifyResult(await client.callStaking(SYNC_INFLOW_METHOD, gasTgas));
    } catch (error) {
      classified = classifyError(error);
    }
    const entry = {
      ts: now().toISOString(),
      network: config.network,
      contract: contractId,
      keeper: config.accountId,
      method: SYNC_INFLOW_METHOD,
      gasTgas,
      ...classified,
    };
    results.push(entry);
    log(JSON.stringify(entry));
  }
  return { results, exitCode: exitCodeFor(results) };
}
