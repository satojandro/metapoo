import type { ChainRecord } from "./admin-settings";
// These are settings, not mock balances shown to visitors.
export const tunables = (): ChainRecord => ({
  paused: false, reserve_floor: "5000000000000000000000000",
  near_price_cooldown_ns: 86400000000000, mpoo_price_cooldown_ns: 86400000000000,
  last_near_price_change_ns: null, last_mpoo_price_change_ns: null, last_happy_hour_change_ns: null,
  repaint_base_credits: 1, repaint_mid_credits: 2, repaint_young_credits: 4,
  repaint_young_ns: 600000000000, repaint_mid_ns: 3600000000000,
  max_outstanding_credits: 0, mpoo_daily_credit_cap: 0, toilet_per_cell_second: 0,
  quota_base: 32, quota_per_cell: 4, quota_max: 512, max_earning_cells: 128,
  free_first_paints_per_account: 25, happy_hour_enabled: false, happy_hour_weekday: 6,
  happy_hour_start_s: 72000, happy_hour_length_s: 3600, happy_hour_cap_per_account: 100,
  happy_hour_requires_purchase: true, distribution_interval_ns: 3600000000000,
});
