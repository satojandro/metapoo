/**
 * Page settings that are not the shared board description.
 * The wallet network here is for local development. It is not a mainnet deployment.
 */

/** Network passed to the wallet connector. No transaction is sent by this page. */
export const PAGE_NETWORK = "testnet" as const;

/**
 * Game contract account. Empty on purpose.
 * Do not fill this with the MPOO token account. That account is a supplied
 * token reference, not this game, and it has not been verified in this repo.
 */
export const CONTRACT_ID = "";

/** Sponsorship stays off until custody, limits, and a kill switch exist. */
export const SPONSORSHIP_ENABLED = false;
