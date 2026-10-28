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
  settle: (id: string, result: SubmitDrawResult) => void;
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
  submitted: "Submitted — awaiting wallet/chain confirmation",
  confirmed: "Confirmed on current cell",
  failed: "Failed — no confirmed placement",
  overwritten: "Overwritten — transaction executed; current cell owner differs",
  "confirmation-delayed": "Confirmation delayed — pending/uncertain; not retried",
};

/** Render only inside this wall mount; global page styling stays untouched. */
export function mountPlacementOutcomeLayer(host: HTMLElement, controller: PlacementOutcomeController): () => void {
  const layer = document.createElement("section");
  layer.dataset.placementOutcomes = "true";
  layer.setAttribute("aria-live", "polite");
  layer.setAttribute("aria-label", "Placement outcomes");
  Object.assign(layer.style, { position: "absolute", left: "8px", bottom: "8px", zIndex: "3", maxWidth: "min(30rem, calc(100% - 16px))", display: "grid", gap: "4px", pointerEvents: "none", fontSize: "12px", lineHeight: "1.25" });
  host.append(layer);
  const render = () => {
    layer.replaceChildren();
    for (const outcome of controller.list().slice(-4).reverse()) {
      const row = document.createElement("div");
      row.dataset.placementState = outcome.state;
      row.textContent = `(${outcome.x}, ${outcome.y}) ${labels[outcome.state]}`;
      Object.assign(row.style, { padding: "4px 6px", color: "#fff", background: outcome.state === "confirmed" ? "#176b3a" : outcome.state === "failed" ? "#8d2020" : outcome.state === "overwritten" ? "#75410d" : outcome.state === "confirmation-delayed" ? "#57407d" : "#334155", border: "1px solid rgba(255,255,255,.65)", borderRadius: "3px", boxShadow: "0 1px 2px rgba(0,0,0,.5)" });
      layer.append(row);
    }
  };
  const unsubscribe = controller.subscribe(render);
  render();
  return () => { unsubscribe(); layer.remove(); };
}
