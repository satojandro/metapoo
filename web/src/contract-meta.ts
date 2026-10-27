import board from "@shared/board.json";
import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import type { ChainBoardView } from "./contract";
import { FREE_BOARD_SCHEMA_VERSION } from "./paid-mode";

/**
 * Compare on-chain `get_board` metadata to the page's shared constants.
 * Drawing stays blocked when the contract is incompatible.
 *
 * Accepts free schema 2 (shared/board.json) or paid schema 3 when size,
 * origin, overwrite rule, and palette still match. Schema 3 must report at
 * least one paid marker (pricing_version / pressure / ledger_unit). Schema 2
 * free boards are never rejected for missing those fields.
 */

/** Paid board contract schema (contracts/board SCHEMA_VERSION). */
export const PAID_BOARD_SCHEMA_VERSION = 3;

export type ContractMetaStatus =
  | { ok: true; summary: string }
  | { ok: false; title: string; message: string };

function hasPaidMarker(view: ChainBoardView): boolean {
  const pricing =
    typeof view.pricing_version === "string" && view.pricing_version.length > 0;
  const pressure = view.pressure != null && typeof view.pressure === "object";
  const ledger =
    typeof view.ledger_unit === "string" && view.ledger_unit.length > 0;
  return pricing || pressure || ledger;
}

export function validateContractMetadata(view: ChainBoardView): ContractMetaStatus {
  const schema = view.schema_version;
  const schemaOk =
    schema === FREE_BOARD_SCHEMA_VERSION || schema === PAID_BOARD_SCHEMA_VERSION;
  if (!schemaOk) {
    return {
      ok: false,
      title: "Incompatible contract schema",
      message: `This page accepts schema ${FREE_BOARD_SCHEMA_VERSION} (free) or ${PAID_BOARD_SCHEMA_VERSION} (paid), but the contract reported ${schema}. Drawing stays disabled until they match.`,
    };
  }

  if (schema === PAID_BOARD_SCHEMA_VERSION && !hasPaidMarker(view)) {
    return {
      ok: false,
      title: "Incomplete paid board metadata",
      message:
        "Schema 3 requires at least one paid marker (pricing_version, pressure, or ledger_unit). Drawing stays disabled until get_board reports them.",
    };
  }

  if (view.width !== BOARD_WIDTH || view.height !== BOARD_HEIGHT) {
    return {
      ok: false,
      title: "Incompatible board size",
      message: `This page expects ${BOARD_WIDTH}×${BOARD_HEIGHT}, but the contract reported ${view.width}×${view.height}. Drawing stays disabled.`,
    };
  }
  if (view.overwrite_rule !== board.overwrite_rule) {
    return {
      ok: false,
      title: "Incompatible overwrite rule",
      message: `This page expects “${board.overwrite_rule}”, but the contract reported “${view.overwrite_rule}”. Drawing stays disabled.`,
    };
  }
  if (view.origin !== board.origin) {
    return {
      ok: false,
      title: "Incompatible board origin",
      message: `This page expects origin “${board.origin}”, but the contract reported “${view.origin}”. Drawing stays disabled.`,
    };
  }
  if (!Array.isArray(view.palette) || view.palette.length !== PALETTE.length) {
    return {
      ok: false,
      title: "Incompatible palette size",
      message: `This page expects ${PALETTE.length} colors, but the contract reported ${view.palette?.length ?? 0}. Drawing stays disabled.`,
    };
  }
  for (const swatch of PALETTE) {
    const remote = view.palette.find((item) => item.index === swatch.index);
    if (!remote) {
      return {
        ok: false,
        title: "Incompatible palette",
        message: `Contract is missing palette index ${swatch.index} (${swatch.name}). Drawing stays disabled.`,
      };
    }
    if (remote.name !== swatch.name || remote.hex.toLowerCase() !== swatch.hex.toLowerCase()) {
      return {
        ok: false,
        title: "Incompatible palette entry",
        message: `Palette index ${swatch.index} differs (page ${swatch.name} ${swatch.hex} vs contract ${remote.name} ${remote.hex}). Drawing stays disabled so stored colors are not reinterpreted.`,
      };
    }
  }

  const modeLabel =
    schema === PAID_BOARD_SCHEMA_VERSION ? "paid" : "free";
  return {
    ok: true,
    summary: `Contract metadata matches (${modeLabel}): schema ${schema}, ${view.width}×${view.height}, ${view.overwrite_rule}, ${view.palette.length} colors.`,
  };
}

/**
 * Why painting is disabled, in words that match the actual cause.
 *
 * A failed read and a genuine mismatch both leave the page unable to draw, but
 * they need opposite instructions: one is "try again", the other is "this
 * contract is not this board". Reporting a transient RPC failure as
 * "get_board did not match the shared schema" sends the reader to the wrong
 * place entirely.
 */
export type ContractMetaIssue = { kind: "read" | "mismatch"; detail: string };

export function contractMetaBlockCopy(issue: ContractMetaIssue | null): {
  title: string;
  message: string;
} {
  if (issue?.kind === "read") {
    return {
      title: "Board not read yet",
      message:
        `The board contract could not be read, so painting is paused: ${issue.detail}. ` +
        `This is a read failure, not a contract mismatch — press Refresh board to try again.`,
    };
  }
  const detail =
    issue?.detail ?? "get_board did not match this page's schema, size, rule, or palette.";
  return {
    title: "Drawing blocked by contract metadata",
    message: `${detail} Drawing stays off until the contract id or the deployed board matches.`,
  };
}
