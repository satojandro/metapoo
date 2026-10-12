/**
 * Pressure / paint-cost overlay hooks (stub).
 * Full overlay UI is owned by Worker F in a later wave — not implemented here.
 */

export interface PressureOverlayHooks {
  /** Whether the paint-cost overlay toggle is available. */
  available: boolean;
  /** No-op stub until pressure quotes exist. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

export function createPressureOverlayHooks(): PressureOverlayHooks {
  let enabled = false;
  return {
    available: false,
    setEnabled(next) {
      enabled = next;
    },
    isEnabled() {
      return enabled;
    },
  };
}
