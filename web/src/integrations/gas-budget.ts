import { assertAtomic } from "./types";
export interface NativeBudgetInput {
  spendableBeforeGasYocto: string;
  payableDepositsYocto: string;
  gasCeilingYocto: string;
  playReserveYocto: string;
}
/** All values are smallest-unit integers; access-key allowance is deliberately not a balance. */
export function computeSpendableNative(input: NativeBudgetInput) {
  const available = assertAtomic(input.spendableBeforeGasYocto);
  const deposits = assertAtomic(input.payableDepositsYocto);
  const gas = assertAtomic(input.gasCeilingYocto);
  const reserve = assertAtomic(input.playReserveYocto);
  const required = deposits + gas + reserve;
  return {
    ...input,
    maxInputYocto: (available > required
      ? available - required
      : 0n
    ).toString(),
    canPay: available >= required,
    requiredYocto: required.toString(),
  };
}
export function estimateGasCeiling(gasUnits: string, gasPrice: string): string {
  // Match the existing local signer conservative 2x gas-price margin.
  return (assertAtomic(gasUnits) * assertAtomic(gasPrice) * 2n).toString();
}
