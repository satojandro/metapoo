/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import type { SubmitDrawResult } from "../../submit-draw";
import {
  createPlacementOutcomeController,
  mountPlacementOutcomeLayer,
  type PlacementOutcomeState,
} from "./placement-outcome";

const placement = { x: 8, y: 12, colorIndex: 3 };
function result(status: SubmitDrawResult["status"]): SubmitDrawResult {
  const pixel = {
    x: 8,
    y: 12,
    colorIndex: 3,
    artistAccountId: "alice.testnet",
    lastWriteTimestampNs: "1",
  };
  if (status === "confirmed" || status === "overwritten") {
    return {
      status,
      title: status,
      message: `${status} result`,
      transactionId: "tx-1",
      explorerUrl: null,
      pixel,
      observedBlockHeight: 7,
    };
  }
  if (status === "confirmation_delayed") {
    return {
      status,
      title: status,
      message: "read error; do not retry",
      transactionId: "tx-1",
      explorerUrl: null,
      pixel: null,
      observedBlockHeight: null,
    };
  }
  if (status === "pending") {
    return {
      status,
      title: status,
      message: "still pending",
      transactionId: "tx-1",
      explorerUrl: null,
      pixel: null,
    };
  }
  if (status === "rejected") {
    return {
      status,
      title: status,
      message: "not sent",
      transactionId: null,
      explorerUrl: null,
      pixel: null,
    };
  }
  return {
    status,
    title: status,
    message: "observed failure",
    transactionId: null,
    explorerUrl: null,
    pixel: null,
  };
}
describe("placement outcome controller", () => {
  it("records a matching cell as confirmed", () => { const c = createPlacementOutcomeController({ now: () => 100 }); const id = c.submit(placement); c.settle(id, result("confirmed")); expect(c.list()[0]).toMatchObject({ state: "confirmed", submittedAtMs: 100, settledAtMs: 100 }); });
  it("records wallet success with a non-matching current cell as overwritten, not failed", () => { const c = createPlacementOutcomeController(); const id = c.submit(placement); c.settle(id, result("overwritten")); expect(c.list()[0]?.state).toBe("overwritten"); });
  it("records an observed transaction failure as failed", () => { const c = createPlacementOutcomeController(); const id = c.submit(placement); c.settle(id, result("failed")); expect(c.list()[0]?.state).toBe("failed"); });
  it("keeps a read error uncertain and never invokes another submit", () => { const c = createPlacementOutcomeController(); const id = c.submit(placement); c.settle(id, result("confirmation_delayed")); expect(c.list()[0]).toMatchObject({ state: "confirmation-delayed", detail: "read error; do not retry" }); expect(c.list()).toHaveLength(1); });
  it("treats pending and confirmation_delayed as unresolved and overwritten as distinct from failed", () => {
    const expected: Record<SubmitDrawResult["status"], PlacementOutcomeState> = {
      pending: "confirmation-delayed",
      confirmation_delayed: "confirmation-delayed",
      overwritten: "overwritten",
      confirmed: "confirmed",
      failed: "failed",
      rejected: "failed",
    };
    for (const status of Object.keys(expected) as Array<SubmitDrawResult["status"]>) {
      const c = createPlacementOutcomeController();
      const id = c.submit(placement);
      c.settle(id, result(status));
      expect(c.list()[0]?.state, status).toBe(expected[status]);
    }
  });
});

/** A failure claim names the transaction itself as failed. Avoid the word even in a negation. */
function claimsFailedTransaction(text: string): boolean {
  return /\b(fail(?:ed|ure|s)?|unsuccessful)\b/i.test(text);
}

describe("placement outcome rendered wording", () => {
  const rendered: Record<PlacementOutcomeState, RegExp[]> = {
    submitted: [/awaiting/i],
    confirmed: [/\bexecuted\b/i],
    overwritten: [/\bexecuted\b/i, /current cell owner now differs/i],
    "confirmation-delayed": [/unresolved/i, /not-retried/i, /will not be auto-resubmitted/i],
    failed: [/\bfailed\b/i, /did not execute/i],
  };

  it("uses distinguishing wording for each outcome and never calls overwritten or confirmation-delayed a failure", () => {
    for (const state of Object.keys(rendered) as PlacementOutcomeState[]) {
      const host = document.createElement("div");
      const controller = createPlacementOutcomeController({ now: () => 5 });
      const unmount = mountPlacementOutcomeLayer(host, controller);
      const id = controller.submit({ x: 2, y: 4, colorIndex: 1 });
      if (state !== "submitted") {
        const status: SubmitDrawResult["status"] =
          state === "confirmation-delayed" ? "confirmation_delayed" : state;
        controller.settle(id, result(status));
      }
      const row = host.querySelector("[data-placement-state]");
      const text = row?.textContent ?? "";
      expect(row?.getAttribute("data-placement-state"), state).toBe(state);
      for (const pattern of rendered[state]) {
        expect(text, state).toMatch(pattern);
      }
      if (state === "overwritten" || state === "confirmation-delayed") {
        expect(claimsFailedTransaction(text), text).toBe(false);
      }
      unmount();
    }
  });

  it("renders a pending settle with the unresolved label, not a failure", () => {
    const host = document.createElement("div");
    const controller = createPlacementOutcomeController();
    mountPlacementOutcomeLayer(host, controller);
    const id = controller.submit(placement);
    controller.settle(id, result("pending"));
    const text = host.querySelector("[data-placement-state]")?.textContent ?? "";
    expect(host.querySelector("[data-placement-state]")?.getAttribute("data-placement-state")).toBe(
      "confirmation-delayed",
    );
    expect(text).toMatch(/unresolved/i);
    expect(text).toMatch(/not-retried/i);
    expect(claimsFailedTransaction(text)).toBe(false);
  });
});
