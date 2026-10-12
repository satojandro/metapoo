import board from "@shared/board.json";
import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import type { ChainBoardView } from "./contract";

/**
 * Compare on-chain `get_board` metadata to the page's shared constants.
 * Drawing stays blocked when the contract is incompatible.
 */

export type ContractMetaStatus =
  | { ok: true; summary: string }
  | { ok: false; title: string; message: string };

export function validateContractMetadata(view: ChainBoardView): ContractMetaStatus {
  if (view.schema_version !== board.schema_version) {
    return {
      ok: false,
      title: "Incompatible contract schema",
      message: `This page expects schema ${board.schema_version}, but the contract reported ${view.schema_version}. Drawing stays disabled until they match.`,
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

  return {
    ok: true,
    summary: `Contract metadata matches: schema ${view.schema_version}, ${view.width}×${view.height}, ${view.overwrite_rule}, ${view.palette.length} colors.`,
  };
}
