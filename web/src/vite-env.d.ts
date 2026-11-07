/// <reference types="vite/client" />

/**
 * Vite only exposes variables that start with `VITE_` to the browser.
 * These optional strings configure which contract and network the page uses.
 */
interface ImportMetaEnv {
  readonly VITE_PRIVY_ENABLED?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  readonly VITE_PRIVY_APP_CLIENT_ID?: string;
  readonly VITE_PRIVY_SIGN_PAGE_URL?: string;
  readonly VITE_INTENTS_FUNDING_ENABLED?: string;
  readonly VITE_INTENTS_API_BASE?: string;
  readonly VITE_INTENTS_TRANSPORT?: string;
  readonly VITE_INTENTS_PROXY_BASE?: string;
  readonly VITE_RHEA_MPOO_SWAP_ENABLED?: string;
  readonly VITE_RHEA_MAX_INPUT_YOCTO?: string;
  readonly VITE_RHEA_GAS_RESERVE_YOCTO?: string;
  readonly VITE_RHEA_MAX_PRICE_IMPACT_BPS?: string;
  readonly VITE_ACQUISITION_PLAY_RESERVE_YOCTO?: string;

  readonly VITE_BOARD_OWNER?: string;
  readonly VITE_CONTRACT_ID?: string;
  readonly VITE_BOARD_SIDE?: string;
  readonly VITE_NEAR_NETWORK?: string;
  readonly VITE_NEAR_RPC_URL?: string;
  readonly VITE_NEAR_READ_FALLBACK_URL?: string;
  readonly VITE_BOARD_SERVER_URL?: string;
  readonly VITE_SPONSORSHIP_ENABLED?: string;
  readonly VITE_TOILET_ID?: string;
  readonly VITE_BETA_BANNER?: string;
  readonly VITE_BETA_GUIDE_URL?: string;
  readonly VITE_BETA_REPORT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Short commit of the built bundle, injected by vite.config.ts. */
declare const __BUILD_ID__: string;
