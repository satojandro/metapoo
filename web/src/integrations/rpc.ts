import type { ReadinessRpc } from "./account-readiness";
/** Preserve structured RPC errors: a timeout must not masquerade as an absent account. */
export function createAcquisitionRpc(url: string): ReadinessRpc {
  return async (method, params) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "acquisition",
          method,
          params,
        }),
      });
      if (!response.ok) throw new Error("NEAR RPC unavailable");
      const json = await response.json();
      if (json.error) throw json.error;
      if (!("result" in json)) throw new Error("Invalid NEAR RPC response");
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  };
}
