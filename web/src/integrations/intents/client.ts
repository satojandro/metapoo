import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { integer } from "./quote";
import { PROVIDER_STATUSES } from "./types";
import type {
  FundingClient,
  FundingQuote,
  FundingQuoteEcho,
  FundingQuoteRequest,
  FundingStatus,
  IntentsToken,
  ProviderStatus,
} from "./types";

export class IntentsApiError extends Error {
  constructor(
    message: string,
    readonly code: "transport" | "schema" | "signature" | "http" | "aborted",
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider response");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 2048): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

function date(value: unknown): string {
  const result = text(value, "date", 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("Invalid provider date");
  return result;
}

export function parseTokens(value: unknown): IntentsToken[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error("Invalid token registry");
  const ids = new Set<string>();
  return value.map((item) => {
    const row = object(item);
    const assetId = text(row.assetId, "asset id", 256);
    if (ids.has(assetId)) throw new Error("Duplicate asset id");
    ids.add(assetId);
    if (
      !Number.isInteger(row.decimals) ||
      (row.decimals as number) < 0 ||
      (row.decimals as number) > 38
    )
      throw new Error("Invalid token decimals");
    return {
      assetId,
      blockchain: text(row.blockchain, "chain", 32),
      symbol: text(row.symbol, "symbol", 32),
      decimals: row.decimals as number,
      contractAddress:
        row.contractAddress == null
          ? null
          : text(row.contractAddress, "token contract", 256),
    };
  });
}

/** Validate restored records with the same parser as network responses. */
export function parseQuote(value: unknown): FundingQuote {
  return quoteEnvelope(value, true) as FundingQuote;
}

/**
 * One validator for both envelopes: `/v0/quote` carries `correlationId`, the
 * `/v0/status` echo does not (it falls outside the vendor's signed payload), so the
 * echo parses without it and the parsed object simply has no such field.
 */
function quoteEnvelope(
  value: unknown,
  requireCorrelationId: boolean,
): FundingQuoteEcho {
  const envelope = object(value);
  const request = object(envelope.quoteRequest);
  const quote = object(envelope.quote);
  if (
    typeof request.dry !== "boolean" ||
    request.swapType !== "EXACT_INPUT" ||
    request.destinationAsset !== "nep141:wrap.near" ||
    request.depositType !== "ORIGIN_CHAIN" ||
    request.recipientType !== "DESTINATION_CHAIN" ||
    request.refundType !== "ORIGIN_CHAIN" ||
    request.slippageTolerance !== 100 ||
    !["SIMPLE", "MEMO"].includes(String(request.depositMode))
  ) {
    throw new Error("Unsupported quote parameters");
  }
  for (const field of ["originAsset", "recipient", "refundTo"])
    text(request[field], field, 256);
  integer(request.amount);
  date(request.deadline);
  const result: FundingQuoteEcho = {
    timestamp: date(envelope.timestamp),
    signature: text(envelope.signature, "signature", 2048),
    quoteRequest: request as unknown as FundingQuoteRequest,
    quote: {
      amountIn: integer(quote.amountIn),
      amountOut: integer(quote.amountOut),
      minAmountOut: integer(quote.minAmountOut),
      timeEstimate: quote.timeEstimate as number,
    },
    raw: envelope,
  };
  if (envelope.correlationId != null || requireCorrelationId)
    result.correlationId = text(envelope.correlationId, "correlation id", 256);
  if (
    !Number.isFinite(quote.timeEstimate) ||
    result.quote.timeEstimate < 0 ||
    result.quote.timeEstimate > 7 * 24 * 3600
  )
    throw new Error("Invalid time estimate");
  if (quote.depositAddress != null)
    result.quote.depositAddress = text(
      quote.depositAddress,
      "deposit address",
      256,
    );
  if (quote.depositMemo != null)
    result.quote.depositMemo = text(quote.depositMemo, "deposit memo", 256);
  if (quote.deadline != null) result.quote.deadline = date(quote.deadline);
  if (quote.timeWhenInactive != null)
    result.quote.timeWhenInactive = date(quote.timeWhenInactive);
  return result;
}

function hashes(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Invalid transaction references");
  return value.map((item) =>
    text(
      typeof item === "string" ? item : object(item).hash,
      "transaction hash",
      128,
    ),
  );
}

export function parseStatus(value: unknown): FundingStatus {
  const row = object(value);
  const detail = row.swapDetails == null ? {} : object(row.swapDetails);
  const status = text(row.status, "status", 64);
  return {
    status: (PROVIDER_STATUSES as readonly string[]).includes(status)
      ? (status as ProviderStatus)
      : "UNKNOWN",
    providerStatus: status,
    updatedAt: date(row.updatedAt),
    quoteResponse: quoteEnvelope(row.quoteResponse, false),
    destinationHashes: hashes(detail.destinationChainTxHashes),
    originHashes: hashes(detail.originChainTxHashes),
    refundHashes: hashes(detail.refundTxHashes),
    ...(detail.amountOut == null
      ? {}
      : { amountOut: integer(detail.amountOut) }),
  };
}

export interface IntentsClientOptions {
  fetch?: typeof globalThis.fetch;
  /** A proxy must be same-origin. A random URL is never a credential-bearing upstream. */
  baseUrl?: string;
  origin?: string;
  verifySignature?: (value: unknown) => boolean | Promise<boolean>;
  timeoutMs?: number;
}

export function createIntentsClient(
  options: IntentsClientOptions = {},
): FundingClient {
  const origin =
    options.origin ?? globalThis.location?.origin ?? "http://localhost";
  const base = new URL(
    options.baseUrl ?? "https://1click.chaindefuser.com",
    origin,
  );
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(
      base.origin === "https://1click.chaindefuser.com" ||
      base.origin === origin
    )
  )
    throw new Error("Unapproved Intents endpoint");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const verifier =
    options.verifySignature ??
    ((value) =>
      verifyQuoteSignature(
        value as Parameters<typeof verifyQuoteSignature>[0],
      ));
  const verify = async (quote: FundingQuoteEcho) => {
    try {
      return (await verifier(quote.raw)) === true;
    } catch {
      return false;
    }
  };
  async function request(
    path: string,
    body: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 15_000,
    );
    try {
      const response = await fetcher(`${base.href.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        redirect: "error",
        headers:
          body === undefined
            ? { Accept: "application/json" }
            : {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retry = response.headers.get("Retry-After");
        const delay =
          retry && /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : undefined;
        throw new IntentsApiError(
          response.status === 429
            ? "Funding service is busy; retry shortly"
            : "Funding service could not complete the request",
          "http",
          response.status,
          delay != null && Number.isFinite(delay)
            ? Math.max(0, Math.min(delay, 300_000))
            : undefined,
        );
      }
      const raw = await response.text();
      if (raw.length > 2_000_000)
        throw new IntentsApiError("Provider response is too large", "schema");
      try {
        return JSON.parse(raw);
      } catch {
        throw new IntentsApiError("Invalid provider JSON", "schema");
      }
    } catch (error) {
      if (error instanceof IntentsApiError) throw error;
      throw new IntentsApiError(
        signal?.aborted
          ? "Request cancelled"
          : "Funding service unavailable; existing payments remain recoverable",
        signal?.aborted ? "aborted" : "transport",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async function signed(value: unknown): Promise<FundingQuote> {
    let quote: FundingQuote;
    try {
      quote = parseQuote(value);
    } catch {
      throw new IntentsApiError("Unsupported provider quote", "schema");
    }
    if (!(await verify(quote)))
      throw new IntentsApiError(
        "Could not verify the funding quote",
        "signature",
      );
    return quote;
  }
  return {
    verify,
    async tokens(signal) {
      const result = await request("/v0/tokens", undefined, signal);
      try {
        return parseTokens(result);
      } catch {
        throw new IntentsApiError("Invalid token registry", "schema");
      }
    },
    async quote(input, signal) {
      return signed(await request("/v0/quote", input, signal));
    },
    async status(quote, signal) {
      if (!quote.quote.depositAddress)
        throw new Error("No deposit address to track");
      const params = new URLSearchParams({
        depositAddress: quote.quote.depositAddress,
      });
      if (quote.quote.depositMemo)
        params.set("depositMemo", quote.quote.depositMemo);
      const result = await request(`/v0/status?${params}`, undefined, signal);
      let status: FundingStatus;
      try {
        status = parseStatus(result);
      } catch {
        throw new IntentsApiError("Unsupported provider status", "schema");
      }
      if (!(await verify(status.quoteResponse)))
        throw new IntentsApiError(
          "Could not verify the payment status quote",
          "signature",
        );
      return status;
    },
  };
}
