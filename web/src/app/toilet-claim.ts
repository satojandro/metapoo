/**
 * "Your TOILET": balance, earnings waiting on the board, and the claim button.
 * Mounted in the wallet panel and on /toilet. Staking, unstaking and mPOO rewards
 * join it once the staking contract is on a testnet board (fe-toilet-page).
 */

import { explorerUrl } from "@shared/board-rules.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL, TOILET_ID } from "../config";
import { connectWallet } from "../shared/connect-wallet";
import { isUserRejection, parseTxOutcome } from "../tx-outcome";
import { signAndSendClaimToilet } from "../wallet";
import { createRpcView, formatAmount, formatExact } from "./revenue-panel";
import type { AppServices } from "./services";
import {
  claimButtonState,
  CLAIM_TOILET_GAS,
  loadToilet,
  mintRefused,
  TOILET_DECIMALS,
  type ToiletSnapshot,
} from "./toilet";
import "./toilet.css";

export interface ToiletClaimDeps {
  load: (account: string | null) => Promise<ToiletSnapshot>;
  sign: typeof signAndSendClaimToilet;
  network: string;
  contractId: string;
  toiletId: string;
  pollMs: number;
}

function defaultDeps(): ToiletClaimDeps {
  const view = createRpcView(RPC_URL);
  return {
    load: (account) => loadToilet(view, CONTRACT_ID, TOILET_ID, account),
    sign: signAndSendClaimToilet,
    network: PAGE_NETWORK,
    contractId: CONTRACT_ID,
    toiletId: TOILET_ID,
    pollMs: 30_000,
  };
}

/** True when this page can read and claim TOILET at all. */
export function toiletConfigured(deps: Pick<ToiletClaimDeps, "contractId" | "toiletId"> = defaultDeps()): boolean {
  return deps.contractId !== "" && deps.toiletId !== "";
}

export function mountToiletClaim(
  host: HTMLElement,
  services: AppServices,
  overrides: Partial<ToiletClaimDeps> = {},
): () => void {
  const deps = { ...defaultDeps(), ...overrides };
  host.classList.add("toilet-claim");
  host.innerHTML = `
    <h2 class="toilet-claim-h">Your TOILET</h2>
    <dl class="toilet-claim-rows">
      <div><dt>In your wallet</dt><dd data-tc="balance">…</dd></div>
      <div><dt>Earned by your tiles, not claimed</dt><dd data-tc="pending" class="toilet-claim-pending">…</dd></div>
    </dl>
    <button type="button" class="mp-btn mp-btn-primary" data-tc-claim disabled>Claim TOILET</button>
    <p class="toilet-claim-hint" data-tc="hint"></p>
    <p class="toilet-claim-result" data-tc="result" role="status"></p>`;
  const $ = (key: string) => host.querySelector<HTMLElement>(`[data-tc="${key}"]`)!;
  const button = host.querySelector<HTMLButtonElement>("[data-tc-claim]")!;

  let snapshot: ToiletSnapshot | null = null;
  let failed = false;
  let busy = false;
  /** Signed out: the button is a Connect control, not a claim control (UI review C1). */
  let connecting = false;
  let generation = 0;
  let disposed = false;

  function amount(key: string, units: bigint): void {
    $(key).textContent = `${formatAmount(units, TOILET_DECIMALS, { maxFraction: 2 })} TOILET`;
    $(key).title = `${formatExact(units, TOILET_DECIMALS)} TOILET exactly`;
  }

  function render(): void {
    const session = services.wallet.getSession();
    const live = snapshot?.kind === "live" ? snapshot : null;
    if (!session.accountId) {
      $("balance").textContent = "Connect a wallet";
      $("pending").textContent = "Connect a wallet";
    } else if (session.networkId !== deps.network) {
      $("balance").textContent = `Switch to ${deps.network}`;
      $("pending").textContent = `Switch to ${deps.network}`;
    } else if (snapshot?.kind === "not-yet") {
      $("balance").textContent = "Not on this board";
      $("pending").textContent = "Not on this board";
    } else if (live?.account) {
      amount("balance", live.account.balance);
      amount("pending", live.account.pending);
    } else if (failed || live?.accountFailed) {
      $("balance").textContent = "Unavailable";
      $("pending").textContent = "Unavailable";
    }
    const state = claimButtonState({
      pending: live?.account?.pending ?? null,
      accountId: session.accountId,
      walletNetwork: session.networkId,
      pageNetwork: deps.network,
      toilet: deps.toiletId,
      paused: live?.paused ?? null,
      busy,
      example: deps.contractId === "",
    });
    button.disabled = !state.enabled;
    button.textContent = state.label;
    connecting = state.connect === true;
    $("hint").textContent = snapshot?.kind === "not-yet"
      ? "This board was deployed before TOILET existed, so it doesn’t pay any."
      : state.hint;
  }

  async function refresh(): Promise<void> {
    if (disposed || !toiletConfigured(deps)) return;
    const current = ++generation;
    const session = services.wallet.getSession();
    // Wrong network: the account id belongs to another chain, so don't read it here.
    const account = session.networkId === deps.network ? session.accountId : null;
    try {
      const next = await deps.load(account);
      if (disposed || current !== generation) return;
      snapshot = next;
      failed = false;
    } catch {
      if (disposed || current !== generation) return;
      failed = true;
    }
    render();
  }

  async function claim(): Promise<void> {
    if (connecting) {
      connectWallet(() => void services.wallet.connect());
      return;
    }
    if (button.disabled) return;
    const result = $("result");
    busy = true;
    result.replaceChildren();
    render();
    try {
      const raw = await deps.sign({ contractId: deps.contractId, toilet: deps.toiletId, gas: CLAIM_TOILET_GAS });
      const outcome = parseTxOutcome(raw);
      let message: string;
      // The transaction succeeds even when the token refuses the mint: the board's
      // callback puts the earnings back and logs `claim_failed`.
      if (outcome.status === "success" && mintRefused(raw)) {
        message = "The TOILET token refused the mint. Your earnings were put back, so nothing is lost. Try again later.";
      } else if (outcome.status === "success") message = "Claimed. The TOILET is in your wallet.";
      else if (outcome.failureMessage && /NothingToClaim/.test(outcome.failureMessage)) message = "Nothing was waiting to claim.";
      else if (outcome.status === "failed") message = `The board refused: ${outcome.failureMessage ?? "unknown reason"}.`;
      else message = "Submitted. Check the transaction before trying again.";
      result.textContent = message;
      const link = explorerUrl(deps.network as Parameters<typeof explorerUrl>[0], outcome.transactionHash);
      if (link) {
        const a = document.createElement("a");
        a.href = link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = " View transaction ↗";
        result.append(a);
      }
    } catch (error) {
      result.textContent = isUserRejection(error)
        ? "Cancelled. Nothing was sent."
        : "The wallet couldn’t send it. Nothing changed; try again.";
    } finally {
      busy = false;
      if (!disposed) await refresh();
    }
  }

  const onClick = (): void => void claim();
  button.addEventListener("click", onClick);
  const unsubscribe = services.wallet.subscribe(() => { render(); void refresh(); });
  const onFocus = (): void => { if (document.visibilityState !== "hidden") void refresh(); };
  const poll = window.setInterval(onFocus, deps.pollMs);
  window.addEventListener("focus", onFocus);
  render();
  void refresh();

  return () => {
    disposed = true;
    generation++;
    window.clearInterval(poll);
    window.removeEventListener("focus", onFocus);
    button.removeEventListener("click", onClick);
    unsubscribe();
    host.replaceChildren();
  };
}
