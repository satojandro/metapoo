// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSelfCustodyPanel, shortCustodyKey } from "./self-custody-panel";
import { privyPublicKey } from "../integrations/privy/self-custody";

const ACCOUNT = "a".repeat(64);
const OWN_KEY = privyPublicKey(ACCOUNT);
const MY_KEY = "ed25519:3sF9abcdefghijklmnopqrstuvwxyzABCDEFGHkQ2";
const PAINT_KEY = "ed25519:9zYqabcdefghijklmnopqrstuvwxyzABCDEFGHkZ7";

type Key = { key: string; permission: unknown };
const state = vi.hoisted(() => ({
  keys: [] as { key: string; permission: unknown }[],
  sign: vi.fn(async () => ({ confirmed: true })),
  connected: true,
}));

vi.mock("../config", () => ({ CONTRACT_ID: "game.near", RPC_URL: "https://rpc.example" }));
vi.mock("../wallet", () => ({
  getAcquisitionContext: (operationId: string) =>
    state.connected ? { operationId, accountId: "a".repeat(64), networkId: "mainnet", sessionEpoch: 1 } : null,
  isConnectedPrivyWallet: async () => state.connected,
  signAndSendSelfCustodyKey: state.sign,
}));
vi.mock("../integrations/rpc", () => ({
  createAcquisitionRpc: () => async (method: string, params: { request_type?: string }) => {
    if (method !== "query") throw new Error(`unexpected rpc method ${method}`);
    if (params.request_type !== "view_access_key_list") throw new Error("unexpected query");
    return { keys: state.keys.map(({ key, permission }) => ({ public_key: key, access_key: { permission } })) };
  },
}));

const fullAccess = (key: string): Key => ({ key, permission: "FullAccess" });
const paintAccess = (key: string): Key => ({ key, permission: { FunctionCall: { receiver_id: "game.near", method_names: ["draw"], allowance: null } } });
const otherAccess = (key: string): Key => ({ key, permission: { FunctionCall: { receiver_id: "elsewhere.near", method_names: [], allowance: null } } });

function mount() {
  const host = document.createElement("section");
  document.body.append(host);
  const dispose = mountSelfCustodyPanel(host);
  return { host, dispose };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-key-row]")];

beforeEach(() => {
  state.keys = [fullAccess(OWN_KEY), fullAccess(MY_KEY)];
  state.connected = true;
  state.sign.mockClear();
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("the key list", () => {
  it("renders a full-access key as a name, an access fact and a shortened key", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      const [privy, mine] = rows(host);
      expect(privy.querySelector("dt")?.textContent).toBe("Privy (your sign-in)");
      expect(privy.querySelector('[data-key-value]')?.textContent).toBe(shortCustodyKey(OWN_KEY));
      expect(mine.querySelector("dt")?.textContent).toBe("Your key");
      expect([...mine.querySelectorAll("dd")].map(dd => dd.textContent)).toContain("Full access");
      // The whole key is available as a tooltip and to assistive tech, never as row text.
      const value = mine.querySelector<HTMLElement>('[data-key-value]')!;
      expect(value.title).toBe(MY_KEY);
      expect(value.getAttribute("aria-label")).toBe(MY_KEY);
      expect(mine.querySelector("dt")?.getAttribute("title")).toBeNull();
      expect(mine.textContent).not.toContain(MY_KEY);
      expect(value.textContent).toBe(`${MY_KEY.slice(0, 10)}…${MY_KEY.slice(-6)}`);
      expect(value.textContent).not.toBe(MY_KEY);
    } finally { dispose(); }
  });

  it("names a limited key by what it can actually do", async () => {
    state.keys = [fullAccess(OWN_KEY), paintAccess(PAINT_KEY), otherAccess(MY_KEY)];
    const { host, dispose } = mount();
    try {
      await tick();
      const [, painting, other] = rows(host);
      expect(painting.querySelector("dt")?.textContent).toBe("Drawing key");
      expect(painting.textContent).toContain("Limited access — can paint here and spend your credits");
      expect(other.querySelector("dt")?.textContent).toBe("Other limited key");
      expect(other.textContent).toContain("Limited access — one contract only");
      // A limited key is not removable from this panel.
      expect(other.querySelector("[data-remove]")).toBeNull();
    } finally { dispose(); }
  });

  it("offers removal only for a full-access key that is not Privy's", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      const [privy, mine] = rows(host);
      expect(privy.querySelector("[data-remove]")).toBeNull();
      expect(mine.querySelector("[data-remove]")?.textContent).toBe("Remove this key");
    } finally { dispose(); }
  });
});

describe("removing a key", () => {
  it("asks in the panel, not through window.confirm, and signs nothing on the first press", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { host, dispose } = mount();
    try {
      await tick();
      const row = rows(host)[1];
      row.querySelector<HTMLButtonElement>("[data-remove]")!.click();
      await tick();
      expect(confirm).not.toHaveBeenCalled();
      expect(state.sign).not.toHaveBeenCalled();
      const question = row.querySelector("[data-confirm] p")?.textContent ?? "";
      expect(question).toContain("Privy keeps its sign-in key");
      expect(row.querySelector("[data-confirm-remove]")?.textContent).toBe("Remove key");
      expect(row.querySelector("[data-keep]")?.textContent).toBe("Keep it");
      // Keyboard focus lands on the button that would act.
      expect(document.activeElement).toBe(row.querySelector("[data-confirm-remove]"));
    } finally { dispose(); }
  });

  it("signs the removal when the confirm button is pressed", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      const row = rows(host)[1];
      row.querySelector<HTMLButtonElement>("[data-remove]")!.click();
      await tick();
      row.querySelector<HTMLButtonElement>("[data-confirm-remove]")!.click();
      await tick();
      expect(state.sign).toHaveBeenCalledTimes(1);
      const [, key, kind] = state.sign.mock.calls[0] as unknown as [unknown, string, string];
      expect(key).toBe(MY_KEY);
      expect(kind).toBe("remove-own-key");
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Key removed on chain.");
    } finally { dispose(); }
  });

  it("restores the row and signs nothing when asked to keep it", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      const row = rows(host)[1];
      row.querySelector<HTMLButtonElement>("[data-remove]")!.click();
      await tick();
      row.querySelector<HTMLButtonElement>("[data-keep]")!.click();
      await tick();
      expect(state.sign).not.toHaveBeenCalled();
      expect(row.querySelector("[data-confirm]")).toBeNull();
      expect(row.querySelector("[data-remove]")?.textContent).toBe("Remove this key");
      expect(document.activeElement).toBe(row.querySelector("[data-remove]"));
    } finally { dispose(); }
  });
});

describe("adding a key", () => {
  it("numbers the steps instead of running them together in one sentence", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      const steps = [...host.querySelectorAll("ol.mp-custody-steps > li")].map(li => li.textContent);
      expect(steps).toEqual([
        "Create a key in a wallet you control",
        "Paste its public key here — never a private key or recovery phrase",
        "Approve the change in your wallet",
      ]);
      expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("ed25519:…");
    } finally { dispose(); }
  });

  it("clears invalid pasted input and never echoes it back", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      const input = host.querySelector("input")!;
      const pasted = "d".repeat(64); // the shape of a private key
      input.value = pasted;
      host.querySelector<HTMLButtonElement>("[data-add]")!.click();
      await tick();
      expect(state.sign).not.toHaveBeenCalled();
      expect(input.value).toBe("");
      const status = host.querySelector('[role="status"]')?.textContent ?? "";
      expect(status).toContain("private key");
      expect(status).not.toContain(pasted);
      expect(host.textContent).not.toContain(pasted);
    } finally { dispose(); }
  });

  it("refreshes the list after a confirmed removal, keeping the result line", async () => {
    const { host, dispose } = mount();
    try {
      await tick();
      host.querySelector<HTMLButtonElement>("[data-remove]")!.click();
      expect(host.querySelector("[data-confirm-remove]")).not.toBeNull();
      // The chain now reports the key gone, which is what refresh() must show.
      state.keys = [fullAccess(OWN_KEY)];
      host.querySelector<HTMLButtonElement>("[data-confirm-remove]")!.click();
      await vi.waitFor(() => expect(state.sign).toHaveBeenCalled());
      await vi.waitFor(() => expect(host.querySelector("[data-confirm-remove]")).toBeNull());
      await vi.waitFor(() => expect(rows(host)).toHaveLength(1));
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Key removed on chain.");
    } finally { dispose(); }
  });

  it("ships the destructive style unopposed by the send sheet's rules", async () => {
    const { readFileSync } = await import("node:fs");
    const send = readFileSync("src/app/send-sheet.css", "utf8");
    const custody = readFileSync("src/app/self-custody.css", "utf8");
    // The shared rule that beat .mp-custody-danger on specificity is gone...
    expect(send).not.toContain(".mp-custody button");
    // ...and the destructive rule now lives at equal-or-higher specificity.
    expect(custody).toContain(".mp-custody .mp-custody-danger");
    expect(custody).toContain("var(--mp-bad)");
  });
});
