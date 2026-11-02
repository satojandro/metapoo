/// <reference types="vite/client" />

/**
 * Vite only exposes variables that start with `VITE_` to the browser.
 * These optional strings configure which contract and network the page uses.
 */
interface ImportMetaEnv {
  readonly VITE_BOARD_OWNER?: string;
  readonly VITE_CONTRACT_ID?: string;
  readonly VITE_NEAR_NETWORK?: string;
  readonly VITE_NEAR_RPC_URL?: string;
  readonly VITE_SPONSORSHIP_ENABLED?: string;
  readonly VITE_TOILET_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
