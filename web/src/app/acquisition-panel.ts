import {
  ACQUISITION_PLAY_RESERVE_YOCTO,
  INTENTS_FUNDING_ENABLED,
  RHEA_MPOO_SWAP_ENABLED,
  PAGE_NETWORK,
  RPC_URL,
} from "../config";
import {
  getAcquisitionContext,
  readConnectedAccountReadiness,
  signAndSendApprovedTransactions,
  configureAcquisitionPolicy,
  reconcilePendingAcquisition,
  getConnectedAcquisitionPublicKey,
  supportsAcquisitionBatchRegistrations,
} from "../wallet";
import { createAcquisitionRpc } from "../integrations/rpc";
import { resolveAccountReadiness } from "../integrations/account-readiness";
import { createAcquisitionStore } from "../integrations/operation-store";
import { createIntentsClient } from "../integrations/intents/client";
import { createIntentsStorage } from "../integrations/intents/storage";
import { createIntentsFundingController } from "../integrations/intents/funding";
import { createDestinationReconciler } from "../integrations/intents/receipt";
import { mountIntentsFundingPanel } from "../integrations/intents/panel";
import { mountRheaPanel } from "../integrations/rhea/panel";
import { createRheaConfig } from "../integrations/rhea/config";
import { createRheaRuntime } from "../integrations/rhea/runtime";
import {
  INTENTS_NATIVE_EVIDENCE,
  INTENTS_BROWSER_TRANSPORT_VERIFIED,
  INTENTS_REVIEWED_SOURCES,
  RHEA_REVIEWED_ROUTE,
  RHEA_REVIEWED_GAS,
} from "../integrations/release-evidence";
import type { AppServices } from "./services";

/** Optional inline acquisition UI. It does not mount over, remount or submit the drawing surface. */
export function mountAcquisitionPanel(
  host: HTMLElement,
  services: AppServices,
  onBalancesChanged: () => void,
): () => void {
  const root = document.createElement("section");
  root.className = "mp-acquisition";
  host.append(root);
  const title = document.createElement("h3");
  title.textContent = "Add funds and get mPOO";
  const receive = document.createElement("p");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy NEAR receive address";
  const note = document.createElement("p");
  note.setAttribute("role", "status");
  root.append(title, receive, copy, note);
  let intentsId = crypto.randomUUID(),
    rheaId = crypto.randomUUID(),
    previousIdentity = "",
    disposed = false;
  const context = () => getAcquisitionContext(intentsId);
  const rheaContext = () => getAcquisitionContext(rheaId);
  const rpc = createAcquisitionRpc(RPC_URL);
  const refreshIdentity = () => {
    const session = services.wallet.getSession();
    const identity = `${session.accountId}:${session.networkId}`;
    if (identity !== previousIdentity) {
      intentsId = crypto.randomUUID();
      rheaId = crypto.randomUUID();
      previousIdentity = identity;
    }
    receive.textContent = session.accountId
      ? `Receive native NEAR at ${session.accountId} on ${session.networkId}. Keep some NEAR for network fees.`
      : "Connect a wallet to see its NEAR receive address.";
    copy.disabled = !session.accountId || session.networkId !== PAGE_NETWORK;
  };
  const onCopy = () => {
    const s = services.wallet.getSession();
    if (s.accountId && s.networkId === PAGE_NETWORK)
      void navigator.clipboard
        .writeText(s.accountId)
        .then(() => {
          if (!disposed)
            note.textContent =
              "Receive address copied. Send only native NEAR on this network.";
        })
        .catch(() => {
          if (!disposed) note.textContent = "Copy the address shown above.";
        });
  };
  copy.addEventListener("click", onCopy);
  const cleanups: Array<() => void> = [
    services.wallet.subscribe(refreshIdentity),
    () => copy.removeEventListener("click", onCopy),
  ];
  const recovery = findRecoverableAcquisition();
  if (INTENTS_FUNDING_ENABLED || recovery?.feature === "intents") {
    const target = document.createElement("div");
    root.append(target);
    const reserve = /^[1-9]\d*$/.test(ACQUISITION_PLAY_RESERVE_YOCTO)
      ? ACQUISITION_PLAY_RESERVE_YOCTO
      : "0";
    const base =
      import.meta.env.VITE_INTENTS_TRANSPORT === "proxy"
        ? import.meta.env.VITE_INTENTS_PROXY_BASE
        : import.meta.env.VITE_INTENTS_API_BASE;
    const readReadiness = (
      c: import("../integrations/types").OperationContext,
    ) => readConnectedAccountReadiness(c);
    const controller = createIntentsFundingController({
      client: createIntentsClient({ baseUrl: base || undefined }),
      storage: createIntentsStorage(window.localStorage),
      currentContext: context,
      readReadiness,
      policy: {
        enabled:
          INTENTS_FUNDING_ENABLED &&
          PAGE_NETWORK === "mainnet" &&
          reserve !== "0",
        transportVerified: INTENTS_BROWSER_TRANSPORT_VERIFIED,
        deliveryMode: "native",
        nativeDeliveryEvidence: INTENTS_NATIVE_EVIDENCE,
        sourceAllowlist: INTENTS_REVIEWED_SOURCES,
        playReserveYocto: reserve,
      },
      reconcileDestination: createDestinationReconciler({
        readTransaction: (hash, recipient) =>
          rpc("EXPERIMENTAL_tx_status", {
            tx_hash: hash,
            sender_account_id: recipient,
            wait_until: "FINAL",
          }),
        readReadiness: async (operation) => {
          const account = operation.context.accountId;
          const { encodeBase58 } = await import("../drawing-session");
          const expected = /^[0-9a-f]{64}$/.test(account)
            ? "ed25519:" +
              encodeBase58(
                Uint8Array.from(account.match(/../g)!, (part) =>
                  parseInt(part, 16),
                ),
              )
            : undefined;
          return resolveAccountReadiness(
            account,
            operation.context.networkId,
            rpc,
            expected,
          );
        },
      }),
      onBalancesChanged(c) {
        const current = context();
        if (
          current?.accountId === c.accountId &&
          current.networkId === c.networkId
        )
          onBalancesChanged();
      },
    });
    cleanups.push(
      mountIntentsFundingPanel(target, controller, {
        getContext: context,
        initialOperationId:
          recovery?.feature === "intents"
            ? recovery.context.operationId
            : undefined,
        newContext: () => {
          intentsId = crypto.randomUUID();
          return context();
        },
      }),
    );
  }
  if (RHEA_MPOO_SWAP_ENABLED || recovery?.feature === "rhea") {
    const target = document.createElement("div");
    root.append(target);
    const config = createRheaConfig(
      import.meta.env,
      PAGE_NETWORK === "mainnet" ? "mainnet" : "testnet",
      RHEA_REVIEWED_ROUTE,
    );
    const runtimeDeps: import("../integrations/rhea/runtime").RheaRuntimeDependencies =
      {
        config,
        rpcUrl: RPC_URL,
        context: rheaContext,
        storage: window.localStorage,
        async approve(request) {
          const route = config.route;
          if (!route) throw new Error("A reviewed mPOO route is unavailable.");
          const storageMaximums: Record<string, string> = {};
          for (const tx of request.transactions) {
            if (
              tx.actions.some(
                (action) => action.params.methodName === "storage_deposit",
              )
            ) {
              const raw = (await rpc("query", {
                request_type: "call_function",
                finality: "final",
                account_id: tx.receiverId,
                method_name: "storage_balance_bounds",
                args_base64: btoa("{}"),
              })) as { result: number[] };
              const bounds = JSON.parse(
                new TextDecoder().decode(new Uint8Array(raw.result)),
              ) as { min: string };
              if (!/^[1-9]\d*$/.test(bounds.min))
                throw new Error("Token storage minimum could not be verified.");
              storageMaximums[tx.receiverId] = bounds.min;
            }
          }
          configureAcquisitionPolicy({
            wrapAccount: route.wrapToken,
            tokenAccounts: Object.keys(route.decimals),
            exchangeAccounts: [
              ...new Set(route.legs.map((leg) => leg.exchange)),
            ],
            poolIds: route.legs.map((leg) => leg.poolId),
            storageMaximums,
          });
          return signAndSendApprovedTransactions(request);
        },
        onBalancesChanged: () => onBalancesChanged(),
        gas: RHEA_REVIEWED_GAS ?? undefined,
        onReconciled: (ctx) =>
          reconcilePendingAcquisition(ctx).then(() => undefined),
        expectedPublicKey: async () => {
          const ctx = rheaContext();
          return ctx ? getConnectedAcquisitionPublicKey(ctx) : undefined;
        },
      };
    const runtime = createRheaRuntime(runtimeDeps);
    const prepare = runtime.prepareQuote;
    runtime.prepareQuote = async (input, slippage, signal) => {
      // Every explicit new swap review gets its own ledger ID, independent of funding.
      rheaId = crypto.randomUUID();
      runtimeDeps.batchRegistrations =
        await supportsAcquisitionBatchRegistrations();
      return prepare(input, slippage, signal);
    };
    // Route details remain in diagnostics/evidence; the player gets a plain availability message.
    if (runtime.availabilityReason)
      runtime.availabilityReason =
        PAGE_NETWORK === "mainnet"
          ? "In-game mPOO swaps are not available yet. Use the market link below."
          : "Real mPOO is on NEAR mainnet. This game is using a different network.";
    cleanups.push(mountRheaPanel(target, runtime));
  }
  refreshIdentity();
  return () => {
    disposed = true;
    cleanups.forEach((fn) => fn());
    root.remove();
  };
}
export function findRecoverableAcquisition() {
  try {
    const store = createAcquisitionStore(window.localStorage);
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith("metapoo:acquisition:v1:")) continue;
      const op = store.load(key.slice("metapoo:acquisition:v1:".length));
      if (
        op &&
        !["complete", "funded", "refunded", "failed"].includes(op.phase)
      )
        return op;
    }
  } catch {
    /* Invalid recovery stays in storage for diagnosis, never an automatic new payment. */
  }
  return null;
}
