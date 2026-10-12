import type { NetworkId } from "@shared/types.ts";

/**
 * Immutable draw attempt captured at enqueue / Place time.
 * UI selection, color, and account may change while this request is in flight;
 * submission and recovery must use only these fields.
 *
 * Optional paid fields (Journey C) freeze the user's authorized TOILET ceiling
 * and quote expiry at enqueue time. Free-board requests omit them.
 */
export interface DrawRequest {
  readonly x: number;
  readonly y: number;
  readonly colorIndex: number;
  readonly accountId: string;
  readonly networkId: NetworkId;
  /** Max TOILET the user authorized for this paint (decimal string). */
  readonly maxCost?: string;
  /** Quote expiry nanoseconds (decimal string) frozen at enqueue. */
  readonly expiresAtNs?: string;
  readonly pricingVersion?: string;
  readonly actionNonce?: string;
  readonly sessionId?: string;
}

export function createDrawRequest(input: {
  x: number;
  y: number;
  colorIndex: number;
  accountId: string;
  networkId: NetworkId;
  maxCost?: string;
  expiresAtNs?: string;
  pricingVersion?: string;
  actionNonce?: string;
  sessionId?: string;
}): DrawRequest {
  return {
    x: input.x,
    y: input.y,
    colorIndex: input.colorIndex,
    accountId: input.accountId,
    networkId: input.networkId,
    ...(input.maxCost !== undefined ? { maxCost: input.maxCost } : {}),
    ...(input.expiresAtNs !== undefined ? { expiresAtNs: input.expiresAtNs } : {}),
    ...(input.pricingVersion !== undefined
      ? { pricingVersion: input.pricingVersion }
      : {}),
    ...(input.actionNonce !== undefined ? { actionNonce: input.actionNonce } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
  };
}

/**
 * True when the live wallet identity still matches the frozen request.
 * Queued paints must not run under a different account's drawing key.
 */
export function drawRequestMatchesSession(
  request: DrawRequest,
  accountId: string | null,
  networkId: NetworkId | null,
): boolean {
  return (
    accountId !== null &&
    networkId !== null &&
    request.accountId === accountId &&
    request.networkId === networkId
  );
}
