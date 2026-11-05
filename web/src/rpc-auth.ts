/**
 * Auth headers for a paid JSON-RPC endpoint.
 *
 * FastNEAR (and similar providers) accept the key as `Authorization: Bearer <key>`
 * or as an `?apiKey=` query parameter. The header is the documented default: it
 * keeps the credential out of copied URLs and most request logs.
 *
 * The key is only sent where it is meant to go:
 *
 *   - the configured endpoint's origin, and
 *   - another FastNEAR host when the configured endpoint is FastNEAR's own
 *     (one FastNEAR key works across their regular and archival RPC hosts).
 *
 * A read transport may fall back to a second host (see `read-rpc.ts`). Sending the
 * key to a host that never issued it would leak the credential without buying any
 * headroom.
 *
 * A key in a browser bundle is not a secret: Vite inlines every `VITE_` value into
 * the shipped JavaScript. Treat it as a rate-limit credential a visitor can lift,
 * and only ship one for a domain-restricted (browser) key.
 */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // A relative or malformed URL cannot be proven to belong to the key's host.
    return null;
  }
}

function isFastNearHost(host: string | null): boolean {
  return host !== null && (host === "fastnear.com" || host.endsWith(".fastnear.com"));
}

/** True for any FastNEAR host (RPC, archival, tx, api, kv): one key covers all of them. */
export function isFastNearUrl(url: string): boolean {
  return isFastNearHost(hostOf(url));
}

/** `Bearer` value for `requestUrl`, or no header when that host is not the key's host. */
export function rpcAuthHeaders(
  requestUrl: string,
  primaryUrl: string,
  apiKey: string,
): Record<string, string> {
  if (!apiKey) return {};
  const requestHost = hostOf(requestUrl);
  const primaryHost = hostOf(primaryUrl);
  if (requestHost === null || primaryHost === null) return {};
  const sameHost = requestHost === primaryHost;
  const sameFastNearAccount = isFastNearHost(requestHost) && isFastNearHost(primaryHost);
  if (!sameHost && !sameFastNearAccount) return {};
  return { Authorization: `Bearer ${apiKey}` };
}
