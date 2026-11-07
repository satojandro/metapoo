import type { SubmitDrawResult } from "../../submit-draw";

/** A mount-local record; it only classifies submitDraw's returned outcome. */
export type PlacementOutcomeState =
  | "submitted"
  | "confirmed"
  | "failed"
  | "overwritten"
  | "confirmation-delayed";

export interface PlacementOutcome {
  id: string;
  x: number;
  y: number;
  colorIndex: number;
  state: PlacementOutcomeState;
  submittedAtMs: number;
  settledAtMs: number | null;
  detail: string | null;
}

export interface PlacementOutcomeController {
  submit: (placement: Pick<PlacementOutcome, "x" | "y" | "colorIndex">) => string;
  discard: (id: string) => void;
  /** Only the status and message are read, so a batched tap can settle without a per-cell read. */
  settle: (id: string, result: Pick<SubmitDrawResult, "status" | "message">) => void;
  list: () => readonly PlacementOutcome[];
  subscribe: (listener: () => void) => () => void;
}

export function createPlacementOutcomeController(options: { now?: () => number } = {}): PlacementOutcomeController {
  const now = options.now ?? Date.now;
  const outcomes = new Map<string, PlacementOutcome>();
  const listeners = new Set<() => void>();
  let sequence = 0;
  const notify = () => listeners.forEach((listener) => listener());

  return {
    submit(placement) {
      const id = `placement-${++sequence}`;
      outcomes.set(id, { ...placement, id, state: "submitted", submittedAtMs: now(), settledAtMs: null, detail: null });
      notify();
      return id;
    },
    discard(id) {
      if (outcomes.delete(id)) notify();
    },
    settle(id, result) {
      const outcome = outcomes.get(id);
      if (!outcome) return;
      const state: PlacementOutcomeState = result.status === "confirmed"
        ? "confirmed"
        : result.status === "overwritten"
          ? "overwritten"
          : result.status === "confirmation_delayed" || result.status === "pending"
            ? "confirmation-delayed"
            : "failed";
      outcomes.set(id, { ...outcome, state, settledAtMs: now(), detail: result.message });
      notify();
    },
    list: () => [...outcomes.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const labels: Record<PlacementOutcomeState, string> = {
  submitted: "Sending…",
  confirmed: "Painted",
  failed: "Didn’t paint",
  overwritten: "Painted over since",
  "confirmation-delayed": "Confirmation delayed",
};

/** Render only inside this wall mount; global page styling stays untouched. */
export function mountPlacementOutcomeLayer(host: HTMLElement, controller: PlacementOutcomeController): () => void {
  const layer = document.createElement("section");
  layer.dataset.placementOutcomes = "true";
  layer.setAttribute("aria-live", "polite");
  layer.setAttribute("aria-label", "Placement outcomes");
  // Styled by wall-page.css: small pills over the wall, where the paint landed
  // in attention terms. Confirmed ones fade; problems stay until replaced.
  layer.className = "placement-outcomes";
  host.append(layer);
  const render = () => {
    layer.replaceChildren();
    for (const outcome of controller.list().slice(-4).reverse()) {
      const row = document.createElement("div");
      row.dataset.placementState = outcome.state;
      row.className = "placement-outcome";
      row.textContent = `${labels[outcome.state]} · ${outcome.x}, ${outcome.y}`;
      layer.append(row);
    }
  };
  const unsubscribe = controller.subscribe(render);
  render();
  return () => { unsubscribe(); layer.remove(); };
}
