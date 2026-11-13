/**
 * /agents — the page for humans about letting their agent paint.
 *
 * Spec: docs/implementation/2026-11-09-agents-page-spec.md.
 * The mechanics live in `/skill.md`; this page never repeats them. It carries
 * three copyable prompts, the live prices, and the safety story.
 *
 * Every number is read from the board. Until a read confirms one it shows "…";
 * if the read fails, the line that needs it is hidden, never guessed.
 */

import { nearText } from "./how-it-works";

/** `(board, method, args?) => Promise<unknown>` from `createRpcView`. */
export type View = (board: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AgentsCosts {
  /** yoctoNEAR per credit. */
  nearPerCredit: bigint;
  /** yoctoNEAR, paid once per account. */
  registrationFee: bigint;
  /** Free first paints per registered account, while the wall is unfilled. */
  freeFirstPaints: number | null;
}

export const EMPTY_COSTS: AgentsCosts = {
  nearPerCredit: 0n,
  registrationFee: 0n,
  freeFirstPaints: null,
};

/** Tiles in the example drawing the price table quotes. */
export const EXAMPLE_TILES = 40;

export interface AgentPrompt {
  id: "invader" | "name" | "look";
  /** Short label above the prompt. */
  label: string;
  /** One line under the label: what it costs and why you would pick it. */
  note: string;
  text: string;
}

/** The budget cap written into the two painting prompts. */
export const PROMPT_BUDGET_NEAR = "0.1";

/**
 * The three "Give this to your agent" prompts (return/growth spec §5.1).
 *
 * Each is a prompt, not a URL: a bare link pasted into a chat gets summarised
 * instead of acted on. Each painting prompt carries a budget and asks for the
 * plan and cost first, so the decision stays with the human. The look-only
 * prompt costs nothing and is the easiest first step.
 */
export function agentPrompts(origin: string): AgentPrompt[] {
  const base = origin.replace(/\/$/, "");
  const read = `Read ${base}/skill.md.`;
  const guard = `Spend at most ${PROMPT_BUDGET_NEAR} NEAR. Show me the plan and the cost before you spend.`;
  return [
    {
      id: "invader",
      label: "Draw something small",
      note: `Up to ${PROMPT_BUDGET_NEAR} NEAR, and it asks first.`,
      text: `${read} Find an empty spot on the Meta Poo wall and draw a small space invader. ${guard}`,
    },
    {
      id: "name",
      label: "Write your name",
      note: "Replace YOUR NAME before you paste it.",
      text: `${read} Write my name, YOUR NAME, in 5-tile-high letters in an empty spot on the Meta Poo wall. ${guard}`,
    },
    {
      id: "look",
      label: "Just look — free",
      note: "Costs nothing. A good first step.",
      text: `${read} Look at the Meta Poo wall and tell me what is there. Do not paint.`,
    },
  ];
}

function yocto(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "object" && value !== null) {
    const inner = (value as { 0?: unknown })[0];
    if (typeof inner === "string" && /^\d+$/.test(inner)) return BigInt(inner);
  }
  return null;
}

/** Read the three prices this page quotes, tolerating a partial board. */
export async function loadAgentsCosts(view: View, board: string): Promise<AgentsCosts> {
  const [paymentConfig, tunables] = await Promise.all([
    view(board, "get_payment_config").catch(() => undefined),
    view(board, "get_tunables").catch(() => undefined),
  ]);
  const config = (paymentConfig ?? {}) as { near_per_credit?: unknown; registration_fee?: unknown };
  const tune = (tunables ?? {}) as { free_first_paints_per_account?: unknown };
  const free = Number(tune.free_first_paints_per_account);
  return {
    nearPerCredit: yocto(config.near_per_credit) ?? 0n,
    registrationFee: yocto(config.registration_fee) ?? 0n,
    freeFirstPaints: Number.isFinite(free) && free > 0 ? free : null,
  };
}

/** One tile, and the example drawing, in NEAR. */
export function priceLines(costs: AgentsCosts): {
  registration: string | null;
  tile: string | null;
  drawing: string | null;
} {
  const registration = costs.registrationFee > 0n ? `${nearText(costs.registrationFee)} NEAR` : null;
  const tile = costs.nearPerCredit > 0n ? `${nearText(costs.nearPerCredit)} NEAR` : null;
  const drawing = costs.nearPerCredit > 0n
    ? `${nearText(costs.nearPerCredit * BigInt(EXAMPLE_TILES))} NEAR`
    : null;
  return { registration, tile, drawing };
}
