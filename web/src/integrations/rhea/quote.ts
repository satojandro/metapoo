import type { OperationContext } from "../types";
import { atomic, validateRheaConfig } from "./config";
import { integer, object, readRouteEvidence } from "./read";
import type {
  RheaBuyQuote,
  RheaCheckpointQuote,
  RheaConfig,
  RheaReadClient,
  RheaRouteLeg,
  RheaRouteManifest,
} from "./types";

/** Only proven adjacent DCL hops share a transaction; otherwise keep checkpoints. */
export function groupCheckpoints(route: RheaRouteManifest): RheaRouteLeg[][] {
  const groups: RheaRouteLeg[][] = [];
  for (const leg of route.legs) {
    const previous = groups[groups.length - 1];
    if (
      previous &&
      leg.venue === "dcl" &&
      leg.atomicMultiPool &&
      previous.every(
        (x) =>
          x.venue === "dcl" && x.atomicMultiPool && x.exchange === leg.exchange,
      )
    )
      previous.push(leg);
    else groups.push([leg]);
  }
  return groups;
}

export function netAfterTax(
  gross: bigint,
  bps: number,
  rounding: "floor-tax" | "floor-net",
): bigint {
  const denominator = 10000n;
  return rounding === "floor-tax"
    ? gross - (gross * BigInt(bps)) / denominator
    : (gross * (denominator - BigInt(bps))) / denominator;
}
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

async function quoteCheckpoint(
  legs: RheaRouteLeg[],
  input: string,
  client: RheaReadClient,
  signal?: AbortSignal,
): Promise<string> {
  const first = legs[0],
    last = legs[legs.length - 1];
  if (first.venue === "dcl") {
    const result = object(
      (
        await client.view(
          first.exchange,
          "quote",
          {
            pool_ids: legs.map((x) => x.poolId),
            input_token: first.tokenIn,
            output_token: last.tokenOut,
            input_amount: input,
          },
          signal,
        )
      ).value,
    );
    return integer(result.amount);
  }
  // Classic v1 intentionally supports one verified SIMPLE_POOL per checkpoint.
  return integer(
    (
      await client.view(
        first.exchange,
        "get_return",
        {
          pool_id: Number(first.poolId),
          token_in: first.tokenIn,
          token_out: first.tokenOut,
          amount_in: input,
        },
        signal,
      )
    ).value,
  );
}

export interface QuoteDependencies {
  config: RheaConfig;
  client: RheaReadClient;
  now?: () => number;
  newId?: () => string;
}
export async function quoteMpooBuy(
  input: {
    context: OperationContext;
    inputNearYocto: string;
    slippageBps: number;
    settledInputs?: Record<number, string>;
  },
  deps: QuoteDependencies,
  signal?: AbortSignal,
): Promise<RheaBuyQuote> {
  const now = deps.now ?? Date.now;
  validateRheaConfig(deps.config);
  if (input.context.networkId !== deps.config.networkId)
    throw new Error("Wallet and route network do not match");
  const amount = atomic(input.inputNearYocto, true);
  if (amount > atomic(deps.config.maxInputYocto, true))
    throw new Error("Amount exceeds the configured trade limit");
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 1 ||
    input.slippageBps > 300
  )
    throw new Error("Slippage must be between 1 and 300 basis points");
  const route = deps.config.route!;
  const evidence = await readRouteEvidence(route, deps.client, now, signal);
  const checkpoints: RheaCheckpointQuote[] = [];
  let nextInput = amount;
  let cumulativeRetainedBps = 10000n;
  let aggregateImpact = 0;
  const groups = groupCheckpoints(route);
  for (const [index, legs] of groups.entries()) {
    if (index > 0 && input.settledInputs?.[index] !== undefined)
      nextInput = atomic(input.settledInputs[index], true);
    const gross = atomic(
      await quoteCheckpoint(legs, nextInput.toString(), deps.client, signal),
      true,
    );
    // Compare to a small quote of the same checkpoint; fees cancel from this comparison.
    const referenceInput = nextInput / 1000n;
    if (referenceInput === 0n)
      throw new Error("Amount is too small to verify price impact");
    const referenceOut = atomic(
      await quoteCheckpoint(
        legs,
        referenceInput.toString(),
        deps.client,
        signal,
      ),
      true,
    );
    const linearOut = (referenceOut * nextInput) / referenceInput;
    const impact =
      gross >= linearOut
        ? 0
        : Number(ceilDiv((linearOut - gross) * 10000n, linearOut));
    cumulativeRetainedBps =
      (cumulativeRetainedBps * BigInt(10000 - impact)) / 10000n;
    aggregateImpact = 10000 - Number(cumulativeRetainedBps);
    if (aggregateImpact > deps.config.maxPriceImpactBps)
      throw new Error("Price impact exceeds the configured limit");
    const final = index === groups.length - 1;
    const proof = route.netMinimumProof!;
    const taxed = final && proof.mode === "immutable-transfer-tax";
    const net = taxed
      ? netAfterTax(gross, proof.buyBps, proof.rounding)
      : gross;
    const minimumNet = (net * BigInt(10000 - input.slippageBps)) / 10000n;
    if (minimumNet === 0n) throw new Error("The output minimum would be zero");
    const minimumGross = taxed
      ? ceilDiv(minimumNet * 10000n, BigInt(10000 - proof.buyBps))
      : minimumNet;
    checkpoints.push({
      legs,
      inputAtomic: nextInput.toString(),
      grossOutputAtomic: gross.toString(),
      expectedNetAtomic: net.toString(),
      minimumGrossAtomic: minimumGross.toString(),
      minimumNetAtomic: minimumNet.toString(),
    });
    nextInput = net;
  }
  const createdAtMs = evidence.observedAtMs;
  if (now() >= createdAtMs + 30000)
    throw new Error(
      "Quote expired while checking the route; request a new quote",
    );
  return {
    context: { ...input.context },
    id: (deps.newId ?? (() => crypto.randomUUID()))(),
    createdAtMs,
    expiresAtMs: createdAtMs + 30000,
    inputNearYocto: amount.toString(),
    expectedNetMpooAtomic: nextInput.toString(),
    minNetMpooAtomic: checkpoints[checkpoints.length - 1].minimumNetAtomic,
    slippageBps: input.slippageBps,
    priceImpactBps: aggregateImpact,
    evidence,
    route: structuredClone(route),
    checkpoints,
    ...(input.settledInputs
      ? { settledInputs: { ...input.settledInputs } }
      : {}),
  };
}
