import { CONTRACT_ID, PAGE_NETWORK, TOILET_ID } from "../../config";
import { MPOO_ACCOUNT } from "../../paint-wallet";
import type { SendPolicy } from "./plan";
export const SEND_ENABLED = import.meta.env.VITE_SEND_ENABLED === "true";
export const SELF_CUSTODY_ENABLED = import.meta.env.VITE_SELF_CUSTODY_ENABLED === "true";
export const SEND_POLICY: SendPolicy = {
  enabled: SEND_ENABLED,
  tokens: [
    {contractId: TOILET_ID, symbol: "TOILET", decimals: 18},
    ...(import.meta.env.VITE_SEND_MPOO_ENABLED === "true" ? [{contractId: PAGE_NETWORK === "mainnet" ? MPOO_ACCOUNT : String(import.meta.env.VITE_MPOO_ID ?? ""), symbol: PAGE_NETWORK === "mainnet" ? "mPOO" : "Test mPOO", decimals: 18}] : []),
  ].filter(t => t.contractId),
  blockedRecipients: [CONTRACT_ID], storageMinimums: {},
};
