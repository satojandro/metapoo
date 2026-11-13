// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { EMPTY_SNAPSHOT } from "./how-it-works";
import { mountHowItWorksPage, type HowItWorksDeps } from "./how-it-works-page";
import { METEOR, VERIFIED_ON_DEVICE } from "./meteor-name-steps";

const HEX = `fcd66acf${"0".repeat(48)}3076f59e`;
let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; });

function ctx(accountId: string | null): PageContext {
  const session = { accountId, networkId: accountId ? "mainnet" : null };
  return {
    services: {
      wallet: {
        getSession: () => session, connect: async () => {}, disconnect: async () => {},
        subscribe: () => () => {}, whenReady: Promise.resolve(session),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/how-it-works"),
    navigate: () => {},
  } as unknown as PageContext;
}

async function mount(deps: Partial<HowItWorksDeps>, accountId: string | null = null) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountHowItWorksPage(root, ctx(accountId), {
    now: () => Date.UTC(2026, 10, 13, 12), configured: false, network: "mainnet", board: "board.near",
    reducedMotion: true, pollMs: 1e9, load: async () => EMPTY_SNAPSHOT, isPrivy: async () => false, ...deps,
  });
  cleanup.push(() => { dispose(); root.remove(); });
  await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
  const section = root.querySelector<HTMLElement>("#hiw-name");
  const type = (value: string) => {
    const input = section!.querySelector<HTMLInputElement>("[data-name-input]")!;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  const who = () => Array.from(section!.querySelectorAll("[data-name-who]")).map((n) => n.textContent);
  return { root, section, type, who };
}

describe("/how-it-works — Get a name", () => {
  it("flag off renders nothing: no section, and off is what the build ships", async () => {
    const off = await mount({ namesGuide: false }, HEX);
    expect(off.section).toBeNull();
    expect(off.root.textContent).not.toContain("Meteor");
    // No override: the page reads VITE_NAMES_GUIDE, which is unset.
    const byDefault = await mount({}, HEX);
    expect(byDefault.section).toBeNull();
  });

  it("flag on: the section sits after the stall, where #hiw-name lands", async () => {
    const { root, section } = await mount({ namesGuide: true });
    expect(section).not.toBeNull();
    expect(root.querySelector("#hiw-stall")!.nextElementSibling).toBe(section);
    expect(section!.querySelector("h3")!.textContent).toBe("Sign your work.");
  });

  it("previews the typed name where the hex id sits, in the tile card and the holders row", async () => {
    const { section, type, who } = await mount({ namesGuide: true }, HEX);
    // Before typing: the viewer's own id, short.
    expect(who()).toEqual(["fcd66acf…3076f59e", "fcd66acf…3076f59e"]);
    expect(section!.textContent).not.toContain(HEX);
    type("alice");
    expect(who()).toEqual(["alice.near", "alice.near"]);
    expect(section!.querySelector<HTMLElement>("[data-name-preview]")!.dataset.named).toBe("true");
    // A name NEAR would refuse leaves the hex id in place and says why.
    type("al ice");
    expect(who()).toEqual(["fcd66acf…3076f59e", "fcd66acf…3076f59e"]);
    expect(section!.querySelector("[data-name-hint]")!.textContent).toMatch(/lowercase letters and numbers/);
    expect(section!.querySelector("[data-name-input]")!.getAttribute("aria-invalid")).toBe("true");
  });

  it("uses the network's ending, and a sample id for a signed-out visitor", async () => {
    const { section, type, who } = await mount({ namesGuide: true, network: "testnet" });
    expect(who()[0]).toBe("3f9a1b2c…a5b6c21e");
    type("bob");
    expect(who()).toEqual(["bob.testnet", "bob.testnet"]);
    expect(section!.dataset.viewer).toBe("out");
  });

  it("says plainly that nothing moves, and what a Privy player can do", async () => {
    const { section } = await mount({ namesGuide: true, isPrivy: async () => true }, HEX);
    const honest = section!.querySelector(".hiw-name-honest")!.textContent!;
    expect(honest).toContain("a new account starts empty");
    expect(honest).toMatch(/Tiles you hold stay signed by the old id/);
    expect(honest).toMatch(/Credits you bought stay with the old account, and so does the TOILET/);
    expect(honest).toContain("That account can’t be given a name");
    expect(honest).toContain("Meteor wallet with a named account");
    expect(section!.dataset.viewer).toBe("privy");
    // The UI review's vocabulary: "tile" and "credit", never "cell" or "pixel".
    expect(section!.textContent).not.toMatch(/\b(cell|pixel)s?\b/i);
  });

  it("a named account is told it already has one", async () => {
    const { section } = await mount({ namesGuide: true }, "alice.near");
    const status = section!.querySelector<HTMLElement>("[data-name-status]")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("You already have one: alice.near. Nothing to do here.");
    expect(section!.dataset.viewer).toBe("named");
    const hex = await mount({ namesGuide: true }, HEX);
    expect(hex.section!.querySelector<HTMLElement>("[data-name-status]")!.hidden).toBe(true);
  });

  it("Meteor only: the steps come from the data file, with one way out", async () => {
    const { section } = await mount({ namesGuide: true });
    const steps = Array.from(section!.querySelectorAll("[data-name-steps] h5")).map((n) => n.textContent);
    expect(steps).toEqual(METEOR.steps.map((s) => s.title));
    const out = Array.from(section!.querySelectorAll<HTMLAnchorElement>("a[href^='http']"));
    expect(out.map((a) => a.href)).toEqual([`${METEOR.walletUrl}/`]);
    expect(section!.textContent).not.toMatch(/MyNearWallet|HOT Wallet|Ledger|Bitte/i);
  });

  it("unverified steps carry a draft notice and print no cost", async () => {
    // The shipped data file is a draft until the owner checks it on a device.
    expect(VERIFIED_ON_DEVICE).toBe(false);
    expect(METEOR.cost.verified).toBe(false);
    const draft = await mount({ namesGuide: true });
    expect(draft.section!.querySelector<HTMLElement>("[data-name-draft]")!.hidden).toBe(false);
    expect(draft.section!.querySelector<HTMLElement>("[data-name-cost]")!.hidden).toBe(true);
    expect(draft.section!.textContent).not.toContain(METEOR.cost.text);

    const checked = await mount({
      namesGuide: true,
      nameSteps: { guide: { ...METEOR, cost: { text: "It costs nothing.", verified: true } }, verified: true },
    });
    expect(checked.section!.querySelector<HTMLElement>("[data-name-draft]")!.hidden).toBe(true);
    expect(checked.section!.textContent).toContain("It costs nothing.");
  });
});
