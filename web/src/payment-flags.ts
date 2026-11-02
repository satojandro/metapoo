/**
 * Mainnet launch sells credits for NEAR and mPOO (owner decision, 2026-10-29).
 *
 * The buy-credits sheet no longer reads this flag: its token checkout is
 * feature-detected per board (`mpooCheckoutOpen` in buy-credits.ts — REV-B's
 * `get_mpoo_sales_today` must exist and report cap > 0 with credits remaining).
 *
 * This constant still gates only the read-only "Paint & wallet" panel's mPOO
 * balance row and NEARLY link, which have not moved to feature detection yet.
 */
export const TOKEN_PAYMENTS_ENABLED = false;
