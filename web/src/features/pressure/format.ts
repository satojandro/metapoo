/**
 * Quote age / expiry formatting for the paint dock (Journey C).
 * Nanosecond timestamps arrive as decimal strings — never use floating money math.
 */

const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MINUTE = 60n * NS_PER_SECOND;

export function formatDurationNs(ns: bigint): string {
  if (ns <= 0n) {
    return "0s";
  }
  if (ns < NS_PER_SECOND) {
    const ms = ns / 1_000_000n;
    return ms <= 0n ? "<1ms" : `${ms.toString()}ms`;
  }
  if (ns < NS_PER_MINUTE) {
    const seconds = ns / NS_PER_SECOND;
    return `${seconds.toString()}s`;
  }
  const minutes = ns / NS_PER_MINUTE;
  const seconds = (ns % NS_PER_MINUTE) / NS_PER_SECOND;
  if (seconds === 0n) {
    return `${minutes.toString()}m`;
  }
  return `${minutes.toString()}m ${seconds.toString()}s`;
}

export function formatQuoteAge(observedAtNs: string, nowNs: string): string {
  const age = BigInt(nowNs) - BigInt(observedAtNs);
  if (age <= 0n) {
    return "just now";
  }
  return `${formatDurationNs(age)} ago`;
}

export function formatQuoteExpiry(expiresAtNs: string, nowNs: string): string {
  const remaining = BigInt(expiresAtNs) - BigInt(nowNs);
  if (remaining <= 0n) {
    return "expired";
  }
  return `expires in ${formatDurationNs(remaining)}`;
}

export function formatToiletAmount(amount: string): string {
  return `${amount} TOILET`;
}

export interface QuoteTimingSummary {
  ageLabel: string;
  expiryLabel: string;
  expired: boolean;
}

export function summarizeQuoteTiming(
  quote: { observedAtNs: string; expiresAtNs: string },
  nowNs: string,
): QuoteTimingSummary {
  const expired = BigInt(nowNs) > BigInt(quote.expiresAtNs);
  return {
    ageLabel: formatQuoteAge(quote.observedAtNs, nowNs),
    expiryLabel: formatQuoteExpiry(quote.expiresAtNs, nowNs),
    expired,
  };
}
