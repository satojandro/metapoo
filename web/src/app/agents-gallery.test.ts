// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { mountAgentsPage, type AgentsPageDeps } from "./agents-page";
import { agentPieceProblem, parseAgentGallery, PROMPT_MAX_CHARS, type AgentPiece } from "./agents-gallery";
import { hallEntryProblem } from "./hall";
import { stillEntryProblem } from "./wall-still";

const HEX_ID = "2db3956c9f6a4b1e8d7c5a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6afea0b0";

/** A test fixture. Not a real piece: the shipped gallery is empty until someone sends one. */
const piece = (over: Partial<AgentPiece> = {}): AgentPiece => ({
  id: "test-piece",
  title: "Test piece",
  date: "2026-11-12",
  block: 224100000,
  painters: [HEX_ID],
  x: 12,
  y: 20,
  zoom: 12,
  image: "/agents-gallery/test-piece.png",
  prompt: "Read https://wall.example/skill.md, then draw a small invader.\nSpend at most 0.1 NEAR.",
  ...over,
});

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
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

async function mount(gallery: AgentPiece[], deps: Partial<AgentsPageDeps> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountAgentsPage(root, ctx(), {
    origin: "https://wall.example",
    configured: true,
    network: "mainnet",
    board: "board.example",
    issuesUrl: "https://github.com/satojandro/metapoo/issues",
    load: async () => ({ nearPerCredit: 0n, registrationFee: 0n, freeFirstPaints: null }),
    gallery,
    ...deps,
  });
  cleanup.push(() => {
    dispose();
    root.remove();
  });
  await new Promise((r) => setTimeout(r, 0));
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  return { root, q };
}

describe("agents-gallery.json", () => {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "agents-gallery.json"), "utf8")) as unknown[];

  it("ships only usable entries, each with its still in web/public", () => {
    expect(Array.isArray(raw)).toBe(true);
    for (const item of raw) expect(agentPieceProblem(item)).toBeNull();
    for (const item of raw as AgentPiece[]) {
      expect(() => readFileSync(resolve(__dirname, "../../public", item.image.slice(1)))).not.toThrow();
    }
  });
});

describe("agentPieceProblem", () => {
  it("accepts a complete entry", () => {
    expect(agentPieceProblem(piece())).toBeNull();
  });

  it("rejects an entry with no prompt, an empty one, or the snapshot tool's TODO", () => {
    const { prompt: _prompt, ...noPrompt } = piece();
    expect(agentPieceProblem(noPrompt)).toMatch(/prompt/);
    expect(agentPieceProblem(piece({ prompt: "   " }))).toMatch(/prompt/);
    expect(agentPieceProblem(piece({ prompt: "TODO" }))).toMatch(/prompt/);
    expect(agentPieceProblem({ ...piece(), prompt: 42 })).toMatch(/prompt/);
    expect(agentPieceProblem(piece({ prompt: "x".repeat(PROMPT_MAX_CHARS + 1) }))).toMatch(/longer/);
  });

  it("rejects what the Hall rejects, through the same check", () => {
    expect(agentPieceProblem(piece({ title: "TODO" }))).toMatch(/title/);
    expect(agentPieceProblem(piece({ painters: ["TODO"] }))).toMatch(/painter/);
    expect(agentPieceProblem(piece({ x: 200 }))).toMatch(/x/);
    expect(agentPieceProblem(piece({ date: "12 Nov" }))).toMatch(/date/);
    // One implementation: the Hall's verdict on the shared fields is the gallery's.
    const hallShaped = { ...piece(), image: "/hall/test-piece.png", x: -1 };
    expect(hallEntryProblem(hallShaped)).toBe(stillEntryProblem(hallShaped, "agents-gallery"));
  });

  it("keeps each list's stills in its own directory, and off other hosts", () => {
    expect(agentPieceProblem(piece({ image: "/hall/test-piece.png" }))).toMatch(/\/agents-gallery\//);
    expect(agentPieceProblem(piece({ image: "https://evil.example/agents-gallery/x.png" }))).toMatch(/image/);
    expect(agentPieceProblem(piece({ image: "/agents-gallery/../hall/x.png" }))).toMatch(/image/);
    expect(hallEntryProblem({ ...piece(), image: "/agents-gallery/test-piece.png" })).toMatch(/\/hall\//);
  });

  it("drops malformed entries and duplicates, newest first", () => {
    const list = parseAgentGallery([
      piece({ id: "a", block: 1 }),
      piece({ id: "bad", prompt: "" }),
      piece({ id: "b", block: 5 }),
      piece({ id: "a", block: 9 }),
      "nonsense",
    ]);
    expect(list.map((p) => p.id)).toEqual(["b", "a"]);
    expect(parseAgentGallery({})).toEqual([]);
  });
});

describe("the gallery on /agents", () => {
  it("renders no grid with zero entries, only the invitation and its Tell us link", async () => {
    const { root, q } = await mount([]);
    expect(root.querySelector("[data-agents-gallery-grid]")).toBeNull();
    expect(root.querySelector(".hall-card")).toBeNull();
    expect(root.querySelector("[data-agents-copy-piece]")).toBeNull();
    const empty = q("[data-agents-gallery-empty]");
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toMatch(/first pieces will hang here/i);
    expect(empty.querySelector("a")!.getAttribute("href")).toBe("https://github.com/satojandro/metapoo/issues");
    // The starter prompts are untouched by an empty gallery.
    expect(root.querySelectorAll("[data-agents-copy]")).toHaveLength(3);
  });

  it("renders a piece with its still, title, date, short account and the right wall link", async () => {
    const { root, q } = await mount([piece()]);
    expect(root.querySelectorAll("[data-agents-gallery-grid] > li")).toHaveLength(1);
    expect(q("[data-agents-gallery-empty]").hidden).toBe(true);
    const card = q('[data-agents-piece="test-piece"]');
    expect(card.querySelector("img")!.getAttribute("src")).toBe("/agents-gallery/test-piece.png");
    expect(card.querySelector("h4")!.textContent).toBe("Test piece");
    expect(card.querySelector("time")!.textContent).toBe("12 Nov 2026");
    expect(card.querySelector(".hall-painters")!.textContent).toContain("2db3956c…6afea0b0");
    expect(card.textContent).not.toContain(HEX_ID);
    const link = card.querySelector<HTMLAnchorElement>(".hall-link")!;
    expect(link.getAttribute("href")).toBe("/wall?x=12&y=20&zoom=12");
    expect(link.textContent).toBe("See it on the wall →");
  });

  it("renders the prompt as text, never as HTML", async () => {
    const hostile = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><b>bold</b>`;
    const { q } = await mount([piece({ prompt: hostile })]);
    const pre = q('[data-agents-piece="test-piece"] pre');
    expect(pre.textContent).toBe(hostile);
    expect(pre.children).toHaveLength(0);
    expect(pre.querySelector("img, script, b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders a hostile title and painter as text too", async () => {
    const { q } = await mount([piece({ title: "<i>x</i>", painters: ["<u>p</u>"] })]);
    const card = q('[data-agents-piece="test-piece"]');
    expect(card.querySelector("i, u")).toBeNull();
    expect(card.querySelector("h4")!.textContent).toBe("<i>x</i>");
  });

  it("copies exactly the piece's prompt and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const p = piece();
    const { q } = await mount([p, piece({ id: "other", image: "/agents-gallery/other.png", prompt: "another prompt", block: 1 })]);
    q<HTMLButtonElement>('[data-agents-copy-piece="test-piece"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(p.prompt);
    expect(q('[data-agents-copy-piece="test-piece"]').textContent).toBe("Copied");
    expect(q('[data-agents-copy-piece="other"]').textContent).toBe("Copy");
    expect(q('[data-agents-copy="look"]').textContent).toBe("Copy");
    expect(q("[data-agents-gallery-status]").textContent).toMatch(/"Test piece" copied/);
  });

  it("selects the prompt for a manual copy when the clipboard refuses", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { q } = await mount([piece()]);
    q<HTMLButtonElement>('[data-agents-copy-piece="test-piece"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(q("[data-agents-gallery-status]").textContent).toMatch(/Ctrl-C/);
    expect(q('[data-agents-copy-piece="test-piece"]').textContent).toBe("Copy");
  });

  it("gives the prompt box a keyboard stop, so a clamped long prompt can be scrolled", async () => {
    const { q } = await mount([piece({ prompt: "line\n".repeat(400) })]);
    const pre = q<HTMLPreElement>('[data-agents-piece="test-piece"] pre');
    expect(pre.tabIndex).toBe(0);
    expect(pre.classList.contains("agents-prompt")).toBe(true);
    const css = readFileSync(resolve(__dirname, "agents.css"), "utf8");
    expect(css).toMatch(/\.agents-piece-prompt \.agents-prompt \{[^}]*max-height:[^}]*overflow-y: auto/);
  });
});
