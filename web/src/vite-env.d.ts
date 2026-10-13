/// <reference types="vite/client" />

/**
 * Vite only exposes variables that start with `VITE_` to the browser.
 * These optional strings configure which contract and network the page uses.
 */
interface ImportMetaEnv {
  readonly VITE_EXTRA_PAGES_ENABLED?: string;
  readonly VITE_CONTRACT_ID?: string;
  /** Art bounty escrow contract (views). Empty → fixture adapter. */
  readonly VITE_BOUNTY_CONTRACT_ID?: string;
  /** Unlock live fund CTA (default false — gated until payout path ready). */
  readonly VITE_BOUNTY_FUNDING_ENABLED?: string;
  readonly VITE_NEAR_NETWORK?: string;
  readonly VITE_NEAR_RPC_URL?: string;
  readonly VITE_SPONSORSHIP_ENABLED?: string;
  /** Enable Journey C paid-paint UI (quotes / pressure). Default off. */
  readonly VITE_PAID_PAINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
