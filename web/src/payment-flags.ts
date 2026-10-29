/**
 * Launch sells credits for NEAR only.
 *
 * The contract keeps its mPOO purchase path (`ft_on_transfer`, `mpoo_per_credit`),
 * but the NEAR/mPOO exchange rate is an extra product decision the launch does not
 * need. Flip this to true when that rate is settled; nothing else changes.
 */
export const TOKEN_PAYMENTS_ENABLED = false;
