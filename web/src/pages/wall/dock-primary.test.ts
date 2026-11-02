import { describe, expect, it } from "vitest";
import { dockPrimaryState, parseCreditsLine, type DockPrimaryInput } from "./dock-primary";

const READY: DockPrimaryInput = {
  connected: true,
  credits: 12,
  colourChosen: true,
  armed: false,
  phase: null,
};

describe("dockPrimaryState", () => {
  it("asks for a wallet first", () => {
    expect(dockPrimaryState({ ...READY, connected: false })).toEqual({
      kind: "connect",
      label: "Connect wallet to paint",
      disabled: false,
    });
  });

  it("offers credits when the balance is known to be zero", () => {
    expect(dockPrimaryState({ ...READY, credits: 0 })).toMatchObject({ kind: "buy", label: "Buy credits" });
    // Unknown balance (free board, or not read yet) never blocks the paint path.
    expect(dockPrimaryState({ ...READY, credits: null }).kind).toBe("place");
  });

  it("asks for a colour before anything can be painted", () => {
    expect(dockPrimaryState({ ...READY, colourChosen: false })).toEqual({
      kind: "pick-colour",
      label: "Pick a colour",
      disabled: true,
    });
  });

  it("says the wall itself is the action while a drawing key is armed", () => {
    expect(dockPrimaryState({ ...READY, armed: true })).toMatchObject({
      kind: "armed",
      label: "Tap or drag on the wall to paint",
      disabled: true,
    });
    expect(dockPrimaryState({ ...READY, armed: true, phase: "submitted" }).label).toBe("Painting…");
  });

  it("is Paint this tile when a paint can be sent, and Painting… while one is in flight", () => {
    expect(dockPrimaryState(READY)).toEqual({ kind: "place", label: "Paint this tile", disabled: false });
    for (const phase of ["wallet_prompt", "submitted", "confirmation_delayed"]) {
      expect(dockPrimaryState({ ...READY, phase }).label, phase).toBe("Painting…");
    }
    for (const phase of ["confirmed", "failed", "overwritten", "editing"]) {
      expect(dockPrimaryState({ ...READY, phase }).label, phase).toBe("Paint this tile");
    }
  });
});

describe("parseCreditsLine", () => {
  it("reads the pricing controller's credits line", () => {
    expect(parseCreditsLine("Credits: 12")).toBe(12);
    expect(parseCreditsLine("Credits: 0")).toBe(0);
    expect(parseCreditsLine("Credits: not registered · 0")).toBe(0);
  });

  it("treats anything else as unknown", () => {
    for (const line of ["Credits: …", "Credits: connect wallet", "Credits: unavailable — retry", "", null]) {
      expect(parseCreditsLine(line), String(line)).toBeNull();
    }
  });
});
