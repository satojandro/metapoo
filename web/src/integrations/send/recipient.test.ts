import { describe, expect, it } from "vitest";
import { normalizeRecipient } from "./plan";

const IMPLICIT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ETH_IMPLICIT = "0x0123456789abcdef0123456789abcdef01234567";

describe("recipient normalisation", () => {
  it("leaves a valid account id exactly as typed", () => {
    expect(normalizeRecipient("alice.near")).toBe("alice.near");
    expect(normalizeRecipient("  alice.near  ")).toBe("alice.near");
    expect(normalizeRecipient(IMPLICIT)).toBe(IMPLICIT);
    expect(normalizeRecipient(ETH_IMPLICIT)).toBe(ETH_IMPLICIT);
  });

  it("corrects a case-only difference", () => {
    // A NEAR account id is lowercase, so an uppercase paste names the same account only after
    // lowering — and a hex address is case-insensitive in the same way.
    expect(normalizeRecipient("ALICE.NEAR")).toBe("alice.near");
    expect(normalizeRecipient("0x0123456789ABCDEF0123456789ABCDEF01234567")).toBe(ETH_IMPLICIT);
    expect(normalizeRecipient(IMPLICIT.toUpperCase())).toBe(IMPLICIT);
  });

  it("never repairs anything except case", () => {
    // Spec §5.1: lowercase only when the value is otherwise valid. Everything else must surface
    // as an error — silently rewriting it is how a send lands on an account nobody chose.
    const invalid = [
      "alice..near", // empty label
      "-alice.near", // leading separator
      "alice near", // space
      "alice.near.", // trailing dot
      "аlice.near", // Cyrillic а, not ASCII a
      "a", // too short
      "A".repeat(65), // too long, case-insensitive length
    ];
    for (const input of invalid) expect(() => normalizeRecipient(input), input).toThrow();
  });
});
