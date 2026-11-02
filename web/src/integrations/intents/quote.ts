import type { FundingQuoteRequest, FundingQuote, IntentsToken } from "./types";

/** Captured in a signature-verified public 1Click dry quote on 3 Nov 2026. */
export const REVIEWED_PLATFORM_FEE_RECIPIENT =
  "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
const CORE_REQUEST_FIELDS = [
  "dry",
  "swapType",
  "slippageTolerance",
  "originAsset",
  "destinationAsset",
  "depositType",
  "recipientType",
  "refundType",
  "amount",
  "recipient",
  "refundTo",
  "deadline",
  "depositMode",
] as const;

/** Provider-reported fee only. Absence is not evidence that all provider costs are zero. */
export function providerFeeBps(quote: FundingQuote): number | undefined {
  const fees = quote.quoteRequest.appFees;
  if (fees === undefined) return undefined;
  if (!Array.isArray(fees) || fees.length > 1)
    throw new Error("Unreviewed provider fee configuration");
  if (!fees.length) return 0;
  const fee = fees[0];
  if (
    !fee ||
    typeof fee !== "object" ||
    Object.keys(fee).some((k) => !["recipient", "fee"].includes(k)) ||
    fee.recipient !== REVIEWED_PLATFORM_FEE_RECIPIENT ||
    !Number.isInteger(fee.fee) ||
    fee.fee < 0 ||
    fee.fee > 25
  ) {
    throw new Error("Unreviewed provider fee recipient or amount");
  }
  return fee.fee;
}

/** Copy only fields requested by this application, excluding server-added platform fees. */
export function canonicalQuoteRequest(
  request: FundingQuoteRequest,
  dry: boolean,
): FundingQuoteRequest {
  return Object.fromEntries(
    CORE_REQUEST_FIELDS.map((key) => [key, key === "dry" ? dry : request[key]]),
  ) as unknown as FundingQuoteRequest;
}

export function integer(value: unknown, label = "amount"): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 100
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/** Never round a player's payment or use floating point to scale it. */
export function parseTokenAmount(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 38 ||
    value.length > 100 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
  )
    throw new Error("Enter a valid positive amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error("Amount has too many decimal places");
  const amount = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  return amount.toString();
}

export function formatTokenAmount(value: string, decimals: number): string {
  integer(value);
  const padded = value.padStart(decimals + 1, "0");
  if (!decimals) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

export function makeQuoteRequest(
  token: IntentsToken,
  amount: string,
  recipient: string,
  refundTo: string,
  now: number,
  lifetimeMs = 20 * 60_000,
): FundingQuoteRequest {
  if (!/^[a-z0-9._-]{2,64}$/.test(recipient))
    throw new Error("Invalid NEAR recipient");
  validateRefundAddress(token.blockchain, refundTo);
  if (lifetimeMs < 120_000 || lifetimeMs > 24 * 60 * 60_000)
    throw new Error("Invalid quote lifetime");
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: token.assetId,
    destinationAsset: "nep141:wrap.near",
    amount,
    depositType: "ORIGIN_CHAIN",
    recipientType: "DESTINATION_CHAIN",
    refundType: "ORIGIN_CHAIN",
    recipient,
    refundTo,
    deadline: new Date(now + lifetimeMs).toISOString(),
    depositMode: token.blockchain === "stellar" ? "MEMO" : "SIMPLE",
  };
}

/** Unsupported chains must acquire their own reviewed address validator before listing. */
export function validateRefundAddress(chain: string, address: string): void {
  const evm = new Set([
    "eth",
    "base",
    "arb",
    "op",
    "bsc",
    "pol",
    "avax",
    "gnosis",
    "bera",
    "scroll",
    "monad",
    "plasma",
    "xlayer",
    "adi",
  ]);
  let valid = false;
  if (evm.has(chain)) valid = /^0x[0-9a-fA-F]{40}$/.test(address);
  else if (chain === "sol")
    valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  else if (chain === "near")
    valid =
      /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(address) &&
      address.length >= 2 &&
      address.length <= 64;
  else if (chain === "stellar") valid = /^G[A-Z2-7]{55}$/.test(address);
  if (!valid)
    throw new Error(
      "Use a supported refund address on the selected source network",
    );
}

export function assertQuoteMatches(
  quote: FundingQuote,
  request: FundingQuoteRequest,
): void {
  const actual = quote.quoteRequest as unknown as Record<string, unknown>;
  for (const key of CORE_REQUEST_FIELDS) {
    if (actual[key] !== request[key])
      throw new Error(`Quote changed ${key}; request a new quote`);
  }
  // Accept only captured, nonprogrammable defaults; unknown routing extensions stay rejected.
  const defaults: Record<string, unknown> = {
    confidentiality: "public",
    quoteWaitingTimeMs: 0,
    insured: false,
  };
  for (const key of Object.keys(actual)) {
    if (
      (CORE_REQUEST_FIELDS as readonly string[]).includes(key) ||
      key === "appFees"
    )
      continue;
    if (!Object.hasOwn(defaults, key))
      throw new Error("Quote contains unrequested parameters");
    if (actual[key] !== defaults[key])
      throw new Error(`Quote changed provider default ${key}`);
  }
  providerFeeBps(quote);
  // Historical status echoes may contain fresh array objects with identical safe fees.
  if (request.appFees !== undefined) {
    const echoedFees = quote.quoteRequest.appFees;
    if (
      !Array.isArray(echoedFees) ||
      echoedFees.length !== request.appFees.length ||
      echoedFees.some(
        (fee, index) =>
          fee.recipient !== request.appFees![index].recipient ||
          fee.fee !== request.appFees![index].fee,
      )
    ) {
      throw new Error("Quote changed provider fee");
    }
  }
  if (
    quote.quote.amountIn !== request.amount ||
    BigInt(quote.quote.minAmountOut) <= 0n ||
    BigInt(quote.quote.minAmountOut) > BigInt(quote.quote.amountOut)
  )
    throw new Error("Invalid quote amounts");
  if (request.dry && quote.quote.depositAddress)
    throw new Error("Preview unexpectedly contains a payment address");
  if (!request.dry && (!quote.quote.depositAddress || !quote.quote.deadline))
    throw new Error("Missing payment instructions");
  if (
    !request.dry &&
    request.depositMode === "MEMO" &&
    !quote.quote.depositMemo
  )
    throw new Error("Missing mandatory deposit memo");
}

export function expiresAt(quote: FundingQuote): number {
  const dates = [
    quote.quoteRequest.deadline,
    quote.quote.deadline,
    quote.quote.timeWhenInactive,
  ]
    .filter((v): v is string => !!v)
    .map(Date.parse);
  if (dates.some((n) => !Number.isFinite(n)))
    throw new Error("Invalid quote expiry");
  return Math.min(...dates);
}
