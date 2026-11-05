/** Shared read-only transport. Never accepts broadcasts or changes wallet signing. */
import { rpcAuthHeaders } from "./rpc-auth";

export class RpcBusyError extends Error {
  constructor() { super("Network busy. Please retry shortly."); }
}
type Job = { priority: number; run: () => Promise<void> };

export function createReadTransport(options: {
  fetcher?: typeof fetch;
  fallback?: string;
  spacingMs?: number;
  timeoutMs?: number;
  /** Bearer token for the primary endpoint; defaults to `VITE_NEAR_RPC_API_KEY`. */
  apiKey?: string;
} = {}) {
  const pending = new Map<string, Promise<Response>>();
  const health = new Map<string, { failures: number; until: number }>();
  const queue: Job[] = [];
  let active = 0;
  let nextStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spacing = options.spacingMs ?? 200;

  // Read at request time, not import time, so a test or a late env load still applies.
  const apiKey = (): string => (options.apiKey ?? import.meta.env.VITE_NEAR_RPC_API_KEY ?? "").trim();

  // Two reads at a time, with priority for prices, balances and confirmation.
  function pump(): void {
    if (timer || active >= 2 || !queue.length) return;
    const delay = Math.max(0, nextStart - Date.now());
    if (delay) {
      timer = setTimeout(() => { timer = undefined; pump(); }, delay);
      return;
    }
    queue.sort((a, b) => a.priority - b.priority);
    const job = queue.shift()!;
    active++;
    nextStart = Date.now() + spacing;
    void job.run().finally(() => { active--; pump(); });
    pump();
  }

  return async function read(url: string, init: RequestInit, priority = 0): Promise<Response> {
    const body = JSON.parse(String(init.body)) as { method: string; params?: Record<string, unknown> };
    if (!["query", "block", "gas_price", "EXPERIMENTAL_protocol_config"].includes(body.method)) {
      throw new Error("Read transport refuses transaction submission.");
    }
    init.signal?.throwIfAborted();
    // IDs only label responses; account, arguments, network and pinned block remain in the key.
    const key = JSON.stringify([url, body.method, body.params]);
    let work = pending.get(key);
    if (!work) {
      if (queue.length >= 64) throw new RpcBusyError();
      work = new Promise<Response>((resolve, reject) => {
        queue.push({ priority, run: async () => {
          try {
            for (const endpoint of [...new Set([url, options.fallback].filter(Boolean) as string[])]) {
              const previous = health.get(endpoint);
              if (previous && previous.until > Date.now()) continue;
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
              try {
                const headers = new Headers(init.headers);
                for (const [name, value] of Object.entries(rpcAuthHeaders(endpoint, url, apiKey()))) {
                  headers.set(name, value);
                }
                const response = await (options.fetcher ?? fetch)(endpoint, { ...init, headers, signal: controller.signal });
                if (response.status === 429 || response.status >= 500) {
                  const retry = response.headers.get("Retry-After");
                  const wait = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
                  coolDown(endpoint, wait);
                  continue;
                }
                // Read the body within the timeout, before handing independent copies to callers.
                const bytes = await response.arrayBuffer();
                health.delete(endpoint);
                resolve(new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }));
                return;
              } catch {
                // Browsers hide the HTTP status when an error response lacks CORS headers.
                coolDown(endpoint, 0);
              } finally { clearTimeout(timeout); }
            }
            reject(new RpcBusyError());
          } catch (error) { reject(error); }
        } });
        pump();
      });
      pending.set(key, work);
      void work.finally(() => pending.delete(key)).catch(() => undefined);
    }
    // A caller can stop waiting without cancelling another caller's identical read.
    const signal = init.signal;
    if (!signal) return (await work).clone();
    return new Promise<Response>((resolve, reject) => {
      const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void work!.then(response => { cleanup(); resolve(response.clone()); }, error => { cleanup(); reject(error); });
    });
  };

  function coolDown(endpoint: string, retryAfter: number): void {
    const failures = (health.get(endpoint)?.failures ?? 0) + 1;
    const delay = Math.min(60_000, Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, 2_000 * 2 ** Math.min(failures - 1, 5)));
    health.set(endpoint, { failures, until: Date.now() + delay });
  }
}

// Each network gets only its own backup. Local/mock nodes never fall through to a public chain.
function fallbackUrl(): string | undefined {
  const network = import.meta.env.VITE_NEAR_NETWORK || "testnet";
  if (network !== "mainnet" && network !== "testnet") return undefined;
  return import.meta.env.VITE_NEAR_READ_FALLBACK_URL?.trim()
    || (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
}
const transports = new Map<string, ReturnType<typeof createReadTransport>>();
export function readRpcFetch(url: string, init: RequestInit, priority = 0): Promise<Response> {
  let transport = transports.get(url);
  if (!transport) {
    transport = createReadTransport({ fallback: fallbackUrl() });
    transports.set(url, transport);
  }
  return transport(url, init, priority);
}
