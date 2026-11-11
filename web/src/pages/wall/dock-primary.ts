/**
 * The dock's one primary action (Phase 1 step 1).
 *
 * Only one primary control is visible at a time. Its label and action come from
 * state the existing controllers already own: the wallet session, the chosen
 * colour, the credits line the pricing controller writes, whether Paint this tile
 * is hidden (a drawing key is armed, so a tap paints) and the draw-state phase.
 * Nothing here decides whether a paint may be sent; `#draw-button` keeps its own
 * disabled state and click handler in the paint controller.
 */

import type { WallScope } from "./wall-scope";

export type DockPrimaryKind = "connect" | "buy" | "pick-colour" | "armed" | "place";

export interface DockPrimaryInput {
  connected: boolean;
  /** Credits from the dock's figure; null when not known. */
  credits: number | null;
  colourChosen: boolean;
  /** Paint this tile is hidden because a tap on the wall paints directly. */
  armed: boolean;
  /** The draw-state phase (`UiPhase`), if any. */
  phase: string | null;
  /**
   * The last stroke cost more than the balance. Buying is the action that
   * unblocks it, so it takes the one primary slot (owner, 11 Nov).
   */
  shortfall?: boolean;
}

export interface DockPrimaryState {
  kind: DockPrimaryKind;
  /** Label for `#dock-primary`; for `place` the label of `#draw-button`. */
  label: string;
  /** `#dock-primary` is a status, not an action (pick a colour, armed). */
  disabled: boolean;
}

const IN_FLIGHT = new Set(["wallet_prompt", "submitted", "confirmation_delayed"]);

export function dockPrimaryState(input: DockPrimaryInput): DockPrimaryState {
  if (!input.connected) {
    return { kind: "connect", label: "Connect wallet to paint", disabled: false };
  }
  if (input.credits === 0) {
    return { kind: "buy", label: "Buy credits", disabled: false };
  }
  if (input.shortfall) {
    return { kind: "buy", label: "Buy more credits", disabled: false };
  }
  if (!input.colourChosen) {
    return { kind: "pick-colour", label: "Pick a colour", disabled: true };
  }
  if (input.armed) {
    return {
      kind: "armed",
      label: input.phase && IN_FLIGHT.has(input.phase) ? "Painting…" : "Tap or drag on the wall to paint",
      disabled: true,
    };
  }
  return {
    kind: "place",
    label: input.phase && IN_FLIGHT.has(input.phase) ? "Painting…" : "Paint this tile",
    disabled: false,
  };
}

/** The credits figure: "12", "0" → number; "—", "…", anything else → null. */
export function parseCreditsLine(text: string | null | undefined): number | null {
  const match = /^(\d+)$/.exec((text ?? "").trim());
  return match ? Number(match[1]) : null;
}

export interface DockPrimaryDeps {
  scope: WallScope;
  dock: HTMLElement;
  /** `.wall-action`: gets `data-primary` so CSS shows exactly one control. */
  actionRow: HTMLElement;
  primary: HTMLButtonElement;
  drawButton: HTMLButtonElement;
  creditsDock: HTMLElement;
  creditsBalance: HTMLElement;
  buyCreditsButton: HTMLButtonElement;
  drawState: HTMLElement;
  connected(): boolean;
  colourChosen(): boolean;
  connect(): void;
}

export interface DockPrimary {
  sync(): void;
  state(): DockPrimaryState;
  dispose(): void;
}

export function mountDockPrimary(deps: DockPrimaryDeps): DockPrimary {
  const { scope, dock, actionRow, primary, drawButton } = deps;
  let current: DockPrimaryState | null = null;

  function read(): DockPrimaryState {
    return dockPrimaryState({
      connected: deps.connected(),
      credits: deps.creditsDock.hidden ? null : parseCreditsLine(deps.creditsBalance.textContent),
      colourChosen: deps.colourChosen(),
      armed: drawButton.hidden,
      phase: deps.drawState.dataset.phase ?? null,
      shortfall: deps.creditsDock.dataset.shortfall === "true",
    });
  }

  function sync(): void {
    const next = read();
    if (
      current &&
      current.kind === next.kind &&
      current.label === next.label &&
      current.disabled === next.disabled
    ) {
      return;
    }
    current = next;
    actionRow.dataset.primary = next.kind;
    const usesDrawButton = next.kind === "place";
    primary.hidden = usesDrawButton;
    if (usesDrawButton) {
      drawButton.textContent = next.label;
    } else {
      primary.textContent = next.label;
      primary.disabled = next.disabled;
      primary.dataset.kind = next.kind;
    }
  }

  scope.listen(primary, "click", () => {
    const kind = current?.kind;
    if (kind === "connect") deps.connect();
    else if (kind === "buy") deps.buyCreditsButton.click();
  });

  // The controllers write the DOM; follow it instead of reaching into them.
  const observer = new MutationObserver(() => sync());
  observer.observe(dock, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "disabled", "data-phase", "data-shortfall", "aria-pressed"],
  });
  sync();

  return {
    sync,
    state: () => current ?? read(),
    dispose: () => observer.disconnect(),
  };
}
