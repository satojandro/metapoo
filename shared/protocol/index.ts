/**
 * Versioned Meta Poo protocol surface for R0/R1.
 * Agents propose schema patches to the coordinator; they do not invent
 * alternate monetary types or lifecycle enums outside this package.
 */

export * from "./errors.ts";
export * from "./board.ts";
export * from "./bounties.ts";
export * from "./history.ts";
export * from "./prints.ts";
export * from "./operations.ts";

export const PROTOCOL_FREEZE_ID = "mpoo-protocol-r0-2026-10-12";
export const PROTOCOL_FREEZE_LABEL =
  "R0 interface freeze — prototype fixtures, not mainnet economics";
