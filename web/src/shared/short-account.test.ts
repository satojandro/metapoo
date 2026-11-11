import { describe, expect, it } from "vitest";
import { shortAccount } from "./short-account";

describe("shortAccount", () => {
  it("keeps the first 8 and last 8 characters of a 64-char implicit id", () => {
    const id = "fcd66acf" + "0".repeat(48) + "3076f59e";
    expect(id).toHaveLength(64);
    expect(shortAccount(id)).toBe("fcd66acf…3076f59e");
  });

  it("leaves a named account whole", () => {
    expect(shortAccount("misfits-validator.near")).toBe("misfits-validator.near");
  });

  it("leaves an account of exactly 20 characters whole", () => {
    expect("team.metapoo.testnet").toHaveLength(20);
    expect(shortAccount("team.metapoo.testnet")).toBe("team.metapoo.testnet");
  });

  it("leaves a short string whole", () => {
    expect(shortAccount("alice.near")).toBe("alice.near");
  });

  it("returns an empty string unchanged", () => {
    expect(shortAccount("")).toBe("");
  });
});
