import type { NetworkId } from "@shared/types.ts";

/**
 * Immutable draw attempt captured at enqueue / Place time.
 * UI selection, color, and account may change while this request is in flight;
 * submission and recovery must use only these fields.
 */
export interface DrawRequest {
  readonly x: number;
  readonly y: number;
  readonly colorIndex: number;
  readonly accountId: string;
  readonly networkId: NetworkId;
}

export function createDrawRequest(input: {
  x: number;
  y: number;
  colorIndex: number;
  accountId: string;
  networkId: NetworkId;
}): DrawRequest {
  return {
    x: input.x,
    y: input.y,
    colorIndex: input.colorIndex,
    accountId: input.accountId,
    networkId: input.networkId,
  };
}
