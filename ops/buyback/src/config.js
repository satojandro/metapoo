// Buyback configuration, read from environment variables only (spec K2). Everything is checked
// before anything is signed. The private key comes from a secret env var; it is never read from
// a file and never printed. Error messages name the variable, never its value.

import { YOCTO_PER_NEAR, parseNear } from './amount.js';
import { isAccountId, networkMismatch, parseRoute } from './route.js';

export const DEFAULT_RPC = Object.freeze({
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
});

export const DEFAULT_WRAP_TOKEN = Object.freeze({
  testnet: 'wrap.testnet',
  mainnet: 'wrap.near',
});

// Spec K2 proposals. BUYBACK_MAX_CHUNK_NEAR and BUYBACK_MIN_CHUNK_NEAR have no default: the
// chunk size is the owner's call per network.
export const DEFAULTS = Object.freeze({
  gasReserveNear: '1',
  maxImpactBps: 50,
  slippageBps: 100,
  gasSwapTgas: 200,
  gasReturnTgas: 100,
  gasWrapTgas: 10,
  gasUnwrapTgas: 10,
});

// Below this the account could not pay for the run's own transactions.
const MIN_GAS_RESERVE = YOCTO_PER_NEAR / 10n;
const PRIVATE_KEY_RE = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid buyback configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function checkAccountId(name, value, network, problems) {
  if (!value) {
    problems.push(`${name} is required`);
    return false;
  }
  if (!isAccountId(value)) {
    problems.push(`${name} is not a valid NEAR account id`);
    return false;
  }
  const mismatch = networkMismatch(value, network);
  if (mismatch) {
    problems.push(`${name} ${mismatch}`);
    return false;
  }
  return true;
}

function parseNearVar(name, raw, fallback, problems, { required = false, positive = true } = {}) {
  if (raw === undefined || raw === '') {
    if (required) problems.push(`${name} is required (an amount of NEAR, e.g. 2.5)`);
    return fallback === undefined ? undefined : parseNear(fallback);
  }
  const value = parseNear(raw);
  if (value === null || (positive && value === 0n)) {
    problems.push(`${name} must be a positive decimal amount of NEAR`);
    return undefined;
  }
  return value;
}

function parseInteger(name, raw, fallback, min, max, unit, problems) {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer number of ${unit} between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const trim = (k) => (typeof env[k] === 'string' ? env[k].trim() : undefined);

  const network = trim('BUYBACK_NETWORK');
  if (!network) problems.push('BUYBACK_NETWORK is required (testnet or mainnet)');
  else if (!Object.hasOwn(DEFAULT_RPC, network)) problems.push('BUYBACK_NETWORK must be testnet or mainnet');
  const validNetwork = network && Object.hasOwn(DEFAULT_RPC, network) ? network : undefined;

  let rpcUrl = trim('BUYBACK_RPC_URL') || (validNetwork ? DEFAULT_RPC[validNetwork] : undefined);
  if (rpcUrl) {
    try {
      const u = new URL(rpcUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      problems.push('BUYBACK_RPC_URL must be an http(s) URL');
      rpcUrl = undefined;
    }
  }

  // A paid RPC (FastNEAR and similar) meters requests by key. Optional: the public
  // endpoints need no credential. Sent as an Authorization header, never in the URL.
  const rpcApiKey = trim('BUYBACK_RPC_API_KEY');

  const boardId = trim('BUYBACK_BOARD_CONTRACT_ID');
  const accountId = trim('BUYBACK_ACCOUNT_ID');
  const boardOk = checkAccountId('BUYBACK_BOARD_CONTRACT_ID', boardId, validNetwork, problems);
  const accountOk = checkAccountId('BUYBACK_ACCOUNT_ID', accountId, validNetwork, problems);
  if (boardOk && accountOk && boardId === accountId) {
    problems.push('BUYBACK_ACCOUNT_ID must be a dedicated account, not the board');
  }

  const wrapToken = trim('BUYBACK_WRAP_TOKEN_ID') || (validNetwork ? DEFAULT_WRAP_TOKEN[validNetwork] : undefined);
  if (trim('BUYBACK_WRAP_TOKEN_ID')) checkAccountId('BUYBACK_WRAP_TOKEN_ID', wrapToken, validNetwork, problems);

  const privateKey = trim('BUYBACK_PRIVATE_KEY');
  if (!privateKey) problems.push('BUYBACK_PRIVATE_KEY is required (set it from a secret)');
  else if (!PRIVATE_KEY_RE.test(privateKey)) {
    // Never echo the value: it may be a real key with a typo.
    problems.push('BUYBACK_PRIVATE_KEY must look like ed25519:<base58>');
  }

  const gasReserve = parseNearVar('BUYBACK_GAS_RESERVE', trim('BUYBACK_GAS_RESERVE'), DEFAULTS.gasReserveNear, problems);
  if (gasReserve !== undefined && gasReserve < MIN_GAS_RESERVE) {
    problems.push('BUYBACK_GAS_RESERVE must be at least 0.1 NEAR');
  }
  const maxChunk = parseNearVar('BUYBACK_MAX_CHUNK_NEAR', trim('BUYBACK_MAX_CHUNK_NEAR'), undefined, problems, { required: true });
  const minChunk = parseNearVar('BUYBACK_MIN_CHUNK_NEAR', trim('BUYBACK_MIN_CHUNK_NEAR'), undefined, problems, { required: true });
  if (maxChunk !== undefined && minChunk !== undefined && minChunk > maxChunk) {
    problems.push('BUYBACK_MIN_CHUNK_NEAR must not exceed BUYBACK_MAX_CHUNK_NEAR');
  }

  const maxImpactBps = parseInteger('BUYBACK_MAX_IMPACT_BPS', trim('BUYBACK_MAX_IMPACT_BPS'), DEFAULTS.maxImpactBps, 1, 1000, 'basis points', problems);
  const slippageBps = parseInteger('BUYBACK_SLIPPAGE_BPS', trim('BUYBACK_SLIPPAGE_BPS'), DEFAULTS.slippageBps, 1, 500, 'basis points', problems);
  const gasSwapTgas = parseInteger('BUYBACK_GAS_SWAP_TGAS', trim('BUYBACK_GAS_SWAP_TGAS'), DEFAULTS.gasSwapTgas, 50, 300 - DEFAULTS.gasWrapTgas, 'TGas', problems);
  const gasReturnTgas = parseInteger('BUYBACK_GAS_RETURN_TGAS', trim('BUYBACK_GAS_RETURN_TGAS'), DEFAULTS.gasReturnTgas, 30, 300, 'TGas', problems);

  const { route, problems: routeProblems } = parseRoute(trim('BUYBACK_ROUTE'), { network: validNetwork, wrapToken });
  problems.push(...routeProblems);

  if (problems.length > 0) throw new ConfigError(problems);

  const config = {
    network,
    rpcUrl,
    boardId,
    accountId,
    wrapToken,
    route,
    gasReserve,
    maxChunk,
    minChunk,
    maxImpactBps,
    slippageBps,
    gas: Object.freeze({
      swapTgas: gasSwapTgas,
      returnTgas: gasReturnTgas,
      wrapTgas: DEFAULTS.gasWrapTgas,
      unwrapTgas: DEFAULTS.gasUnwrapTgas,
    }),
  };
  // Non-enumerable so JSON.stringify(config) or console.log(config) cannot leak it.
  Object.defineProperty(config, 'privateKey', { value: privateKey, enumerable: false });
  // Same rule as the private key: never in JSON.stringify(config) or a console.log.
  if (rpcApiKey) Object.defineProperty(config, 'rpcApiKey', { value: rpcApiKey, enumerable: false });
  return Object.freeze(config);
}
