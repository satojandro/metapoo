//! Meta Poo paid pixel board contract (Open wall + pressure/paint).
//!
//! Schema 3 is the init path: TOILET ledger, regional pressure, sessions,
//! and v2 draw events. There is no free-write bypass.
//!
//! Schema-2 free `draw(x,y,color)` lives only in `legacy_free` (tests).
//! Migration: do **not** call `new` over an existing schema-2 state; deploy
//! a fresh paid board account (or a planned migration path later).
//!
//! Prototype fixture economics only — not production / mainnet pricing.
//! Do not deploy until an explicit review.

mod pressure;

#[cfg(test)]
mod legacy_free;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue, PublicKey,
};
use pressure::{
    apply_successful_heat, cold_region, quote_region, region_count, region_id, BoardGeometry,
    PressureConfig, PressureError, RegionState, FIXTURE_CONFIG, FIXTURE_GEOMETRY,
    FIXTURE_QUOTE_TTL_NS, MAX_QUOTE_FUTURE_NS,
};

/// Paid schema. Shared `board.json` remains schema 2 for free-client fixtures.
const SCHEMA_VERSION: u32 = 3;
const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
const ORIGIN: &str = "top-left";
const OVERWRITE_RULE: &str = "open_wall";
const PALETTE_VERSION: &str = "1";
const LEDGER_UNIT: &str = "TOILET";
const MAX_PIXELS_PAGE: u32 = 256;
const MAX_REGIONS_PAGE: u32 = 64;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Index 0 is Ink. Unpainted cells are absent records, not Ink.
const PALETTE: [(&str, &str); 8] = [
    ("Ink", "#1c1917"),
    ("Paper", "#f4efe4"),
    ("Brick", "#b23a2f"),
    ("Marigold", "#e0a100"),
    ("Moss", "#3d7a4a"),
    ("River", "#2f6f8f"),
    ("Grape", "#6b4c7a"),
    ("Clay", "#c47b5a"),
];

/// Fixture pack only — exact MPOO amount; not mainnet economics.
const FIXTURE_PACK_ID: &str = "fixture_pack_a";
const FIXTURE_SCHEDULE_VERSION: &str = "1";
const FIXTURE_PACK_AMOUNT_MPOO: u128 = 1_000_000;
const FIXTURE_PACK_CREDIT_TOILET: u128 = 100;

// ─── Views (large ints / ns as decimal strings) ─────────────────────────────

#[near(serializers = [json])]
pub struct PaletteColor {
    pub index: u32,
    pub name: String,
    pub hex: String,
}

#[near(serializers = [json])]
pub struct PressureConfigView {
    pub version: String,
    pub region_size: u32,
    pub base_cost: String,
    pub max_cost: String,
    pub heat_cap: String,
    pub heat_increment: String,
    pub decay_per_second: String,
    pub surcharge_numerator: String,
    pub surcharge_denominator: String,
    pub effective_at_seconds: String,
    pub quote_ttl_ns: String,
}

#[near(serializers = [json])]
pub struct BoardView {
    pub schema_version: u32,
    pub width: u32,
    pub height: u32,
    pub origin: String,
    pub overwrite_rule: String,
    pub overwrite_policy: String,
    pub sponsorship_enabled: bool,
    pub chain_id: String,
    pub board_account_id: String,
    pub board_epoch: String,
    pub palette_version: String,
    pub revision: String,
    pub pricing_version: String,
    pub paint_token_account_id: String,
    pub ledger_unit: String,
    pub writes_paused: bool,
    pub pressure: PressureConfigView,
    pub palette: Vec<PaletteColor>,
}

#[near(serializers = [json])]
pub struct PixelView {
    pub x: u32,
    pub y: u32,
    pub color: Option<u32>,
    pub artist: Option<String>,
    pub written_at_ns: Option<String>,
}

#[near(serializers = [json])]
pub struct PaintedPixelView {
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub artist: String,
    pub written_at_ns: String,
}

#[near(serializers = [json])]
pub struct PixelsPage {
    pub pixels: Vec<PaintedPixelView>,
    pub from_index: u32,
    pub limit: u32,
    pub total: u32,
    pub next_from_index: Option<u32>,
}

#[near(serializers = [json])]
pub struct QuoteView {
    pub cost: String,
    pub region_id: u32,
    pub cooled_heat: String,
    pub pricing_version: String,
    pub observed_at_ns: String,
    pub expires_at_ns: String,
    pub balance: String,
    pub revision: String,
}

#[near(serializers = [json])]
pub struct PaintActionOutcomeView {
    pub action_nonce: String,
    pub status: String,
    pub charged_cost: Option<String>,
    pub revision: Option<String>,
    pub operation_id: String,
    pub observed_at_ns: String,
}

#[near(serializers = [json])]
pub struct AccountPaintView {
    pub account_id: String,
    pub balance: String,
    pub last_action_nonce: String,
    pub last_outcome: Option<PaintActionOutcomeView>,
}

#[near(serializers = [json])]
pub struct RegionPriceView {
    pub region_id: u32,
    pub cooled_heat: String,
    pub cost: String,
    pub updated_at_seconds: String,
}

#[near(serializers = [json])]
pub struct RegionsPage {
    pub regions: Vec<RegionPriceView>,
    pub from_index: u32,
    pub limit: u32,
    pub total: u32,
    pub next_from_index: Option<u32>,
    pub observed_at_ns: String,
}

#[near(serializers = [json])]
pub struct PaintSessionView {
    pub session_id: String,
    pub public_key: String,
    pub remaining_budget: String,
    pub expires_at_ns: String,
    pub board_epoch: String,
    pub revoked: bool,
}

// ─── Storage ────────────────────────────────────────────────────────────────

#[near(serializers = [borsh])]
#[derive(Clone)]
struct PixelRecord {
    color: u32,
    artist: AccountId,
    written_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct RegionRecord {
    heat: u128,
    updated_at_seconds: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct PaintOutcomeRecord {
    action_nonce: u64,
    status: String,
    charged_cost: Option<u128>,
    revision: Option<u64>,
    operation_id: String,
    observed_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct AccountPaintRecord {
    balance: u128,
    last_action_nonce: u64,
    last_outcome: Option<PaintOutcomeRecord>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct PaintSessionRecord {
    owner: AccountId,
    public_key: PublicKey,
    remaining_budget: u128,
    expires_at_ns: u64,
    board_epoch: String,
    revoked: bool,
}

#[near(serializers = [borsh])]
struct PressureConfigRecord {
    version: u32,
    region_size: u32,
    base_cost: u128,
    max_cost: u128,
    heat_cap: u128,
    heat_increment: u128,
    decay_per_second: u128,
    surcharge_numerator: u128,
    surcharge_denominator: u128,
    effective_at_seconds: u64,
    quote_ttl_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    schema_version: u32,
    chain_id: String,
    board_epoch: String,
    palette_version: String,
    revision: u64,
    pricing_version: String,
    paint_token_account_id: AccountId,
    writes_paused: bool,
    pressure: PressureConfigRecord,
    pixels: IterableMap<u32, PixelRecord>,
    regions: LookupMap<u32, RegionRecord>,
    accounts: LookupMap<AccountId, AccountPaintRecord>,
    sessions: LookupMap<String, PaintSessionRecord>,
    next_session_seq: u64,
}

#[near]
impl Board {
    /// Initialize a paid board. Call once on a fresh account.
    /// Do not call over schema-2 free state (no in-place migration).
    #[init]
    pub fn new(
        chain_id: String,
        board_epoch: String,
        paint_token_account_id: AccountId,
    ) -> Self {
        let cfg = &FIXTURE_CONFIG;
        Self {
            schema_version: SCHEMA_VERSION,
            chain_id,
            board_epoch,
            palette_version: PALETTE_VERSION.to_string(),
            revision: 0,
            pricing_version: cfg.version.to_string(),
            paint_token_account_id,
            writes_paused: false,
            pressure: PressureConfigRecord {
                version: cfg.version,
                region_size: FIXTURE_GEOMETRY.region_size,
                base_cost: cfg.base_cost,
                max_cost: cfg.max_cost,
                heat_cap: cfg.heat_cap,
                heat_increment: cfg.heat_increment,
                decay_per_second: cfg.decay_per_second,
                surcharge_numerator: cfg.surcharge_numerator,
                surcharge_denominator: cfg.surcharge_denominator,
                effective_at_seconds: cfg.effective_at,
                quote_ttl_ns: FIXTURE_QUOTE_TTL_NS,
            },
            pixels: IterableMap::new(b"p"),
            regions: LookupMap::new(b"r"),
            accounts: LookupMap::new(b"a"),
            sessions: LookupMap::new(b"s"),
            next_session_seq: 0,
        }
    }

    pub fn get_board(&self) -> BoardView {
        BoardView {
            schema_version: self.schema_version,
            width: WIDTH,
            height: HEIGHT,
            origin: ORIGIN.to_string(),
            overwrite_rule: OVERWRITE_RULE.to_string(),
            overwrite_policy: OVERWRITE_RULE.to_string(),
            sponsorship_enabled: false,
            chain_id: self.chain_id.clone(),
            board_account_id: env::current_account_id().to_string(),
            board_epoch: self.board_epoch.clone(),
            palette_version: self.palette_version.clone(),
            revision: self.revision.to_string(),
            pricing_version: self.pricing_version.clone(),
            paint_token_account_id: self.paint_token_account_id.to_string(),
            ledger_unit: LEDGER_UNIT.to_string(),
            writes_paused: self.writes_paused,
            pressure: PressureConfigView {
                version: self.pressure.version.to_string(),
                region_size: self.pressure.region_size,
                base_cost: self.pressure.base_cost.to_string(),
                max_cost: self.pressure.max_cost.to_string(),
                heat_cap: self.pressure.heat_cap.to_string(),
                heat_increment: self.pressure.heat_increment.to_string(),
                decay_per_second: self.pressure.decay_per_second.to_string(),
                surcharge_numerator: self.pressure.surcharge_numerator.to_string(),
                surcharge_denominator: self.pressure.surcharge_denominator.to_string(),
                effective_at_seconds: self.pressure.effective_at_seconds.to_string(),
                quote_ttl_ns: self.pressure.quote_ttl_ns.to_string(),
            },
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
                written_at_ns: Some(record.written_at_ns.to_string()),
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

    pub fn get_pixels(&self, from_index: u32, limit: u32) -> PixelsPage {
        let total = self.pixels.len() as u32;
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
                written_at_ns: record.written_at_ns.to_string(),
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

    /// Advisory quote — not a reservation.
    pub fn get_quote(&self, x: u32, y: u32, color: u32, account_id: AccountId) -> QuoteView {
        let _ = color; // color does not affect price; kept for wire parity
        if let Err(code) = check_coordinate(x, y) {
            reject(code);
        }
        let now_ns = env::block_timestamp();
        let t = ns_to_seconds(now_ns);
        let rid = region_id(&self.geometry(), x, y).unwrap_or_else(|_| {
            reject("CoordinateOutOfRange");
        });
        let region = self.region_state(rid);
        let (_elapsed, cooled, cost) = quote_region(&region, &self.pressure_config(), t)
            .unwrap_or_else(|e| reject_pressure(e));
        let balance = self
            .accounts
            .get(&account_id)
            .map(|a| a.balance)
            .unwrap_or(0);
        QuoteView {
            cost: cost.to_string(),
            region_id: rid,
            cooled_heat: cooled.to_string(),
            pricing_version: self.pricing_version.clone(),
            observed_at_ns: now_ns.to_string(),
            expires_at_ns: now_ns.saturating_add(self.pressure.quote_ttl_ns).to_string(),
            balance: balance.to_string(),
            revision: self.revision.to_string(),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountPaintView {
        match self.accounts.get(&account_id) {
            Some(rec) => AccountPaintView {
                account_id: account_id.to_string(),
                balance: rec.balance.to_string(),
                last_action_nonce: rec.last_action_nonce.to_string(),
                last_outcome: rec.last_outcome.as_ref().map(outcome_view),
            },
            None => AccountPaintView {
                account_id: account_id.to_string(),
                balance: "0".to_string(),
                last_action_nonce: "0".to_string(),
                last_outcome: None,
            },
        }
    }

    pub fn get_regions(&self, from_index: u32, limit: u32) -> RegionsPage {
        let total = region_count(&self.geometry());
        let limit = limit.min(MAX_REGIONS_PAGE);
        let now_ns = env::block_timestamp();
        let t = ns_to_seconds(now_ns);
        let cfg = self.pressure_config();

        let mut regions = Vec::new();
        let end = from_index.saturating_add(limit).min(total);
        for region_id in from_index..end {
            let state = self.region_state(region_id);
            let (_elapsed, cooled, cost) =
                quote_region(&state, &cfg, t).unwrap_or_else(|e| reject_pressure(e));
            regions.push(RegionPriceView {
                region_id,
                cooled_heat: cooled.to_string(),
                cost: cost.to_string(),
                updated_at_seconds: state.updated_at_seconds.to_string(),
            });
        }

        let consumed = from_index.saturating_add(regions.len() as u32);
        let next_from_index = if consumed < total {
            Some(consumed)
        } else {
            None
        };

        RegionsPage {
            regions,
            from_index,
            limit,
            total,
            next_from_index,
            observed_at_ns: now_ns.to_string(),
        }
    }

    /// Zero-deposit session draw. Requires registered `session_id`.
    #[payable]
    pub fn draw(
        &mut self,
        x: u32,
        y: u32,
        color: u32,
        max_cost: String,
        pricing_version: String,
        expires_at_ns: String,
        action_nonce: String,
        session_id: String,
    ) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(0),
            "SessionDrawRequiresZeroDeposit: session draw must attach 0 yoctoNEAR"
        );
        if session_id.is_empty() {
            reject("SessionRejected: missing session_id");
        }
        self.paint_internal(
            x,
            y,
            color,
            &max_cost,
            &pricing_version,
            &expires_at_ns,
            &action_nonce,
            Some(&session_id),
        );
    }

    /// Ordinary wallet paint. Requires exactly one yoctoNEAR; no session.
    #[payable]
    pub fn paint_with_wallet(
        &mut self,
        x: u32,
        y: u32,
        color: u32,
        max_cost: String,
        pricing_version: String,
        expires_at_ns: String,
        action_nonce: String,
    ) {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "WalletPaintRequiresOneYocto: paint_with_wallet must attach exactly 1 yoctoNEAR"
        );
        self.paint_internal(
            x,
            y,
            color,
            &max_cost,
            &pricing_version,
            &expires_at_ns,
            &action_nonce,
            None,
        );
    }

    /// Register a draw session budget. Requires predecessor == signer and 1 yocto.
    #[payable]
    pub fn register_paint_session(
        &mut self,
        public_key: PublicKey,
        max_total_cost: String,
        expires_at_ns: String,
        board_epoch: String,
    ) -> PaintSessionView {
        self.require_signer_and_one_yocto("RegisterSession");
        if board_epoch != self.board_epoch {
            reject("SessionRejected: board_epoch mismatch");
        }
        let budget = parse_u128(&max_total_cost, "InvalidMaxTotalCost");
        let expires = parse_u64(&expires_at_ns, "InvalidExpiresAtNs");
        let now = env::block_timestamp();
        if expires <= now {
            reject("SessionRejected: expires_at_ns not in the future");
        }

        let owner = env::predecessor_account_id();
        self.next_session_seq = self.next_session_seq.saturating_add(1);
        let session_id = format!("{}:{}", owner, self.next_session_seq);
        let record = PaintSessionRecord {
            owner: owner.clone(),
            public_key: public_key.clone(),
            remaining_budget: budget,
            expires_at_ns: expires,
            board_epoch: board_epoch.clone(),
            revoked: false,
        };
        self.sessions.insert(session_id.clone(), record);

        PaintSessionView {
            session_id,
            public_key: String::from(&public_key),
            remaining_budget: budget.to_string(),
            expires_at_ns: expires.to_string(),
            board_epoch,
            revoked: false,
        }
    }

    /// Revoke a session. Requires predecessor == signer and 1 yocto.
    #[payable]
    pub fn revoke_paint_session(&mut self, session_id: String) {
        self.require_signer_and_one_yocto("RevokeSession");
        let Some(mut session) = self.sessions.get(&session_id).cloned() else {
            reject("SessionRejected: unknown session_id");
        };
        if session.owner != env::predecessor_account_id() {
            reject("SessionRejected: not session owner");
        }
        session.revoked = true;
        session.remaining_budget = 0;
        self.sessions.insert(session_id, session);
    }

    /// NEP-141 receiver stub: exact fixture pack amount → TOILET credit; else refund.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.paint_token_account_id {
            env::panic_str("WrongToken: only the configured paint token may call ft_on_transfer");
        }

        let Ok(parsed) = serde_json::from_str::<FtPurchaseMessage>(&msg) else {
            return PromiseOrValue::Value(amount); // refund malformed
        };
        if parsed.version != 1
            || parsed.action != "buy_paint_pack"
            || parsed.pack_id != FIXTURE_PACK_ID
            || parsed.schedule_version != FIXTURE_SCHEDULE_VERSION
        {
            return PromiseOrValue::Value(amount);
        }
        if amount.0 != FIXTURE_PACK_AMOUNT_MPOO {
            return PromiseOrValue::Value(amount); // exact pack only
        }
        if self.writes_paused {
            return PromiseOrValue::Value(amount);
        }

        // Credit original FT sender — never a claimed browser artist.
        self.credit_balance(&sender_id, FIXTURE_PACK_CREDIT_TOILET);
        let _ = parsed.purchase_ref; // reserved for future idempotency
        PromiseOrValue::Value(U128(0))
    }
}

#[derive(serde::Deserialize)]
struct FtPurchaseMessage {
    version: u32,
    action: String,
    #[serde(rename = "packId")]
    pack_id: String,
    #[serde(rename = "scheduleVersion")]
    schedule_version: String,
    #[serde(rename = "purchaseRef")]
    purchase_ref: String,
}

impl Board {
    fn geometry(&self) -> BoardGeometry {
        BoardGeometry {
            width: WIDTH,
            height: HEIGHT,
            region_size: self.pressure.region_size,
        }
    }

    fn pressure_config(&self) -> PressureConfig {
        PressureConfig {
            version: self.pressure.version,
            base_cost: self.pressure.base_cost,
            max_cost: self.pressure.max_cost,
            heat_cap: self.pressure.heat_cap,
            heat_increment: self.pressure.heat_increment,
            decay_per_second: self.pressure.decay_per_second,
            surcharge_numerator: self.pressure.surcharge_numerator,
            surcharge_denominator: self.pressure.surcharge_denominator,
            effective_at: self.pressure.effective_at_seconds,
        }
    }

    fn region_state(&self, region_id: u32) -> RegionState {
        match self.regions.get(&region_id) {
            Some(r) => RegionState {
                heat: r.heat,
                updated_at_seconds: r.updated_at_seconds,
            },
            None => cold_region(),
        }
    }

    fn require_signer_and_one_yocto(&self, context: &str) {
        require!(
            env::predecessor_account_id() == env::signer_account_id(),
            format!("{context}: predecessor must equal signer")
        );
        require!(
            env::attached_deposit() == ONE_YOCTO,
            format!("{context}: must attach exactly 1 yoctoNEAR")
        );
    }

    fn credit_balance(&mut self, account_id: &AccountId, amount: u128) {
        let mut rec = self.accounts.get(account_id).cloned().unwrap_or(AccountPaintRecord {
            balance: 0,
            last_action_nonce: 0,
            last_outcome: None,
        });
        rec.balance = rec
            .balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("BalanceOverflow"));
        self.accounts.insert(account_id.clone(), rec);
    }

    #[allow(clippy::too_many_arguments)]
    fn paint_internal(
        &mut self,
        x: u32,
        y: u32,
        color: u32,
        max_cost_str: &str,
        pricing_version: &str,
        expires_at_ns_str: &str,
        action_nonce_str: &str,
        session_id: Option<&str>,
    ) {
        if self.writes_paused {
            reject("WritesPaused");
        }
        if env::predecessor_account_id() != env::signer_account_id() {
            reject("SignerMismatch: predecessor must equal signer");
        }
        if let Err(code) = validate_draw_args(x, y, color) {
            reject(code);
        }

        let artist = env::predecessor_account_id();
        let now_ns = env::block_timestamp();
        let t = ns_to_seconds(now_ns);
        let max_cost = parse_u128(max_cost_str, "InvalidMaxCost");
        let expires_at_ns = parse_u64(expires_at_ns_str, "InvalidExpiresAtNs");
        let action_nonce = parse_u64(action_nonce_str, "InvalidActionNonce");

        if pricing_version != self.pricing_version {
            reject("VersionMismatch: pricing_version does not match board");
        }
        if now_ns > expires_at_ns {
            reject("ExpiredQuote: quote expired before execution");
        }
        if expires_at_ns > now_ns.saturating_add(MAX_QUOTE_FUTURE_NS) {
            reject("ExpiredQuote: expires_at_ns exceeds max future TTL");
        }

        // Session checks before debit (zero-deposit path only).
        let mut session_key: Option<String> = None;
        if let Some(sid) = session_id {
            let Some(session) = self.sessions.get(sid) else {
                reject("SessionRejected: unknown session_id");
            };
            if session.revoked {
                reject("SessionRejected: session revoked");
            }
            if session.owner != artist {
                reject("SessionRejected: session owner mismatch");
            }
            if session.board_epoch != self.board_epoch {
                reject("SessionRejected: session board_epoch mismatch");
            }
            if now_ns > session.expires_at_ns {
                reject("SessionRejected: session expired");
            }
            if session.public_key != env::signer_account_pk() {
                reject("SessionRejected: signer public key mismatch");
            }
            session_key = Some(sid.to_string());
        }

        let mut account = self.accounts.get(&artist).cloned().unwrap_or(AccountPaintRecord {
            balance: 0,
            last_action_nonce: 0,
            last_outcome: None,
        });
        let expected_nonce = account.last_action_nonce.saturating_add(1);
        if action_nonce != expected_nonce {
            reject("NonceRejected: action_nonce must equal last+1");
        }

        let rid = region_id(&self.geometry(), x, y).unwrap_or_else(|_| {
            reject("CoordinateOutOfRange");
        });
        let region = self.region_state(rid);
        let (_elapsed, cooled, cost) = quote_region(&region, &self.pressure_config(), t)
            .unwrap_or_else(|e| reject_pressure(e));

        if cost > max_cost {
            reject("MaxCostExceeded: actual cost greater than max_cost");
        }

        // Same-artist / same-color: no-op reject without charge or heat.
        let key = pixel_key(x, y);
        if let Some(existing) = self.pixels.get(&key) {
            if existing.artist == artist && existing.color == color {
                reject("NoopSameColor: same artist and color; no charge");
            }
        }

        if account.balance < cost {
            reject("InsufficientBalance: not enough TOILET");
        }

        if let Some(ref sid) = session_key {
            let session = self.sessions.get(sid).expect("session checked");
            if session.remaining_budget < cost {
                reject("SessionRejected: insufficient session budget");
            }
        }

        // ── Mutations (commit together) ──────────────────────────────────
        account.balance -= cost;
        account.last_action_nonce = action_nonce;
        self.revision = self.revision.saturating_add(1);
        let revision = self.revision;
        let operation_id = format!("{}:{}:{}", self.board_epoch, artist, action_nonce);
        account.last_outcome = Some(PaintOutcomeRecord {
            action_nonce,
            status: "accepted".to_string(),
            charged_cost: Some(cost),
            revision: Some(revision),
            operation_id: operation_id.clone(),
            observed_at_ns: now_ns,
        });
        self.accounts.insert(artist.clone(), account);

        if let Some(sid) = session_key {
            let mut session = self.sessions.get(&sid).cloned().expect("session");
            session.remaining_budget -= cost;
            self.sessions.insert(sid, session);
        }

        self.pixels.insert(
            key,
            PixelRecord {
                color,
                artist: artist.clone(),
                written_at_ns: now_ns,
            },
        );

        let next_heat = apply_successful_heat(cooled, &self.pressure_config(), t)
            .unwrap_or_else(|e| reject_pressure(e));
        self.regions.insert(
            rid,
            RegionRecord {
                heat: next_heat.heat,
                updated_at_seconds: next_heat.updated_at_seconds,
            },
        );

        emit_draw_v2(
            &self.board_epoch,
            revision,
            x,
            y,
            color,
            &artist,
            now_ns,
            &self.palette_version,
            cost,
            &self.pricing_version,
            action_nonce,
        );
    }
}

fn outcome_view(rec: &PaintOutcomeRecord) -> PaintActionOutcomeView {
    PaintActionOutcomeView {
        action_nonce: rec.action_nonce.to_string(),
        status: rec.status.clone(),
        charged_cost: rec.charged_cost.map(|c| c.to_string()),
        revision: rec.revision.map(|r| r.to_string()),
        operation_id: rec.operation_id.clone(),
        observed_at_ns: rec.observed_at_ns.to_string(),
    }
}

fn emit_draw_v2(
    board_epoch: &str,
    revision: u64,
    x: u32,
    y: u32,
    color: u32,
    artist: &AccountId,
    written_at_ns: u64,
    palette_version: &str,
    cost_toilet: u128,
    pricing_version: &str,
    action_nonce: u64,
) {
    // NEP-style event; large ints as decimal strings per protocol freeze.
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"mpoo_board\",\"version\":\"2.0.0\",\"event\":\"draw\",\"data\":[{{\
\"boardEpoch\":\"{board_epoch}\",\
\"revision\":\"{revision}\",\
\"x\":{x},\
\"y\":{y},\
\"color\":{color},\
\"artist\":\"{artist}\",\
\"writtenAtNs\":\"{written_at_ns}\",\
\"paletteVersion\":\"{palette_version}\",\
\"costToilet\":\"{cost_toilet}\",\
\"pricingVersion\":\"{pricing_version}\",\
\"actionNonce\":\"{action_nonce}\"\
}}]}}"
    ));
}

fn pixel_key(x: u32, y: u32) -> u32 {
    y * WIDTH + x
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

fn ns_to_seconds(ns: u64) -> u64 {
    ns / 1_000_000_000
}

fn parse_u128(s: &str, code: &str) -> u128 {
    s.parse::<u128>()
        .unwrap_or_else(|_| env::panic_str(&format!("{code}: expected decimal string")))
}

fn parse_u64(s: &str, code: &str) -> u64 {
    s.parse::<u64>()
        .unwrap_or_else(|_| env::panic_str(&format!("{code}: expected decimal string")))
}

fn reject(code: &str) -> ! {
    env::panic_str(code);
}

fn reject_pressure(err: PressureError) -> ! {
    match err {
        PressureError::ZeroDenominator => reject("PressureError: zero surcharge denominator"),
        PressureError::OutOfBounds => reject("CoordinateOutOfRange"),
        PressureError::Overflow => reject("PressureOverflow: surcharge multiplication overflow"),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId, PublicKey};

    const NS: u64 = 1_000_000_000;

    fn test_pk() -> PublicKey {
        "ed25519:6E8sCejN9Ay1xHmfgraKxV5mkxnEqr8YnXcVZVbKEVLx"
            .parse()
            .expect("test public key")
    }

    fn other_pk() -> PublicKey {
        "ed25519:3tysLvy7KGoE8pbraDWAjJz1HFu6xdXhQhNsKZiXEYaR"
            .parse()
            .expect("other public key")
    }

    fn context_builder(
        predecessor: AccountId,
        block_timestamp_ns: u64,
        deposit: NearToken,
        pk: PublicKey,
    ) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(2))
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .signer_account_pk(pk)
            .block_timestamp(block_timestamp_ns)
            .attached_deposit(deposit);
        builder
    }

    fn set_ctx(predecessor: AccountId, ts_ns: u64, deposit: NearToken, pk: PublicKey) {
        testing_env!(context_builder(predecessor, ts_ns, deposit, pk).build());
    }

    fn setup() -> Board {
        set_ctx(accounts(0), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        Board::new(
            "testnet".to_string(),
            "epoch-1".to_string(),
            accounts(3), // mock paint token
        )
    }

    fn credit(board: &mut Board, account: &AccountId, amount: u128) {
        // Simulate accepted ft_on_transfer credit.
        set_ctx(accounts(3), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let msg = serde_json::json!({
            "version": 1,
            "action": "buy_paint_pack",
            "packId": FIXTURE_PACK_ID,
            "scheduleVersion": FIXTURE_SCHEDULE_VERSION,
            "purchaseRef": "test-ref-1"
        })
        .to_string();
        // Credit in packs of FIXTURE_PACK_CREDIT_TOILET; for tests we may need more.
        let packs = amount.div_ceil(FIXTURE_PACK_CREDIT_TOILET);
        for i in 0..packs {
            let refund = board.ft_on_transfer(
                account.clone(),
                U128(FIXTURE_PACK_AMOUNT_MPOO),
                serde_json::json!({
                    "version": 1,
                    "action": "buy_paint_pack",
                    "packId": FIXTURE_PACK_ID,
                    "scheduleVersion": FIXTURE_SCHEDULE_VERSION,
                    "purchaseRef": format!("test-ref-{i}")
                })
                .to_string(),
            );
            match refund {
                PromiseOrValue::Value(v) => assert_eq!(v.0, 0, "expected accept"),
                _ => panic!("unexpected promise"),
            }
            let _ = &msg;
        }
        // Trim excess if amount is not a pack multiple (direct adjust for exact tests).
        let bal = board.accounts.get(account).map(|a| a.balance).unwrap_or(0);
        if bal > amount {
            let mut rec = board.accounts.get(account).cloned().unwrap();
            rec.balance = amount;
            board.accounts.insert(account.clone(), rec);
        }
    }

    fn paint_wallet(
        board: &mut Board,
        account: AccountId,
        ts_ns: u64,
        x: u32,
        y: u32,
        color: u32,
        max_cost: u128,
        nonce: u64,
    ) {
        set_ctx(account, ts_ns, ONE_YOCTO, test_pk());
        let expires = ts_ns + FIXTURE_QUOTE_TTL_NS;
        board.paint_with_wallet(
            x,
            y,
            color,
            max_cost.to_string(),
            "1".to_string(),
            expires.to_string(),
            nonce.to_string(),
        );
    }

    #[test]
    fn paid_board_view_has_schema_3_and_open_wall() {
        let board = setup();
        let view = board.get_board();
        assert_eq!(view.schema_version, 3);
        assert_eq!(view.width, 128);
        assert_eq!(view.height, 128);
        assert_eq!(view.overwrite_policy, "open_wall");
        assert_eq!(view.ledger_unit, "TOILET");
        assert_eq!(view.revision, "0");
        assert_eq!(view.pricing_version, "1");
        assert_eq!(view.pressure.base_cost, "10");
        assert_eq!(view.pressure.max_cost, "50");
        assert!(!view.sponsorship_enabled);
    }

    #[test]
    fn geometry_matches_fixture_256_regions() {
        let board = setup();
        assert_eq!(region_count(&board.geometry()), 256);
        assert_eq!(region_id(&board.geometry(), 0, 0).unwrap(), 0);
        assert_eq!(region_id(&board.geometry(), 7, 0).unwrap(), 0);
        assert_eq!(region_id(&board.geometry(), 8, 0).unwrap(), 1);
        assert_eq!(region_id(&board.geometry(), 0, 8).unwrap(), 16);
    }

    #[test]
    fn golden_pressure_vectors_via_quote() {
        let mut board = setup();
        // cold at t=100s → cost 10
        set_ctx(accounts(0), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let q = board.get_quote(0, 0, 1, accounts(0));
        assert_eq!(q.cost, "10");
        assert_eq!(q.cooled_heat, "0");

        credit(&mut board, &accounts(0), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 1, 50, 1);

        // same second → cost 11
        set_ctx(accounts(0), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let q2 = board.get_quote(1, 0, 2, accounts(0));
        assert_eq!(q2.region_id, 0);
        assert_eq!(q2.cost, "11");
        assert_eq!(q2.cooled_heat, "10");

        paint_wallet(&mut board, accounts(0), 100 * NS, 1, 0, 2, 50, 2);
        // heat 20; after 10s cools to 10 → cost 11
        set_ctx(accounts(0), 110 * NS, NearToken::from_yoctonear(0), test_pk());
        let q3 = board.get_quote(2, 0, 3, accounts(0));
        assert_eq!(q3.cooled_heat, "10");
        assert_eq!(q3.cost, "11");
    }

    #[test]
    fn heat_cap_quote_is_50() {
        let mut board = setup();
        // Force region heat to cap.
        board.regions.insert(
            0,
            RegionRecord {
                heat: 400,
                updated_at_seconds: 50,
            },
        );
        set_ctx(accounts(0), 50 * NS, NearToken::from_yoctonear(0), test_pk());
        let q = board.get_quote(0, 0, 1, accounts(0));
        assert_eq!(q.cost, "50");
        assert_eq!(q.cooled_heat, "400");
    }

    #[test]
    #[should_panic(expected = "NoopSameColor")]
    fn noop_same_artist_same_color_no_charge() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 4, 50, 1);
        let bal_before = board.get_account(accounts(0)).balance;
        let rev_before = board.get_board().revision;
        // same artist + color → panic; balance/revision unchanged after rollback
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 4, 50, 2);
        let _ = (bal_before, rev_before);
    }

    #[test]
    fn noop_leaves_balance_and_heat_unchanged_when_caught() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 4, 50, 1);
        let bal_before: u128 = board.get_account(accounts(0)).balance.parse().unwrap();
        let heat_before = board.region_state(0).heat;
        let rev_before = board.revision;

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            paint_wallet(&mut board, accounts(0), 101 * NS, 0, 0, 4, 50, 2);
        }));
        assert!(result.is_err());
        // In unit tests, panic does not roll back local Rust state the same way
        // as chain — paint_internal panics before mutation, so state is intact.
        assert_eq!(
            board.get_account(accounts(0)).balance.parse::<u128>().unwrap(),
            bal_before
        );
        assert_eq!(board.region_state(0).heat, heat_before);
        assert_eq!(board.revision, rev_before);
        assert_eq!(board.get_account(accounts(0)).last_action_nonce, "1");
    }

    #[test]
    fn other_account_same_color_charges() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        credit(&mut board, &accounts(1), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 4, 50, 1);

        set_ctx(accounts(1), 101 * NS, ONE_YOCTO, test_pk());
        let expires = 101 * NS + FIXTURE_QUOTE_TTL_NS;
        board.paint_with_wallet(
            0,
            0,
            4,
            "50".to_string(),
            "1".to_string(),
            expires.to_string(),
            "1".to_string(),
        );
        let pixel = board.get_pixel(0, 0);
        assert_eq!(pixel.artist.as_deref(), Some(accounts(1).as_str()));
        assert_eq!(board.revision, 2);
        let bal: u128 = board.get_account(accounts(1)).balance.parse().unwrap();
        assert!(bal < 100);
    }

    #[test]
    #[should_panic(expected = "InsufficientBalance")]
    fn insufficient_balance_rejects() {
        let mut board = setup();
        // no credit
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 1, 50, 1);
    }

    #[test]
    #[should_panic(expected = "ExpiredQuote")]
    fn expired_quote_rejects() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        set_ctx(accounts(0), 100 * NS, ONE_YOCTO, test_pk());
        board.paint_with_wallet(
            0,
            0,
            1,
            "50".to_string(),
            "1".to_string(),
            (99 * NS).to_string(), // already expired
            "1".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "VersionMismatch")]
    fn version_mismatch_rejects() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        set_ctx(accounts(0), 100 * NS, ONE_YOCTO, test_pk());
        let expires = 100 * NS + FIXTURE_QUOTE_TTL_NS;
        board.paint_with_wallet(
            0,
            0,
            1,
            "50".to_string(),
            "999".to_string(),
            expires.to_string(),
            "1".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "NonceRejected")]
    fn duplicate_nonce_rejects_without_debit() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 1, 50, 1);
        // replay nonce 1
        paint_wallet(&mut board, accounts(0), 101 * NS, 1, 0, 2, 50, 1);
    }

    #[test]
    #[should_panic(expected = "NonceRejected")]
    fn stale_nonce_rejects() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 1, 50, 1);
        paint_wallet(&mut board, accounts(0), 101 * NS, 1, 0, 2, 50, 0);
    }

    #[test]
    #[should_panic(expected = "SessionRejected: missing session_id")]
    fn session_draw_missing_session_id_rejects() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        set_ctx(accounts(0), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let expires = 100 * NS + FIXTURE_QUOTE_TTL_NS;
        board.draw(
            0,
            0,
            1,
            "50".to_string(),
            "1".to_string(),
            expires.to_string(),
            "1".to_string(),
            "".to_string(),
        );
    }

    #[test]
    fn register_and_session_draw_succeeds() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);

        set_ctx(accounts(0), 100 * NS, ONE_YOCTO, test_pk());
        let session = board.register_paint_session(
            test_pk(),
            "50".to_string(),
            (200 * NS).to_string(),
            "epoch-1".to_string(),
        );
        assert!(!session.session_id.is_empty());
        assert_eq!(session.remaining_budget, "50");

        set_ctx(accounts(0), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let expires = 100 * NS + FIXTURE_QUOTE_TTL_NS;
        board.draw(
            0,
            0,
            1,
            "50".to_string(),
            "1".to_string(),
            expires.to_string(),
            "1".to_string(),
            session.session_id.clone(),
        );
        assert_eq!(board.revision, 1);
        let pixel = board.get_pixel(0, 0);
        assert_eq!(pixel.color, Some(1));
        let acct = board.get_account(accounts(0));
        assert_eq!(acct.balance, "90");
        assert_eq!(acct.last_action_nonce, "1");
        assert_eq!(acct.last_outcome.as_ref().unwrap().status, "accepted");
    }

    #[test]
    #[should_panic(expected = "SessionRejected: signer public key mismatch")]
    fn session_draw_wrong_key_rejects() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        set_ctx(accounts(0), 100 * NS, ONE_YOCTO, test_pk());
        let session = board.register_paint_session(
            test_pk(),
            "50".to_string(),
            (200 * NS).to_string(),
            "epoch-1".to_string(),
        );
        set_ctx(accounts(0), 100 * NS, NearToken::from_yoctonear(0), other_pk());
        let expires = 100 * NS + FIXTURE_QUOTE_TTL_NS;
        board.draw(
            0,
            0,
            1,
            "50".to_string(),
            "1".to_string(),
            expires.to_string(),
            "1".to_string(),
            session.session_id,
        );
    }

    #[test]
    fn successful_placement_increments_revision_only() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        assert_eq!(board.revision, 0);
        paint_wallet(&mut board, accounts(0), 100 * NS, 0, 0, 1, 50, 1);
        assert_eq!(board.revision, 1);
        paint_wallet(&mut board, accounts(0), 101 * NS, 0, 0, 2, 50, 2);
        assert_eq!(board.revision, 2);
    }

    #[test]
    fn get_regions_bounded() {
        let board = setup();
        let page = board.get_regions(0, 1000);
        assert_eq!(page.limit, MAX_REGIONS_PAGE);
        assert_eq!(page.regions.len(), MAX_REGIONS_PAGE as usize);
        assert_eq!(page.total, 256);
        assert_eq!(page.next_from_index, Some(64));
        assert_eq!(page.regions[0].cost, "10");
    }

    #[test]
    fn ft_on_transfer_exact_pack_credits_sender() {
        let mut board = setup();
        set_ctx(accounts(3), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let msg = serde_json::json!({
            "version": 1,
            "action": "buy_paint_pack",
            "packId": FIXTURE_PACK_ID,
            "scheduleVersion": FIXTURE_SCHEDULE_VERSION,
            "purchaseRef": "p1"
        })
        .to_string();
        let refund = board.ft_on_transfer(accounts(0), U128(FIXTURE_PACK_AMOUNT_MPOO), msg);
        match refund {
            PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
            _ => panic!("expected value"),
        }
        assert_eq!(
            board.get_account(accounts(0)).balance,
            FIXTURE_PACK_CREDIT_TOILET.to_string()
        );
        // funding must not bump revision
        assert_eq!(board.revision, 0);
    }

    #[test]
    fn ft_on_transfer_wrong_amount_refunds() {
        let mut board = setup();
        set_ctx(accounts(3), 100 * NS, NearToken::from_yoctonear(0), test_pk());
        let msg = serde_json::json!({
            "version": 1,
            "action": "buy_paint_pack",
            "packId": FIXTURE_PACK_ID,
            "scheduleVersion": FIXTURE_SCHEDULE_VERSION,
            "purchaseRef": "p1"
        })
        .to_string();
        let refund = board.ft_on_transfer(accounts(0), U128(999), msg);
        match refund {
            PromiseOrValue::Value(v) => assert_eq!(v.0, 999),
            _ => panic!("expected refund"),
        }
        assert_eq!(board.get_account(accounts(0)).balance, "0");
    }

    #[test]
    fn written_at_ns_is_decimal_string() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 3, 4, 2, 50, 1);
        let pixel = board.get_pixel(3, 4);
        let expected_ns = (100 * NS).to_string();
        assert_eq!(pixel.written_at_ns.as_deref(), Some(expected_ns.as_str()));
    }

    #[test]
    fn open_wall_overwrite_by_other_account() {
        let mut board = setup();
        credit(&mut board, &accounts(0), 100);
        credit(&mut board, &accounts(1), 100);
        paint_wallet(&mut board, accounts(0), 100 * NS, 3, 4, 2, 50, 1);
        set_ctx(accounts(1), 101 * NS, ONE_YOCTO, test_pk());
        let expires = 101 * NS + FIXTURE_QUOTE_TTL_NS;
        board.paint_with_wallet(
            3,
            4,
            5,
            "50".to_string(),
            "1".to_string(),
            expires.to_string(),
            "1".to_string(),
        );
        let pixel = board.get_pixel(3, 4);
        assert_eq!(pixel.color, Some(5));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(1).as_str()));
    }
}
