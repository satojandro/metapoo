/**
 * One short form for account ids, used wherever an id has to sit in prose or a chip.
 *
 * Implicit ids (64 hex characters, as Privy creates) are unreadable whole and wide
 * enough to stretch a phone-width grid, so they become `fcd66acf…3076f59e`. A short
 * string is already the readable form — `misfits-validator.near` is a name, not an id —
 * and the shape check keeps it that way even when the name is longer than the limit.
 */

/** Implicit ids are 64 lowercase hex characters and nothing else. */
const IMPLICIT_ID = /^[0-9a-f]{64}$/;

export function shortAccount(account: string): string {
  if (account.length <= 20 || !IMPLICIT_ID.test(account)) return account;
  return `${account.slice(0, 8)}…${account.slice(-8)}`;
}
