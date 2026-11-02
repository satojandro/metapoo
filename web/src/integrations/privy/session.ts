import type { PrivyNetwork } from "./config";

export interface PrivyNearWallet {
  type: "wallet";
  chain_type: "near";
  id: string;
  address: string;
}
export interface PrivyUser {
  id: string;
  linked_accounts?: unknown[];
}
export interface PrivySessionClient {
  user: { get(): Promise<{ user: unknown }> };
  createNearWallet(): Promise<void>;
  logout(): Promise<void>;
}
export interface HostIdentity {
  accountId: string;
  networkId: PrivyNetwork;
  sessionEpoch: number;
}
export const PRIVY_HOST_IDENTITY_KEY = "metapoo:privy:host-identity:v1";
const selectionKey = (network: PrivyNetwork) =>
  `metapoo:privy:selected-wallet:v1:${network}`;
export type SessionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

/** Validate metadata rather than assuming the first linked wallet belongs to NEAR. */
export function nearWallets(user: unknown): PrivyNearWallet[] {
  if (!user || typeof user !== "object") return [];
  const linked = (user as { linked_accounts?: unknown }).linked_accounts;
  if (!Array.isArray(linked)) return [];
  return linked.filter((v): v is PrivyNearWallet => {
    const w = v as Partial<PrivyNearWallet> | null;
    return (
      !!w &&
      typeof w === "object" &&
      w.type === "wallet" &&
      w.chain_type === "near" &&
      typeof w.id === "string" &&
      w.id.length > 0 &&
      typeof w.address === "string" &&
      /^[0-9a-f]{64}$/.test(w.address)
    );
  });
}

const provisioning = new WeakMap<PrivySessionClient, Promise<void>>();
/** Provision once, then re-read authoritative linked metadata. No signing key is exported. */
export async function ensureNearWallet(
  client: PrivySessionClient,
  network: PrivyNetwork,
  storage: SessionStorage,
): Promise<PrivyNearWallet> {
  let { user } = await client.user.get();
  if (!user) throw new Error("Sign in with Google or email first.");
  if (!nearWallets(user).length) {
    let pending = provisioning.get(client);
    if (!pending) {
      pending = client
        .createNearWallet()
        .finally(() => provisioning.delete(client));
      provisioning.set(client, pending);
    }
    await pending;
    user = (await client.user.get()).user;
  }
  const wallets = nearWallets(user);
  const selectedId = storage.getItem(selectionKey(network));
  const selected = selectedId
    ? wallets.find((w) => w.id === selectedId)
    : wallets.length === 1
      ? wallets[0]
      : undefined;
  if (!selected)
    throw new Error(
      selectedId
        ? "Your selected NEAR wallet is unavailable. Sign out before selecting another account."
        : wallets.length > 1
          ? "Multiple NEAR wallets are linked. Select a wallet explicitly before connecting."
          : "Privy did not return a NEAR wallet. Try again.",
    );
  storage.setItem(selectionKey(network), selected.id);
  return selected;
}

export function setPrivyHostIdentity(
  identity: HostIdentity | null,
  storage: SessionStorage,
): void {
  // No key, email or authentication token crosses the host/sign-page boundary.
  storage.setItem(PRIVY_HOST_IDENTITY_KEY, JSON.stringify(identity));
}
export function getPrivyHostIdentity(
  storage: SessionStorage,
): HostIdentity | null {
  try {
    const raw = storage.getItem(PRIVY_HOST_IDENTITY_KEY);
    if (!raw || raw.length > 1024) return null;
    const v = JSON.parse(raw) as Partial<HostIdentity> | null;
    if (
      !v ||
      typeof v.accountId !== "string" ||
      !/^[a-z0-9._-]{2,64}$/.test(v.accountId) ||
      !["mainnet", "testnet"].includes(String(v.networkId)) ||
      !Number.isSafeInteger(v.sessionEpoch) ||
      Number(v.sessionEpoch) < 0
    )
      return null;
    return v as HostIdentity;
  } catch {
    return null;
  }
}
export function sameHostIdentity(
  a: HostIdentity | null,
  b: HostIdentity | null,
): boolean {
  return (
    !!a &&
    !!b &&
    a.accountId === b.accountId &&
    a.networkId === b.networkId &&
    a.sessionEpoch === b.sessionEpoch
  );
}

export async function logoutPrivySession(
  client: PrivySessionClient,
  network: PrivyNetwork,
  storage: SessionStorage,
): Promise<void> {
  // Disable signing before a potentially failing vendor logout. Drawing storage is untouched.
  setPrivyHostIdentity(null, storage);
  await client.logout();
  storage.removeItem(selectionKey(network));
}

export interface PendingDrawingAuthorization extends HostIdentity {
  publicKey: string;
  contractId: string;
  methods: readonly string[];
  allowance: string;
  createdAtMs: number;
}
const PENDING_DRAWING_KEY = "metapoo:privy:pending-drawing:v1";
export function setPrivyPendingDrawingAuthorization(
  value: PendingDrawingAuthorization | null,
  storage: SessionStorage,
): void {
  if (value) storage.setItem(PENDING_DRAWING_KEY, JSON.stringify(value));
  else storage.removeItem(PENDING_DRAWING_KEY);
}
export function getPrivyPendingDrawingAuthorization(
  storage: SessionStorage,
  now = Date.now(),
): PendingDrawingAuthorization | null {
  try {
    const raw = storage.getItem(PENDING_DRAWING_KEY);
    if (!raw || raw.length > 2048) return null;
    const v = JSON.parse(raw) as PendingDrawingAuthorization;
    if (
      !v ||
      typeof v.accountId !== "string" ||
      !["testnet", "mainnet"].includes(v.networkId) ||
      !Number.isSafeInteger(v.sessionEpoch) ||
      typeof v.publicKey !== "string" ||
      typeof v.contractId !== "string" ||
      !Array.isArray(v.methods) ||
      !v.methods.every((m) => typeof m === "string") ||
      typeof v.allowance !== "string" ||
      !/^\d+$/.test(v.allowance) ||
      !Number.isSafeInteger(v.createdAtMs) ||
      now - v.createdAtMs < 0 ||
      now - v.createdAtMs > 300_000
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
