// Keeper configuration, read from environment variables only. The private key comes from a
// secret env var (a GitHub Actions secret, or the server's environment); it is never read
// from a file and never printed.

export const DEFAULT_RPC = Object.freeze({
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
});

// Prepaid gas per call, in TGas. Unused gas is refunded; the function-call key's allowance
// must cover the prepaid amount at the current gas price. Measure on testnet (REV-E) and
// tune: distribute_mpoo makes three outgoing transfers with callbacks, so it needs more.
export const DEFAULT_GAS_TGAS = Object.freeze({
  distribute_near: 50,
  distribute_mpoo: 150,
});

export const METHODS = Object.freeze(['distribute_near', 'distribute_mpoo']);

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_RE = /^[0-9a-f]{64}$/;
const PRIVATE_KEY_RE = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid keeper configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function checkAccountId(name, value, network, problems) {
  if (!value) {
    problems.push(`${name} is required`);
    return;
  }
  if (value.length < 2 || value.length > 64 || !ACCOUNT_ID_RE.test(value)) {
    problems.push(`${name} is not a valid NEAR account id`);
    return;
  }
  if (IMPLICIT_RE.test(value) || !network) return;
  // Catch a testnet id in a mainnet run (and the reverse) before signing anything.
  if (network === 'mainnet' && value.endsWith('.testnet')) {
    problems.push(`${name} ends with .testnet but KEEPER_NETWORK is mainnet`);
  }
  if (network === 'testnet' && value.endsWith('.near')) {
    problems.push(`${name} ends with .near but KEEPER_NETWORK is testnet`);
  }
}

function parseGas(name, raw, fallback, problems) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 5 || n > 300) {
    problems.push(`${name} must be an integer number of TGas between 5 and 300`);
    return fallback;
  }
  return n;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const trim = (k) => (typeof env[k] === 'string' ? env[k].trim() : undefined);

  const network = trim('KEEPER_NETWORK');
  if (!network) problems.push('KEEPER_NETWORK is required (testnet or mainnet)');
  else if (!Object.hasOwn(DEFAULT_RPC, network)) problems.push('KEEPER_NETWORK must be testnet or mainnet');
  const validNetwork = network && Object.hasOwn(DEFAULT_RPC, network) ? network : undefined;

  let rpcUrl = trim('KEEPER_RPC_URL') || (validNetwork ? DEFAULT_RPC[validNetwork] : undefined);
  if (rpcUrl) {
    try {
      const u = new URL(rpcUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      problems.push('KEEPER_RPC_URL must be an http(s) URL');
      rpcUrl = undefined;
    }
  }

  const contractId = trim('KEEPER_BOARD_CONTRACT_ID');
  const accountId = trim('KEEPER_ACCOUNT_ID');
  checkAccountId('KEEPER_BOARD_CONTRACT_ID', contractId, validNetwork, problems);
  checkAccountId('KEEPER_ACCOUNT_ID', accountId, validNetwork, problems);

  const privateKey = trim('KEEPER_PRIVATE_KEY');
  if (!privateKey) problems.push('KEEPER_PRIVATE_KEY is required (set it from a secret)');
  else if (!PRIVATE_KEY_RE.test(privateKey)) {
    // Never echo the value: it may be a real key with a typo.
    problems.push('KEEPER_PRIVATE_KEY must look like ed25519:<base58>');
  }

  const gasTgas = {
    distribute_near: parseGas('KEEPER_GAS_NEAR_TGAS', trim('KEEPER_GAS_NEAR_TGAS'), DEFAULT_GAS_TGAS.distribute_near, problems),
    distribute_mpoo: parseGas('KEEPER_GAS_MPOO_TGAS', trim('KEEPER_GAS_MPOO_TGAS'), DEFAULT_GAS_TGAS.distribute_mpoo, problems),
  };

  if (problems.length > 0) throw new ConfigError(problems);

  const config = { network, rpcUrl, contractId, accountId, gasTgas };
  // Non-enumerable so JSON.stringify(config) or console.log(config) cannot leak it.
  Object.defineProperty(config, 'privateKey', { value: privateKey, enumerable: false });
  return Object.freeze(config);
}
