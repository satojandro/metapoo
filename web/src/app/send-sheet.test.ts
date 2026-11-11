// @vitest-environment happy-dom
/**
 * The Send sheet reads as a payment: a balance beside the asset, Max inside the amount
 * field, a review of labelled lines, and a Close button in the panel's own header.
 * Every safety behaviour (re-plan guard, no automatic retry) is asserted here too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendPlan } from "../integrations/send/controller";
import type { OperationContext } from "../integrations/types";

const planSend = vi.fn();
const submitSend = vi.fn();
const reconcile = vi.fn(async (_context: OperationContext) => true);
// The marker lives in storage in the real app; happy-dom here has no localStorage, so the
// probe is a state flag and the sheet still cannot read the key format itself.
const pendingState = vi.hoisted(() => ({ has: false }));

vi.mock("../integrations/send/controller", () => ({
  planSend: (...args: unknown[]) => planSend(...args),
  submitSend: (...args: unknown[]) => submitSend(...args),
}));

vi.mock("../integrations/send/config", () => ({
  SEND_POLICY: {
    enabled: true,
    tokens: [{ contractId: "toilet.testnet", symbol: "TOILET", decimals: 18 }],
    blockedRecipients: [],
    storageMinimums: {},
  },
}));

vi.mock("../wallet", () => ({
  getAcquisitionContext: (operationId: string): OperationContext => ({
    operationId,
    accountId: "alice.testnet",
    networkId: "testnet",
    sessionEpoch: 1,
  }),
  reconcilePendingAcquisition: (context: OperationContext) => reconcile(context),
  hasPendingAcquisition: () => pendingState.has,
}));

import { mountSendSheet } from "./send-sheet";

const context: OperationContext = {
  operationId: "op",
  accountId: "alice.testnet",
  networkId: "testnet",
  sessionEpoch: 1,
};

function plan(overrides: Partial<SendPlan> = {}): SendPlan {
  const base: SendPlan = {
    request: {
      context,
      purpose: "send",
      transactions: [
        {
          receiverId: "bob.testnet",
          actions: [{ type: "Transfer", params: { deposit: "1000000000000000000000000" } }],
        },
      ],
      approval: {
        summary: "Send 1 NEAR",
        maxNativeSpendYocto: "30000000000000000000000",
        expiresAtMs: Date.now() + 120000,
      },
    },
    recipient: "bob.testnet",
    symbol: "NEAR",
    decimals: 24,
    amount: "1000000000000000000000000",
    maximum: "1065400000000000000000000",
    registration: "0",
    gas: "2100000000000000000000",
  };
  return { ...base, ...overrides };
}

function tokenPlan(overrides: Partial<SendPlan> = {}): SendPlan {
  return plan({
    symbol: "TOILET",
    decimals: 18,
    amount: "1500000000000000000",
    maximum: "4200000000000000000",
    registration: "1250000000000000000000",
    tokenBalance: "4200000000000000000",
    request: {
      context,
      purpose: "send",
      transactions: [
        {
          receiverId: "toilet.testnet",
          actions: [
            {
              type: "FunctionCall",
              params: { methodName: "ft_transfer", args: { receiver_id: "bob.testnet", amount: "1500000000000000000" }, gas: "30000000000000", deposit: "1" },
            },
          ],
        },
      ],
      approval: {
        summary: "Send 1.5 TOILET",
        maxNativeSpendYocto: "5000000000000000000000",
        expiresAtMs: Date.now() + 120000,
      },
    },
    ...overrides,
  });
}

let mounted: (() => void) | undefined;

function mount(onClose?: () => void) {
  const host = document.createElement("section");
  document.body.append(host);
  const refresh = vi.fn();
  mounted = mountSendSheet(host, refresh, onClose);
  return { host, refresh, form: host.querySelector("form")! };
}

function fill(form: HTMLFormElement, name: string, value: string) {
  const input = form.elements.namedItem(name) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function review(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

afterEach(() => {
  pendingState.has = false;
  mounted?.();
  mounted = undefined;
  document.body.replaceChildren();
  planSend.mockReset();
  submitSend.mockReset();
  reconcile.mockClear();
});

describe("Send sheet — a payment, not a developer form", () => {
  it("shows the balance beside the asset once a plan resolves", async () => {
    planSend.mockResolvedValue(plan());
    const { host, form } = mount();
    const balance = host.querySelector<HTMLElement>("[data-balance]")!;
    expect(balance.textContent).toBe("");

    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);

    await vi.waitFor(() => expect(balance.textContent).toBe("NEAR · 1.0654 available"));
    // The reading sits in the asset row, next to the selector.
    expect(balance.closest(".mp-send-asset")).not.toBeNull();
  });

  it("cuts the balance to four decimals instead of rounding it up", async () => {
    planSend.mockResolvedValue(plan({ maximum: "1065499999999999999999999" }));
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-balance]")!.textContent).toBe("NEAR · 1.0654 available"));
  });

  it("Max fills the amount from the plan maximum and never submits", async () => {
    planSend.mockResolvedValue(plan());
    const { host, form } = mount();
    const amount = form.elements.namedItem("amount") as HTMLInputElement;
    expect(amount.value).toBe("");

    host.querySelector<HTMLButtonElement>("[data-max]")!.click();

    await vi.waitFor(() => expect(amount.value).toBe("1.0654"));
    expect(planSend).toHaveBeenCalledWith(expect.anything(), "NEAR", "", "MAX");
    expect(submitSend).not.toHaveBeenCalled();
  });

  it("renders one labelled row per fact, never a single run-on sentence", async () => {
    planSend.mockResolvedValue(tokenPlan());
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1.5");
    review(form);

    await vi.waitFor(() => expect(host.querySelector("dl.mp-send-lines")).not.toBeNull());
    const lines = host.querySelector<HTMLElement>("dl.mp-send-lines")!;
    const labels = [...lines.querySelectorAll("dt")].map(dt => dt.textContent);
    const values = [...lines.querySelectorAll("dd")].map(dd => dd.textContent);
    expect(labels).toEqual(["You send", "To", "Network fee, at most", "Recipient setup", "Total"]);
    expect(values[0]).toBe("1.5 TOILET");
    expect(values[1]).toBe("bob.testnet");
    expect(values[2]).toBe("0.0021 NEAR");
    expect(values[3]).toBe("0.00125 NEAR");
    // Registration is priced in NEAR: never added to a token amount as if units matched.
    expect(values[4]).toBe("1.5 TOILET + 0.00125 NEAR setup, plus a small network fee");
    expect(host.querySelector("[data-review]")!.textContent).not.toMatch(/Network fee ceiling:|Recipient registration:/);
  });

  it("omits Recipient setup and totals NEAR in NEAR for a NEAR send", async () => {
    planSend.mockResolvedValue(plan());
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);

    await vi.waitFor(() => expect(host.querySelector("dl.mp-send-lines")).not.toBeNull());
    const labels = [...host.querySelectorAll("dl.mp-send-lines dt")].map(dt => dt.textContent);
    const values = [...host.querySelectorAll("dl.mp-send-lines dd")].map(dd => dd.textContent);
    expect(labels).toEqual(["You send", "To", "Network fee, at most", "Total"]);
    expect(values.at(-1)).toBe("1 NEAR");
  });

  it("keeps the 0.01 NEAR reserve note and the undo warning", async () => {
    planSend.mockResolvedValue(plan());
    const { host, form } = mount();
    expect(host.textContent).toContain("Keeps 0.01 NEAR for future network fees.");
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-review] button")).not.toBeNull());
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Transfers can't be undone. Double-check the recipient.");
  });

  it("hides Check pending transfer until an outcome is unknown", async () => {
    planSend.mockResolvedValue(plan());
    submitSend.mockResolvedValue({ status: "unknown" });
    const { host, form } = mount();
    const pending = host.querySelector<HTMLButtonElement>("[data-reconcile]")!;
    expect(pending.hidden).toBe(true);

    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-review] button")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-review] button")!.click();

    await vi.waitFor(() => expect(pending.hidden).toBe(false));
    expect(pending.textContent).toBe("Check pending transfer");
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Check pending transfer before trying again.");
  });

  it("keeps Check pending transfer hidden after a confirmed transfer", async () => {
    planSend.mockResolvedValue(plan());
    submitSend.mockResolvedValue({ status: "confirmed", transactionHash: "abc123" });
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-review] button")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-review] button")!.click();

    await vi.waitFor(() => expect(host.querySelector('[role="status"]')!.textContent).toContain("Sent. The transfer is confirmed."));
    expect(host.querySelector<HTMLButtonElement>("[data-reconcile]")!.hidden).toBe(true);
    // The transaction link survives.
    expect(host.querySelector<HTMLAnchorElement>('[role="status"] a')!.href).toBe("https://testnet.nearblocks.io/txns/abc123");
  });

  it("shows no invented balance when the plan cannot be built, and leaves Review usable", async () => {
    planSend.mockRejectedValue(new Error("Balance unavailable — retry."));
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);

    await vi.waitFor(() => expect(host.querySelector('[role="status"]')!.textContent).toBe("Balance unavailable — retry."));
    expect(host.querySelector("[data-balance]")!.textContent).toBe("");
    expect(host.querySelector<HTMLButtonElement>(".mp-send-submit")!.disabled).toBe(false);
  });

  it("offers the reconcile path once it is shown", async () => {
    planSend.mockResolvedValue(plan());
    submitSend.mockResolvedValue({ status: "unknown" });
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-review] button")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-review] button")!.click();
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>("[data-reconcile]")!.hidden).toBe(false));

    host.querySelector<HTMLButtonElement>("[data-reconcile]")!.click();

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("No unresolved broadcast remains. Refresh balances before a new send.");
  });

  it("puts a Close button inside the panel header and unmounts through it", async () => {
    const { host } = mount();
    const close = host.querySelector<HTMLButtonElement>(".mp-send-header [data-close]")!;
    expect(close).not.toBeNull();
    expect(close.textContent).toBe("Close");
    expect(close.closest(".mp-send-header")).not.toBeNull();
    let disposed: () => void = () => undefined;
    const local = document.createElement("section");
    document.body.append(local);
    disposed = mountSendSheet(local, vi.fn(), () => disposed());
    local.querySelector<HTMLButtonElement>("[data-close]")!.click();
    expect(local.querySelector("form")).toBeNull();
  });

  it("still refuses a transfer whose re-planned transaction changed", async () => {
    const first = plan();
    const changed = plan({
      request: {
        ...first.request,
        transactions: [
          { receiverId: "bob.testnet", actions: [{ type: "Transfer", params: { deposit: "900000000000000000000000" } }] },
        ],
      },
    });
    planSend.mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-review] button")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-review] button")!.click();

    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')!.textContent).toBe("Balance or fees changed. Review again."),
    );
    expect(submitSend).not.toHaveBeenCalled();
  });

  it("refuses when a re-plan raises the fee ceiling", async () => {
    const first = plan();
    planSend.mockResolvedValueOnce(first).mockResolvedValueOnce(
      plan({ request: { ...first.request, approval: { ...first.request.approval, maxNativeSpendYocto: "30000000000000000000001" } } }),
    );
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1");
    review(form);
    await vi.waitFor(() => expect(host.querySelector("[data-review] button")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-review] button")!.click();

    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')!.textContent).toBe("Balance or fees changed. Review again."),
    );
    expect(submitSend).not.toHaveBeenCalled();
  });

  it("totals a token send with its NEAR setup instead of dropping the row above it", async () => {
    planSend.mockResolvedValue(tokenPlan());
    const { form } = mount();
    fill(form, "recipient", "bob.testnet");
    fill(form, "amount", "1.5");
    review(form);
    await vi.waitFor(() => expect(form.querySelector(".mp-send-lines")).not.toBeNull());
    const total = [...form.querySelectorAll(".mp-send-lines div")].find(
      (row) => row.querySelector("dt")?.textContent === "Total",
    );
    expect(total?.querySelector("dd")?.textContent).toBe(
      "1.5 TOILET + 0.00125 NEAR setup, plus a small network fee",
    );
  });

  it("shows the reconcile control on mount when the account has an unresolved transfer", () => {
    pendingState.has = true;
    const first = mount();
    expect(first.host.querySelector<HTMLButtonElement>("[data-reconcile]")!.hidden).toBe(false);
    mounted?.();
    mounted = undefined;
    // Closing the dialog unmounts the sheet; reopening it must still offer the control.
    const second = mount();
    expect(second.host.querySelector<HTMLButtonElement>("[data-reconcile]")!.hidden).toBe(false);
    pendingState.has = false;
  });

  it("hides the reconcile control once the marker is gone", async () => {
    pendingState.has = true;
    planSend.mockResolvedValue(plan());
    const { host, form } = mount();
    const pending = host.querySelector<HTMLButtonElement>("[data-reconcile]")!;
    expect(pending.hidden).toBe(false);
    pendingState.has = false;
    form.querySelector<HTMLButtonElement>("[data-max]")!.click();
    await vi.waitFor(() => expect(pending.hidden).toBe(true));
  });

  it("keeps Close usable while a read or a wallet prompt is in flight", async () => {
    let release: (value: SendPlan) => void = () => {};
    planSend.mockImplementation(() => new Promise<SendPlan>((resolve) => { release = resolve; }));
    const { host, form } = mount();
    fill(form, "recipient", "bob.testnet");
    form.querySelector<HTMLButtonElement>("[data-max]")!.click();
    await vi.waitFor(() => expect(form.querySelector<HTMLButtonElement>("[data-max]")!.disabled).toBe(true));
    expect(host.querySelector<HTMLButtonElement>("[data-close]")!.disabled).toBe(false);
    release(plan());
    await vi.waitFor(() => expect(form.querySelector<HTMLButtonElement>("[data-max]")!.disabled).toBe(false));
  });
});
