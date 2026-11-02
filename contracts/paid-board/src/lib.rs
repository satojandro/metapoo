//! Meta Poo paid pixel board (fresh schema 4).
//!
//! A smart contract is a program that a blockchain runs. People call its
//! change methods with signed transactions. This crate:
//! - describes a 128 by 128 board and a 16-color palette
//! - stores only painted cells (sparse storage)
//! - lets funded callers paint in-range cells at one credit per entry
//! - pages every currently painted cell for readers (`get_pixels`)
//!
//! Geometry matches `shared/board.json`; schema 4 is a separate paid deployment.
//! Do not deploy until an explicit review. Local `cargo test` is not a
//! testnet or mainnet result.

mod emission;
mod free_paint;
mod migrate;
mod payments;
mod revenue;
mod safety;
use emission::Holder;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, PanicOnDefault};
use payments::Payments;

/// Storage prefixes. `p`, `h` and `c` are deployed with live data: never change
/// their prefix or value type (spec §C7, Finding 3). New facts get new prefixes.
/// `h` values only ever grow at the end, and still decode a version-1 record
/// (see `emission::Holder`).
const PREFIX_PIXELS: &[u8] = b"p";
const PREFIX_HOLDERS: &[u8] = b"h";
const PREFIX_ACCOUNT_EXTRA: &[u8] = b"a";
const PREFIX_FREE_CELLS: &[u8] = b"f";

/// Board width in pixels. Coordinate x must be 0 through 127.
const WIDTH: u32 = 128;
/// Board height in pixels. Coordinate y must be 0 through 127.
const HEIGHT: u32 = 128;
/// (0, 0) is the top-left square. x grows to the right. y grows downward.
const ORIGIN: &str = "top-left";
/// Accepted product rule: any account may paint any cell.
const OVERWRITE_RULE: &str = "open_wall";
/// Schema 4 adds purchased credits; never deserialize schema 2 state as this type.
const SCHEMA_VERSION: u32 = 4;
/// Hard cap so one view call cannot try to return the whole wall at once.
const MAX_PIXELS_PAGE: u32 = 256;
/// Hard cap on cells in one `draw_many` call.
///
/// A stroke is a short drag, not a whole canvas. Keeping the call bounded keeps
/// the transaction under the network gas limit and makes the stroke atomic: one
/// transaction stores every cell of the stroke, or none of them.
const MAX_DRAW_BATCH: u32 = 64;

/// C1: no repaint tier may cost more than this many credits.
const MAX_REPAINT_CREDITS: u32 = 8;
/// C1: the mid-tier window (and so the young one) is at most 24 hours.
const MAX_REPAINT_WINDOW_NS: u64 = 86_400_000_000_000;
/// C8: `mpoo_daily_credit_cap` is at most this many credits a day.
const MAX_MPOO_DAILY_CREDIT_CAP: u128 = 1_000_000;
/// REV-G: `distribution_interval_ns` is at least 10 minutes …
const MIN_DISTRIBUTION_INTERVAL_NS: u64 = 600_000_000_000;
/// … and at most 24 hours, so the owner cannot freeze revenue sharing for years.
const MAX_DISTRIBUTION_INTERVAL_NS: u64 = 86_400_000_000_000;

/// One cell inside a batched stroke.
///
/// `draw_many` takes a list of these so a drag costs one wallet approval
/// instead of one approval per pixel, which is the difference between a paint
/// moment and a signing chore.
#[near(serializers = [json, borsh])]
pub struct DrawCell {
    pub x: u32,
    pub y: u32,
    pub color: u32,
}

/// One cell in a batched price request.
///
/// The client prices a whole stroke in one call instead of one call per cell:
/// `get_cell_cost` per painted cell costs two round-trips each and stalls a
/// 64-cell drag behind ~129 of them before the wallet prompt.
#[near(serializers = [json])]
pub struct CellRef {
    pub x: u32,
    pub y: u32,
}

/// Index 0 is Ink, a real paint color. An unpainted square is not index 0.
/// Names and hex values match `shared/palette.ts`. Change both together.
/// Indices 8-15 are Grime & Gum (spec §P1); existing cells keep their index.
const PALETTE: [(&str, &str); 16] = [
    ("Ink", "#1c1917"),
    ("Paper", "#f4efe4"),
    ("Brick", "#b23a2f"),
    ("Marigold", "#e0a100"),
    ("Moss", "#3d7a4a"),
    ("River", "#2f6f8f"),
    ("Grape", "#6b4c7a"),
    ("Clay", "#c47b5a"),
    ("Grout", "#8a857c"),
    ("Rust", "#7a4528"),
    ("Nicotine", "#ecd9a0"),
    ("Bubblegum", "#ec8fb0"),
    ("Bleach", "#9ccbdc"),
    ("Bruise", "#263552"),
    ("Bile", "#9fb53a"),
    ("Cone", "#ef7a2c"),
];

/// One named paint color returned to the page.
#[near(serializers = [json])]
pub struct PaletteColor {
    pub index: u32,
    pub name: String,
    pub hex: String,
}

/// Every knob the game is expected to tune. Stored from the first deployment so
/// changing a rule is an owner call, not a contract upgrade plus a migration.
/// A limit of `0` disables that optional rule.
///
/// `max_outstanding_credits` is deliberately a plain `u128`: it counts credits,
/// not token amounts, so it stays far inside JavaScript's safe integer range.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tunables {
    /// Emergency stop. Pausing stops painting (`draw`, `draw_many`, free paints
    /// included) and buying credits with NEAR or mPOO (an mPOO purchase is refunded).
    /// Views keep answering, and `distribute_near`, `distribute_mpoo` and the
    /// buyback's mPOO revenue transfers keep running (owner, 2 Nov): pause stops
    /// paint, not revenue.
    pub paused: bool,
    /// Additional liquid NEAR retained after existing storage and credit obligations.
    pub reserve_floor: near_sdk::json_types::U128,
    /// Minimum time between NEAR price changes (v1 `price_cooldown_ns`).
    pub near_price_cooldown_ns: u64,
    /// None permits the first price change, including at timestamp zero.
    /// History, not a knob: `set_tunables` refuses to change it.
    pub last_near_price_change_ns: Option<u64>,
    /// Minimum time between mPOO price changes (C8), checked by `set_mpoo_price`.
    pub mpoo_price_cooldown_ns: u64,
    /// History, not a knob: `set_tunables` refuses to change it.
    pub last_mpoo_price_change_ns: Option<u64>,
    /// A cell repainted within this many nanoseconds costs the "young" rate.
    pub repaint_young_ns: u64,
    pub repaint_young_credits: u32,
    /// A cell repainted within this many nanoseconds costs the "mid" rate.
    pub repaint_mid_ns: u64,
    pub repaint_mid_credits: u32,
    /// First paint of an empty cell, and any repaint older than `repaint_mid_ns`.
    pub repaint_base_credits: u32,
    /// Ceiling on credits sold and not yet spent. 0 = uncapped.
    pub max_outstanding_credits: u128,
    /// Daily paint allowance: `min(quota_max, quota_base + quota_per_cell × cells_owned)`.
    /// Stored now, enforced by the quota change; `quota_max = 0` disables it.
    pub quota_base: u32,
    pub quota_per_cell: u32,
    pub quota_max: u32,
    /// Atomic TOILET units per earning cell per second; zero disables emission.
    /// Changed only by `set_toilet_rate`; `set_tunables` refuses it (`RateViaSetter`).
    pub toilet_per_cell_second: u128,
    // ---- Revision 2 (state version 2). Stored at defaults by REV-A; the
    // ---- behaviour that reads them lands in REV-B/C/D. Nothing reads them yet.
    /// C8: credits that may be sold for mPOO per UTC day. 0 = mPOO sales closed.
    pub mpoo_daily_credit_cap: u128,
    /// F1: free first paints per account until the first fill. 0 = off.
    pub free_first_paints_per_account: u32,
    /// F2: weekly happy hour. Off by default.
    pub happy_hour_enabled: bool,
    /// 0 = Monday … 6 = Sunday.
    pub happy_hour_weekday: u32,
    /// Seconds after midnight UTC.
    pub happy_hour_start_s: u32,
    pub happy_hour_length_s: u32,
    pub happy_hour_cap_per_account: u32,
    pub happy_hour_requires_purchase: bool,
    /// History for the happy-hour cooldown; `set_tunables` refuses to change it.
    pub last_happy_hour_change_ns: Option<u64>,
    /// R1/R2: minimum time between `distribute_near` (or `distribute_mpoo`) calls.
    /// 10 minutes through 24 hours inclusive (`DistributionIntervalOutOfRange`).
    pub distribution_interval_ns: u64,
}

impl Tunables {
    /// Credits needed to paint a cell last written at `written_at`, evaluated at
    /// `now`. An empty cell always costs the base rate: claiming new ground is
    /// never the expensive action, hammering a cell someone just painted is.
    pub fn cost(&self, now: u64, written_at: Option<u64>) -> u32 {
        let Some(written_at) = written_at else {
            return self.repaint_base_credits;
        };
        let age = now.saturating_sub(written_at);
        if age < self.repaint_young_ns {
            self.repaint_young_credits
        } else if age < self.repaint_mid_ns {
            self.repaint_mid_credits
        } else {
            self.repaint_base_credits
        }
    }

    /// True when no NEAR price change happened within `near_price_cooldown_ns`.
    pub(crate) fn near_price_cooldown_elapsed(&self, now: u64) -> bool {
        cooldown_elapsed(
            self.last_near_price_change_ns,
            self.near_price_cooldown_ns,
            now,
        )
    }

    /// True when no mPOO price change happened within `mpoo_price_cooldown_ns`.
    pub(crate) fn mpoo_price_cooldown_elapsed(&self, now: u64) -> bool {
        cooldown_elapsed(
            self.last_mpoo_price_change_ns,
            self.mpoo_price_cooldown_ns,
            now,
        )
    }

    /// True when a cell last written at `written_at` is at the base tier at `now`:
    /// empty, or older than `repaint_mid_ns`. Happy hour (F2) frees only these.
    pub fn is_base_tier(&self, now: u64, written_at: Option<u64>) -> bool {
        written_at.is_none_or(|w| now.saturating_sub(w) >= self.repaint_mid_ns)
    }

    fn validate(&self) {
        free_paint::validate_tunables(self);
        assert!(
            self.reserve_floor.0 >= safety::MIN_RESERVE,
            "ReserveFloorTooLow"
        );
        assert!(
            self.near_price_cooldown_ns >= safety::MIN_COOLDOWN_NS
                && self.mpoo_price_cooldown_ns >= safety::MIN_COOLDOWN_NS,
            "PriceCooldownTooShort"
        );
        // C1: a compromised or careless owner key cannot multiply every pixel's
        // price by 1000 in one call. 8 is the ceiling for the most expensive tier.
        assert!(
            [
                self.repaint_base_credits,
                self.repaint_mid_credits,
                self.repaint_young_credits,
            ]
            .iter()
            .all(|credits| (1..=MAX_REPAINT_CREDITS).contains(credits)),
            "RepaintCreditsOutOfRange"
        );
        assert!(
            self.repaint_base_credits <= self.repaint_mid_credits
                && self.repaint_mid_credits <= self.repaint_young_credits,
            "RepaintCreditsOutOfOrder"
        );
        assert!(
            self.repaint_young_ns <= self.repaint_mid_ns,
            "RepaintTiersOutOfOrder"
        );
        assert!(
            self.repaint_mid_ns <= MAX_REPAINT_WINDOW_NS,
            "RepaintWindowTooLong"
        );
        assert!(
            self.mpoo_daily_credit_cap <= MAX_MPOO_DAILY_CREDIT_CAP,
            "MpooDailyCapTooHigh"
        );
        assert!(
            self.toilet_per_cell_second <= emission::MAX_RATE,
            "ToiletRateTooHigh"
        );
        if self.quota_max > 0 {
            assert!(self.quota_base <= self.quota_max, "QuotaBaseAboveMax");
        }
        assert!(
            (MIN_DISTRIBUTION_INTERVAL_NS..=MAX_DISTRIBUTION_INTERVAL_NS)
                .contains(&self.distribution_interval_ns),
            "DistributionIntervalOutOfRange"
        );
    }

    /// `{field, old, new}` for every field whose value differs between `old` and
    /// `self`, in declaration order. Values use the same JSON as `get_tunables`; a
    /// `u128` too large for a JSON number is written as a decimal string.
    fn changes_from(&self, old: &Tunables) -> Vec<near_sdk::serde_json::Value> {
        macro_rules! diff {
            ($($field:ident),* $(,)?) => {{
                // Exhaustive on purpose: adding or removing a field without listing
                // it here fails to compile, so the event can never silently miss one.
                let Tunables { $($field: _),* } = self;
                let mut changed = Vec::new();
                $(
                    if self.$field != old.$field {
                        changed.push(near_sdk::serde_json::json!({
                            "field": stringify!($field),
                            "old": event_value(&old.$field),
                            "new": event_value(&self.$field),
                        }));
                    }
                )*
                changed
            }};
        }
        diff!(
            paused,
            reserve_floor,
            near_price_cooldown_ns,
            last_near_price_change_ns,
            mpoo_price_cooldown_ns,
            last_mpoo_price_change_ns,
            repaint_young_ns,
            repaint_young_credits,
            repaint_mid_ns,
            repaint_mid_credits,
            repaint_base_credits,
            max_outstanding_credits,
            quota_base,
            quota_per_cell,
            quota_max,
            toilet_per_cell_second,
            mpoo_daily_credit_cap,
            free_first_paints_per_account,
            happy_hour_enabled,
            happy_hour_weekday,
            happy_hour_start_s,
            happy_hour_length_s,
            happy_hour_cap_per_account,
            happy_hour_requires_purchase,
            last_happy_hour_change_ns,
            distribution_interval_ns,
        )
    }
}

/// One tunable value as event JSON. Only a `u128` above `u64::MAX` fails
/// `to_value` (no arbitrary precision); it falls back to its decimal string
/// rather than failing the owner's call.
fn event_value<T: near_sdk::serde::Serialize>(value: &T) -> near_sdk::serde_json::Value {
    near_sdk::serde_json::to_value(value).unwrap_or_else(|_| {
        near_sdk::serde_json::Value::String(
            near_sdk::serde_json::to_string(value)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
        )
    })
}

impl Default for Tunables {
    fn default() -> Self {
        Self {
            paused: false,
            reserve_floor: near_sdk::json_types::U128(safety::MIN_RESERVE),
            near_price_cooldown_ns: safety::MIN_COOLDOWN_NS,
            last_near_price_change_ns: None,
            mpoo_price_cooldown_ns: safety::MIN_COOLDOWN_NS,
            last_mpoo_price_change_ns: None,
            repaint_young_ns: 600_000_000_000, // 10 minutes
            repaint_young_credits: 4,
            repaint_mid_ns: 3_600_000_000_000, // 60 minutes
            repaint_mid_credits: 2,
            repaint_base_credits: 1,
            max_outstanding_credits: 0, // uncapped at launch
            quota_base: 32,
            quota_per_cell: 4,
            quota_max: 512,
            toilet_per_cell_second: 0,
            mpoo_daily_credit_cap: 0, // mPOO sales closed until the owner sets a cap
            free_first_paints_per_account: 25,
            happy_hour_enabled: false,
            happy_hour_weekday: 6,      // Sunday
            happy_hour_start_s: 72_000, // 20:00 UTC
            happy_hour_length_s: 3_600,
            happy_hour_cap_per_account: 100,
            happy_hour_requires_purchase: true,
            last_happy_hour_change_ns: None,
            distribution_interval_ns: 3_600_000_000_000, // 1 hour
        }
    }
}

/// Per-account facts added by revision 2, in the map under prefix `a`.
/// Absent means all zeros: no migration ever has to visit every account.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccountExtra {
    /// F1: free first paints already used.
    pub free_first_used: u8,
    /// F2: set by any successful credit purchase, NEAR or mPOO.
    pub has_purchased: bool,
    /// F2: which happy-hour window `happy_hour_used` counts for.
    pub happy_hour_window: u32,
    /// F2: free cells used in `happy_hour_window`.
    pub happy_hour_used: u16,
}

/// What `get_board` returns. Field names stay snake_case, matching NEAR's usual JSON.
#[near(serializers = [json])]
pub struct BoardView {
    pub schema_version: u32,
    pub width: u32,
    pub height: u32,
    pub origin: String,
    pub overwrite_rule: String,
    /// Always false here. Sponsorship is a later, separate service.
    pub sponsorship_enabled: bool,
    pub palette: Vec<PaletteColor>,
}

/// What `get_pixel` returns. Null fields mean "nothing has been stored".
#[near(serializers = [json])]
pub struct PixelView {
    pub x: u32,
    pub y: u32,
    pub color: Option<u32>,
    /// Attribution only. Open wall does not treat artist as an access right.
    pub artist: Option<String>,
    /// Nanoseconds, the unit NEAR uses for block time.
    pub written_at_ns: Option<u64>,
}

/// One currently painted cell. Only cells with a stored record appear here.
/// After an overwrite, this is the latest color and artist (still one entry).
#[near(serializers = [json])]
pub struct PaintedPixelView {
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub artist: String,
    pub written_at_ns: u64,
}

/// One page of painted pixels from `get_pixels`.
#[near(serializers = [json])]
pub struct PixelsPage {
    pub pixels: Vec<PaintedPixelView>,
    /// Index into the painted-cell list where this page started.
    pub from_index: u32,
    /// Limit after clamping to `MAX_PIXELS_PAGE`.
    pub limit: u32,
    /// How many painted cells exist right now (not board width×height).
    pub total: u32,
    /// Next `from_index` to request, or `None` when this page finished the list.
    pub next_from_index: Option<u32>,
}

/// One painted cell in contract storage. Value type of map `p`: never change it.
#[near(serializers = [borsh])]
pub(crate) struct PixelRecord {
    color: u32,
    artist: AccountId,
    written_at_ns: u64,
}

/// On-chain state. NEAR saves this between calls.
///
/// Empty pixels are not saved one by one. Saving all 16,384 squares up front
/// would spend storage before anyone paints.
///
/// `IterableMap` (not `LookupMap`) keeps keys so `get_pixels` can walk every
/// painted cell exactly once.
///
/// Layout version 2. `state_version` must stay the first field: `migrate` tells
/// layouts apart by the first four bytes of the state (see `migrate.rs`).
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    /// Storage layout version. v1 (deployed 2026-10-29) had no such field.
    state_version: u32,
    /// Public API schema reported by `get_board` (4). Not the storage layout.
    schema_version: u32,
    payments: Payments,
    /// Every tunable rule. Everything here can change without a code upgrade.
    tunables: Tunables,
    /// Key is `y * WIDTH + x`. Only painted cells appear here.
    pixels: IterableMap<u32, PixelRecord>,
    /// Ownership and settled emission survive even after the last cell is lost.
    holders: LookupMap<AccountId, Holder>,
    acc_per_cell: u128,
    last_accrual_ns: u64,
    accrued_total: u128,
    total_cells: u32,
    /// F1 latch: true once every cell has been painted. Never goes back.
    first_fill_complete: bool,
    /// Revision-2 per-account facts, prefix `a`. Read with `account_extra()`.
    account_extra: LookupMap<AccountId, AccountExtra>,
    /// Cells whose latest paint was free (F1/F2), prefix `f`. Key as `pixels`.
    free_cells: LookupSet<u32>,
    /// B1: painted cells whose latest paint was paid with credits (not in
    /// `free_cells`). Accrual divides by this, not by `total_cells`.
    total_earning: u32,
    /// B4: the TOILET token, fixed at `new`. `claim_toilet` mints on it and
    /// `set_toilet_paused` targets it; no caller chooses it.
    toilet_token: AccountId,
    /// B3: when the rate was last set to a non-zero value.
    last_toilet_rate_change_ns: Option<u64>,
    /// B3: the last non-zero rate; bounds a switch-on after an emergency stop.
    last_nonzero_toilet_rate: u128,
}

#[near]
impl Board {
    /// Create a fresh paid board (state version 2) at 0.0025 NEAR per credit and an
    /// explicit mPOO price. Revenue accounts are fixed here; changing them later is
    /// an owner call with a cooldown (REV-C). `toilet` is the TOILET token this
    /// board mints on, fixed for the board's life (§B4). Never call `new` over live
    /// state: an existing board moves forward with `upgrade` → `migrate`.
    #[init]
    pub fn new(
        mpoo_token: AccountId,
        mpoo_per_credit: near_sdk::json_types::U128,
        team_account: AccountId,
        buyback_account: AccountId,
        toilet: AccountId,
    ) -> Self {
        Self {
            state_version: migrate::STATE_VERSION,
            schema_version: SCHEMA_VERSION,
            payments: Payments::new(
                mpoo_token,
                payments::INITIAL_NEAR_PRICE,
                mpoo_per_credit.0,
                team_account,
                buyback_account,
            ),
            tunables: Tunables::default(),
            pixels: IterableMap::new(PREFIX_PIXELS),
            holders: LookupMap::new(PREFIX_HOLDERS),
            acc_per_cell: 0,
            last_accrual_ns: env::block_timestamp(),
            accrued_total: 0,
            total_cells: 0,
            first_fill_complete: false,
            account_extra: LookupMap::new(PREFIX_ACCOUNT_EXTRA),
            free_cells: LookupSet::new(PREFIX_FREE_CELLS),
            total_earning: 0,
            toilet_token: toilet,
            last_toilet_rate_change_ns: None,
            last_nonzero_toilet_rate: 0,
        }
    }

    /// Move version-1 state to version 2. Called by `upgrade` in the same receipt as
    /// the code deploy; `#[private]` so only this account can run it.
    ///
    /// Reads the raw state, accepts only version 1 and rejects anything else with
    /// `UnsupportedStateVersion` (including a second run). Existing maps keep their
    /// prefixes and contents; the new fields start at their defaults.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(team_account: AccountId, buyback_account: AccountId, toilet: AccountId) -> Self {
        let v1 = migrate::read_v1();
        let board = Self::from_v1(v1, team_account, buyback_account, toilet);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"mpoo_board\",\"version\":\"1.0.0\",\"event\":\"state_migrated\",\"data\":[{{\"from\":1,\"to\":{}}}]}}",
            migrate::STATE_VERSION
        ));
        board
    }

    /// Storage layout version: 2 for this code. Lets a rehearsal prove the migration ran.
    pub fn get_state_version(&self) -> u32 {
        self.state_version
    }

    /// Read the board description. A view method does not change state.
    pub fn get_board(&self) -> BoardView {
        BoardView {
            schema_version: self.schema_version,
            width: WIDTH,
            height: HEIGHT,
            origin: ORIGIN.to_string(),
            overwrite_rule: OVERWRITE_RULE.to_string(),
            sponsorship_enabled: false,
            palette: PALETTE
                .iter()
                .enumerate()
                .map(|(index, (name, hex))| PaletteColor {
                    index: index as u32,
                    name: (*name).to_string(),
                    hex: (*hex).to_string(),
                })
                .collect(),
        }
    }

    /// Read one square. Missing storage means the square is unpainted.
    pub fn get_pixel(&self, x: u32, y: u32) -> PixelView {
        if let Err(code) = check_coordinate(x, y) {
            reject(code);
        }
        match self.pixels.get(&pixel_key(x, y)) {
            Some(record) => PixelView {
                x,
                y,
                color: Some(record.color),
                artist: Some(record.artist.to_string()),
                written_at_ns: Some(record.written_at_ns),
            },
            None => PixelView {
                x,
                y,
                color: None,
                artist: None,
                written_at_ns: None,
            },
        }
    }

    /// Page through every currently painted cell exactly once.
    ///
    /// Overwrites replace the same map entry, so a cell never appears twice
    /// and the listed color/artist are always the latest successful write.
    /// Unpainted cells are omitted (they have no storage record).
    ///
    /// Call again with `next_from_index` until it is `null`.
    pub fn get_pixels(&self, from_index: u32, limit: u32) -> PixelsPage {
        let total = self.pixels.len();
        let limit = limit.min(MAX_PIXELS_PAGE);

        let mut pixels = Vec::new();
        for (key, record) in self
            .pixels
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
        {
            let key = *key;
            let x = key % WIDTH;
            let y = key / WIDTH;
            pixels.push(PaintedPixelView {
                x,
                y,
                color: record.color,
                artist: record.artist.to_string(),
                written_at_ns: record.written_at_ns,
            });
        }

        let consumed = from_index.saturating_add(pixels.len() as u32);
        let next_from_index = if consumed < total {
            Some(consumed)
        } else {
            None
        };

        PixelsPage {
            pixels,
            from_index,
            limit,
            total,
            next_from_index,
        }
    }

    /// Every tunable rule, including the ones disabled at launch.
    pub fn get_tunables(&self) -> Tunables {
        self.tunables.clone()
    }

    /// The account allowed to call owner methods (`set_tunables`, prices, pause,
    /// revenue accounts, `upgrade`): the account that called `new`.
    pub fn get_owner(&self) -> AccountId {
        self.payments.owner.clone()
    }

    /// Owner-only. Changing a game rule is a transaction, not a redeployment and
    /// not a migration — that is the whole point of storing the knobs on chain.
    ///
    /// Emits `tunables_changed` (`mpoo_payments` 1.0.0) with
    /// `data: [{changed: [{field, old, new}], changed_at_ns}]`, listing every stored
    /// field this call changed, including history the call moved itself
    /// (`last_near_price_change_ns`, `last_happy_hour_change_ns`). A call that
    /// changes nothing emits no event.
    #[payable]
    pub fn set_tunables(&mut self, tunables: Tunables) {
        let mut tunables = tunables;
        near_sdk::assert_one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.owner,
            "OwnerOnly"
        );
        tunables.validate();
        // These timestamps are history, not owner-editable knobs. Otherwise the
        // general setter could silently defeat a cooldown.
        assert!(
            tunables.last_near_price_change_ns == self.tunables.last_near_price_change_ns
                && tunables.last_mpoo_price_change_ns == self.tunables.last_mpoo_price_change_ns,
            "PriceHistoryImmutable"
        );
        assert_eq!(
            tunables.last_happy_hour_change_ns, self.tunables.last_happy_hour_change_ns,
            "HappyHourHistoryImmutable"
        );
        // B3: the emission rate has its own guarded setter.
        assert_eq!(
            tunables.toilet_per_cell_second, self.tunables.toilet_per_cell_second,
            "RateViaSetter"
        );
        // C1: a float cap below what is already sold would block every sale with a
        // confusing FloatCapExceeded. 0 (uncapped) is always allowed.
        assert!(
            tunables.max_outstanding_credits == 0
                || tunables.max_outstanding_credits >= self.payments.outstanding,
            "FloatCapBelowOutstanding"
        );
        let now = env::block_timestamp();
        // C1: repaint credits are a NEAR price. Changing them needs the NEAR price
        // cooldown to have passed, and restarts it. The windows are not prices.
        let repaint_changed = tunables.repaint_base_credits != self.tunables.repaint_base_credits
            || tunables.repaint_mid_credits != self.tunables.repaint_mid_credits
            || tunables.repaint_young_credits != self.tunables.repaint_young_credits;
        if repaint_changed {
            assert!(
                self.tunables.near_price_cooldown_elapsed(now),
                "RepaintPriceCooldown"
            );
        }
        free_paint::apply_happy_hour_change(&self.tunables, &mut tunables, now);
        // Settle emission before any rule changes. mpoo_daily_credit_cap applies
        // immediately (C8): it bounds protocol loss, not what users pay, so it has
        // no cooldown.
        self.accrue(now);
        let old = std::mem::replace(&mut self.tunables, tunables);
        if repaint_changed {
            self.tunables.last_near_price_change_ns = Some(now);
        }
        let changed = self.tunables.changes_from(&old);
        if !changed.is_empty() {
            Self::safety_event(
                "tunables_changed",
                near_sdk::serde_json::json!({
                    "changed": changed,
                    "changed_at_ns": now.to_string()
                }),
            );
        }
    }

    /// What this cell costs to paint right now. The page must display this rather
    /// than re-implement the tier rule in JavaScript, or the two will drift.
    pub fn get_cell_cost(&self, x: u32, y: u32) -> u32 {
        if let Err(code) = check_coordinate(x, y) {
            reject(code);
        }
        self.tunables
            .cost(env::block_timestamp(), read_cell(self, pixel_key(x, y)).1)
    }

    /// Price every cell of one stroke in a single call.
    ///
    /// Same answer as calling `get_cell_cost` per cell, without the round-trips:
    /// the recency tiers stay defined here and nowhere else. Bounded by
    /// `MAX_DRAW_BATCH`, the same cap `draw_many` enforces, so a quote can never
    /// describe a stroke the contract would refuse.
    pub fn get_cell_costs(&self, cells: Vec<CellRef>) -> Vec<u32> {
        if cells.len() as u32 > MAX_DRAW_BATCH {
            reject("StrokeTooLarge");
        }
        let now = env::block_timestamp();
        cells
            .iter()
            .map(|cell| {
                if let Err(code) = check_coordinate(cell.x, cell.y) {
                    reject(code);
                }
                self.tunables
                    .cost(now, read_cell(self, pixel_key(cell.x, cell.y)).1)
            })
            .collect()
    }

    /// Cells an account currently holds: the input to the paint quota and to the
    /// emission earning cap.
    pub fn get_cells_owned(&self, account_id: AccountId) -> u32 {
        self.holders.get(&account_id).map_or(0, |holder| holder.cells)
    }

    /// Replace this contract's code. Owner-only, one yocto attached.
    ///
    /// The board keeps an upgrade path; the TOILET token deliberately does not (D4). The
    /// difference is what each one holds. The board custodies credits and pixels, so a bug
    /// here strands user balances and has to be repairable. The token's only authority is
    /// its emitter and its configuration is frozen at `new`, so a code-swap power would buy
    /// nothing that is worth the trust.
    ///
    /// Deploy and migrate are **one receipt** on this account: `DeployContract`, then a
    /// `migrate(migrate_args)` call. Actions in one receipt succeed or fail together, so
    /// if `migrate` rejects, the deploy is rolled back and the old code keeps running
    /// over the old state. The board is never left with new code over old state.
    ///
    /// `migrate_args` is the JSON object passed to the new code's `migrate`, e.g.
    /// `{"team_account": "…", "buyback_account": "…", "toilet": "…"}` for version 1 → 2. Never call
    /// `new` over live state. Before mainnet money this belongs behind a delay; that is
    /// tracked as an M2 item, not a reason to delete the method.
    #[payable]
    pub fn upgrade(
        &mut self,
        code: near_sdk::json_types::Base64VecU8,
        migrate_args: near_sdk::serde_json::Value,
    ) {
        near_sdk::assert_one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.owner,
            "OwnerOnly"
        );
        let args = near_sdk::serde_json::to_vec(&migrate_args).expect("SerializationFailed");
        // The promise is the action itself; its result is observable on chain.
        let _upgrade = near_sdk::Promise::new(env::current_account_id())
            .deploy_contract(code.0)
            .function_call_weight(
                "migrate",
                args,
                near_sdk::NearToken::from_yoctonear(0),
                near_sdk::Gas::from_tgas(20),
                near_sdk::GasWeight(1),
            );
    }

    /// Paint one cell. Any predecessor may overwrite any cell (Open wall).
    ///
    /// `max_credits` is the most the caller agreed to pay (spec §C2): if the cell
    /// costs more at execution, the call rejects with `PriceRoseAboveMax` and nothing
    /// is stored or charged. A free paint (F1/F2) counts as 0 against it.
    ///
    /// On NEAR, a panic cancels the whole transaction. A successful return
    /// means the cell was stored for this call.
    pub fn draw(&mut self, x: u32, y: u32, color: u32, max_credits: u32) {
        self.paint(&[DrawCell { x, y, color }], max_credits, "draw");
    }

    /// Paint many cells in one transaction, so a drag is one wallet approval.
    ///
    /// All-or-nothing: if any cell is out of range or has an unknown color, or the
    /// stroke's total (after free paints) is above `max_credits`, the whole call
    /// panics and nothing is stored, so a painter can never end up with half a
    /// stroke on the wall and half rejected. Cells apply in order; if the same cell
    /// appears twice, the last entry wins and the repeat pays the repaint rate.
    ///
    /// The stroke is capped at `MAX_DRAW_BATCH` cells. Longer drags are
    /// split by the client into several calls, each of which is still atomic.
    pub fn draw_many(&mut self, cells: Vec<DrawCell>, max_credits: u32) {
        self.paint(&cells, max_credits, "draw_many");
    }
}

impl Board {
    /// The one paint path behind `draw` and `draw_many`.
    fn paint(&mut self, cells: &[DrawCell], max_credits: u32, event: &str) {
        self.accrue(env::block_timestamp());
        self.assert_unpaused();
        if cells.is_empty() {
            reject("EmptyStroke");
        }
        if cells.len() as u32 > MAX_DRAW_BATCH {
            reject("StrokeTooLarge");
        }
        for cell in cells.iter() {
            if let Err(code) = validate_draw_args(cell.x, cell.y, cell.color) {
                reject(code);
            }
        }

        let artist = env::predecessor_account_id();
        let written_at_ns = env::block_timestamp();
        let keys: Vec<u32> = cells.iter().map(|c| pixel_key(c.x, c.y)).collect();

        // Price the stroke entry by entry, free paints included (F1/F2). A cell that
        // appears twice in one drag was just repainted by the earlier entry, so it
        // pays the repaint rate.
        let plan = self.plan_stroke(Some(&artist), &keys, written_at_ns);
        if plan.total > u128::from(max_credits) {
            reject("PriceRoseAboveMax");
        }

        // Whoever held each distinct cell before this stroke, and whether it was
        // earning then (painted, latest paint not free). Read before any write.
        let mut charged: Vec<(u32, Option<AccountId>, bool)> = Vec::with_capacity(cells.len());
        for &key in keys.iter() {
            if !charged.iter().any(|(k, ..)| *k == key) {
                let previous = read_cell(self, key).0;
                let was_earning = previous.is_some() && !self.free_cells.contains(&key);
                charged.push((key, previous, was_earning));
            }
        }

        // One debit for the whole stroke: a rejected stroke stores nothing and
        // costs nothing, because a panic rolls back the debit and the writes.
        self.payments.spend(&artist, plan.total);
        if plan.extra_changed {
            self.account_extra.insert(artist.clone(), plan.extra);
        }

        let mut events: Vec<String> = Vec::with_capacity(cells.len());
        for ((cell, &key), price) in cells.iter().zip(keys.iter()).zip(plan.cells.iter()) {
            self.pixels.insert(
                key,
                PixelRecord {
                    color: cell.color,
                    artist: artist.clone(),
                    written_at_ns,
                },
            );
            // A cell is in `free_cells` while its latest paint was free.
            if price.free {
                self.free_cells.insert(key);
            } else {
                self.free_cells.remove(&key);
            }
            events.push(format!(
                "{{\"x\":{},\"y\":{},\"color\":{},\"artist\":\"{artist}\",\"written_at_ns\":{written_at_ns},\"credits\":{},\"free\":{}}}",
                cell.x, cell.y, cell.color, price.credits, price.free
            ));
        }

        // Ownership and earning counts move once per distinct cell, from whoever
        // held it before this stroke to the artist who just took it (§B1). The
        // cell's final state decides `now_earning`: the last entry for it wins.
        // Even a same-artist repaint can move the earning count, free → paid.
        let mut deltas: Vec<(AccountId, i64, i64)> = Vec::new();
        for (key, previous_owner, was_earning) in charged.iter() {
            let now_earning = !self.free_cells.contains(key);
            let moved = previous_owner.as_ref() != Some(&artist);
            if let Some(previous) = previous_owner {
                add_delta(&mut deltas, previous, -i64::from(moved), -i64::from(*was_earning));
            }
            add_delta(&mut deltas, &artist, i64::from(moved), i64::from(now_earning));
        }
        for (account, cells_delta, earning_delta) in deltas {
            if cells_delta != 0 || earning_delta != 0 {
                adjust_holder(self, &account, cells_delta, earning_delta);
            }
        }

        // F1 latch: set the first time every cell holds paint. Never unset.
        if !self.first_fill_complete && self.pixels.len() == WIDTH * HEIGHT {
            self.first_fill_complete = true;
        }

        // One event per call keeps an indexer's work proportional to drags,
        // not to pixels.
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"mpoo_board\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{}]}}",
            events.join(",")
        ));
    }
}

/// None (never changed) always permits the change, including at timestamp zero.
pub(crate) fn cooldown_elapsed(last: Option<u64>, cooldown: u64, now: u64) -> bool {
    last.is_none_or(|last| {
        now.checked_sub(last)
            .is_some_and(|elapsed| elapsed >= cooldown)
    })
}

fn pixel_key(x: u32, y: u32) -> u32 {
    y * WIDTH + x
}

impl Board {
    /// Revision-2 facts for one account; absent means all zeros.
    pub(crate) fn account_extra(&self, account: &AccountId) -> AccountExtra {
        self.account_extra.get(account).copied().unwrap_or_default()
    }
}

/// Read a cell's current owner and write time without holding a borrow, so the
/// caller can mutate payments and ownership counts in the same function.
fn read_cell(board: &Board, key: u32) -> (Option<AccountId>, Option<u64>) {
    match board.pixels.get(&key) {
        Some(record) => (Some(record.artist.clone()), Some(record.written_at_ns)),
        None => (None, None),
    }
}

/// Sum one cell's `(cells, earning)` change into the stroke's per-account deltas.
fn add_delta(deltas: &mut Vec<(AccountId, i64, i64)>, account: &AccountId, cells: i64, earning: i64) {
    match deltas.iter_mut().find(|(a, ..)| a == account) {
        Some(entry) => {
            entry.1 += cells;
            entry.2 += earning;
        }
        None => deltas.push((account.clone(), cells, earning)),
    }
}

/// Apply a signed change to a `u32` count, panicking with `code` on under/overflow.
fn shift(count: u32, delta: i64, code: &str) -> u32 {
    u32::try_from(i64::from(count) + delta).unwrap_or_else(|_| env::panic_str(code))
}

/// Settle at the old earning weight, change ownership and earning counts, then
/// checkpoint the debt at the new earning weight.
fn adjust_holder(board: &mut Board, account: &AccountId, cells: i64, earning: i64) {
    let mut holder = board.settled_holder(account, board.acc_per_cell);
    holder.cells = shift(holder.cells, cells, "CellCountInvariant");
    holder.earning = shift(holder.earning, earning, "EarningCountInvariant");
    board.total_cells = shift(board.total_cells, cells, "CellCountInvariant");
    board.total_earning = shift(board.total_earning, earning, "EarningCountInvariant");
    holder.debt = emission::entitlement(holder.earning, board.acc_per_cell);
    board.holders.insert(account.clone(), holder);
}

fn validate_draw_args(x: u32, y: u32, color: u32) -> Result<(), &'static str> {
    check_coordinate(x, y)?;
    if color >= PALETTE.len() as u32 {
        return Err("ColorOutOfRange");
    }
    Ok(())
}

fn check_coordinate(x: u32, y: u32) -> Result<(), &'static str> {
    if x >= WIDTH || y >= HEIGHT {
        return Err("CoordinateOutOfRange");
    }
    Ok(())
}

/// Stop the call with a stable code first, then a short explanation.
fn reject(code: &str) -> ! {
    env::panic_str(&format!(
        "{code}: draw was rejected and no pixel was stored"
    ));
}

/// Revenue accounts for unit-test boards. Not `accounts(n)`, so no test caller
/// is accidentally also a revenue account.
#[cfg(test)]
pub(crate) fn test_team() -> AccountId {
    "team.metapoo.testnet".parse().unwrap()
}
#[cfg(test)]
pub(crate) fn test_buyback() -> AccountId {
    "buyback.metapoo.testnet".parse().unwrap()
}
/// The TOILET token for unit-test boards; deliberately not the mPOO token.
#[cfg(test)]
pub(crate) fn test_toilet() -> AccountId {
    "toilet.metapoo.testnet".parse().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId};
    use std::collections::HashSet;

    fn context(predecessor: AccountId, block_timestamp: u64) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .block_timestamp(block_timestamp)
            .build();
        testing_env!(context);
    }

    fn setup() -> Board {
        context(accounts(0), 1_000);
        let mut board = Board::new(accounts(5), near_sdk::json_types::U128(100), crate::test_team(), crate::test_buyback(), crate::test_toilet());
        // Geometry tests start with funded accounts; payment tests use public methods.
        for i in 0..6 {
            board.payments.balances.insert(accounts(i), 1000);
        }
        // Fixture credits must also be included in the global liability counter.
        board.payments.outstanding = 6000;
        // Paid-path tests: F1 free first paints are covered in `free_paint.rs`.
        board.tunables.free_first_paints_per_account = 0;
        board
    }

    #[test]
    fn batched_costs_match_the_single_cell_view() {
        let mut board = setup();
        context(accounts(1), 1_000_000_000_000);
        board.draw(0, 0, 1, u32::MAX);
        // (0,0) was just painted, so it must quote the young tier while (1,1)
        // is empty and quotes the base tier.
        let batch = board.get_cell_costs(vec![
            CellRef { x: 0, y: 0 },
            CellRef { x: 1, y: 1 },
        ]);
        assert_eq!(
            batch,
            vec![board.get_cell_cost(0, 0), board.get_cell_cost(1, 1)]
        );
        assert_ne!(batch[0], batch[1]);
    }

    #[test]
    fn batched_costs_accept_an_empty_stroke() {
        let board = setup();
        assert!(board.get_cell_costs(vec![]).is_empty());
    }

    #[test]
    #[should_panic(expected = "StrokeTooLarge")]
    fn batched_costs_reject_a_stroke_over_the_draw_cap() {
        let board = setup();
        let cells: Vec<CellRef> = (0..65).map(|i| CellRef { x: i, y: 0 }).collect();
        board.get_cell_costs(cells);
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn batched_costs_reject_an_off_board_cell() {
        let board = setup();
        board.get_cell_costs(vec![CellRef { x: 200, y: 0 }]);
    }

    #[test]
    fn board_view_matches_the_shared_description() {
        let board = setup();
        let view = board.get_board();
        assert_eq!(view.schema_version, 4);
        assert_eq!(view.width, 128);
        assert_eq!(view.height, 128);
        assert_eq!(view.origin, "top-left");
        assert_eq!(view.overwrite_rule, "open_wall");
        assert!(!view.sponsorship_enabled);
        assert_eq!(view.palette[0].name, "Ink");
    }

    // --- P1: 16 colours ---------------------------------------------------

    #[test]
    fn p1_get_board_returns_16_colours() {
        let view = setup().get_board();
        assert_eq!(view.palette.len(), 16);
        assert_eq!(view.palette[7].name, "Clay");
        assert_eq!(view.palette[8].name, "Grout");
        assert_eq!(view.palette[8].hex, "#8a857c");
        assert_eq!(view.palette[15].index, 15);
        assert_eq!(view.palette[15].name, "Cone");
        assert_eq!(view.palette[15].hex, "#ef7a2c");
    }

    #[test]
    fn p1_colour_15_is_accepted() {
        let mut board = setup();
        board.draw(1, 1, 15, u32::MAX);
        board.draw_many(stroke(&[(2, 1, 15), (3, 1, 8)]), u32::MAX);
        assert_eq!(board.get_pixel(1, 1).color, Some(15));
        assert_eq!(board.get_pixel(3, 1).color, Some(8));
    }

    #[test]
    fn shared_json_matches_contract_constants() {
        let raw = include_str!("../../../shared/board.json");
        let shared: serde_json::Value = serde_json::from_str(raw).expect("shared board json");
        assert_eq!(shared["width"], serde_json::json!(WIDTH));
        assert_eq!(shared["height"], serde_json::json!(HEIGHT));
        assert_eq!(shared["origin"], ORIGIN);
        assert_eq!(shared["overwrite_rule"], OVERWRITE_RULE);
        assert_eq!(shared["sponsorship_enabled"], false);
        // Shared frontend metadata still describes the separate free board.
        assert_eq!(SCHEMA_VERSION, 4);
        let palette = shared["palette"].as_array().expect("palette array");
        assert_eq!(palette.len(), PALETTE.len());
        for (entry, (name, hex)) in palette.iter().zip(PALETTE) {
            assert_eq!(entry["name"], *name);
            assert_eq!(entry["hex"], *hex);
        }
    }

    #[test]
    fn in_range_pixel_starts_empty() {
        let board = setup();
        let pixel = board.get_pixel(0, 0);
        assert!(pixel.color.is_none());
        assert!(pixel.artist.is_none());
        assert!(pixel.written_at_ns.is_none());
        let corner = board.get_pixel(127, 127);
        assert!(corner.color.is_none());
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn pixel_outside_the_board_is_rejected() {
        let board = setup();
        let _ = board.get_pixel(128, 0);
    }

    #[test]
    #[should_panic(expected = "ColorOutOfRange")]
    fn p1_colour_16_is_rejected_with_color_out_of_range() {
        let mut board = setup();
        board.draw(1, 1, 16, u32::MAX);
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn draw_outside_the_board_is_rejected() {
        let mut board = setup();
        board.draw(128, 0, 0, u32::MAX);
    }

    #[test]
    fn first_paint_stores_color_artist_and_time() {
        let mut board = setup();
        board.draw(3, 4, 2, u32::MAX);
        let pixel = board.get_pixel(3, 4);
        assert_eq!(pixel.color, Some(2));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(0).as_str()));
        assert_eq!(pixel.written_at_ns, Some(1_000));
    }

    #[test]
    fn another_account_may_overwrite_under_open_wall() {
        let mut board = setup();
        board.draw(3, 4, 2, u32::MAX);

        context(accounts(1), 2_000);
        board.draw(3, 4, 5, u32::MAX);

        let pixel = board.get_pixel(3, 4);
        assert_eq!(pixel.color, Some(5));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(1).as_str()));
        assert_eq!(pixel.written_at_ns, Some(2_000));
    }

    #[test]
    fn same_account_may_recolor() {
        let mut board = setup();
        board.draw(0, 0, 1, u32::MAX);
        context(accounts(0), 3_000);
        board.draw(0, 0, 7, u32::MAX);
        let pixel = board.get_pixel(0, 0);
        assert_eq!(pixel.color, Some(7));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(0).as_str()));
        assert_eq!(pixel.written_at_ns, Some(3_000));
    }

    #[test]
    fn painting_one_cell_does_not_create_neighbors() {
        let mut board = setup();
        board.draw(10, 10, 3, u32::MAX);
        assert!(board.get_pixel(10, 11).color.is_none());
        assert!(board.get_pixel(11, 10).color.is_none());
    }

    #[test]
    fn get_pixels_is_empty_on_a_fresh_board() {
        let board = setup();
        let page = board.get_pixels(0, 10);
        assert_eq!(page.total, 0);
        assert!(page.pixels.is_empty());
        assert!(page.next_from_index.is_none());
    }

    #[test]
    fn get_pixels_returns_each_painted_cell_exactly_once_after_overwrite() {
        let mut board = setup();
        board.draw(3, 4, 2, u32::MAX);
        board.draw(5, 6, 1, u32::MAX);
        context(accounts(1), 2_000);
        board.draw(3, 4, 5, u32::MAX);

        let page = board.get_pixels(0, 256);
        assert_eq!(page.total, 2);
        assert_eq!(page.pixels.len(), 2);
        assert!(page.next_from_index.is_none());

        let keys: HashSet<(u32, u32)> = page.pixels.iter().map(|p| (p.x, p.y)).collect();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&(3, 4)));
        assert!(keys.contains(&(5, 6)));

        let overwritten = page
            .pixels
            .iter()
            .find(|p| p.x == 3 && p.y == 4)
            .expect("overwritten cell");
        assert_eq!(overwritten.color, 5);
        assert_eq!(overwritten.artist, accounts(1).as_str());
        assert_eq!(overwritten.written_at_ns, 2_000);
    }

    #[test]
    fn get_pixels_pages_without_duplicates_across_pages() {
        let mut board = setup();
        for i in 0..5 {
            board.draw(i, 0, 2, u32::MAX);
        }

        let first = board.get_pixels(0, 2);
        assert_eq!(first.pixels.len(), 2);
        assert_eq!(first.total, 5);
        assert_eq!(first.next_from_index, Some(2));

        let second = board.get_pixels(first.next_from_index.unwrap(), 2);
        assert_eq!(second.pixels.len(), 2);
        assert_eq!(second.next_from_index, Some(4));

        let third = board.get_pixels(second.next_from_index.unwrap(), 2);
        assert_eq!(third.pixels.len(), 1);
        assert!(third.next_from_index.is_none());

        let mut seen = HashSet::new();
        for page in [&first, &second, &third] {
            for pixel in &page.pixels {
                assert!(seen.insert((pixel.x, pixel.y)), "duplicate cell in paging");
            }
        }
        assert_eq!(seen.len(), 5);
    }

    #[test]
    fn second_client_sees_pixel_painted_by_first_via_get_pixels() {
        // Client A (accounts(0)) paints.
        let mut board = setup();
        board.draw(3, 4, 2, u32::MAX);

        // Client B is a different account that only reads. Open wall does not
        // require B to have painted; the wall is shared state.
        context(accounts(1), 2_000);
        let page = board.get_pixels(0, 10);
        assert_eq!(page.total, 1);
        assert_eq!(page.pixels.len(), 1);
        assert_eq!(page.pixels[0].x, 3);
        assert_eq!(page.pixels[0].y, 4);
        assert_eq!(page.pixels[0].color, 2);
        assert_eq!(page.pixels[0].artist, accounts(0).as_str());

        let single = board.get_pixel(3, 4);
        assert_eq!(single.color, Some(2));
        assert_eq!(single.artist.as_deref(), Some(accounts(0).as_str()));
    }

    #[test]
    fn get_pixels_clamps_limit_to_max_page() {
        let mut board = setup();
        board.draw(0, 0, 1, u32::MAX);
        let page = board.get_pixels(0, 10_000);
        assert_eq!(page.limit, MAX_PIXELS_PAGE);
        assert_eq!(page.pixels.len(), 1);
    }

    fn stroke(cells: &[(u32, u32, u32)]) -> Vec<DrawCell> {
        cells
            .iter()
            .map(|(x, y, color)| DrawCell {
                x: *x,
                y: *y,
                color: *color,
            })
            .collect()
    }

    #[test]
    fn a_stroke_stores_every_cell_with_one_artist_and_one_timestamp() {
        let mut board = setup();
        board.draw_many(stroke(&[(1, 1, 2), (2, 1, 2), (3, 1, 3)]), u32::MAX);

        for (x, y, color) in [(1, 1, 2), (2, 1, 2), (3, 1, 3)] {
            let pixel = board.get_pixel(x, y);
            assert_eq!(pixel.color, Some(color), "cell {x},{y} color");
            assert_eq!(pixel.artist.as_deref(), Some(accounts(0).as_str()));
            assert_eq!(pixel.written_at_ns, Some(1_000));
        }

        // One stroke, three cells, one page entry each.
        let page = board.get_pixels(0, 256);
        assert_eq!(page.total, 3);
        assert_eq!(page.pixels.len(), 3);
    }

    #[test]
    fn a_stroke_is_one_wallet_action_even_for_a_long_drag() {
        let mut board = setup();
        let cells: Vec<(u32, u32, u32)> = (0..MAX_DRAW_BATCH).map(|i| (i, 7, 4)).collect();
        board.draw_many(stroke(&cells), u32::MAX);
        assert_eq!(board.get_pixels(0, 256).total, MAX_DRAW_BATCH);
    }

    #[test]
    fn repeated_cell_inside_one_stroke_keeps_the_last_color() {
        let mut board = setup();
        board.draw_many(stroke(&[(5, 5, 2), (5, 5, 6)]), u32::MAX);
        assert_eq!(board.get_pixel(5, 5).color, Some(6));
        assert_eq!(board.get_pixels(0, 256).total, 1);
    }

    #[test]
    #[should_panic(expected = "EmptyStroke")]
    fn an_empty_stroke_is_rejected() {
        let mut board = setup();
        board.draw_many(Vec::new(), u32::MAX);
    }

    #[test]
    #[should_panic(expected = "StrokeTooLarge")]
    fn a_stroke_over_the_cap_is_rejected() {
        let mut board = setup();
        let cells: Vec<(u32, u32, u32)> = (0..=MAX_DRAW_BATCH).map(|i| (i, 0, 1)).collect();
        board.draw_many(stroke(&cells), u32::MAX);
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn one_bad_cell_rejects_the_whole_stroke() {
        let mut board = setup();
        board.draw_many(stroke(&[(1, 1, 2), (128, 1, 2)]), u32::MAX);
    }

    #[test]
    #[should_panic(expected = "ColorOutOfRange")]
    fn one_unknown_color_rejects_the_whole_stroke() {
        let mut board = setup();
        board.draw_many(stroke(&[(1, 1, 2), (1, 2, 99)]), u32::MAX);
    }

    #[test]
    fn draw_and_draw_many_share_the_same_cell_space() {
        let mut board = setup();
        board.draw(9, 9, 1, u32::MAX);
        board.draw_many(stroke(&[(9, 9, 5), (10, 9, 5)]), u32::MAX);
        assert_eq!(board.get_pixel(9, 9).color, Some(5));
        assert_eq!(board.get_pixels(0, 256).total, 2);
    }

    // --- repaint pricing -------------------------------------------------
    // These pin the rule the frontend must display: claiming empty ground is
    // always cheapest, and hammering a cell someone just painted costs more.

    fn paying_context(caller: usize, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(4))
            .predecessor_account_id(accounts(caller))
            .attached_deposit(near_sdk::NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .build());
    }

    fn balance_of(board: &Board, who: usize) -> u128 {
        board.get_credits(accounts(who)).map(|v| v.0).unwrap_or(0)
    }

    #[test]
    fn an_empty_cell_costs_the_base_rate() {
        let board = setup();
        assert_eq!(board.get_cell_cost(3, 3), 1);
        assert_eq!(board.get_tunables().repaint_base_credits, 1);
    }

    #[test]
    fn repaint_within_ten_minutes_costs_four_credits() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(0, 0, 1, u32::MAX);
        assert_eq!(balance_of(&board, 0), 999);
        paying_context(0, 0, 1_000 + 60_000_000_000); // 60 s later
        assert_eq!(board.get_cell_cost(0, 0), 4);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(balance_of(&board, 0), 995);
    }

    #[test]
    fn repaint_between_ten_and_sixty_minutes_costs_two_credits() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(0, 0, 1, u32::MAX);
        paying_context(0, 0, 1_000 + 900_000_000_000); // 15 min later
        assert_eq!(board.get_cell_cost(0, 0), 2);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(balance_of(&board, 0), 997);
    }

    #[test]
    fn repaint_after_an_hour_costs_the_base_rate_again() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(0, 0, 1, u32::MAX);
        paying_context(0, 0, 1_000 + 3_601_000_000_000); // just over 60 min later
        assert_eq!(board.get_cell_cost(0, 0), 1);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(balance_of(&board, 0), 998);
    }

    #[test]
    fn a_stroke_prices_every_cell_and_debits_once() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw_many(stroke(&[(0, 0, 1), (1, 0, 1)]), u32::MAX);
        assert_eq!(balance_of(&board, 0), 998);
        paying_context(0, 0, 1_000 + 300_000_000_000); // 5 min later
        board.draw_many(stroke(&[(0, 0, 2), (1, 0, 2)]), u32::MAX);
        // Both cells are young, so 4 + 4.
        assert_eq!(balance_of(&board, 0), 990);
    }

    #[test]
    fn a_duplicate_cell_inside_one_stroke_pays_the_repaint_rate() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw_many(stroke(&[(0, 0, 1), (0, 0, 2)]), u32::MAX);
        // First entry claims empty ground (1), the second repaints it (4).
        assert_eq!(balance_of(&board, 0), 995);
        assert_eq!(board.get_pixel(0, 0).color, Some(2));
        assert_eq!(board.get_pixels(0, 256).total, 1);
    }

    #[test]
    fn young_repaint_rejection_is_all_or_nothing() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(0, 0, 1, u32::MAX);
        // Only 2 credits left; a young repaint costs 4.
        board.payments.balances.insert(accounts(0), 2);
        board.payments.outstanding -= 997;
        paying_context(0, 0, 1_000 + 60_000_000_000);
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            board.draw(0, 0, 3, u32::MAX);
        }));
        assert!(rejected.is_err());
        assert_eq!(board.get_pixel(0, 0).color, Some(1));
        assert_eq!(balance_of(&board, 0), 2);
    }

    // --- C2: max_credits ----------------------------------------------------

    fn rejected_with(code: &str, f: impl FnOnce()) {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
        let message = err
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains(code), "{message}");
    }

    #[test]
    fn c2_cost_equal_to_max_succeeds() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw_many(stroke(&[(0, 0, 1), (1, 0, 1), (2, 0, 1)]), 3);
        assert_eq!(balance_of(&board, 0), 997);
        paying_context(0, 0, 2_000);
        board.draw(0, 0, 2, 4); // young repaint: 4
        assert_eq!(balance_of(&board, 0), 993);
    }

    #[test]
    fn c2_one_credit_above_max_rejects_and_stores_nothing() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(0, 0, 1, 1);
        paying_context(0, 0, 2_000);
        // Quoted at 1 before someone else's paint made it young (4).
        rejected_with("PriceRoseAboveMax", || board.draw(0, 0, 2, 3));
        assert_eq!(board.get_pixel(0, 0).color, Some(1));
        assert_eq!(balance_of(&board, 0), 999);
        rejected_with("PriceRoseAboveMax", || {
            board.draw_many(stroke(&[(5, 5, 1), (6, 5, 1)]), 1)
        });
        assert!(board.get_pixel(5, 5).color.is_none());
        assert_eq!(balance_of(&board, 0), 999);
        assert_eq!(board.get_outstanding_credits().0, 5999);
    }

    #[test]
    fn c2_a_duplicate_cell_raising_the_cost_above_max_rejects() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        // Two distinct-looking entries priced 1 + 1 by a naive per-cell quote, but the
        // repeat is a young repaint: 1 + 4 = 5.
        rejected_with("PriceRoseAboveMax", || {
            board.draw_many(stroke(&[(0, 0, 1), (0, 0, 2)]), 2)
        });
        assert!(board.get_pixel(0, 0).color.is_none());
        assert_eq!(balance_of(&board, 0), 1000);
        board.draw_many(stroke(&[(0, 0, 1), (0, 0, 2)]), 5);
        assert_eq!(balance_of(&board, 0), 995);
    }

    #[test]
    fn c2_free_cells_count_as_zero_against_the_max() {
        let mut board = setup();
        board.tunables.free_first_paints_per_account = 2;
        paying_context(0, 0, 1_000);
        // Three empty cells: two free first paints, one paid.
        board.draw_many(stroke(&[(0, 0, 1), (1, 0, 1), (2, 0, 1)]), 1);
        assert_eq!(balance_of(&board, 0), 999);
        // A single free draw passes with max 0.
        board.tunables.free_first_paints_per_account = 3;
        board.draw(3, 0, 1, 0);
        assert_eq!(balance_of(&board, 0), 999);
    }

    #[test]
    fn c2_stroke_quote_matches_what_draw_many_charges() {
        let mut board = setup();
        board.tunables.free_first_paints_per_account = 1;
        paying_context(0, 0, 1_000);
        board.draw(9, 9, 1, u32::MAX); // uses the one free first paint
        paying_context(1, 0, 2_000);
        let cells = [(9, 9, 2), (10, 9, 2), (10, 9, 3)];
        let refs: Vec<CellRef> = cells.iter().map(|(x, y, _)| CellRef { x: *x, y: *y }).collect();
        let quote = board.get_stroke_cost(Some(accounts(1)), refs);
        // young repaint 4, free first paint 0, repeat of a just-painted cell 4.
        assert_eq!(quote.costs, vec![4, 0, 4]);
        assert_eq!(quote.free, vec![false, true, false]);
        assert_eq!(quote.total, 8);
        board.draw_many(stroke(&cells), quote.total);
        assert_eq!(balance_of(&board, 1), 992);
        // Without an account nothing is free.
        let anon = board.get_stroke_cost(None, vec![CellRef { x: 50, y: 50 }]);
        assert_eq!((anon.costs, anon.total), (vec![1], 1));
    }

    #[test]
    fn c2_draw_events_mark_each_cell_free_or_paid() {
        let mut board = setup();
        board.tunables.free_first_paints_per_account = 1;
        paying_context(0, 0, 1_000);
        board.draw_many(stroke(&[(0, 0, 1), (1, 0, 1)]), 1);
        let logs = near_sdk::test_utils::get_logs();
        let last = logs.last().expect("draw_many event");
        assert!(last.contains("\"x\":0,\"y\":0,\"color\":1"), "{last}");
        assert!(last.contains("\"credits\":0,\"free\":true"), "{last}");
        assert!(last.contains("\"credits\":1,\"free\":false"), "{last}");
        board.draw(2, 0, 1, 1);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.last().unwrap().contains("\"event\":\"draw\""));
        assert!(logs.last().unwrap().contains("\"free\":false"));
    }

    // --- ownership counts ------------------------------------------------

    #[test]
    fn cells_owned_follows_the_artist_on_overwrite() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(4, 4, 1, u32::MAX);
        assert_eq!(board.get_cells_owned(accounts(0)), 1);
        assert_eq!(board.get_cells_owned(accounts(1)), 0);

        paying_context(4, 0, 2_000);
        board.draw(4, 4, 2, u32::MAX);
        assert_eq!(board.get_cells_owned(accounts(0)), 0);
        assert_eq!(board.get_cells_owned(accounts(4)), 1);
    }

    #[test]
    fn a_stroke_does_not_count_a_cell_twice() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw_many(stroke(&[(0, 0, 1), (0, 0, 2), (1, 0, 1)]), u32::MAX);
        assert_eq!(board.get_cells_owned(accounts(0)), 2);
    }

    #[test]
    fn the_same_artist_repainting_keeps_its_count() {
        let mut board = setup();
        paying_context(0, 0, 1_000);
        board.draw(2, 2, 1, u32::MAX);
        paying_context(0, 0, 2_000);
        board.draw(2, 2, 3, u32::MAX);
        assert_eq!(board.get_cells_owned(accounts(0)), 1);
    }

    // --- owner controls --------------------------------------------------

    #[test]
    #[should_panic(expected = "OwnerOnly")]
    fn tunables_are_owner_only() {
        let mut board = setup();
        paying_context(1, 1, 1_000);
        board.set_tunables(Tunables::default());
    }

    #[test]
    #[should_panic(expected = "RepaintCreditsOutOfRange")]
    fn a_free_repaint_is_rejected() {
        let mut board = setup();
        let tunables = Tunables {
            repaint_young_credits: 0,
            ..Tunables::default()
        };
        paying_context(0, 1, 1_000);
        board.set_tunables(tunables);
    }

    #[test]
    #[should_panic(expected = "RepaintTiersOutOfOrder")]
    fn inverted_repaint_tiers_are_rejected() {
        let mut board = setup();
        let mut tunables = Tunables::default();
        tunables.repaint_young_ns = tunables.repaint_mid_ns + 1;
        paying_context(0, 1, 1_000);
        board.set_tunables(tunables);
    }

    #[test]
    fn the_owner_can_retune_without_a_redeploy() {
        let mut board = setup();
        let tunables = Tunables {
            repaint_young_credits: 8,
            ..Tunables::default()
        };
        paying_context(0, 1, 1_000);
        board.set_tunables(tunables);
        assert_eq!(board.get_tunables().repaint_young_credits, 8);
        paying_context(0, 0, 1_000);
        board.draw(0, 0, 1, u32::MAX);
        paying_context(0, 0, 1_000 + 60_000_000_000);
        assert_eq!(board.get_cell_cost(0, 0), 8);
    }

    // --- C1: bounded repaint costs -----------------------------------------

    #[test]
    fn repaint_tier_above_eight_credits_is_rejected() {
        let mut board = setup();
        paying_context(0, 1, 1_000);
        let tunables = Tunables {
            repaint_young_credits: 9,
            ..Tunables::default()
        };
        rejected_with("RepaintCreditsOutOfRange", || board.set_tunables(tunables));
    }

    #[test]
    fn repaint_tier_credits_out_of_order_are_rejected() {
        let mut board = setup();
        paying_context(0, 1, 1_000);
        // mid above young
        let tunables = Tunables {
            repaint_mid_credits: 5,
            ..Tunables::default()
        };
        rejected_with("RepaintCreditsOutOfOrder", || board.set_tunables(tunables));
        // base above mid
        let tunables = Tunables {
            repaint_base_credits: 3,
            ..Tunables::default()
        };
        rejected_with("RepaintCreditsOutOfOrder", || board.set_tunables(tunables));
    }

    #[test]
    fn repaint_mid_window_over_a_day_is_rejected() {
        let mut board = setup();
        paying_context(0, 1, 1_000);
        let tunables = Tunables {
            repaint_mid_ns: safety::MIN_COOLDOWN_NS + 1,
            ..Tunables::default()
        };
        rejected_with("RepaintWindowTooLong", || board.set_tunables(tunables));
        // Exactly 24 h is allowed.
        let tunables = Tunables {
            repaint_mid_ns: safety::MIN_COOLDOWN_NS,
            ..Tunables::default()
        };
        board.set_tunables(tunables);
    }

    #[test]
    fn float_cap_below_outstanding_is_rejected_but_zero_is_allowed() {
        let mut board = setup(); // 6000 outstanding
        paying_context(0, 1, 1_000);
        let tunables = Tunables {
            max_outstanding_credits: 5_999,
            ..Tunables::default()
        };
        rejected_with("FloatCapBelowOutstanding", || board.set_tunables(tunables));
        board.set_tunables(Tunables {
            max_outstanding_credits: 6_000,
            ..Tunables::default()
        });
        board.set_tunables(Tunables {
            max_outstanding_credits: 0,
            ..Tunables::default()
        });
    }

    #[test]
    fn mpoo_daily_cap_above_one_million_is_rejected() {
        let mut board = setup();
        paying_context(0, 1, 1_000);
        let tunables = Tunables {
            mpoo_daily_credit_cap: 1_000_001,
            ..Tunables::default()
        };
        rejected_with("MpooDailyCapTooHigh", || board.set_tunables(tunables));
        board.set_tunables(Tunables {
            mpoo_daily_credit_cap: 1_000_000,
            ..Tunables::default()
        });
        assert_eq!(board.get_tunables().mpoo_daily_credit_cap, 1_000_000);
    }

    #[test]
    fn repaint_change_inside_near_cooldown_is_rejected() {
        let mut board = setup();
        board.tunables.last_near_price_change_ns = Some(1_000);
        paying_context(0, 1, 1_000 + safety::MIN_COOLDOWN_NS - 1);
        let tunables = Tunables {
            repaint_young_credits: 8,
            ..board.get_tunables()
        };
        rejected_with("RepaintPriceCooldown", || board.set_tunables(tunables));
        assert_eq!(board.get_tunables().repaint_young_credits, 4);
    }

    #[test]
    fn repaint_change_after_near_cooldown_is_accepted_and_restarts_it() {
        let mut board = setup();
        board.tunables.last_near_price_change_ns = Some(1_000);
        let now = 1_000 + safety::MIN_COOLDOWN_NS;
        paying_context(0, 1, now);
        let tunables = Tunables {
            repaint_young_credits: 8,
            ..board.get_tunables()
        };
        board.set_tunables(tunables);
        assert_eq!(board.get_tunables().repaint_young_credits, 8);
        assert_eq!(board.get_tunables().last_near_price_change_ns, Some(now));
        // The mPOO cooldown is untouched.
        assert_eq!(board.get_tunables().last_mpoo_price_change_ns, None);
        // A non-price tunable inside the restarted cooldown is still fine.
        paying_context(0, 1, now + 1);
        let tunables = Tunables {
            quota_base: 33,
            ..board.get_tunables()
        };
        board.set_tunables(tunables);
        assert_eq!(board.get_tunables().last_near_price_change_ns, Some(now));
    }

    // --- REV-G: distribution interval bounds, tunables event, owner view ----

    const MINUTE_NS: u64 = 60_000_000_000;

    #[test]
    fn distribution_interval_outside_ten_minutes_to_a_day_is_rejected() {
        let mut board = setup();
        paying_context(0, 1, 1_000);
        for too_far in [10 * MINUTE_NS - 1_000_000_000, 86_400_000_000_000 + 1, 0, u64::MAX] {
            let tunables = Tunables {
                distribution_interval_ns: too_far,
                ..Tunables::default()
            };
            rejected_with("DistributionIntervalOutOfRange", || {
                board.set_tunables(tunables)
            });
        }
        for allowed in [10 * MINUTE_NS, 86_400_000_000_000] {
            board.set_tunables(Tunables {
                distribution_interval_ns: allowed,
                ..Tunables::default()
            });
            assert_eq!(board.get_tunables().distribution_interval_ns, allowed);
        }
        assert_eq!(Tunables::default().distribution_interval_ns, 60 * MINUTE_NS);
    }

    fn tunables_events() -> Vec<serde_json::Value> {
        near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| serde_json::from_str::<serde_json::Value>(json).unwrap())
            .filter(|event| event["event"] == "tunables_changed")
            .collect()
    }

    #[test]
    fn set_tunables_emits_one_event_listing_exactly_the_changed_fields() {
        let mut board = setup();
        let now = 5_000;
        paying_context(0, 1, now);
        board.set_tunables(Tunables {
            quota_base: 33,
            distribution_interval_ns: 2 * 3_600_000_000_000,
            ..board.get_tunables()
        });
        let events = tunables_events();
        assert_eq!(events.len(), 1, "{events:?}");
        let event = &events[0];
        assert_eq!(event["standard"], "mpoo_payments");
        assert_eq!(event["version"], "1.0.0");
        let data = event["data"].as_array().unwrap();
        assert_eq!(data.len(), 1);
        assert_eq!(data[0]["changed_at_ns"], now.to_string());
        let mut changed: Vec<_> = data[0]["changed"].as_array().unwrap().clone();
        changed.sort_by_key(|c| c["field"].as_str().unwrap().to_string());
        assert_eq!(
            changed,
            vec![
                serde_json::json!({
                    "field": "distribution_interval_ns",
                    "old": 3_600_000_000_000u64,
                    "new": 7_200_000_000_000u64
                }),
                serde_json::json!({"field": "quota_base", "old": 32, "new": 33}),
            ]
        );
    }

    #[test]
    fn tunables_event_writes_a_u128_above_u64_as_a_decimal_string() {
        let mut board = setup();
        paying_context(0, 1, 5_000);
        board.set_tunables(Tunables {
            max_outstanding_credits: u128::MAX,
            ..board.get_tunables()
        });
        let events = tunables_events();
        assert_eq!(
            events[0]["data"][0]["changed"],
            serde_json::json!([{
                "field": "max_outstanding_credits",
                "old": 0,
                "new": u128::MAX.to_string()
            }])
        );
    }

    #[test]
    fn set_tunables_without_a_change_emits_no_event() {
        let mut board = setup();
        paying_context(0, 1, 5_000);
        board.set_tunables(board.get_tunables());
        assert!(tunables_events().is_empty());
    }

    #[test]
    fn get_owner_returns_the_account_that_called_new() {
        context(accounts(2), 1_000);
        let board = Board::new(
            accounts(5),
            near_sdk::json_types::U128(100),
            crate::test_team(),
            crate::test_buyback(),
            crate::test_toilet(),
        );
        context(accounts(3), 2_000);
        assert_eq!(board.get_owner(), accounts(2));
    }

    #[test]
    #[should_panic(expected = "OwnerOnly")]
    fn upgrade_requires_owner() {
        let mut board = setup();
        paying_context(1, 1, 1_000);
        board.upgrade(
            near_sdk::json_types::Base64VecU8(Vec::new()),
            near_sdk::serde_json::json!({}),
        );
    }
}
