// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { mountAgentsPage, type AgentsPageDeps } from "./agents-page";
import { agentPrompt, priceLines, type AgentsCosts } from "./agents";

const LIVE: AgentsCosts = {
  nearPerCredit: 2_500_000_000_000_000_000_000n,
  registrationFee: 10_000_000_000_000_000_000_000n,
  freeFirstPaints: 25,
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  vi.useRealTimers();
});

function ctx(): PageContext {
  return {
    services: {
      wallet: {
        getSession: () => ({ accountId: null, networkId: null }),
        connect: async () => {},
        disconnect: async () => {},
        subscribe: () => () => {},
        whenReady: Promise.resolve({ accountId: null, networkId: null }),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/agents"),
    navigate: () => {},
  };
}

async function mount(deps: Partial<AgentsPageDeps> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountAgentsPage(root, ctx(), {
    origin: "https://wall.example",
    configured: true,
    network: "mainnet",
    board: "board.example",
    issuesUrl: "https://github.com/satojandro/metapoo/issues",
    load: async () => LIVE,
    ...deps,
  });
  cleanup.push(() => {
    dispose();
    root.remove();
  });
  await new Promise((r) => setTimeout(r, 0));
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  return { root, q, dispose };
}

describe("agentPrompt", () => {
  it("tells the agent to do what the human asked, after reading the skill", () => {
    const text = agentPrompt("https://wall.example/");
    expect(text).toContain("https://wall.example/skill.md");
    expect(text).toContain("paint what I ask for");
    // The old wording asked the agent to invent its own subject and ignored the user.
    expect(text).not.toMatch(/paint something that answers/i);
    expect(text).toMatch(/before you spend/i);
  });
});

describe("priceLines", () => {
  it("quotes registration, one tile and the example drawing", () => {
    const lines = priceLines(LIVE);
    expect(lines.registration).toBe("0.01 NEAR");
    expect(lines.tile).toBe("0.0025 NEAR");
    expect(lines.drawing).toBe("0.1 NEAR");
  });

  it("returns nulls rather than zeros when the board did not answer", () => {
    const lines = priceLines({ nearPerCredit: 0n, registrationFee: 0n, freeFirstPaints: null });
    expect(lines).toEqual({ registration: null, tile: null, drawing: null });
  });
});

describe("mountAgentsPage", () => {
  it("copies exactly the text it shows", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { q } = await mount();
    const shown = q("#agents-prompt").textContent!;
    q<HTMLButtonElement>("[data-agents-copy]").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith(shown);
    expect(q("[data-agents-copy]").textContent).toBe("Copied");
  });

  it("shows live prices and the free allowance", async () => {
    const { q } = await mount();
    expect(q('[data-agents="registration"]').textContent).toBe("0.01 NEAR");
    expect(q('[data-agents="tile"]').textContent).toBe("0.0025 NEAR");
    expect(q('[data-agents="drawing"]').textContent).toBe("0.1 NEAR");
    expect(q('[data-agents="free"]').textContent).toBe("25 free");
    expect(q("[data-needs='tile']").hidden).toBe(false);
  });

  it("carries the beta warning, because the NEAR is real", async () => {
    const { root } = await mount();
    expect(root.textContent).toMatch(/mainnet testing round/i);
    expect(root.textContent).toMatch(/worth nothing/i);
  });

  it("hides prices it could not read instead of guessing", async () => {
    const { q } = await mount({ load: async () => ({ nearPerCredit: 0n, registrationFee: 0n, freeFirstPaints: null }) });
    expect(q("[data-needs='registration']").hidden).toBe(true);
    expect(q("[data-needs='tile']").hidden).toBe(true);
    expect(q("[data-needs='free']").hidden).toBe(true);
  });

  it("says so when the board cannot be reached at all", async () => {
    const { q } = await mount({ load: () => Promise.reject(new Error("rpc down")) });
    expect(q("[data-needs='tile']").hidden).toBe(true);
    expect(q("[data-agents-source]").textContent).toMatch(/unavailable/i);
  });

  it("removes itself on dispose", async () => {
    const { root, dispose } = await mount();
    expect(root.querySelector(".agents")).not.toBeNull();
    dispose();
    expect(root.querySelector(".agents")).toBeNull();
  });
});
