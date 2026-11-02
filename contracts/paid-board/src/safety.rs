//! Safety rules for fresh paid-board deployments. Adding these Tunables fields
//! changes Borsh state: an older deployed board needs an explicit migration.
use crate::{Board, BoardExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

pub(crate) const MIN_RESERVE: u128 = 5_000_000_000_000_000_000_000_000;
pub(crate) const MIN_COOLDOWN_NS: u64 = 86_400_000_000_000;
// Recorded in docs/payments/2026-10-28-paid-model-decisions.md §2:
// 152,724 bytes / 2,301 painted cells ≈ 66.4 bytes, at 10^19 yoctoNEAR/byte.
// This is a baseline estimate, not a measurement of the new paid-board layout.
pub(crate) const STORAGE_PER_PIXEL: u128 = 664_000_000_000_000_000_000;
/// Every cell the board can ever hold (128 × 128).
const BOARD_CELLS: u32 = crate::WIDTH * crate::HEIGHT;

#[near]
impl Board {
    /// Reach the token's emitter-only circuit breaker from this board account.
    #[payable]
    pub fn set_toilet_paused(&mut self, toilet: AccountId, paused: bool) -> Promise {
        self.assert_safety_owner();
        Promise::new(toilet).function_call(
            "set_paused",
            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"paused": paused}))
                .expect("SerializationFailed"),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(10),
        )
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_safety_owner();
        self.tunables.paused = paused;
        Self::safety_event(
            "pause_changed",
            near_sdk::serde_json::json!({"paused": paused}),
        );
    }

    /// NEAR above the protected reserve: what the next `distribute_near` sends.
    ///
    /// `protected = storage used now + empty cells × STORAGE_PER_PIXEL + reserve floor`,
    /// with `empty cells = 16,384 − painted cells` (spec §C5). Outstanding credits
    /// no longer reserve storage: each one either paints an empty cell, already
    /// covered by the empty-cell term, or repaints one, which needs no new storage.
    /// Saturation makes an underfunded board return zero.
    pub fn get_withdrawable_near(&self) -> U128 {
        let storage =
            u128::from(env::storage_usage()).checked_mul(env::storage_byte_cost().as_yoctonear());
        let empty_cells = u128::from(BOARD_CELLS.saturating_sub(self.pixels.len()));
        let protected = empty_cells
            .checked_mul(STORAGE_PER_PIXEL)
            .and_then(|owed| owed.checked_add(self.tunables.reserve_floor.0))
            .and_then(|reserve| storage.and_then(|used| reserve.checked_add(used)));
        U128(protected.map_or(0, |amount| {
            env::account_balance().as_yoctonear().saturating_sub(amount)
        }))
    }
}

impl Board {
    pub(crate) fn assert_unpaused(&self) {
        assert!(!self.tunables.paused, "Paused");
    }

    fn assert_safety_owner(&self) {
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            1,
            "OneYoctoRequired"
        );
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.owner,
            "OwnerOnly"
        );
    }

    pub(crate) fn safety_event(name: &str, data: near_sdk::serde_json::Value) {
        let event = near_sdk::serde_json::json!({
            "standard": "mpoo_payments", "version": "1.0.0", "event": name, "data": [data]
        });
        env::log_str(&format!("EVENT_JSON:{event}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DrawCell;
    use near_sdk::{
        test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder},
        testing_env,
    };

    fn context(caller: usize, timestamp: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(4))
            .predecessor_account_id(accounts(caller))
            .signer_account_id(accounts(caller))
            .attached_deposit(NearToken::from_yoctonear(1))
            .account_balance(NearToken::from_near(100))
            .storage_usage(1000)
            .block_timestamp(timestamp)
            .build());
    }
    fn setup() -> Board {
        context(0, 0);
        let mut board = Board::new(
            accounts(5),
            U128(100),
            crate::test_team(),
            crate::test_buyback(),
        );
        // Paid-path tests: F1 free first paints are covered in `free_paint.rs`.
        board.tunables.free_first_paints_per_account = 0;
        board
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
    fn paused_writes_preserve_pixels_and_credits_but_views_and_resume_work() {
        let mut board = setup();
        board.payments.balances.insert(accounts(1), 10);
        board.payments.outstanding = 10;
        board.set_paused(true);
        context(1, 0);
        rejected("Paused", || board.draw(0, 0, 1, u32::MAX));
        rejected("Paused", || {
            board.draw_many(vec![DrawCell {
                x: 0,
                y: 0,
                color: 1,
            }], u32::MAX)
        });
        rejected("Paused", || {
            board.buy_credits_near(U128(1), U128(1));
        });
        assert_eq!(board.get_credits(accounts(1)), Some(U128(10)));
        assert_eq!(board.get_outstanding_credits(), U128(10));
        assert!(board.get_pixel(0, 0).color.is_none());
        assert_eq!(board.get_pixels(0, 256).total, 0);
        context(5, 0);
        assert_eq!(
            board.ft_on_transfer(accounts(1), U128(100), "{}".into()),
            U128(100)
        );
        context(0, 0);
        board.set_paused(false);
        context(1, 0);
        board.draw(0, 0, 1, u32::MAX);
        assert_eq!(board.get_credits(accounts(1)), Some(U128(9)));
    }

    #[test]
    fn withdrawable_reserves_storage_empty_cells_and_floor_but_not_credits() {
        let mut board = setup();
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        let before = board.get_withdrawable_near().0;
        assert_eq!(
            before,
            env::account_balance().as_yoctonear()
                - MIN_RESERVE
                - storage
                - u128::from(BOARD_CELLS) * STORAGE_PER_PIXEL
        );
        // Outstanding credits no longer reserve storage (spec C5).
        board.payments.outstanding = 10_000;
        assert_eq!(board.get_withdrawable_near().0, before);
        // A painted cell releases its empty-cell reservation.
        board.payments.balances.insert(accounts(1), 1);
        board.payments.outstanding = 1;
        context(1, 0);
        board.draw(0, 0, 1, u32::MAX);
        assert_eq!(
            board.get_withdrawable_near().0,
            before + STORAGE_PER_PIXEL
                - (u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
                    - storage)
        );
    }

    #[test]
    fn underfunded_board_has_no_withdrawable_balance() {
        let board = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(4))
            .account_balance(NearToken::from_near(10))
            .storage_usage(1000)
            .build());
        assert_eq!(board.get_withdrawable_near(), U128(0));
    }

    #[test]
    fn withdraw_near_is_not_a_contract_method() {
        // Owner decision, 1 Nov 2026: revenue leaves only through the split.
        for source in [
            include_str!("safety.rs"),
            include_str!("lib.rs"),
            include_str!("payments.rs"),
            include_str!("revenue.rs"),
            include_str!("emission.rs"),
            include_str!("migrate.rs"),
        ] {
            assert!(!source.contains(concat!("fn withdraw", "_near(")));
        }
    }

    #[test]
    fn prices_emit_old_and_new_values_and_enforce_exact_cooldown_boundary() {
        let mut board = setup();
        let original = board.get_payment_config().near_per_credit.0;
        board.set_near_price(U128(original * 2));
        let log = get_logs().pop().unwrap();
        assert!(log.contains("price_changed") && log.contains("old_near_per_credit"));
        context(0, MIN_COOLDOWN_NS - 1);
        rejected("NearPriceCooldown", || board.set_near_price(U128(original)));
        context(0, MIN_COOLDOWN_NS);
        board.set_near_price(U128(original));
        assert_eq!(
            board.get_tunables().last_near_price_change_ns,
            Some(MIN_COOLDOWN_NS)
        );
    }

    #[test]
    fn mpoo_price_emits_old_and_new_values_and_enforces_its_own_cooldown() {
        let mut board = setup();
        board.set_mpoo_price(U128(50));
        let log = get_logs().pop().unwrap();
        assert!(log.contains("price_changed") && log.contains("\"old_mpoo_per_credit\":\"100\""));
        context(0, MIN_COOLDOWN_NS - 1);
        rejected("MpooPriceCooldown", || board.set_mpoo_price(U128(100)));
        context(0, MIN_COOLDOWN_NS);
        board.set_mpoo_price(U128(100));
        assert_eq!(board.get_payment_config().mpoo_per_credit, U128(100));
        assert_eq!(
            board.get_tunables().last_mpoo_price_change_ns,
            Some(MIN_COOLDOWN_NS)
        );
    }

    #[test]
    fn changing_one_price_does_not_start_the_other_cooldown() {
        let mut board = setup();
        let near = board.get_payment_config().near_per_credit.0;
        context(0, 10);
        board.set_mpoo_price(U128(150));
        assert_eq!(board.get_tunables().last_near_price_change_ns, None);
        // An urgent NEAR change the same block is still allowed.
        board.set_near_price(U128(near * 2));
        assert_eq!(board.get_tunables().last_mpoo_price_change_ns, Some(10));
        assert_eq!(board.get_tunables().last_near_price_change_ns, Some(10));
        // And the reverse: a NEAR change does not reset the mPOO clock.
        context(0, 10 + MIN_COOLDOWN_NS);
        board.set_near_price(U128(near));
        context(0, 10 + MIN_COOLDOWN_NS + 1);
        board.set_mpoo_price(U128(100));
        assert_eq!(
            board.get_tunables().last_mpoo_price_change_ns,
            Some(10 + MIN_COOLDOWN_NS + 1)
        );
    }

    #[test]
    fn price_setters_require_owner_and_one_yocto() {
        let mut board = setup();
        context(1, 0);
        rejected("OwnerOnly", || board.set_near_price(U128(1)));
        rejected("OwnerOnly", || board.set_mpoo_price(U128(100)));
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .build());
        rejected("exactly 1 yoctoNEAR", || board.set_near_price(U128(1)));
        rejected("exactly 1 yoctoNEAR", || board.set_mpoo_price(U128(100)));
    }

    #[test]
    fn general_tunables_cannot_bypass_history_cooldown_or_reserve_minimum() {
        let mut board = setup();
        let original = board.get_payment_config().near_per_credit;
        board.set_near_price(original);
        let mut config = board.get_tunables();
        config.last_near_price_change_ns = None;
        rejected("PriceHistoryImmutable", || board.set_tunables(config));
        let mut config = board.get_tunables();
        config.near_price_cooldown_ns = 0;
        rejected("PriceCooldownTooShort", || board.set_tunables(config));
        let mut config = board.get_tunables();
        config.reserve_floor = U128(0);
        rejected("ReserveFloorTooLow", || board.set_tunables(config));
    }

    #[test]
    fn toilet_pause_requires_owner_and_exactly_one_yocto() {
        let mut board = setup();
        context(1, 0);
        rejected("OwnerOnly", || {
            drop(board.set_toilet_paused(accounts(5), true));
        });
        for deposit in [0, 2] {
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(accounts(0))
                .attached_deposit(NearToken::from_yoctonear(deposit))
                .build());
            rejected("OneYoctoRequired", || {
                drop(board.set_toilet_paused(accounts(5), true));
            });
            assert!(get_created_receipts().is_empty());
        }
    }

    #[test]
    fn toilet_pause_forwards_target_payload_deposit_and_gas_even_when_board_paused() {
        let mut board = setup();
        board.set_paused(true);
        for paused in [true, false] {
            context(0, 0);
            drop(board.set_toilet_paused(accounts(5), paused));
            let receipts = get_created_receipts();
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].receiver_id, accounts(5));
            assert_eq!(receipts[0].actions.len(), 1);
            match &receipts[0].actions[0] {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } => {
                    assert_eq!(method_name, b"set_paused");
                    let payload: near_sdk::serde_json::Value =
                        near_sdk::serde_json::from_slice(args).unwrap();
                    assert_eq!(payload, near_sdk::serde_json::json!({"paused": paused}));
                    assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
                    assert_eq!(*prepaid_gas, Gas::from_tgas(10));
                }
                action => panic!("unexpected action: {action:?}"),
            }
        }
    }

    #[test]
    fn safety_controls_require_owner_and_one_yocto() {
        let mut board = setup();
        context(1, 0);
        rejected("OwnerOnly", || board.set_paused(true));
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .build());
        rejected("OneYoctoRequired", || board.set_paused(true));
    }

    #[test]
    fn price_halving_rounds_up_and_checks_each_currency() {
        let mut board = setup();
        rejected("PriceStepTooLarge", || board.set_mpoo_price(U128(49)));
        rejected("PriceStepTooLarge", || board.set_mpoo_price(U128(201)));
        board.set_mpoo_price(U128(51));
        context(0, MIN_COOLDOWN_NS);
        rejected("PriceStepTooLarge", || board.set_mpoo_price(U128(25)));
        board.set_mpoo_price(U128(26));
        // The NEAR setter applies the same step rule.
        let near = board.get_payment_config().near_per_credit.0;
        rejected("PriceStepTooLarge", || {
            board.set_near_price(U128(near * 2 + 1))
        });
        rejected("PriceStepTooLarge", || {
            board.set_near_price(U128(near / 2 - 1))
        });
        rejected("ZeroPrice", || board.set_near_price(U128(0)));
        board.set_near_price(U128(near / 2));
    }
}
