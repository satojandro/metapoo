import type { SignPageOptions } from "@peerfolio/privy-near-connect/sign-page";
import { nearWallets } from "./session";

type SdkWallet = NonNullable<SignPageOptions["wallet"]>;
/** Keep the real linked wallet record; never fabricate recovery or signing capabilities. */
function isSdkWallet(value: unknown): value is SdkWallet {
  if (
    !value ||
    typeof value !== "object" ||
    !nearWallets({ linked_accounts: [value] }).length
  )
    return false;
  const w = value as Record<string, unknown>;
  const time = (v: unknown) =>
    v === null || (typeof v === "number" && Number.isFinite(v));
  return (
    typeof w.chain_id === "string" &&
    w.connector_type === "embedded" &&
    typeof w.delegated === "boolean" &&
    time(w.first_verified_at) &&
    typeof w.imported === "boolean" &&
    time(w.latest_verified_at) &&
    typeof w.public_key === "string" &&
    [
      "privy",
      "user-passcode",
      "google-drive",
      "icloud",
      "recovery-encryption-key",
      "privy-v2",
    ].includes(String(w.recovery_method)) &&
    typeof w.verified_at === "number" &&
    Number.isFinite(w.verified_at) &&
    w.wallet_client === "privy" &&
    w.wallet_client_type === "privy" &&
    Number.isSafeInteger(w.wallet_index) &&
    (w.user_can_sign === undefined || w.user_can_sign === true)
  );
}
export function checkedSdkWallet(value: unknown): SdkWallet {
  if (!isSdkWallet(value))
    throw new Error(
      "Privy returned incomplete or non-signing NEAR wallet metadata.",
    );
  return value;
}
