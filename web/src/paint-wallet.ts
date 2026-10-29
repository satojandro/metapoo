/** Read-only balances. No wallet signatures, transfers or optimistic credits. */
export const MPOO_ACCOUNT = "mpoo.nearlytrade.near";
export const NEARLY_MPOO_URL = "https://nearly.trade/mpoo.nearlytrade.near";
export interface PaintWalletSnapshot {
  price: string;
  credits: string;
  near: string;
  mpoo: string;
  note: string;
}
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  return value as Record<string, unknown>;
}
function units(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid amount");
  return BigInt(value);
}
/** Decimal strings preserve token precision, even above JavaScript's integer limit. */
export function formatUnits(value: string, decimals: number): string {
  units(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error("Invalid decimals");
  const padded = BigInt(value).toString().padStart(decimals + 1, "0");
  if (!decimals) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
export function availableNear(amount: string, locked: string, bytes: number, byteCost: string): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid storage");
  const total = units(amount) + units(locked);
  const storage = BigInt(bytes) * units(byteCost);
  const reserved = storage > units(locked) ? storage : units(locked);
  return formatUnits((total > reserved ? total - reserved : 0n).toString(), 24);
}
export function createReadRpc(url: string, signal: AbortSignal): Rpc {
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: "paint-wallet", method, params }),
    });
    if (!response.ok) throw new Error("Network unavailable");
    const data = record(await response.json());
    if (data.error || !("result" in data)) throw new Error("Read failed");
    return data.result;
  };
}
async function view(rpc: Rpc, account: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = record(await rpc("query", {
    request_type: "call_function", account_id: account, method_name: method,
    args_base64: btoa(JSON.stringify(args)), finality: "final",
  }));
  if (!Array.isArray(response.result) || !response.result.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("Invalid view");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(response.result)));
}

export async function loadPaintWallet(rpc: Rpc, board: string, network: string, account: string | null): Promise<PaintWalletSnapshot> {
  const result: PaintWalletSnapshot = {
    price: "Planned: 0.0069 NEAR / pixel", credits: "Paid painting not available yet",
    near: account ? "Unavailable — retry" : "Connect wallet to view",
    mpoo: account ? "Unavailable — retry" : "Connect wallet to view",
    note: "Buy credits from the paint dock when this board is paid. Balances here stay read-only.",
  };
  // NEAR can load even if the board or token read fails.
  const nearRead = (async () => {
    if (!account) return;
    try {
      const state = record(await rpc("query", {request_type: "view_account", account_id: account, finality: "final"}));
      const config = record(await rpc("EXPERIMENTAL_protocol_config", {block_id: state.block_hash}));
      const runtime = record(config.runtime_config);
      result.near = `${availableNear(String(state.amount), String(state.locked), state.storage_usage as number, String(runtime.storage_amount_per_byte))} NEAR`;
    } catch { /* Retain an explicit unavailable value; never display a fake zero. */ }
  })();
  let token = network === "mainnet" ? MPOO_ACCOUNT : "";
  let config: Record<string, unknown> | null = null;
  if (board) {
    try {
      const meta = record(await view(rpc, board, "get_board"));
      if (meta.schema_version === 4) {
        config = record(await view(rpc, board, "get_payment_config"));
        if (typeof config.mpoo_token !== "string" || !/^[a-z0-9._-]{2,64}$/.test(config.mpoo_token)) throw new Error("Invalid token");
        if (network === "mainnet" && config.mpoo_token !== MPOO_ACCOUNT) throw new Error("Unexpected mPOO token");
        if (units(config.near_per_credit) <= 0n || units(config.mpoo_per_credit) <= 0n) throw new Error("Invalid price");
        token = config.mpoo_token;
        result.price = `${formatUnits(String(config.near_per_credit),24)} NEAR / pixel`;
        result.credits = account ? "Unavailable — retry" : "Connect wallet to view";
        result.note =
          "Buy credits from the paint dock on the wall. This panel only shows balances.";
      } else {
        result.note = "This board does not use paint credits.";
      }
    } catch {
      config = null;
      result.price = "Unavailable — retry";
      result.credits = "Unavailable — retry";
      result.note = "Could not verify paid-board prices. Retry to refresh.";
    }
  }
  await Promise.all([
    nearRead,
    (async () => {
      if (!config || !account) return;
      try {
        const balance = await view(rpc, board, "get_credits", {account_id: account});
        result.credits = balance === null ? "Not registered · 0 credits" : `${units(balance)} pixels`;
      } catch { result.credits = "Unavailable — retry"; }
    })(),
    (async () => {
      if (!token) { result.mpoo = "No mPOO token configured on this network"; return; }
      try {
        const metadata = record(await view(rpc, token, "ft_metadata"));
        const decimals = metadata.decimals as number;
        // Validate metadata even if disconnected; it also formats the price.
        formatUnits("0", decimals);
        const label = network === "mainnet" ? "mPOO" : "test token";
        if (config) result.price += ` · ${formatUnits(String(config.mpoo_per_credit), decimals)} ${label} / pixel`;
        if (account) result.mpoo = `${formatUnits(String(await view(rpc, token, "ft_balance_of", {account_id: account})),decimals)} ${label}`;
      } catch { if (config) result.price += " · mPOO price unavailable"; }
    })(),
  ]);
  return result;
}
