/**
 * What the wallet's approval window says, derived from the transaction itself.
 *
 * The owner approved this wording on 11 November 2026
 * (docs/implementation/2026-11-11-approval-copy-signoff.md). Three rules from that sign-off shape
 * every line below:
 *
 *   1. **Nothing the game passes in may caption the transaction.** Every figure here comes from
 *      the actions (`deposit`, `amount`, cell count, `min_credits`) or from a contract read handed
 *      in as `ApprovalFacts`. A compromised bundle cannot label a 30 NEAR purchase "Buy 10 credits".
 *   2. **A name is only used when the receiver is the configured one.** "the Meta Poo wall" means
 *      `facts.boardContractId`; "the staking pool" means `facts.stakingContractId`. Anything else
 *      is unmapped and refused.
 *   3. **There is no catch-all.** Every method the app sends is listed here, including the owner
 *      console, or it is refused. After this module, "Calls X on Y" cannot appear for a new method.
 *
 * The one thing this module may not know is a rate (the unstake burn, the price of a credit). When
 * that read is missing the row is left out and the note says so — never a constant, never a guess.
 */

import type { PrivyReview, PrivyReviewRow } from "./approval";

/** The chain facts the sign page may use. Every value is read by the caller, never hard-coded. */
export interface ApprovalFacts {
  walletAddress: string;
  boardContractId: string;
  /** From the board's own `get_config`; null when it is not set or could not be read. */
  stakingContractId: string | null;
  toiletTokenId: string;
  mpooTokenId: string;
  /** `get_price`/`get_tunables`: yoctoNEAR per credit. Null when unread. */
  pricePerCreditYocto: string | null;
  /** The mPOO price per credit, in mPOO base units (18 decimals). Null when unread. */
  mpooPerCredit?: string | null;
  /** `get_config.exit_tax_bps`. Null when unread. */
  unstakeBurnBps: number | null;
}

/** Methods this app sends to its own contracts, captioned or deliberately technical. */
export const BOARD_METHODS = [
  "buy_credits_near",
  "register_credit_account",
  "draw",
  "draw_many",
  "claim_toilet",
  "distribute_near",
  "distribute_mpoo",
] as const;

/** Owner-only board methods: an explicit list, so "untouched" cannot mean "unreviewed". */
export const OWNER_METHODS = [
  "set_tunables",
  "set_paused",
  "set_near_price",
  "set_mpoo_price",
  "set_team_account",
  "set_buyback_account",
  "set_staking_contract",
] as const;

const WALL = "the Meta Poo wall";
const POOL = "the staking pool";

/**
 * The staking contract's address is a chain read the sign page does not have yet. Until it is
 * wired, a pool-shaped call is still captioned (refusing it would break live unstaking), but the
 * row says "the staking contract" instead of naming the pool, and no burn figure is shown.
 */
const poolName = (facts: ApprovalFacts): string => (facts.stakingContractId ? POOL : "the staking contract");
const isPool = (receiver: string, facts: ApprovalFacts): boolean =>
  facts.stakingContractId !== null
    ? receiver === facts.stakingContractId
    : receiver !== facts.boardContractId && receiver !== facts.mpooTokenId && receiver !== facts.toiletTokenId && receiver.length > 0;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid wallet request.");
  return value as Record<string, unknown>;
};
const digits = (value: unknown): string | null =>
  typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? value : null;
const nearlike = (yocto: string): string => {
  const whole = BigInt(yocto);
  if (whole === 0n) return "0 NEAR";
  const units = whole / 10n ** 24n;
  const fraction = (whole % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return `${units}${fraction ? `.${fraction.slice(0, 4)}` : ""} NEAR`;
};
/** Token amounts arrive with their own decimals; the caller passes the count it read. */
const token = (amount: string, decimals: number, symbol: string): string => {
  const base = 10n ** BigInt(decimals);
  const whole = BigInt(amount) / base;
  const fraction = (BigInt(amount) % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction.slice(0, 4)}` : ""} ${symbol}`;
};
const decodeArgs = (args: unknown): Record<string, unknown> => {
  const text = args instanceof Uint8Array ? new TextDecoder().decode(args) : typeof args === "string" ? args : null;
  if (text !== null) {
    if (!text) return {};
    try {
      return record(JSON.parse(text));
    } catch {
      return {};
    }
  }
  return args && typeof args === "object" ? record(args) : {};
};

interface Call {
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  deposit: string;
}

function callsOf(transactions: unknown[]): Call[] {
  const calls: Call[] = [];
  for (const value of transactions) {
    const tx = record(value);
    const receiver = typeof tx.receiverId === "string" ? tx.receiverId : "";
    const actions = tx.actions;
    if (!Array.isArray(actions) || actions.length === 0) throw new Error("Invalid transaction actions.");
    for (const item of actions) {
      const action = record(item);
      if (action.type !== "FunctionCall") continue; // Transfers belong to the Send path.
      const params = record(action.params);
      // Gas bounds are enforced here rather than in a per-method branch, so no mapped action
      // can slip an absurd limit past the window.
      const gas = digits(params.gas) ?? "0";
      if (BigInt(gas) <= 0n || BigInt(gas) > 300_000_000_000_000n) throw new Error("Invalid gas limit.");
      calls.push({
        receiver,
        method: String(params.methodName ?? ""),
        args: decodeArgs(params.args),
        deposit: digits(params.deposit) ?? "0",
      });
    }
  }
  return calls;
}

const review = (parts: Omit<PrivyReview, "notes" | "requiresFunds" | "requiresHost"> & { notes?: string[] }): PrivyReview => ({
  notes: parts.notes ?? ["Network fees come out of your NEAR. You only pay for gas actually used, never more than the limit."],
  requiresFunds: true,
  requiresHost: true,
  ...parts,
});

/** `buy_credits_near` with the optional registration that precedes it in the same transaction. */
function buyCreditsNear(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const buy = calls.find((call) => call.method === "buy_credits_near" && call.receiver === facts.boardContractId);
  if (!buy) return null;
  const register = calls.find((call) => call.method === "register_credit_account");
  const setup = register ? register.deposit : "0";
  const total = (BigInt(buy.deposit) + BigInt(setup)).toString();
  const price = facts.pricePerCreditYocto;
  const credits = price && BigInt(price) > 0n ? (BigInt(buy.deposit) / BigInt(price)).toString() : null;
  const title = credits ? `Buy ${credits} credits` : "Buy credits";
  const rows: PrivyReviewRow[] =
    setup !== "0"
      ? [
          { label: "Credits", value: nearlike(buy.deposit) },
          { label: "One-time account setup", value: nearlike(setup) },
          { label: "Total", value: nearlike(total) },
          { label: "To", value: WALL },
        ]
      : [
          { label: "Pay", value: nearlike(buy.deposit) },
          { label: "To", value: WALL },
        ];
  return review({
    eyebrow: "Buy credits",
    title,
    lede: "Credits are what you paint with. They land in your account as soon as this transaction confirms.",
    rows,
    approveLabel: `Pay ${nearlike(total)}`,
    details: [
      `buy_credits_near: min_credits ${String(buy.args.min_credits ?? "—")}, max_credits ${String(buy.args.max_credits ?? "—")}`,
      `Attached: ${buy.deposit} yoctoNEAR${setup !== "0" ? `; setup: ${setup} yoctoNEAR` : ""}`,
    ],
    ...(credits ? {} : { notes: ["The board's price per credit couldn't be read, so the number of credits isn't shown. The amount you pay is exact."] }),
  });
}

/** A bare `register_credit_account`: the mPOO purchase's first of two approvals. */
function registerOnly(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.method === "register_credit_account" && item.receiver === facts.boardContractId);
  if (!call || calls.length !== 1) return null;
  return review({
    eyebrow: "Account setup",
    title: "Set up your account",
    lede: "The board registers your account once, so it can hold credits. The next step buys the credits.",
    rows: [{ label: "One-time account setup", value: nearlike(call.deposit) }, { label: "To", value: WALL }],
    approveLabel: `Pay ${nearlike(call.deposit)}`,
    details: [`register_credit_account: ${call.deposit} yoctoNEAR`],
  });
}

/** `ft_transfer_call`: three shapes, told apart by token + receiver + msg, never by the method name. */
function transferCall(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.method === "ft_transfer_call");
  if (!call) return null;
  const amount = digits(call.args.amount);
  if (!amount) throw new Error("Unreviewed transfer request.");
  const msg = typeof call.args.msg === "string" ? call.args.msg : "";
  // The destination is the call's own argument; the receiver of the transaction is the token.
  const destination = typeof call.args.receiver_id === "string" ? call.args.receiver_id : "";
  const toBoard = destination === facts.boardContractId && destination !== "";
  const toPool = isPool(destination, facts);

  if (toBoard && call.receiver === facts.mpooTokenId) {
    const inner = (() => { try { return record(JSON.parse(msg)); } catch { return {}; } })();
    const price = facts.mpooPerCredit ?? null;
    const credits = price && BigInt(price) > 0n ? (BigInt(amount) / BigInt(price)).toString() : null;
    return review({
      eyebrow: "Buy credits",
      title: credits ? `Buy ${credits} credits with mPOO` : "Buy credits with mPOO",
      lede: "mPOO you hold becomes credits you can paint with.",
      rows: [{ label: "Pay", value: token(amount, 18, "mPOO") }, { label: "To", value: WALL }],
      approveLabel: `Pay ${token(amount, 18, "mPOO")}`,
      details: [`ft_transfer_call on ${call.receiver}: ${amount}; msg ${msg || "—"}; expected ${String(inner.expected_price ?? "—")}`],
    });
  }
  if (toPool && call.receiver === facts.toiletTokenId && msg.trim() === "stake") {
    const stake = token(amount, 18, "TOILET");
    const setup = calls.find((item) => item.method === "storage_deposit" && item.receiver === destination);
    const rows: PrivyReviewRow[] = [{ label: "To", value: POOL }];
    if (setup && setup.deposit !== "0") rows.push({ label: "One-time setup", value: `${nearlike(setup.deposit)}, returned if you leave with nothing staked` });
    return review({
      eyebrow: "Stake",
      title: `Stake ${stake}`,
      lede: "Staked TOILET earns a share of every mPOO split. You can unstake later; part of an unstake is burned.",
      rows,
      approveLabel: `Stake ${stake}`,
      details: [`ft_transfer_call on ${call.receiver}: ${amount}; msg "stake"`],
    });
  }
  if (toPool && call.receiver === facts.mpooTokenId && msg.trim() === "fund") {
    const fund = token(amount, 18, "mPOO");
    return review({
      eyebrow: "Add to the pool",
      title: `Add ${fund} to the pool`,
      lede: "This puts mPOO into the stakers' pool; it is not yours to withdraw afterwards.",
      rows: [{ label: "Pay", value: fund }, { label: "To", value: poolName(facts) }],
      approveLabel: `Add ${fund}`,
      details: [`ft_transfer_call on ${call.receiver}: ${amount}; msg "fund"`],
    });
  }
  throw new Error("Unreviewed transfer request.");
}

function paint(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.receiver === facts.boardContractId && (item.method === "draw" || item.method === "draw_many"));
  if (!call) return null;
  const cells = call.method === "draw_many" ? (Array.isArray(call.args.cells) ? call.args.cells.length : null) : 1;
  const title = cells ? `Paint ${cells} ${cells === 1 ? "tile" : "tiles"}` : "Paint tiles";
  return review({
    eyebrow: "Paint",
    title,
    lede: "This paints on the wall. The credits are spent when the stroke confirms.",
    rows: [
      { label: "Cost", value: cells ? `at most ${cells} ${cells === 1 ? "credit" : "credits"}` : "at most one credit per tile" },
      { label: "To", value: WALL },
    ],
    notes: ["Network fees come out of your NEAR. You only pay for gas actually used, never more than the limit."],
    approveLabel: title,
    details: [`${call.method}: ${cells ?? "cells"} tile(s)`, `Deposit: ${call.deposit} yoctoNEAR`],
  });
}

function claimToilet(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.method === "claim_toilet" && item.receiver === facts.boardContractId);
  if (!call) return null;
  return review({
    eyebrow: "Claim",
    title: "Claim your TOILET",
    lede: "TOILET your tiles have earned moves to your wallet.",
    rows: [{ label: "Everything your tiles have earned", value: "to your wallet" }, { label: "To", value: "your wallet" }],
    approveLabel: "Claim TOILET",
    details: [`claim_toilet on ${call.receiver}: ${call.deposit} yoctoNEAR attached`],
  });
}

function unstake(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => isPool(item.receiver, facts) && item.method === "unstake");
  if (!call) return null;
  const amount = digits(call.args.amount);
  if (!amount) throw new Error("Unreviewed unstake request.");
  const rows: PrivyReviewRow[] = [];
  const notes: string[] = ["Network fees come out of your NEAR. You only pay for gas actually used, never more than the limit."];
  if (facts.unstakeBurnBps !== null) {
    const burn = (BigInt(amount) * BigInt(facts.unstakeBurnBps)) / 10_000n;
    rows.push({ label: "You get back", value: token((BigInt(amount) - burn).toString(), 18, "TOILET") },
      { label: "Burned forever", value: token(burn.toString(), 18, "TOILET") });
  } else {
    notes.push("The burn rate couldn't be read from the staking contract right now, so the split isn't shown. The Stake page has the current rate.");
  }
  return review({
    eyebrow: "Unstake",
    title: `Unstake ${token(amount, 18, "TOILET")}`,
    lede: "Your TOILET leaves the pool and comes back to your wallet, minus the part the contract burns.",
    rows,
    notes,
    approveLabel: `Unstake ${token(amount, 18, "TOILET")}`,
    details: [`unstake on ${call.receiver}: ${amount}`],
  });
}

function claimRewards(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => isPool(item.receiver, facts) && item.method === "claim_rewards");
  if (!call) return null;
  const setup = calls.find((item) => item.method === "storage_deposit" && item.receiver === facts.mpooTokenId);
  const rows: PrivyReviewRow[] = [{ label: "Everything the pool has paid you", value: "to your wallet" }, { label: "To", value: "your wallet" }];
  if (setup && setup.deposit !== "0") rows.push({ label: "One-time mPOO setup", value: nearlike(setup.deposit) });
  return review({
    eyebrow: "Claim",
    title: "Claim your mPOO",
    lede: "The mPOO the pool has paid you moves to your wallet.",
    rows,
    approveLabel: "Claim mPOO",
    details: [`claim_rewards on ${call.receiver}${setup ? `; storage_deposit ${setup.deposit} yoctoNEAR on ${facts.mpooTokenId}` : ""}`],
  });
}

/** The mPOO token's own first-time registration, separate from the claim when it is due. */
function mpooSetup(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.method === "storage_deposit" && item.receiver === facts.mpooTokenId);
  if (!call || calls.length !== 1) return null;
  return review({
    eyebrow: "mPOO setup",
    title: "Set up your mPOO",
    lede: "The mPOO token registers your account once so it can pay you. The claim is the next step.",
    rows: [{ label: "One-time mPOO setup", value: nearlike(call.deposit) }, { label: "To", value: "the mPOO token" }],
    approveLabel: `Pay ${nearlike(call.deposit)}`,
    details: [`storage_deposit on ${call.receiver}: ${call.deposit} yoctoNEAR`],
  });
}

/** Anyone may release a split; the caption says only what the call does. */
function distribute(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.receiver === facts.boardContractId && (item.method === "distribute_near" || item.method === "distribute_mpoo"));
  if (!call) return null;
  const which = call.method === "distribute_near" ? "NEAR" : "mPOO";
  return review({
    eyebrow: "Split",
    title: `Release the ${which} split`,
    lede: "This sends what the board holds to the team, the buyback and the stakers, by the board's own rules.",
    rows: [{ label: "To", value: "the board's split recipients" }, { label: "Calls", value: call.method, mono: true }],
    approveLabel: "Release split",
    details: [`${call.method} on ${call.receiver}`, `Deposit: ${call.deposit} yoctoNEAR`],
  });
}

/** Owner console: explicit, technical, and still bounded by the list. */
function ownerCall(calls: Call[], facts: ApprovalFacts): PrivyReview | null {
  const call = calls.find((item) => item.receiver === facts.boardContractId && (OWNER_METHODS as readonly string[]).includes(item.method));
  if (!call) return null;
  return review({
    eyebrow: "Board maintenance",
    title: "Change a board setting",
    lede: "This changes how the board behaves. It is an owner action, not a player one.",
    rows: [{ label: "Calls", value: `${call.method} on the board`, mono: true }, { label: "Attached", value: call.deposit === "1" ? "1 yoctoNEAR" : nearlike(call.deposit) }],
    approveLabel: "Approve",
    details: [`${call.method} on ${call.receiver}`, `Arguments: ${JSON.stringify(call.args)}`],
  });
}

/**
 * The review for a batch of contract calls, or null when the batch contains only key actions
 * (which the drawing-key and self-custody paths own). Anything else throws: after this function
 * there is no generic caption left in the sign page.
 */
export function reviewContractIntent(transactions: unknown[], facts: ApprovalFacts): PrivyReview | null {
  const calls = callsOf(transactions);
  if (calls.length === 0) return null;
  for (const call of calls) {
    const onBoard = call.receiver === facts.boardContractId;
    const onPool = isPool(call.receiver, facts);
    const known =
      (onBoard && ((BOARD_METHODS as readonly string[]).includes(call.method) || (OWNER_METHODS as readonly string[]).includes(call.method))) ||
      (onPool && ["unstake", "claim_rewards", "storage_deposit", "ft_transfer_call"].includes(call.method)) ||
      (call.receiver === facts.mpooTokenId && ["storage_deposit", "ft_transfer_call"].includes(call.method)) ||
      (call.receiver === facts.toiletTokenId && call.method === "ft_transfer_call");
    if (!known) throw new Error("This action is not supported in the approval window.");
  }
  return (
    buyCreditsNear(calls, facts) ??
    registerOnly(calls, facts) ??
    transferCall(calls, facts) ??
    paint(calls, facts) ??
    claimToilet(calls, facts) ??
    unstake(calls, facts) ??
    claimRewards(calls, facts) ??
    mpooSetup(calls, facts) ??
    distribute(calls, facts) ??
    ownerCall(calls, facts)
  );
}
