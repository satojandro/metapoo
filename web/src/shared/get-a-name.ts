/**
 * NAMES (spec §3, owner decision §3.4): who is offered "Get a name", and the small link
 * that sits beside the signed-in player's own hex id.
 *
 * The whole feature is behind `VITE_NAMES_GUIDE` (default off) until the Meteor steps in
 * `app/meteor-name-steps.ts` have been checked on a real device.
 */

import { NAMES_GUIDE_ENABLED } from "../config";
import { shortAccount } from "./short-account";
import "./get-a-name.css";

/** Implicit ids are 64 lowercase hex characters and nothing else. */
const IMPLICIT_ID = /^[0-9a-f]{64}$/;

export function isImplicitId(account: string): boolean {
  return IMPLICIT_ID.test(account);
}

/** Where the guide lives. The `#hiw-` prefix is what /how-it-works scrolls to on mount. */
export const NAME_GUIDE_HREF = "/how-it-works#hiw-name";
export const NAME_LINK_TEXT = "Get a name →";

export interface SignIn {
  /** Null when nobody is signed in. */
  accountId: string | null;
  /** Signed in through Privy (`isConnectedPrivyWallet` in `wallet.ts`), not a NEAR wallet. */
  privy: boolean;
}

/**
 * Who sees "Get a name" (§3.4): a NEAR wallet sign-in on an implicit id, and every Privy
 * sign-in. Never a named account, never a signed-out visitor.
 */
export function seesGetAName(signIn: SignIn): boolean {
  if (!signIn.accountId) return false;
  return signIn.privy || isImplicitId(signIn.accountId);
}

/**
 * Whether `account`, printed somewhere on the wall, gets the link: only when it is a hex
 * id and it is the viewer's own. Other players' ids never do.
 *
 * The wall does not need to know whether the viewer came through Privy: a Privy account
 * is always an implicit id, so the hex test already covers it.
 */
export function showsNameLink(account: string, viewer: string | null, enabled: boolean = NAMES_GUIDE_ENABLED): boolean {
  return enabled && viewer !== null && account === viewer && isImplicitId(account)
    && seesGetAName({ accountId: viewer, privy: false });
}

/** The link itself, or null when this id does not get one. */
export function nameLink(account: string, viewer: string | null, enabled: boolean = NAMES_GUIDE_ENABLED): HTMLAnchorElement | null {
  if (!showsNameLink(account, viewer, enabled)) return null;
  const link = document.createElement("a");
  link.className = "name-link";
  link.href = NAME_GUIDE_HREF;
  link.textContent = NAME_LINK_TEXT;
  link.setAttribute("aria-label", "Get a name: swap your long account id for a name people can read");
  return link;
}

/**
 * A quiet line for places that say "You" instead of printing the id ("Right now", Your tiles):
 * "The wall signs your tiles 3f9a1b2c…c21e0d4f. Get a name →". Null when the viewer gets no link.
 */
export function nameNote(viewer: string | null, enabled: boolean = NAMES_GUIDE_ENABLED): HTMLParagraphElement | null {
  const link = viewer === null ? null : nameLink(viewer, viewer, enabled);
  if (!link || viewer === null) return null;
  const note = document.createElement("p");
  note.className = "name-note";
  const id = document.createElement("span");
  id.className = "name-note-id";
  id.textContent = shortAccount(viewer);
  id.title = viewer;
  note.append("The wall signs your tiles ", id, ". ", link);
  return note;
}

/**
 * Keep one `nameNote` directly after `anchor`, for `viewer` (pass null to remove it). Safe to
 * call on every render: the note is only rebuilt when the viewer changes.
 */
export function syncNameNote(anchor: Element | null, viewer: string | null, enabled: boolean = NAMES_GUIDE_ENABLED): void {
  if (!anchor) return;
  const next = anchor.nextElementSibling;
  const existing = next instanceof HTMLElement && next.dataset.nameNote !== undefined ? next : null;
  const wanted = viewer !== null && showsNameLink(viewer, viewer, enabled) ? viewer : null;
  if (existing && existing.dataset.nameNote === wanted) return;
  existing?.remove();
  const note = wanted === null ? null : nameNote(wanted, enabled);
  if (!note || wanted === null) return;
  note.dataset.nameNote = wanted;
  anchor.after(note);
}

/* ——— The name a player types into the preview ——— */

/** One NEAR account-id part: lowercase letters and digits, single `-` or `_` between them. */
const NAME_PART = /^[a-z\d]+(?:[-_][a-z\d]+)*$/;
const ACCOUNT_MIN = 2;
const ACCOUNT_MAX = 64;

export type TypedName = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Check a typed name against NEAR's account-id rules (2–64 characters; lowercase letters,
 * digits, and `-` `_` `.` as separators — https://docs.near.org/protocol/account-id).
 * `suffix` is the network's top-level account: "near" on mainnet, "testnet" on testnet.
 * A bare word gets the suffix added, because that is what the player means.
 *
 * This says a name is well formed. It cannot say the name is free: only the wallet knows.
 */
export function checkTypedName(raw: string, suffix: string): TypedName {
  const typed = raw.trim().toLowerCase();
  if (!typed) return { ok: false, reason: "" };
  const tail = `.${suffix}`;
  const label = typed.endsWith(tail) ? typed.slice(0, -tail.length) : typed;
  if (label.includes(".")) return { ok: false, reason: `Use one word before ${tail}, with no dots in it.` };
  if (!NAME_PART.test(label)) {
    return { ok: false, reason: "Use lowercase letters and numbers. A dash or underscore can sit between them, not at either end." };
  }
  const name = `${label}${tail}`;
  if (isImplicitId(label)) return { ok: false, reason: "That’s another long id. Pick something people can read." };
  if (name.length < ACCOUNT_MIN || name.length > ACCOUNT_MAX) {
    return { ok: false, reason: `Too long. A name can be ${ACCOUNT_MAX - tail.length} characters before ${tail}.` };
  }
  return { ok: true, name };
}
