// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { mountAgentsPage, type AgentsPageDeps } from "./agents-page";
import { agentPrompts, PROMPT_BUDGET_NEAR, priceLines, type AgentsCosts } from "./agents";

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

describe("agentPrompts", () => {
  const prompts = agentPrompts("https://wall.example/");

  it("offers three prompts, each pointing at the skill", () => {
    expect(prompts.map((p) => p.id)).toEqual(["invader", "name", "look"]);
    for (const p of prompts) expect(p.text).toContain("https://wall.example/skill.md");
  });

  it("puts a budget and an ask-first line in every prompt that paints", () => {
    for (const p of prompts.filter((x) => x.id !== "look")) {
      expect(p.text).toContain(`at most ${PROMPT_BUDGET_NEAR} NEAR`);
      expect(p.text).toMatch(/plan and the cost before you spend/i);
    }
  });

  it("has one prompt that only looks and spends nothing", () => {
    const look = prompts.find((p) => p.id === "look")!;
    expect(look.text).toMatch(/do not paint/i);
    expect(look.text).not.toMatch(/NEAR\./);
    expect(look.label).toMatch(/free/i);
  });

  it("leaves an obvious placeholder in the name prompt", () => {
    expect(prompts.find((p) => p.id === "name")!.text).toContain("YOUR NAME");
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
  it("renders three prompts, each with its own Copy button", async () => {
    const { root } = await mount();
    expect(root.querySelectorAll(".agents-prompt-item")).toHaveLength(3);
    expect(root.querySelectorAll("[data-agents-copy]")).toHaveLength(3);
  });

  it("copies exactly the text of the prompt whose button was pressed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { q } = await mount();
    const shown = q("#agents-prompt-look").textContent!;
    q<HTMLButtonElement>('[data-agents-copy="look"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(shown);
    expect(q('[data-agents-copy="look"]').textContent).toBe("Copied");
    expect(q('[data-agents-copy="invader"]').textContent).toBe("Copy");
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
