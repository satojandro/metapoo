//! State layout versions and the version-1 → version-2 migration (REV-A, spec §C7).
//!
//! # Versions
//!
//! - **Version 1** is the layout deployed on `board3.metapoo-player1.testnet` on
//!   2026-10-29. It has no `state_version` field. Its first field is
//!   `schema_version`, which v1 code only ever set to the constant 4.
//! - **Version 2** (this code) puts `state_version: u32 = 2` as the *first* field.
//!
//! # How the source version is detected
//!
//! The contract state is one Borsh value under the key `STATE`, so its first four
//! bytes are the first field, little-endian:
//!
//! | first u32 | meaning | action |
//! |---|---|---|
//! | `2` | already version 2 | reject `UnsupportedStateVersion` |
//! | `4` | version 1 (`schema_version`) | strict Borsh read as [`BoardV1`]; any error, trailing byte or unexpected value rejects |
//! | anything else, or no state | unknown | reject `UnsupportedStateVersion` |
//!
//! "Strict" means `try_from_slice`, which fails if any byte is left over, and
//! `AccountId` deserialization validates every account id. A second `migrate` call
//! therefore sees a leading `2` and rejects, without having to guess.
//!
//! **Rule for later layouts:** never assign `state_version = 4`; that word is how a
//! version-1 state identifies itself. Version 3's migration accepts only a leading `2`.
//!
//! # What never changes
//!
//! The maps `p` (pixels), `h` (holders) and `c` (credit balances) keep their prefix
//! and value type. They are not iterable at this size, so they cannot be rewritten
//! in a transaction; the migration moves their handles, not their contents. New
//! per-account and per-cell facts live in new maps (`a`, `f`) that start empty and
//! read as defaults when absent.
use crate::emission::Holder;
use crate::payments::Payments;
use crate::{AccountExtra, Board, PixelRecord, Tunables, HEIGHT, SCHEMA_VERSION, WIDTH};
use near_sdk::borsh::BorshDeserialize;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, AccountId};

/// Layout written by this code.
pub(crate) const STATE_VERSION: u32 = 2;
/// The first u32 of every version-1 state: its `schema_version`, always 4.
const V1_LEADING_WORD: u32 = 4;
const STATE_KEY: &[u8] = b"STATE";

/// Version-1 `Tunables`, field for field. Read-only: exists to decode old state.
#[near(serializers = [borsh])]
pub(crate) struct TunablesV1 {
    pub paused: bool,
    pub reserve_floor: near_sdk::json_types::U128,
    pub price_cooldown_ns: u64,
    pub last_price_change_ns: Option<u64>,
    pub repaint_young_ns: u64,
    pub repaint_young_credits: u32,
    pub repaint_mid_ns: u64,
    pub repaint_mid_credits: u32,
    pub repaint_base_credits: u32,
    pub max_outstanding_credits: u128,
    pub quota_base: u32,
    pub quota_per_cell: u32,
    pub quota_max: u32,
    pub max_earning_cells: u32,
    pub toilet_per_cell_second: u128,
}

/// Version-1 `Payments`, field for field.
#[near(serializers = [borsh])]
pub(crate) struct PaymentsV1 {
    pub owner: AccountId,
    pub token: AccountId,
    pub near_price: u128,
    pub mpoo_price: u128,
    pub balances: LookupMap<AccountId, u128>,
    pub outstanding: u128,
}

/// Version-1 `Board`, field for field. Note: no `state_version`.
#[near(serializers = [borsh])]
pub(crate) struct BoardV1 {
    pub schema_version: u32,
    pub payments: PaymentsV1,
    pub tunables: TunablesV1,
    pub pixels: IterableMap<u32, PixelRecord>,
    pub holders: LookupMap<AccountId, Holder>,
    pub acc_per_cell: u128,
    pub last_accrual_ns: u64,
    pub accrued_total: u128,
    pub total_cells: u32,
}

fn unsupported(detail: &str) -> ! {
    env::panic_str(&format!("UnsupportedStateVersion: {detail}"))
}

/// Read the raw `STATE` value and decode it as version 1, or reject. See the module
/// docs for the detection table.
pub(crate) fn read_v1() -> BoardV1 {
    let Some(raw) = env::storage_read(STATE_KEY) else {
        unsupported("no contract state to migrate");
    };
    let Some(word) = raw.get(..4) else {
        unsupported("state is shorter than a version word");
    };
    let leading = u32::from_le_bytes(word.try_into().expect("four bytes"));
    if leading == STATE_VERSION {
        unsupported("state is already version 2");
    }
    if leading != V1_LEADING_WORD {
        unsupported("unknown state layout");
    }
    match BoardV1::try_from_slice(&raw) {
        Ok(v1) if v1.schema_version == V1_LEADING_WORD => v1,
        _ => unsupported("state does not decode as version 1"),
    }
}

impl Tunables {
    /// Every v1 knob keeps its value. The single v1 price cooldown becomes the NEAR
    /// cooldown, and its last change seeds *both* last-change times, because the v1
    /// price setter always moved both prices together.
    pub(crate) fn from_v1(v1: TunablesV1) -> Self {
        Self {
            paused: v1.paused,
            reserve_floor: v1.reserve_floor,
            near_price_cooldown_ns: v1.price_cooldown_ns,
            last_near_price_change_ns: v1.last_price_change_ns,
            last_mpoo_price_change_ns: v1.last_price_change_ns,
            repaint_young_ns: v1.repaint_young_ns,
            repaint_young_credits: v1.repaint_young_credits,
            repaint_mid_ns: v1.repaint_mid_ns,
            repaint_mid_credits: v1.repaint_mid_credits,
            repaint_base_credits: v1.repaint_base_credits,
            max_outstanding_credits: v1.max_outstanding_credits,
            quota_base: v1.quota_base,
            quota_per_cell: v1.quota_per_cell,
            quota_max: v1.quota_max,
            max_earning_cells: v1.max_earning_cells,
            toilet_per_cell_second: v1.toilet_per_cell_second,
            ..Tunables::default()
        }
    }
}

impl Board {
    /// Build a version-2 board from a decoded version-1 one.
    pub(crate) fn from_v1(
        v1: BoardV1,
        team_account: AccountId,
        buyback_account: AccountId,
    ) -> Self {
        let p = v1.payments;
        let payments = Payments::from_v1(
            p.owner,
            p.token,
            p.near_price,
            p.mpoo_price,
            p.balances,
            p.outstanding,
            team_account,
            buyback_account,
        );
        // The latch is a fact about the board, not a setting: derive it rather than
        // assume a migrated board is not full.
        let first_fill_complete = v1.pixels.len() >= WIDTH * HEIGHT;
        Self {
            state_version: STATE_VERSION,
            schema_version: SCHEMA_VERSION,
            payments,
            tunables: Tunables::from_v1(v1.tunables),
            pixels: v1.pixels,
            holders: v1.holders,
            acc_per_cell: v1.acc_per_cell,
            last_accrual_ns: v1.last_accrual_ns,
            accrued_total: v1.accrued_total,
            total_cells: v1.total_cells,
            first_fill_complete,
            account_extra: LookupMap::<AccountId, AccountExtra>::new(crate::PREFIX_ACCOUNT_EXTRA),
            free_cells: LookupSet::new(crate::PREFIX_FREE_CELLS),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const FIXTURE: &str = include_str!("../fixtures/state_v1.json");

    fn board_account() -> AccountId {
        "board3.metapoo-player1.testnet".parse().unwrap()
    }
    fn team() -> AccountId {
        "team.metapoo.testnet".parse().unwrap()
    }
    fn buyback() -> AccountId {
        "buyback.metapoo.testnet".parse().unwrap()
    }

    fn ctx(caller: AccountId, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(board_account())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(100))
            .block_timestamp(ts)
            .build());
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    /// Install the v1 trie exactly as the v1 code left it. Returns the expectations.
    fn load_v1_state() -> serde_json::Value {
        let fixture = fixture();
        ctx(board_account(), 0, 1_762_000_000_000_000_000);
        for entry in fixture["storage"].as_array().unwrap() {
            let key = unhex(entry[0].as_str().unwrap());
            let value = unhex(entry[1].as_str().unwrap());
            env::storage_write(&key, &value);
        }
        fixture["expected"].clone()
    }

    /// Write `board` back the way the runtime does at the end of an init call.
    fn persist(board: &mut Board) {
        board.pixels.flush();
        board.holders.flush();
        board.payments.balances.flush();
        board.account_extra.flush();
        env::state_write(board);
    }

    fn rejected(code: &str, f: impl FnOnce()) {
        let err =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
        let message = err
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains(code), "{message}");
    }

    #[test]
    fn migrating_real_v1_state_preserves_every_balance_pixel_and_holder() {
        let expected = load_v1_state();
        let mut board = Board::migrate(team(), buyback());
        persist(&mut board);
        // Read back through the runtime path, as the next transaction would.
        let board: Board = env::state_read().expect("v2 state");

        assert_eq!(board.get_state_version(), 2);
        assert_eq!(board.get_board().schema_version, 4);
        assert_eq!(
            board.payments.owner.as_str(),
            expected["owner"].as_str().unwrap()
        );

        for account in expected["accounts"].as_array().unwrap() {
            let id: AccountId = account["account_id"].as_str().unwrap().parse().unwrap();
            let credits = board.get_credits(id.clone());
            assert_eq!(
                serde_json::to_value(credits).unwrap(),
                account["credits"],
                "{id}"
            );
            assert_eq!(
                u64::from(board.get_cells_owned(id.clone())),
                account["cells_owned"].as_u64().unwrap(),
                "{id}"
            );
        }

        let page = board.get_pixels(0, 256);
        let pixels: Vec<serde_json::Value> = page
            .pixels
            .iter()
            .map(|p| {
                serde_json::json!({
                    "x": p.x, "y": p.y, "color": p.color, "artist": p.artist,
                    "written_at_ns": p.written_at_ns
                })
            })
            .collect();
        assert_eq!(serde_json::Value::Array(pixels), expected["pixels"]);
        assert_eq!(
            u64::from(board.total_cells),
            expected["total_cells"].as_u64().unwrap()
        );
        assert_eq!(
            serde_json::to_value(board.get_outstanding_credits()).unwrap(),
            expected["outstanding"]
        );
        assert_eq!(
            serde_json::to_value(board.get_payment_config()).unwrap(),
            expected["payment_config"]
        );
        assert_eq!(
            board.acc_per_cell.to_string(),
            expected["acc_per_cell"].as_str().unwrap()
        );
        assert_eq!(
            board.last_accrual_ns,
            expected["last_accrual_ns"].as_u64().unwrap()
        );
        assert_eq!(
            board.accrued_total.to_string(),
            expected["accrued_total"].as_str().unwrap()
        );

        // Every v1 knob keeps its value; the one cooldown becomes the NEAR one.
        let old = &expected["tunables"];
        let new = serde_json::to_value(board.get_tunables()).unwrap();
        for field in [
            "paused",
            "reserve_floor",
            "repaint_young_ns",
            "repaint_young_credits",
            "repaint_mid_ns",
            "repaint_mid_credits",
            "repaint_base_credits",
            "max_outstanding_credits",
            "quota_base",
            "quota_per_cell",
            "quota_max",
            "max_earning_cells",
            "toilet_per_cell_second",
        ] {
            assert_eq!(new[field], old[field], "{field}");
        }
        assert_eq!(new["near_price_cooldown_ns"], old["price_cooldown_ns"]);
        assert_eq!(
            new["last_near_price_change_ns"],
            old["last_price_change_ns"]
        );
        assert_eq!(
            new["last_mpoo_price_change_ns"],
            old["last_price_change_ns"]
        );

        // New fields at their defaults.
        let t = board.get_tunables();
        let d = Tunables::default();
        assert_eq!(t.mpoo_price_cooldown_ns, d.mpoo_price_cooldown_ns);
        assert_eq!(t.mpoo_daily_credit_cap, 0);
        assert_eq!(t.free_first_paints_per_account, 25);
        assert!(!t.happy_hour_enabled);
        assert_eq!(t.happy_hour_weekday, 6);
        assert_eq!(t.happy_hour_start_s, 72_000);
        assert_eq!(t.happy_hour_length_s, 3_600);
        assert_eq!(t.happy_hour_cap_per_account, 100);
        assert!(t.happy_hour_requires_purchase);
        assert_eq!(t.last_happy_hour_change_ns, None);
        assert_eq!(t.distribution_interval_ns, 3_600_000_000_000);
        let p = &board.payments;
        assert_eq!(p.team_account, team());
        assert_eq!(p.buyback_account, buyback());
        assert_eq!(p.staking_contract, None);
        assert_eq!(p.last_team_account_change_ns, None);
        assert_eq!(p.last_buyback_account_change_ns, None);
        assert_eq!((p.mpoo_day_index, p.mpoo_credits_sold_today), (0, 0));
        assert_eq!((p.mpoo_undistributed, p.mpoo_staker_reserve), (0, 0));
        assert_eq!(p.last_near_distribution_ns, None);
        assert_eq!(p.last_mpoo_distribution_ns, None);
        assert!(!board.first_fill_complete);
        for account in expected["accounts"].as_array().unwrap() {
            let id: AccountId = account["account_id"].as_str().unwrap().parse().unwrap();
            assert_eq!(board.account_extra(&id), AccountExtra::default());
        }
        for pixel in expected["pixels"].as_array().unwrap() {
            let key = crate::pixel_key(
                pixel["x"].as_u64().unwrap() as u32,
                pixel["y"].as_u64().unwrap() as u32,
            );
            assert!(!board.free_cells.contains(&key));
        }
    }

    #[test]
    fn a_migrated_board_keeps_working_on_the_old_maps() {
        load_v1_state();
        let mut board = Board::migrate(team(), buyback());
        persist(&mut board);
        let mut board: Board = env::state_read().unwrap();
        // bob held 3 credits; a base-tier repaint of his own old cell costs 1.
        ctx(accounts(1), 0, 1_762_000_000_000_000_000);
        board.draw(2, 0, 6, u32::MAX);
        assert_eq!(board.get_credits(accounts(1)), Some(U128(2)));
        assert_eq!(board.get_outstanding_credits(), U128(23));
        assert_eq!(board.get_pixel(2, 0).color, Some(6));
        // danny (registered in v1) can still buy.
        let price = board.get_payment_config().near_per_credit.0;
        ctx(accounts(3), price, 1_762_000_000_000_000_000);
        assert_eq!(board.buy_credits_near(U128(1), U128(price)), U128(1));
        assert_eq!(board.get_credits(accounts(3)), Some(U128(4)));
    }

    #[test]
    fn migrating_twice_is_rejected() {
        load_v1_state();
        let mut board = Board::migrate(team(), buyback());
        persist(&mut board);
        rejected("UnsupportedStateVersion", || {
            Board::migrate(team(), buyback());
        });
        // The rejected second run left version 2 intact.
        let board: Board = env::state_read().unwrap();
        assert_eq!(board.get_state_version(), 2);
        assert_eq!(board.get_outstanding_credits(), U128(24));
    }

    #[test]
    fn migrating_a_fresh_v2_board_is_rejected() {
        ctx(accounts(0), 0, 0);
        let mut board = Board::new(accounts(5), U128(100), team(), buyback());
        persist(&mut board);
        rejected("UnsupportedStateVersion", || {
            Board::migrate(team(), buyback());
        });
    }

    #[test]
    fn migrating_without_state_is_rejected() {
        ctx(board_account(), 0, 0);
        rejected("UnsupportedStateVersion", || {
            Board::migrate(team(), buyback());
        });
    }

    #[test]
    fn unknown_or_damaged_state_is_rejected() {
        let raw_v1 = {
            load_v1_state();
            env::storage_read(STATE_KEY).unwrap()
        };
        let mut wrong_schema = raw_v1.clone();
        wrong_schema[0] = 3; // a schema-3 board is a different contract
        let mut trailing = raw_v1.clone();
        trailing.push(0); // strict decode: no leftover bytes
        let truncated = raw_v1[..raw_v1.len() - 1].to_vec();
        let mut future = raw_v1.clone();
        future[0] = 3; // also what a version-3 leading word would look like
        for (name, bytes) in [
            ("wrong schema", wrong_schema),
            ("trailing byte", trailing),
            ("truncated", truncated),
            ("future", future),
            ("short", vec![4, 0]),
            ("empty", vec![]),
        ] {
            load_v1_state();
            env::storage_write(STATE_KEY, &bytes);
            rejected("UnsupportedStateVersion", || {
                Board::migrate(team(), buyback());
            });
            let _ = name;
        }
    }

    #[test]
    fn migration_rejects_the_board_itself_as_a_revenue_account() {
        load_v1_state();
        rejected("InvalidRevenueAccount", || {
            Board::migrate(board_account(), buyback());
        });
        load_v1_state();
        rejected("InvalidRevenueAccount", || {
            Board::migrate(team(), board_account());
        });
    }

    #[test]
    fn fresh_board_starts_at_version_2_with_default_revision_fields() {
        ctx(accounts(0), 0, 0);
        let board = Board::new(accounts(5), U128(100), team(), buyback());
        assert_eq!(board.get_state_version(), 2);
        assert_eq!(board.get_tunables(), Tunables::default());
        assert_eq!(board.payments.team_account, team());
        assert_eq!(board.payments.buyback_account, buyback());
        assert_eq!(board.payments.mpoo_undistributed, 0);
        assert!(!board.first_fill_complete);
    }

    #[test]
    fn upgrade_deploys_and_migrates_in_one_batch_on_this_account() {
        ctx(accounts(0), 0, 0);
        let mut board = Board::new(accounts(5), U128(100), team(), buyback());
        ctx(accounts(0), 1, 0);
        let args = serde_json::json!({"team_account": team(), "buyback_account": buyback()});
        board.upgrade(
            near_sdk::json_types::Base64VecU8(vec![0, 97, 115, 109]),
            args.clone(),
        );
        let receipts = get_created_receipts();
        assert_eq!(
            receipts.len(),
            1,
            "one receipt, so deploy and migrate are atomic"
        );
        assert_eq!(receipts[0].receiver_id, board_account());
        match receipts[0].actions.as_slice() {
            [MockAction::DeployContract { code, .. }, MockAction::FunctionCallWeight {
                method_name,
                args: sent,
                attached_deposit,
                ..
            }] => {
                assert_eq!(code, &vec![0, 97, 115, 109]);
                assert_eq!(method_name, b"migrate");
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(sent).unwrap(),
                    args
                );
                assert_eq!(*attached_deposit, NearToken::from_yoctonear(0));
            }
            other => panic!("unexpected actions: {other:?}"),
        }
    }

    #[test]
    fn upgrade_requires_exactly_one_yocto() {
        ctx(accounts(0), 0, 0);
        let mut board = Board::new(accounts(5), U128(100), team(), buyback());
        for deposit in [0, 2] {
            ctx(accounts(0), deposit, 0);
            rejected("exactly 1 yoctoNEAR", || {
                board.upgrade(
                    near_sdk::json_types::Base64VecU8(vec![]),
                    serde_json::json!({}),
                );
            });
        }
    }
}
