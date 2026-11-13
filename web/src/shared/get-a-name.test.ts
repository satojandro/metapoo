/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { NAMES_GUIDE_ENABLED } from "../config";
import {
  NAME_GUIDE_HREF, checkTypedName, isImplicitId, nameLink, nameNote, seesGetAName, showsNameLink, syncNameNote,
} from "./get-a-name";

const HEX = `fcd66acf${"0".repeat(48)}3076f59e`;
const OTHER_HEX = `aa${"1".repeat(60)}bb`;

describe("who sees Get a name", () => {
  it("a wallet sign-in on a 64-hex implicit id sees it", () => {
    expect(seesGetAName({ accountId: HEX, privy: false })).toBe(true);
  });

  it("every Privy sign-in sees it", () => {
    expect(seesGetAName({ accountId: HEX, privy: true })).toBe(true);
  });

  it("named accounts never see it", () => {
    for (const accountId of ["alice.near", "misfits-validator.near", "bob.testnet", "a.b.near"]) {
      expect(seesGetAName({ accountId, privy: false })).toBe(false);
    }
  });

  it("a signed-out visitor never sees it", () => {
    expect(seesGetAName({ accountId: null, privy: false })).toBe(false);
    expect(seesGetAName({ accountId: null, privy: true })).toBe(false);
  });

  it("an implicit id is exactly 64 lowercase hex characters", () => {
    expect(isImplicitId(HEX)).toBe(true);
    expect(isImplicitId(HEX.slice(1))).toBe(false);
    expect(isImplicitId(`${HEX}0`)).toBe(false);
    expect(isImplicitId(HEX.toUpperCase())).toBe(false);
    expect(isImplicitId(`g${HEX.slice(1)}`)).toBe(false);
    // 64 characters, but a name.
    expect(isImplicitId(`${"a".repeat(59)}.near`)).toBe(false);
  });
});

describe("the Get a name link", () => {
  it("the link shows only for the viewer's own hex id", () => {
    expect(showsNameLink(HEX, HEX, true)).toBe(true);
    // Somebody else's hex id, a signed-out visitor, and the viewer's id beside another row.
    expect(showsNameLink(OTHER_HEX, HEX, true)).toBe(false);
    expect(showsNameLink(HEX, null, true)).toBe(false);
    expect(showsNameLink(HEX, OTHER_HEX, true)).toBe(false);
    const link = nameLink(HEX, HEX, true)!;
    expect(link.getAttribute("href")).toBe(NAME_GUIDE_HREF);
    expect(link.textContent).toBe("Get a name →");
    expect(nameLink(OTHER_HEX, HEX, true)).toBeNull();
  });

  it("named accounts never see it, on their own row or anyone's", () => {
    expect(showsNameLink("alice.near", "alice.near", true)).toBe(false);
    expect(showsNameLink(HEX, "alice.near", true)).toBe(false);
    expect(nameLink("alice.near", "alice.near", true)).toBeNull();
    expect(nameNote("alice.near", true)).toBeNull();
  });

  it("flag off renders nothing, and off is the default", () => {
    expect(NAMES_GUIDE_ENABLED).toBe(false);
    expect(showsNameLink(HEX, HEX)).toBe(false);
    expect(nameLink(HEX, HEX)).toBeNull();
    expect(nameNote(HEX)).toBeNull();
    expect(nameLink(HEX, HEX, false)).toBeNull();
  });

  it("the note shows the id short, first 8 … last 8, and keeps the whole one in the title", () => {
    const note = nameNote(HEX, true)!;
    expect(note.textContent).toBe("The wall signs your tiles fcd66acf…3076f59e. Get a name →");
    expect(note.textContent).not.toContain(HEX);
    expect(note.querySelector<HTMLElement>(".name-note-id")!.title).toBe(HEX);
  });

  it("keeps one note after its anchor, and takes it away when the viewer signs out", () => {
    document.body.innerHTML = `<div><ol id="list"></ol><p id="after"></p></div>`;
    const list = document.querySelector("#list")!;
    syncNameNote(list, HEX, true);
    const first = list.nextElementSibling;
    expect(first?.className).toBe("name-note");
    syncNameNote(list, HEX, true);
    expect(list.nextElementSibling).toBe(first);
    expect(document.querySelectorAll(".name-note")).toHaveLength(1);
    syncNameNote(list, "alice.near", true);
    expect(document.querySelector(".name-note")).toBeNull();
    syncNameNote(list, HEX, true);
    syncNameNote(list, null, true);
    expect(document.querySelector(".name-note")).toBeNull();
    expect(list.nextElementSibling?.id).toBe("after");
  });
});

describe("a typed name", () => {
  it("accepts a NEAR name, and adds the network's ending to a bare word", () => {
    expect(checkTypedName("alice", "near")).toEqual({ ok: true, name: "alice.near" });
    expect(checkTypedName("alice.near", "near")).toEqual({ ok: true, name: "alice.near" });
    expect(checkTypedName("  Poo-Lord_9 ", "near")).toEqual({ ok: true, name: "poo-lord_9.near" });
    expect(checkTypedName("bob", "testnet")).toEqual({ ok: true, name: "bob.testnet" });
  });

  it("refuses what NEAR refuses, with a reason a player can act on", () => {
    for (const bad of ["al ice", "-alice", "alice-", "al--ice", "al!ce", "ålice", "a..b", ".near"]) {
      const result = checkTypedName(bad, "near");
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason, bad).not.toBe("");
    }
    // A name inside a name is not something a wallet creates for you.
    expect(checkTypedName("a.b.near", "near").ok).toBe(false);
    expect(checkTypedName("a".repeat(60), "near").ok).toBe(false);
    expect(checkTypedName("a".repeat(59), "near")).toEqual({ ok: true, name: `${"a".repeat(59)}.near` });
    expect(checkTypedName(HEX, "near").ok).toBe(false);
  });

  it("an empty field is not an error", () => {
    expect(checkTypedName("   ", "near")).toEqual({ ok: false, reason: "" });
  });
});
