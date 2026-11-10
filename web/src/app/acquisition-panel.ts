import {
  ACQUISITION_PLAY_RESERVE_YOCTO,
  INTENTS_FUNDING_ENABLED,
  INTENTS_TEST_MODE,
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
import { listRecoverableAcquisitions } from "../integrations/operation-store";
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
  // Secondary path: players who already hold NEAR elsewhere just send it. Appended last.
  const direct = document.createElement("div");
  direct.className = "mp-acquisition-direct";
  const directTitle = document.createElement("p");
  directTitle.className = "mp-acquisition-direct-title";
  directTitle.textContent = "Already have NEAR?";
  const receive = document.createElement("p");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "mp-intents-btn";
  copy.textContent = "Copy NEAR receive address";
  const note = document.createElement("p");
  note.setAttribute("role", "status");
  direct.append(directTitle, receive, copy, note);
  let intentsId = crypto.randomUUID(),
    rheaId = crypto.randomUUID(),
    previousIdentity = "",
    disposed = false;
  const context = () => getAcquisitionContext(intentsId);
  const rheaContext = () => getAcquisitionContext(rheaId);
  const rpc = createAcquisitionRpc(RPC_URL);
  const fundingRpc = createAcquisitionRpc(
    PAGE_NETWORK === "mainnet" ? RPC_URL : "https://rpc.mainnet.near.org",
  );
  const identityListeners: Array<() => void> = [];
  const refreshIdentity = () => {
    const session = services.wallet.getSession();
    const identity = `${session.accountId}:${session.networkId}:${context()?.sessionEpoch ?? ""}`;
    const changed = identity !== previousIdentity;
    if (changed) {
      intentsId = crypto.randomUUID();
      rheaId = crypto.randomUUID();
      previousIdentity = identity;
    }
    receive.textContent = session.accountId
      ? `Send native NEAR straight to ${session.accountId} on ${session.networkId}. Keep some NEAR for network fees.`
      : "Connect a wallet to see its NEAR receive address.";
    copy.disabled = !session.accountId || session.networkId !== PAGE_NETWORK;
    if (changed) identityListeners.forEach((listener) => listener());
  };
  // Capture the initial identity before asynchronous panels load their assets.
  refreshIdentity();
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
  const recoveries = listRecoverableAcquisitions(window.localStorage);
  const intentsRecovery = recoveries.find((op) => op.feature === "intents");
  const rheaRecovery = recoveries.find((op) => op.feature === "rhea");
  if (recoveries.length) {
    const saved = document.createElement("p");
    saved.textContent =
      "Saved acquisition recovery IDs: " +
      recoveries
        .map(
          (op) =>
            `${op.feature}: ${op.context.operationId} (${op.context.networkId})`,
        )
        .join("; ");
    root.append(saved);
  }
  if (INTENTS_FUNDING_ENABLED || !!intentsRecovery) {
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
        unverifiedTestDelivery: INTENTS_TEST_MODE,
      },
      reconcileDestination: createDestinationReconciler({
        readTransaction: (hash, recipient) =>
          fundingRpc("EXPERIMENTAL_tx_status", {
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
            fundingRpc,
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
    identityListeners.push(() => {
      controller.invalidatePreview();
      // The wallet session usually restores after this panel mounts. The mount-time asset read
      // then fails with "Connect a wallet" and, before this, nothing ever read the registry again.
      if (context() && !controller.getState().operation)
        void controller.loadAssets();
    });
    cleanups.push(
      mountIntentsFundingPanel(target, controller, {
        getContext: context,
        initialOperationId: intentsRecovery?.context.operationId,
        testMode: INTENTS_TEST_MODE,
        newContext: () => {
          intentsId = crypto.randomUUID();
          return context();
        },
      }),
    );
  }
  if (RHEA_MPOO_SWAP_ENABLED || !!rheaRecovery) {
    const target = document.createElement("div");
    root.append(target);
    const activeNetwork = PAGE_NETWORK === "mainnet" ? "mainnet" : "testnet";
    const config = createRheaConfig(
      import.meta.env,
      activeNetwork,
      RHEA_REVIEWED_ROUTE?.networkId === activeNetwork
        ? RHEA_REVIEWED_ROUTE
        : null,
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
        async onReconciled(ctx) {
          if (!(await reconcilePendingAcquisition(ctx)))
            throw new Error(
              "The original wallet attempt still needs matching transaction proof.",
            );
        },
        subscribeContext: (listener) =>
          services.wallet.subscribe(() => listener()),
        expectedPublicKey: async () => {
          const ctx = rheaContext();
          return ctx ? getConnectedAcquisitionPublicKey(ctx) : undefined;
        },
      };
    const runtime = createRheaRuntime(runtimeDeps);
    const originalLast = runtime.lastOperationId;
    const savedSwaps = recoveries.filter((op) => op.feature === "rhea");
    const selection = document.createElement("select");
    selection.setAttribute("aria-label", "Saved mPOO acquisitions");
    for (const op of savedSwaps) {
      const option = document.createElement("option");
      option.value = op.context.operationId;
      option.textContent = `${op.context.accountId} (${op.context.networkId}) — ${op.context.operationId}`;
      selection.append(option);
    }
    if (savedSwaps.length) target.append(selection);
    runtime.lastOperationId = () => selection.value || originalLast?.() || null;
    runtime.resume = async (id) => {
      const { createRheaOperationStore } = await import(
        "../integrations/rhea/controller"
      );
      const saved = createRheaOperationStore(window.localStorage).load(id);
      if (!saved) throw new Error("The original swap record was not found.");
      const originalNetwork = saved.context.networkId;
      const readOnly = createRheaRuntime({
        ...runtimeDeps,
        config: createRheaConfig(
          { ...import.meta.env, VITE_RHEA_MPOO_SWAP_ENABLED: "false" },
          originalNetwork,
          null,
        ),
        rpcUrl:
          originalNetwork === PAGE_NETWORK
            ? RPC_URL
            : originalNetwork === "mainnet"
              ? "https://rpc.mainnet.near.org"
              : "https://rpc.testnet.near.org",
      });
      return readOnly.resume(id);
    };
    const prepare = runtime.prepareQuote;
    runtime.prepareQuote = async (input, slippage, signal) => {
      // Every explicit new swap review gets its own ledger ID, independent of funding.
      rheaId = crypto.randomUUID();
      selection.selectedIndex = -1;
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
  root.append(direct);
  refreshIdentity();
  return () => {
    disposed = true;
    cleanups.forEach((fn) => fn());
    root.remove();
  };
}
export function findRecoverableAcquisition() {
  try {
    return listRecoverableAcquisitions(window.localStorage)[0] ?? null;
  } catch {
    return null;
  }
}
