import { classifyError, classifyResult, exitCodeFor } from './classify.js';
import { METHODS } from './config.js';

// Calls each distribute method once, in order, and logs one JSON line per call.
// `client.call(method, gasTgas)` returns the RPC transaction response or throws.
// A failure of the first call never stops the second.
export async function runKeeper({ config, client, log = (line) => console.log(line), now = () => new Date() }) {
  const results = [];
  for (const method of METHODS) {
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
  return { results, exitCode: exitCodeFor(results) };
}
