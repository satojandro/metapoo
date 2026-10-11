/**
 * Placeholder for a future payment / checkout provider (MPOO, NEAR checkout, etc.).
 *
 * MVP rule: this interface must stay unused. The draw path uses the ordinary
 * wallet transaction only. Do not import this from the draw flow.
 */
export interface PaymentProvider {
  /** Would open a payment checkout. Not implemented. */
  beginCheckout(): Promise<never>;
}

/** Explicit null so callers cannot accidentally use a real provider today. */
export const unusedPaymentProvider: PaymentProvider | null = null;
