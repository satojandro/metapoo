//! Free paints (spec §F1, §F2) and the one pricing routine every paint path uses.
//!
//! - **F1, free first paints.** Until `first_fill_complete` latches, a registered
//!   account's first `free_first_paints_per_account` paints of *empty* cells cost 0.
//! - **F2, happy hour.** Once a week, after the latch, base-tier cells cost 0 up to
//!   `happy_hour_cap_per_account` per window, for accounts that have bought credits
//!   (when `happy_hour_requires_purchase` is on).
//!
//! `Board::plan_stroke` prices a stroke entry by entry, deciding which entries are free.
//! `draw`, `draw_many` and the `get_stroke_cost` view all call it, so a quote can never
//! disagree with what the contract charges.
//!
//! Week maths: 1 Jan 1970 (timestamp 0) was a Thursday. With 0 = Monday, the weekday of
//! day `d` (days since the epoch) is `(d + 3) % 7`, and the Monday-start week index is
//! `(d + 3) / 7`. Week 0 began on Monday 29 Dec 1969, three days before the epoch.
use crate::{AccountExtra, Board, BoardExt, CellRef, Tunables, MAX_DRAW_BATCH};
use near_sdk::json_types::U64;
use near_sdk::{env, near, AccountId};

const NS_PER_S: i128 = 1_000_000_000;
const DAY_S: i128 = 86_400;
/// Monday 0 … Sunday 6: the epoch day was a Thursday.
const EPOCH_WEEKDAY: i128 = 3;
/// Loosening happy hour (on, higher cap, longer or moved window) waits this long.
pub(crate) const HAPPY_HOUR_COOLDOWN_NS: u64 = 86_400_000_000_000;

pub(crate) const MAX_FREE_FIRST_PAINTS: u32 = 100;
pub(crate) const MIN_HAPPY_HOUR_LENGTH_S: u32 = 900;
pub(crate) const MAX_HAPPY_HOUR_LENGTH_S: u32 = 86_400;
pub(crate) const MAX_HAPPY_HOUR_CAP: u32 = 1_000;

/// How one stroke entry is priced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CellPrice {
    /// Credits charged for this entry (0 when free).
    pub credits: u32,
    pub free: bool,
}

/// The priced stroke, plus the account record as it will be after the stroke.
pub(crate) struct StrokePlan {
    pub cells: Vec<CellPrice>,
    pub total: u128,
    pub extra: AccountExtra,
    /// True when any entry was free, so `extra` must be written back.
    pub extra_changed: bool,
}

/// `get_stroke_cost`: the same per-entry pricing `draw_many` will apply for this
/// account right now, free paints included.
#[near(serializers = [json])]
pub struct StrokeCostView {
    /// Credits per entry, in order; 0 for a free entry.
    pub costs: Vec<u32>,
    /// Whether each entry is a free paint (F1 or F2).
    pub free: Vec<bool>,
    /// Sum of `costs`: pass this as `max_credits`.
    pub total: u32,
}

/// `get_free_first_paints`.
#[near(serializers = [json])]
pub struct FreeFirstPaintsView {
    pub used: u32,
    /// Free first paints this account can still use now (0 when inactive or unregistered).
    pub remaining: u32,
    /// True while the programme runs: before the first fill and allowance above 0.
    pub active: bool,
    pub allowance: u32,
    pub registered: bool,
}

/// `get_happy_hour`. Times are nanoseconds as strings (they exceed 2^53).
#[near(serializers = [json])]
pub struct HappyHourView {
    /// A free window is running now (latch set, switch on, inside the window).
    pub open: bool,
    pub enabled: bool,
    pub first_fill_complete: bool,
    /// The open window, or the next one when closed.
    pub window_start_ns: U64,
    pub window_end_ns: U64,
    /// Free cells this account used in the open window (0 when closed or no account).
    pub used: u32,
    pub cap: u32,
    /// Free cells left for this account now: 0 when closed or ineligible.
    pub remaining: u32,
    /// Registered and, when the flag is on, has bought credits.
    pub eligible: bool,
    pub requires_purchase: bool,
}

/// Weekday of a block timestamp, 0 = Monday … 6 = Sunday (UTC). Pins the epoch maths.
#[cfg(test)]
pub(crate) fn weekday(now_ns: u64) -> u32 {
    let day = i128::from(now_ns) / NS_PER_S / DAY_S;
    ((day + EPOCH_WEEKDAY) % 7) as u32
}

/// Monday-start week index of a block timestamp; the happy-hour window id.
pub(crate) fn week_index(now_ns: u64) -> u32 {
    let day = i128::from(now_ns) / NS_PER_S / DAY_S;
    ((day + EPOCH_WEEKDAY) / 7) as u32
}

/// `[start, end)` of week `week`'s window, in ns (may be negative for week 0).
fn window_bounds(t: &Tunables, week: i128) -> (i128, i128) {
    let day = week * 7 - EPOCH_WEEKDAY + i128::from(t.happy_hour_weekday);
    let start = (day * DAY_S + i128::from(t.happy_hour_start_s)) * NS_PER_S;
    (start, start + i128::from(t.happy_hour_length_s) * NS_PER_S)
}

/// The window containing `now_ns` as `(id, start, end)`, schedule only (no switch or
/// latch). A Sunday-night window may run past midnight into the next week, so the
/// previous week's window is checked too; its id stays the week it started in.
pub(crate) fn window_containing(t: &Tunables, now_ns: u64) -> Option<(u32, u64, u64)> {
    let now = i128::from(now_ns);
    let week = i128::from(week_index(now_ns));
    [week, week - 1].into_iter().find_map(|w| {
        let (start, end) = window_bounds(t, w);
        (w >= 0 && start <= now && now < end).then(|| (w as u32, clamp(start), clamp(end)))
    })
}

/// The open window, or else the next one to open, as `(start, end)` ns.
pub(crate) fn current_or_next_window(t: &Tunables, now_ns: u64) -> (u64, u64) {
    let now = i128::from(now_ns);
    let week = i128::from(week_index(now_ns));
    for w in [week - 1, week, week + 1] {
        let (start, end) = window_bounds(t, w);
        if end > now {
            return (clamp(start), clamp(end));
        }
    }
    unreachable!("next week's window always ends in the future")
}

fn clamp(ns: i128) -> u64 {
    ns.clamp(0, i128::from(u64::MAX)) as u64
}

/// Bounds for the F1/F2 tunables; called from `Tunables::validate`.
pub(crate) fn validate_tunables(t: &Tunables) {
    assert!(
        t.free_first_paints_per_account <= MAX_FREE_FIRST_PAINTS,
        "FreeFirstPaintsOutOfRange"
    );
    assert!(
        (MIN_HAPPY_HOUR_LENGTH_S..=MAX_HAPPY_HOUR_LENGTH_S).contains(&t.happy_hour_length_s),
        "HappyHourLengthOutOfRange"
    );
    assert!(
        (1..=MAX_HAPPY_HOUR_CAP).contains(&t.happy_hour_cap_per_account),
        "HappyHourCapOutOfRange"
    );
    assert!(t.happy_hour_weekday <= 6, "HappyHourWeekdayOutOfRange");
    assert!(
        (t.happy_hour_start_s as i128) < DAY_S,
        "HappyHourStartOutOfRange"
    );
}

/// Happy-hour switch rules for `set_tunables` (spec §F2). Turning it off, lowering the
/// cap or shortening the window is immediate. Turning it on, raising the cap,
/// lengthening the window, or moving it while on needs `HAPPY_HOUR_COOLDOWN_NS` since
/// the last such change, and restarts that cooldown. Writes the new history into `next`.
pub(crate) fn apply_happy_hour_change(old: &Tunables, next: &mut Tunables, now: u64) {
    let turned_on = next.happy_hour_enabled && !old.happy_hour_enabled;
    let moved = next.happy_hour_enabled
        && (next.happy_hour_weekday != old.happy_hour_weekday
            || next.happy_hour_start_s != old.happy_hour_start_s);
    let loosened = turned_on
        || moved
        || next.happy_hour_cap_per_account > old.happy_hour_cap_per_account
        || next.happy_hour_length_s > old.happy_hour_length_s;
    if !loosened {
        return;
    }
    if let Some(last) = old.last_happy_hour_change_ns {
        assert!(
            now.checked_sub(last)
                .is_some_and(|elapsed| elapsed >= HAPPY_HOUR_COOLDOWN_NS),
            "HappyHourCooldown"
        );
    }
    next.last_happy_hour_change_ns = Some(now);
}

impl Board {
    /// The open happy-hour window id, if any: latch set, switch on, inside the window.
    pub(crate) fn open_happy_hour(&self, now: u64) -> Option<u32> {
        if !self.first_fill_complete || !self.tunables.happy_hour_enabled {
            return None;
        }
        window_containing(&self.tunables, now).map(|(id, _, _)| id)
    }

    fn is_registered(&self, account: &AccountId) -> bool {
        self.payments.balances.contains_key(account)
    }

    fn happy_hour_eligible(&self, account: &AccountId, extra: &AccountExtra) -> bool {
        self.is_registered(account)
            && (!self.tunables.happy_hour_requires_purchase || extra.has_purchased)
    }

    /// Price a stroke of cell keys for `account` at `now`, entry by entry.
    ///
    /// An entry repeating an earlier key was just repainted by that entry, so it is
    /// priced at the young tier and is never an empty cell. Free first paints go to
    /// empty cells in order; happy hour covers base-tier cells in order. The two never
    /// overlap: one needs the latch unset, the other set. Free paints need a registered
    /// account. `account = None` prices without any free paints.
    pub(crate) fn plan_stroke(&self, account: Option<&AccountId>, keys: &[u32], now: u64) -> StrokePlan {
        let mut extra = account.map(|a| self.account_extra(a)).unwrap_or_default();
        let mut first_left: u32 = match account {
            Some(a) if !self.first_fill_complete && self.is_registered(a) => self
                .tunables
                .free_first_paints_per_account
                .saturating_sub(u32::from(extra.free_first_used)),
            _ => 0,
        };
        let mut happy_left: u32 = 0;
        if let (Some(a), Some(window)) = (account, self.open_happy_hour(now)) {
            if self.happy_hour_eligible(a, &extra) {
                if extra.happy_hour_window != window {
                    extra.happy_hour_window = window;
                    extra.happy_hour_used = 0;
                }
                happy_left = self
                    .tunables
                    .happy_hour_cap_per_account
                    .saturating_sub(u32::from(extra.happy_hour_used));
            }
        }

        let mut seen: Vec<u32> = Vec::with_capacity(keys.len());
        let mut cells = Vec::with_capacity(keys.len());
        let mut total: u128 = 0;
        let mut extra_changed = false;
        for &key in keys {
            let written = if seen.contains(&key) {
                Some(now)
            } else {
                seen.push(key);
                self.pixels.get(&key).map(|record| record.written_at_ns)
            };
            let price = if written.is_none() && first_left > 0 {
                first_left -= 1;
                extra.free_first_used += 1; // allowance ≤ 100 fits u8
                extra_changed = true;
                CellPrice { credits: 0, free: true }
            } else if happy_left > 0 && self.tunables.is_base_tier(now, written) {
                happy_left -= 1;
                extra.happy_hour_used += 1; // cap ≤ 1,000 fits u16
                extra_changed = true;
                CellPrice { credits: 0, free: true }
            } else {
                CellPrice {
                    credits: self.tunables.cost(now, written),
                    free: false,
                }
            };
            total = total.saturating_add(u128::from(price.credits));
            cells.push(price);
        }
        StrokePlan {
            cells,
            total,
            extra,
            extra_changed,
        }
    }
}

#[near]
impl Board {
    /// Price a stroke exactly as `draw_many` would charge `account_id` right now,
    /// including free first paints, happy hour and repeated cells. Pass `total` as
    /// `max_credits`. With no account, nothing is free. `get_cell_costs` is unchanged
    /// (per-cell tier price, no free paints, no duplicate handling).
    pub fn get_stroke_cost(&self, account_id: Option<AccountId>, cells: Vec<CellRef>) -> StrokeCostView {
        if cells.len() as u32 > MAX_DRAW_BATCH {
            crate::reject("StrokeTooLarge");
        }
        let mut keys = Vec::with_capacity(cells.len());
        let side = crate::board_side();
        for cell in &cells {
            if let Err(code) = crate::check_coordinate(cell.x, cell.y, side) {
                crate::reject(code);
            }
            keys.push(crate::pixel_key(cell.x, cell.y));
        }
        let plan = self.plan_stroke(account_id.as_ref(), &keys, env::block_timestamp());
        StrokeCostView {
            costs: plan.cells.iter().map(|c| c.credits).collect(),
            free: plan.cells.iter().map(|c| c.free).collect(),
            total: u32::try_from(plan.total).unwrap_or(u32::MAX),
        }
    }

    /// Free first paints (F1) for one account.
    pub fn get_free_first_paints(&self, account_id: AccountId) -> FreeFirstPaintsView {
        let used = u32::from(self.account_extra(&account_id).free_first_used);
        let allowance = self.tunables.free_first_paints_per_account;
        let active = !self.first_fill_complete && allowance > 0;
        let registered = self.is_registered(&account_id);
        FreeFirstPaintsView {
            used,
            remaining: if active && registered {
                allowance.saturating_sub(used)
            } else {
                0
            },
            active,
            allowance,
            registered,
        }
    }

    /// Happy hour (F2): whether it is open, the open (or next) window, and the
    /// account's use of it.
    pub fn get_happy_hour(&self, account_id: Option<AccountId>) -> HappyHourView {
        let now = env::block_timestamp();
        let t = &self.tunables;
        let window = self.open_happy_hour(now);
        let (start, end) = current_or_next_window(t, now);
        let (used, eligible) = match &account_id {
            Some(a) => {
                let extra = self.account_extra(a);
                let used = match window {
                    Some(id) if extra.happy_hour_window == id => u32::from(extra.happy_hour_used),
                    _ => 0,
                };
                (used, self.happy_hour_eligible(a, &extra))
            }
            None => (0, false),
        };
        HappyHourView {
            open: window.is_some(),
            enabled: t.happy_hour_enabled,
            first_fill_complete: self.first_fill_complete,
            window_start_ns: U64(start),
            window_end_ns: U64(end),
            used,
            cap: t.happy_hour_cap_per_account,
            remaining: if window.is_some() && eligible {
                t.happy_hour_cap_per_account.saturating_sub(used)
            } else {
                0
            },
            eligible,
            requires_purchase: t.happy_hour_requires_purchase,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DrawCell, PixelRecord, LAUNCH_SIDE};
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const S: u64 = 1_000_000_000;
    const MIN: u64 = 60 * S;
    const HOUR: u64 = 3_600 * S;
    const DAY: u64 = 86_400 * S;
    /// Sunday 1 Nov 2026, 00:00 UTC.
    const SUN_1_NOV_2026: u64 = 1_793_491_200 * S;
    /// Default window: Sunday 20:00–21:00 UTC.
    const OPEN: u64 = SUN_1_NOV_2026 + 20 * HOUR;
    const CLOSE: u64 = OPEN + HOUR;

    fn context(caller: usize, ts: u64) {
        // Room for the 16,383-record fill used by the latch test.
        let mut config = near_sdk::test_vm_config();
        config.limit_config.max_gas_burnt = config.limit_config.max_gas_burnt.checked_mul(1_000).unwrap();
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(accounts(4))
                .predecessor_account_id(accounts(caller))
                .attached_deposit(NearToken::from_yoctonear(1))
                .block_timestamp(ts)
                .prepaid_gas(near_sdk::Gas::from_gas(u64::MAX))
                .build(),
            config
        );
    }

    /// Owner accounts(0); accounts(1..=3) registered with 1,000 credits each.
    fn setup() -> Board {
        context(0, SUN_1_NOV_2026 - 7 * DAY);
        let mut board = Board::new(accounts(5), U128(100), crate::test_team(), crate::test_buyback(), crate::test_toilet());
        for i in 1..=3 {
            board.payments.balances.insert(accounts(i), 1_000);
        }
        board.payments.outstanding = 3_000;
        board
    }

    fn balance(board: &Board, who: usize) -> u128 {
        board.get_credits(accounts(who)).map_or(0, |v| v.0)
    }

    fn row(y: u32, n: u32, color: u32) -> Vec<DrawCell> {
        (0..n).map(|x| DrawCell { x, y, color }).collect()
    }

    fn cell(x: u32, y: u32) -> CellRef {
        CellRef { x, y }
    }

    fn rejected(code: &str, f: impl FnOnce()) {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
        let message = err
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains(code), "{message}");
    }

    /// The bottom-right cell of a fresh (`LAUNCH_SIDE`) board.
    const LAST: u32 = LAUNCH_SIDE - 1;

    /// Paint every cell except `(LAST, LAST)` as accounts(3), long ago, without
    /// charging anyone (raw paid records plus the matching holder and earning counts).
    fn fill_all_but_last(board: &mut Board) {
        let filler = accounts(3);
        let cells = (0..LAUNCH_SIDE)
            .flat_map(|y| (0..LAUNCH_SIDE).map(move |x| (x, y)))
            .filter(|&cell| cell != (LAST, LAST));
        for (x, y) in cells {
            board.pixels.insert(
                crate::pixel_key(x, y),
                PixelRecord {
                    color: 0,
                    artist: filler.clone(),
                    written_at_ns: 0,
                },
            );
        }
        let n = i64::from(LAUNCH_SIDE * LAUNCH_SIDE - 1);
        crate::adjust_holder(board, &filler, n, n);
    }

    /// Latch set and happy hour on, every test account a buyer.
    fn happy_board() -> Board {
        let mut board = setup();
        board.first_fill_complete = true;
        board.tunables.happy_hour_enabled = true;
        for i in 1..=3 {
            board.account_extra.insert(
                accounts(i),
                AccountExtra {
                    has_purchased: true,
                    ..AccountExtra::default()
                },
            );
        }
        board
    }

    // --- F1: free first paints -------------------------------------------

    #[test]
    fn f1_25th_free_paint_is_free_and_26th_is_charged() {
        let mut board = setup();
        context(1, SUN_1_NOV_2026);
        for x in 0..25 {
            board.draw(x, 0, 1, 0);
        }
        assert_eq!(balance(&board, 1), 1_000);
        assert_eq!(board.get_free_first_paints(accounts(1)).remaining, 0);
        rejected("PriceRoseAboveMax", || board.draw(25, 0, 1, 0));
        board.draw(25, 0, 1, 1);
        assert_eq!(balance(&board, 1), 999);
        assert!(board.free_cells.contains(&crate::pixel_key(24, 0)));
        assert!(!board.free_cells.contains(&crate::pixel_key(25, 0)));
    }

    #[test]
    fn f1_a_registered_account_with_no_credits_still_gets_its_free_paints() {
        let mut board = setup();
        board.payments.balances.insert(accounts(2), 0);
        context(2, SUN_1_NOV_2026);
        board.draw(0, 0, 3, 0);
        assert_eq!(board.get_pixel(0, 0).color, Some(3));
    }

    #[test]
    fn f1_an_unregistered_account_gets_no_free_paint() {
        let mut board = setup();
        context(5, SUN_1_NOV_2026);
        rejected("PriceRoseAboveMax", || board.draw(0, 0, 1, 0));
        rejected("AccountNotRegistered", || board.draw(0, 0, 1, 1));
        assert_eq!(board.get_free_first_paints(accounts(5)).remaining, 0);
    }

    #[test]
    fn f1_a_repaint_is_never_a_free_first_paint() {
        let mut board = setup();
        context(2, SUN_1_NOV_2026);
        board.draw(0, 0, 1, 0); // accounts(2)'s free first paint
        context(1, SUN_1_NOV_2026 + 2 * HOUR);
        // accounts(1) still has 25 free paints, but (0,0) is not empty.
        let quote = board.get_stroke_cost(Some(accounts(1)), vec![cell(0, 0)]);
        assert_eq!((quote.costs, quote.free), (vec![1], vec![false]));
        board.draw(0, 0, 2, 1);
        assert_eq!(balance(&board, 1), 999);
        assert_eq!(board.get_free_first_paints(accounts(1)).used, 0);
        // A repeated entry in one stroke is a repaint too: free, then young (4).
        board.draw_many(vec![DrawCell { x: 5, y: 5, color: 1 }, DrawCell { x: 5, y: 5, color: 2 }], 4);
        assert_eq!(balance(&board, 1), 995);
        assert_eq!(board.get_free_first_paints(accounts(1)).used, 1);
    }

    #[test]
    fn f1_a_stroke_of_30_empty_cells_charges_5() {
        let mut board = setup();
        context(1, SUN_1_NOV_2026);
        let quote = board.get_stroke_cost(Some(accounts(1)), (0..30).map(|x| cell(x, 0)).collect());
        assert_eq!(quote.total, 5);
        assert!(quote.free[..25].iter().all(|f| *f) && quote.free[25..].iter().all(|f| !*f));
        board.draw_many(row(0, 30, 2), 5);
        assert_eq!(balance(&board, 1), 995);
        let view = board.get_free_first_paints(accounts(1));
        assert_eq!((view.used, view.remaining, view.active), (25, 0, true));
    }

    #[test]
    fn f1_free_paints_go_to_empty_cells_in_stroke_order() {
        let mut board = setup();
        context(2, SUN_1_NOV_2026);
        board.draw(1, 0, 1, 0);
        board.tunables.free_first_paints_per_account = 2;
        context(1, SUN_1_NOV_2026 + 2 * HOUR);
        // (1,0) is painted (base repaint, 1); the first two empty cells are free.
        let quote = board.get_stroke_cost(
            Some(accounts(1)),
            vec![cell(1, 0), cell(0, 0), cell(2, 0), cell(3, 0)],
        );
        assert_eq!(quote.costs, vec![1, 0, 0, 1]);
    }

    #[test]
    fn f1_the_latch_sets_on_the_last_empty_cell_and_free_first_paints_stop() {
        let mut board = setup();
        fill_all_but_last(&mut board);
        context(1, SUN_1_NOV_2026);
        assert!(!board.first_fill_complete);
        assert!(board.get_free_first_paints(accounts(1)).active);
        board.draw(LAST, LAST, 4, 0); // last empty cell, free
        assert!(board.first_fill_complete);
        assert!(board.free_cells.contains(&crate::pixel_key(LAST, LAST)));
        let view = board.get_free_first_paints(accounts(1));
        assert_eq!((view.active, view.remaining, view.used), (false, 0, 1));
        // A base-tier repaint now costs the base rate.
        rejected("PriceRoseAboveMax", || board.draw(0, 0, 1, 0));
        board.draw(0, 0, 1, 1);
        assert_eq!(balance(&board, 1), 999);
        assert!(board.first_fill_complete);
    }

    #[test]
    fn f1_a_paid_repaint_clears_the_free_flag() {
        let mut board = setup();
        context(1, SUN_1_NOV_2026);
        board.draw(7, 7, 1, 0);
        let key = crate::pixel_key(7, 7);
        assert!(board.free_cells.contains(&key));
        context(2, SUN_1_NOV_2026 + 2 * HOUR);
        board.draw(7, 7, 2, 1);
        assert!(!board.free_cells.contains(&key));
        assert_eq!(balance(&board, 2), 999);
    }

    #[test]
    fn f1_free_first_paints_are_bounded_0_to_100_and_0_turns_them_off() {
        let mut board = setup();
        context(0, SUN_1_NOV_2026);
        let mut t = board.get_tunables();
        t.free_first_paints_per_account = 101;
        rejected("FreeFirstPaintsOutOfRange", || board.set_tunables(t.clone()));
        t.free_first_paints_per_account = 100;
        board.set_tunables(t.clone());
        t.free_first_paints_per_account = 0;
        board.set_tunables(t);
        assert!(!board.get_free_first_paints(accounts(1)).active);
        context(1, SUN_1_NOV_2026);
        rejected("PriceRoseAboveMax", || board.draw(0, 0, 1, 0));
    }

    // --- F2: week maths ----------------------------------------------------

    #[test]
    fn f2_1_jan_1970_was_a_thursday_and_weeks_start_on_monday() {
        assert_eq!(weekday(0), 3); // Thursday
        assert_eq!(weekday(DAY - 1), 3);
        assert_eq!(weekday(DAY), 4); // Friday 2 Jan 1970
        assert_eq!(weekday(4 * DAY), 0); // Monday 5 Jan 1970
        assert_eq!(week_index(0), 0);
        assert_eq!(week_index(4 * DAY - 1), 0); // Sunday 4 Jan, 23:59:59.999…
        assert_eq!(week_index(4 * DAY), 1); // Monday 5 Jan, 00:00
        assert_eq!(weekday(SUN_1_NOV_2026), 6);
        assert_eq!(weekday(SUN_1_NOV_2026 + DAY), 0); // Monday 2 Nov 2026
        assert_eq!(week_index(SUN_1_NOV_2026 + DAY), week_index(SUN_1_NOV_2026) + 1);
        assert_eq!(week_index(SUN_1_NOV_2026 + DAY - 1), week_index(SUN_1_NOV_2026));
        // The first window after the epoch: Sunday 4 Jan 1970, 20:00.
        let t = Tunables::default();
        assert_eq!(current_or_next_window(&t, 0).0, (3 * 86_400 + 72_000) * S);
    }

    #[test]
    fn f2_window_start_is_inclusive_and_end_exclusive() {
        let t = Tunables::default();
        assert_eq!(window_containing(&t, OPEN - 1), None);
        assert_eq!(window_containing(&t, OPEN).map(|w| (w.1, w.2)), Some((OPEN, CLOSE)));
        assert!(window_containing(&t, CLOSE - 1).is_some());
        assert_eq!(window_containing(&t, CLOSE), None);
        assert_eq!(current_or_next_window(&t, OPEN - 1), (OPEN, CLOSE));
        assert_eq!(current_or_next_window(&t, CLOSE), (OPEN + 7 * DAY, CLOSE + 7 * DAY));

        let mut board = happy_board();
        context(1, OPEN - 1);
        board.draw(0, 0, 1, 1); // charged: one ns early
        context(1, OPEN);
        board.draw(1, 0, 1, 0); // free
        context(1, CLOSE - 1);
        board.draw(2, 0, 1, 0); // free
        context(1, CLOSE);
        rejected("PriceRoseAboveMax", || board.draw(3, 0, 1, 0));
        assert_eq!(balance(&board, 1), 999);
    }

    #[test]
    fn f2_a_sunday_night_window_runs_past_midnight_into_monday() {
        let t = Tunables {
            happy_hour_start_s: 23 * 3_600 + 1_800, // Sunday 23:30, 1 h
            ..Tunables::default()
        };
        let monday = SUN_1_NOV_2026 + DAY;
        let (id, start, end) = window_containing(&t, monday + 10 * MIN).expect("still open");
        assert_eq!(id, week_index(SUN_1_NOV_2026)); // the week it started in
        assert_eq!((start, end), (monday - 30 * MIN, monday + 30 * MIN));
        assert_eq!(window_containing(&t, monday + 30 * MIN), None);
    }

    // --- F2: pricing ---------------------------------------------------------

    #[test]
    fn f2_cap_per_account_per_window_then_reset_the_next_week() {
        let mut board = happy_board();
        board.tunables.happy_hour_cap_per_account = 3;
        context(1, OPEN + MIN);
        board.draw_many(row(0, 5, 1), 2); // 3 free, 2 paid
        assert_eq!(balance(&board, 1), 998);
        let view = board.get_happy_hour(Some(accounts(1)));
        assert_eq!((view.open, view.used, view.cap, view.remaining), (true, 3, 3, 0));
        // Another account has its own cap.
        context(2, OPEN + 2 * MIN);
        board.draw_many(row(1, 3, 1), 0);
        // Next week the counter starts again.
        context(1, OPEN + 7 * DAY);
        assert_eq!(board.get_happy_hour(Some(accounts(1))).used, 0);
        board.draw_many(row(2, 3, 1), 0);
        assert_eq!(balance(&board, 1), 998);
        assert_eq!(board.account_extra(&accounts(1)).happy_hour_window, week_index(OPEN + 7 * DAY));
    }

    /// §B1: a free happy-hour repaint of a paid cell stops that cell earning,
    /// for another artist and for the same artist alike.
    #[test]
    fn f2_a_free_repaint_of_a_paid_cell_stops_its_earning() {
        let mut board = happy_board();
        board.tunables.toilet_per_cell_second = 7;
        context(2, OPEN - 2 * HOUR);
        board.draw_many(row(0, 2, 1), u32::MAX); // two paid cells
        assert_eq!(balance(&board, 2), 998);
        assert_eq!(board.total_earning, 2);
        context(1, OPEN);
        board.draw(0, 0, 2, 0); // free, another artist
        context(2, OPEN);
        board.draw(1, 0, 2, 0); // free, same artist
        assert_eq!(balance(&board, 1), 1_000);
        assert_eq!(balance(&board, 2), 998);
        assert_eq!((board.total_cells, board.total_earning), (2, 0));
        context(2, OPEN + 10 * S);
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
        assert_eq!(board.get_pending_toilet(accounts(2)), U128(2 * 7 * 7_200));
    }

    #[test]
    fn f2_mid_and_young_cells_are_charged_during_the_window() {
        let mut board = happy_board();
        context(2, OPEN - 15 * MIN);
        board.draw(0, 0, 1, u32::MAX); // mid tier at OPEN
        context(2, OPEN - MIN);
        board.draw(1, 0, 1, u32::MAX); // young tier at OPEN
        context(1, OPEN);
        let quote = board.get_stroke_cost(Some(accounts(1)), vec![cell(0, 0), cell(1, 0), cell(2, 0)]);
        assert_eq!(quote.costs, vec![2, 4, 0]);
        assert_eq!(quote.free, vec![false, false, true]);
        board.draw_many(row(0, 3, 5), 6);
        assert_eq!(balance(&board, 1), 994);
        assert!(!board.free_cells.contains(&crate::pixel_key(0, 0)));
        assert!(board.free_cells.contains(&crate::pixel_key(2, 0)));
    }

    #[test]
    fn f2_non_buyers_are_charged_when_the_purchase_flag_is_on() {
        let mut board = happy_board();
        board.account_extra.remove(&accounts(1));
        context(1, OPEN);
        assert!(!board.get_happy_hour(Some(accounts(1))).eligible);
        rejected("PriceRoseAboveMax", || board.draw(0, 0, 1, 0));
        board.draw(0, 0, 1, 1);
        // With the flag off, any registered account qualifies.
        board.tunables.happy_hour_requires_purchase = false;
        board.draw(1, 0, 1, 0);
        assert_eq!(balance(&board, 1), 999);
        // Unregistered accounts never do.
        context(5, OPEN);
        rejected("PriceRoseAboveMax", || board.draw(2, 0, 1, 0));
    }

    #[test]
    fn f2_the_window_is_closed_before_the_latch() {
        let mut board = happy_board();
        board.first_fill_complete = false;
        board.tunables.free_first_paints_per_account = 0;
        context(1, OPEN);
        let view = board.get_happy_hour(Some(accounts(1)));
        assert!(!view.open && view.enabled && !view.first_fill_complete);
        rejected("PriceRoseAboveMax", || board.draw(0, 0, 1, 0));
    }

    #[test]
    fn f2_switching_off_takes_effect_in_the_same_block() {
        let mut board = happy_board();
        board.tunables.last_happy_hour_change_ns = Some(OPEN - MIN); // inside the cooldown
        context(1, OPEN);
        board.draw(0, 0, 1, 0);
        context(0, OPEN);
        let mut t = board.get_tunables();
        t.happy_hour_enabled = false;
        board.set_tunables(t);
        assert!(!board.get_happy_hour(None).open);
        context(1, OPEN);
        rejected("PriceRoseAboveMax", || board.draw(1, 0, 1, 0));
        // Switching off does not restart the cooldown.
        assert_eq!(board.get_tunables().last_happy_hour_change_ns, Some(OPEN - MIN));
    }

    #[test]
    fn f2_turning_on_raising_the_cap_or_lengthening_needs_the_24h_cooldown_and_restarts_it() {
        let mut board = setup();
        let t0 = SUN_1_NOV_2026;
        context(0, t0);
        let mut t = board.get_tunables();
        t.happy_hour_enabled = true;
        board.set_tunables(t.clone()); // first change: no history, allowed
        assert_eq!(board.get_tunables().last_happy_hour_change_ns, Some(t0));
        t.last_happy_hour_change_ns = Some(t0);

        context(0, t0 + DAY - 1);
        let mut raise = t.clone();
        raise.happy_hour_cap_per_account = 200;
        rejected("HappyHourCooldown", || board.set_tunables(raise));
        let mut longer = t.clone();
        longer.happy_hour_length_s = 7_200;
        rejected("HappyHourCooldown", || board.set_tunables(longer));
        let mut moved = t.clone();
        moved.happy_hour_weekday = 5;
        rejected("HappyHourCooldown", || board.set_tunables(moved));
        // Lowering and shortening are immediate and do not restart it.
        let mut lower = t.clone();
        lower.happy_hour_cap_per_account = 50;
        lower.happy_hour_length_s = 1_800;
        board.set_tunables(lower.clone());
        assert_eq!(board.get_tunables().last_happy_hour_change_ns, Some(t0));

        context(0, t0 + DAY);
        lower.happy_hour_cap_per_account = 200;
        board.set_tunables(lower.clone());
        assert_eq!(board.get_tunables().last_happy_hour_change_ns, Some(t0 + DAY));
        // Off, then on again inside the restarted cooldown: on is refused.
        lower.last_happy_hour_change_ns = Some(t0 + DAY);
        lower.happy_hour_enabled = false;
        board.set_tunables(lower.clone());
        lower.happy_hour_enabled = true;
        rejected("HappyHourCooldown", || board.set_tunables(lower));
    }

    #[test]
    fn f2_happy_hour_bounds_are_rejected_each_with_its_own_code() {
        let mut board = setup();
        context(0, SUN_1_NOV_2026);
        let base = board.get_tunables();
        for (code, t) in [
            ("HappyHourLengthOutOfRange", Tunables { happy_hour_length_s: 899, ..base.clone() }),
            ("HappyHourLengthOutOfRange", Tunables { happy_hour_length_s: 86_401, ..base.clone() }),
            ("HappyHourCapOutOfRange", Tunables { happy_hour_cap_per_account: 0, ..base.clone() }),
            ("HappyHourCapOutOfRange", Tunables { happy_hour_cap_per_account: 1_001, ..base.clone() }),
            ("HappyHourWeekdayOutOfRange", Tunables { happy_hour_weekday: 7, ..base.clone() }),
            ("HappyHourStartOutOfRange", Tunables { happy_hour_start_s: 86_400, ..base.clone() }),
        ] {
            rejected(code, || board.set_tunables(t));
        }
        board.set_tunables(Tunables {
            happy_hour_length_s: 900,
            happy_hour_cap_per_account: 1,
            happy_hour_weekday: 0,
            happy_hour_start_s: 86_399,
            ..base
        });
    }

    #[test]
    fn f2_get_happy_hour_reports_the_open_or_next_window() {
        let mut board = happy_board();
        context(1, OPEN - HOUR);
        let closed = board.get_happy_hour(Some(accounts(1)));
        assert!(!closed.open && closed.eligible);
        assert_eq!((closed.window_start_ns.0, closed.window_end_ns.0), (OPEN, CLOSE));
        assert_eq!((closed.used, closed.remaining, closed.cap), (0, 0, 100));
        context(1, OPEN + MIN);
        board.draw(0, 0, 1, 0);
        let open = board.get_happy_hour(Some(accounts(1)));
        assert!(open.open);
        assert_eq!((open.used, open.remaining), (1, 99));
        let anon = board.get_happy_hour(None);
        assert!(anon.open && !anon.eligible);
        assert_eq!((anon.used, anon.remaining), (0, 0));
    }
}
