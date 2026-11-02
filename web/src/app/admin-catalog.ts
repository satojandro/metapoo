/** Content model from board-settings-reference.html. Launch values are reference only;
 * the dashboard obtains every adjustable value from chain reads. */
export interface AdminSetting {
  name: string; what: string; launch: string; range: string;
  how: string; rule: string; field: string; flag?: string;
}
export interface AdminGroup { id: string; title: string; blurb: string; items: AdminSetting[] }
export const ADMIN_GROUPS: AdminGroup[] = [
  { id: "safety", title: "Emergency", blurb: "The stop button. Use it when something is wrong with painting or payments.", items: [
    { name: "Pause the board", what: "Stops painting and buying. Reading the board keeps working.", launch: "Off", range: "On or off", how: "now", rule: "Owner, immediate, both ways.", field: "set_paused(paused)" ,
      flag: "Open: distributions keep running while paused." },
    { name: "Pause TOILET", what: "Forwards a pause to the TOILET token contract.", launch: "Off", range: "On or off", how: "now", rule: "Owner, immediate.", field: "set_toilet_paused(toilet, paused)" },
  ]},
  { id: "prices", title: "Prices", blurb: "What a credit costs. One credit paints one cell at the base price.", items: [
    { name: "NEAR price per credit", what: "Price of one credit when paying in NEAR.", launch: "0.0025 NEAR", range: "Half to double the current price per change", how: "wait", rule: "Owner, once per NEAR cooldown (24 h).", field: "set_near_price(near_per_credit)" },
    { name: "mPOO price per credit", what: "Price when paying in mPOO. Set weekly by hand from the 7-day pool average, with a 20% holder discount.", launch: "Set before mPOO sales open", range: "Half to double per change", how: "wait", rule: "Owner, once per mPOO cooldown (24 h). Separate from NEAR.", field: "set_mpoo_price(mpoo_per_credit)" },
    { name: "NEAR price cooldown", what: "Minimum time between NEAR price changes. Repaint credit changes count as NEAR price changes.", launch: "24 hours", range: "At least 24 hours", how: "now", rule: "Owner, any time.", field: "near_price_cooldown_ns" },
    { name: "mPOO price cooldown", what: "Minimum time between mPOO price changes.", launch: "24 hours", range: "At least 24 hours", how: "now", rule: "Owner, any time.", field: "mpoo_price_cooldown_ns" },
  ]},
  { id: "repaint", title: "Repaint pricing", blurb: "Painting over fresh art costs more. This protects new work from being wiped instantly.", items: [
    { name: "Base price", what: "An empty cell, or one painted more than an hour ago.", launch: "1 credit", range: "1–8, base ≤ mid ≤ young", how: "wait", rule: "Owner. Counts as a NEAR price change: 24 h cooldown, and restarts it.", field: "repaint_base_credits" },
    { name: "Recent repaint price", what: "A cell painted within the last hour.", launch: "2 credits", range: "1–8", how: "wait", rule: "Same as base price.", field: "repaint_mid_credits" },
    { name: "Fresh repaint price", what: "A cell painted within the last 10 minutes.", launch: "4 credits", range: "1–8", how: "wait", rule: "Same as base price.", field: "repaint_young_credits" },
    { name: "Fresh window", what: "How long a cell counts as fresh.", launch: "10 minutes", range: "Up to the recent window", how: "now", rule: "Owner, any time. Windows are not prices.", field: "repaint_young_ns" },
    { name: "Recent window", what: "How long a cell counts as recent.", launch: "60 minutes", range: "Up to 24 hours", how: "now", rule: "Owner, any time.", field: "repaint_mid_ns" },
  ]},
  { id: "mpoo", title: "mPOO sales", blurb: "Limits how much paint can be bought with mPOO per day, in case mPOO moves between weekly price updates.", items: [
    { name: "Daily mPOO cap", what: "Credits that can be sold for mPOO per UTC day. 0 closes mPOO sales.", launch: "0 at deploy · recommended 20,000", range: "0 – 1,000,000", how: "now", rule: "Owner, immediate both ways, so it can be raised the moment demand shows.", field: "mpoo_daily_credit_cap" },
    { name: "mPOO credits sold today", what: "Resets at midnight UTC. The page shows what's left.", launch: "—", range: "—", how: "read", rule: "View: get_mpoo_sales_today", field: "get_mpoo_sales_today()" },
  ]},
  { id: "supply", title: "Supply and reserves", blurb: "Keeps the board able to pay for storage, and optionally limits unspent paint.", items: [
    { name: "Unspent credit ceiling", what: "Maximum credits sold and not yet painted. 0 means no limit.", launch: "No limit", range: "0, or at least what's outstanding now", how: "now", rule: "Owner, any time.", field: "max_outstanding_credits" },
    { name: "Reserve floor", what: "NEAR the board always keeps on top of storage, never distributed.", launch: "5 NEAR", range: "At least 5 NEAR", how: "now", rule: "Owner, any time.", field: "reserve_floor" },
  ]},
  { id: "free", title: "Free painting", blurb: "Seeds the wall at launch, then a weekly happy hour once it's full.", items: [
    { name: "Free first paints per person", what: "Empty cells each registered account can paint for free, until every cell has been painted once.", launch: "25", range: "0–100", how: "now", rule: "Owner, any time. 0 turns it off.", field: "free_first_paints_per_account" },
    { name: "First board full", what: "Flips on when all 16,384 cells have been painted. Ends free first paints, allows happy hour. Never flips back.", launch: "Not yet", range: "—", how: "read", rule: "Set by the board.", field: "first_fill_complete" },
    { name: "Happy hour", what: "Weekly window where base-price cells are free. Only after the first board is full.", launch: "Off at deploy, on once the board is full", range: "On or off", how: "wait", rule: "Turning off: immediate. Turning on: 24 h after the last happy-hour change.", field: "happy_hour_enabled" },
    { name: "Happy hour day", what: "Day of the week.", launch: "Sunday", range: "Monday–Sunday", how: "wait", rule: "Moving it while on: 24 h cooldown.", field: "happy_hour_weekday" },
    { name: "Happy hour start", what: "Start time in UTC.", launch: "20:00 UTC", range: "Any time of day", how: "wait", rule: "Moving it while on: 24 h cooldown.", field: "happy_hour_start_s" },
    { name: "Happy hour length", what: "How long it lasts.", launch: "1 hour", range: "15 minutes – 24 hours", how: "wait", rule: "Longer: 24 h cooldown. Shorter: immediate.", field: "happy_hour_length_s" },
    { name: "Free cells per person per happy hour", what: "Cap on free cells for each account in one window.", launch: "100", range: "1–1,000", how: "wait", rule: "Higher: 24 h cooldown. Lower: immediate.", field: "happy_hour_cap_per_account" },
    { name: "Only previous buyers", what: "Only accounts that have bought credits at least once get free happy-hour cells.", launch: "On", range: "On or off", how: "now", rule: "Owner, any time.", field: "happy_hour_requires_purchase" },
  ]},
  { id: "revenue", title: "Revenue", blurb: "Revenue leaves the board only through the fixed split. Anyone can trigger it; a keeper does it hourly.", items: [
    { name: "Distribution interval", what: "Minimum time between distributions, for NEAR and mPOO separately.", launch: "1 hour", range: "No limit today", how: "now", rule: "Owner, any time.", field: "distribution_interval_ns",
      flag: "No upper limit: could be set to years and freeze revenue sharing. Proposed bound: 10 minutes – 24 hours." },
    { name: "Team account", what: "Receives 10% of NEAR and 10% of mPOO revenue.", launch: "Dedicated account (owner to create)", range: "Any account but the board", how: "wait", rule: "Owner, once per 7 days.", field: "set_team_account(account_id)" },
    { name: "Buyback account", what: "Receives 90% of NEAR revenue to buy mPOO, and is the only account allowed to send mPOO back as revenue.", launch: "Dedicated account (owner to create)", range: "Any account but the board", how: "wait", rule: "Owner, once per 7 days.", field: "set_buyback_account(account_id)" },
    { name: "Staking contract", what: "Where the stakers' 70% of mPOO goes. Until it's set, that share builds up locked on the board.", launch: "Not set", range: "Any account", how: "wait", rule: "Owner, exactly once, ever.", field: "set_staking_contract(account_id)" },
    { name: "Waiting to distribute", what: "NEAR above the reserve, mPOO waiting, the stakers' locked reserve and the next distribution time.", launch: "—", range: "—", how: "read", rule: "View: get_revenue_state", field: "get_revenue_state()" },
  ]},
  { id: "toilet", title: "TOILET (read only)", blurb: "Emission and allowance settings are visible here. Editing them belongs to the TOILET review round.", items: [
    { name: "TOILET emission rate", what: "TOILET earned per held cell per second.", launch: "0 (off)", range: "Read only here", how: "later", rule: "Current on-chain rate; changes belong to the TOILET round.", field: "toilet_per_cell_second" },
    { name: "Earning cell cap", what: "Most cells per account that earn TOILET.", launch: "128", range: "—", how: "later", rule: "Stored but not enforced yet (audit C3).", field: "max_earning_cells" },
    { name: "Daily paint allowance", what: "Free daily paints for holders: base + per-cell, capped.", launch: "32 + 4 per cell, max 512", range: "—", how: "later", rule: "Stored but not enforced yet (audit C3).", field: "quota_base · quota_per_cell · quota_max" },
  ]},
  { id: "fixed", title: "Fixed in the contract", blurb: "Deliberately not settings. Changing these needs a contract upgrade and a review.", items: [
    { name: "NEAR split", what: "10% team, 90% buyback.", launch: "10 / 90", range: "—", how: "fixed", rule: "Upgrade only.", field: "revenue.rs" },
    { name: "mPOO split", what: "10% team, 20% burn address, 70% stakers.", launch: "10 / 20 / 70", range: "—", how: "fixed", rule: "Upgrade only.", field: "revenue.rs" },
    { name: "Burn address", what: "Tokens sent here can never move. Registered on mainnet mPOO on 2 Nov.", launch: "0000…0000 (64 zeros)", range: "—", how: "fixed", rule: "Upgrade only.", field: "BURN_ACCOUNT" },
    { name: "Free cells earn no TOILET", what: "A free-painted cell earns nothing until someone repaints it with credits. Stored now, enforced in the TOILET round.", launch: "—", range: "—", how: "fixed", rule: "Upgrade only.", field: "free_cells" },
    { name: "Palette", what: "16 colours, Grime & Gum.", launch: "16", range: "—", how: "fixed", rule: "Upgrade only.", field: "PALETTE" },
    { name: "Board and strokes", what: "128 × 128 cells; at most 64 cells per stroke.", launch: "16,384 cells", range: "—", how: "fixed", rule: "Upgrade only.", field: "WIDTH · HEIGHT · MAX_DRAW_BATCH" },
    { name: "Registration fee", what: "One-off fee to open a credit account. Pays for its storage.", launch: "0.01 NEAR", range: "—", how: "fixed", rule: "Upgrade only. Rehearsal checks it covers storage.", field: "REGISTRATION" },
    { name: "Storage per cell", what: "Used for the empty-cell reserve. Still the old board's estimate.", launch: "0.000664 NEAR", range: "—", how: "fixed", rule: "Upgrade only. Rehearsal measures the real figure.", field: "STORAGE_PER_PIXEL" },
  ]},
];
