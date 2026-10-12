/**
 * Display helpers for decimal-string amounts and nanosecond timestamps.
 * Never use floating-point arithmetic for token quantities.
 */

const NS_PER_MS = 1_000_000n;

/** Format a decimal-string token amount for display (keeps digits as text). */
export function formatAmountString(amount: string, tokenSymbol: string): string {
  if (!/^\d+$/.test(amount)) {
    return `invalid amount (${tokenSymbol})`;
  }
  // Show full integer string; UI may later use shared precision helpers from A.
  return `${amount} ${tokenSymbol}`;
}

/** Compact NEAR storage/gas label — separate from the MPOO award. */
export function formatNearCost(amountNear: string, kind: "storage" | "gas"): string {
  const label = kind === "storage" ? "NEAR storage" : "NEAR gas (estimate)";
  return `${amountNear} ${label}`;
}

/** Convert nanosecond decimal string to a local + UTC review string. */
export function formatTimestampNs(ns: string): string {
  if (!/^\d+$/.test(ns)) {
    return "invalid time";
  }
  const ms = Number(BigInt(ns) / NS_PER_MS);
  if (!Number.isFinite(ms)) {
    return "invalid time";
  }
  const date = new Date(ms);
  const local = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const utc = date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return `${local} (local) · ${utc}`;
}

export function formatCrop(crop: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return `(${crop.x}, ${crop.y}) · ${crop.width}×${crop.height}`;
}
