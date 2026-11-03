// Integer amounts. Every on-chain amount is a bigint in the token's smallest unit; NEAR is
// 10^24 yoctoNEAR. Nothing here uses floating point, so nothing rounds money away.

export const YOCTO_PER_NEAR = 10n ** 24n;
export const BPS = 10_000n;

// "1", "0.5", "12.000001" -> yoctoNEAR. Returns null for anything that isn't a plain
// non-negative decimal with at most 24 fractional digits.
export function parseNear(text) {
  if (typeof text !== 'string' || text.length > 40 || !/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, '0'));
}

// Atomic integer string from a contract ("123") -> bigint. Throws on anything else.
export function atomic(value, what = 'amount') {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 78) {
    throw new Error(`unexpected ${what} from chain`);
  }
  return BigInt(value);
}

export function minBig(...values) {
  return values.reduce((a, b) => (b < a ? b : a));
}

// amount * (10000 - bps) / 10000, rounded down.
export function lessBps(amount, bps) {
  return (amount * (BPS - BigInt(bps))) / BPS;
}

// How far `actual` falls short of `expected`, in basis points, rounded up. 0 when not short.
export function shortfallBps(expected, actual) {
  if (expected <= 0n || actual >= expected) return 0;
  return Number(((expected - actual) * BPS + expected - 1n) / expected);
}
