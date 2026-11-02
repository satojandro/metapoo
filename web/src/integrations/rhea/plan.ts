import { computeSpendableNative } from "../gas-budget";
import { atomic, validateManifest } from "./config";
import { groupCheckpoints } from "./quote";
import type {
  RheaBudget,
  RheaBuyQuote,
  RheaExecutionPlan,
  RheaFunctionCall,
  RheaPlanCheckpoint,
  RheaStorageRead,
  RheaTransaction,
} from "./types";

function call(
  methodName: string,
  args: Record<string, unknown>,
  gas: string,
  deposit: string,
): RheaFunctionCall {
  const units = atomic(gas, true);
  if (units > 300000000000000n)
    throw new Error("Prepaid gas exceeds the protocol transaction limit");
  atomic(deposit);
  return { type: "FunctionCall", params: { methodName, args, gas, deposit } };
}

/** A pure plan: it cannot sign, fetch, mutate a wallet or authorize a drawing key. */
export function planMpooBuy(
  quote: RheaBuyQuote,
  budget: RheaBudget,
  storage: RheaStorageRead[],
): RheaExecutionPlan {
  validateManifest(quote.route, quote.context.networkId);
  if (
    !quote.route.netMinimumProof ||
    !quote.evidence.taxEvidenceId ||
    quote.evidence.routeId !== quote.route.id ||
    quote.evidence.manifestEvidenceId !== quote.route.evidenceId
  )
    throw new Error("Quote lacks verified route/tax evidence");
  const groups = groupCheckpoints(quote.route);
  if (
    groups.length !== quote.checkpoints.length ||
    quote.expiresAtMs - quote.createdAtMs > 30000 ||
    quote.expiresAtMs <= quote.createdAtMs
  )
    throw new Error("Invalid quote checkpoints or lifetime");
  const tokens = Object.keys(quote.route.decimals);
  if (
    storage.length !== tokens.length ||
    new Set(storage.map((x) => x.tokenId)).size !== tokens.length ||
    storage.some((x) => !tokens.includes(x.tokenId))
  )
    throw new Error("Storage evidence does not cover the route");
  const registrations: RheaTransaction[] = storage
    .filter((x) => !x.registered)
    .map((x) => ({
      receiverId: x.tokenId,
      actions: [
        call(
          "storage_deposit",
          { account_id: quote.context.accountId, registration_only: true },
          budget.registrationGas,
          atomic(x.minimumYocto, true).toString(),
        ),
      ],
    }));
  const checkpoints: RheaPlanCheckpoint[] = [];
  if (registrations.length)
    checkpoints.push({
      kind: "registration",
      index: -1,
      transactions: registrations,
      quote: null,
      approvalCount: budget.batchRegistrations ? 1 : registrations.length,
    });
  for (const [index, checkpoint] of quote.checkpoints.entries()) {
    const first = groups[index][0],
      last = groups[index][groups[index].length - 1];
    if (JSON.stringify(checkpoint.legs) !== JSON.stringify(groups[index]))
      throw new Error("Quote route changed");
    const input = atomic(checkpoint.inputAtomic, true).toString();
    const minimum = atomic(checkpoint.minimumGrossAtomic, true).toString();
    if (index === 0 && input !== quote.inputNearYocto)
      throw new Error("Input quote mismatch");
    if (
      index > 0 &&
      input !==
        (quote.settledInputs?.[index] ??
          quote.checkpoints[index - 1].expectedNetAtomic)
    )
      throw new Error("Disconnected checkpoint amounts");
    const msg =
      first.venue === "dcl"
        ? {
            Swap: {
              pool_ids: groups[index].map((x) => x.poolId),
              output_token: last.tokenOut,
              min_output_amount: minimum,
            },
          }
        : {
            force: 0,
            actions: [
              {
                pool_id: Number(first.poolId),
                token_in: first.tokenIn,
                token_out: first.tokenOut,
                amount_in: input,
                min_amount_out: minimum,
              },
            ],
          };
    const actions: RheaFunctionCall[] = [];
    // One receiver/transaction combines wrapping with transfer; the DEX callback is later.
    if (index === 0)
      actions.push(
        call("near_deposit", {}, budget.wrapGas, quote.inputNearYocto),
      );
    actions.push(
      call(
        "ft_transfer_call",
        {
          receiver_id: first.exchange,
          amount: input,
          msg: JSON.stringify(msg),
        },
        budget.swapGas,
        "1",
      ),
    );
    if (
      actions.reduce((sum, action) => sum + BigInt(action.params.gas), 0n) >
      300000000000000n
    )
      throw new Error("Combined transaction gas exceeds protocol limit");
    checkpoints.push({
      kind: "swap",
      index,
      quote: checkpoint,
      transactions: [{ receiverId: first.tokenIn, actions }],
      approvalCount: 1,
    });
  }
  const deposits = checkpoints
    .flatMap((x) => x.transactions)
    .flatMap((x) => x.actions)
    .reduce((sum, x) => sum + atomic(x.params.deposit), 0n);
  const gas = atomic(budget.maximumGasYocto, true);
  const reserve = atomic(budget.reserveYocto, true);
  const result = computeSpendableNative({
    spendableBeforeGasYocto: budget.spendableNativeYocto,
    payableDepositsYocto: deposits.toString(),
    gasCeilingYocto: gas.toString(),
    playReserveYocto: reserve.toString(),
  });
  if (!result.canPay)
    throw new Error(
      "Not enough native NEAR after gas, storage and the play reserve",
    );
  return {
    quote: structuredClone(quote),
    checkpoints,
    maxNativeSpendYocto: (deposits + gas).toString(),
    reserveYocto: reserve.toString(),
    maximumGasYocto: gas.toString(),
    approvalCount: checkpoints.reduce((sum, x) => sum + x.approvalCount, 0),
  };
}

/** Recovery never sells intermediate tokens: remaining wNEAR can be explicitly unwrapped. */
export function planUnwrapRheaRemainder(
  wrapToken: string,
  amount: string,
  gas: string,
): RheaTransaction {
  if (!/^[a-z0-9._-]{2,64}$/.test(wrapToken))
    throw new Error("Invalid wrap token");
  return {
    receiverId: wrapToken,
    actions: [
      call(
        "near_withdraw",
        { amount: atomic(amount, true).toString() },
        gas,
        "1",
      ),
    ],
  };
}
