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

    /// Reserve existing storage as well as the future storage purchased by
    /// outstanding credits. Saturation makes an underfunded board return zero.
    pub fn get_withdrawable_near(&self) -> U128 {
        let storage =
            u128::from(env::storage_usage()).checked_mul(env::storage_byte_cost().as_yoctonear());
        let protected = self
            .payments
            .outstanding
            .checked_mul(STORAGE_PER_PIXEL)
            .and_then(|owed| owed.checked_add(self.tunables.reserve_floor.0))
            .and_then(|reserve| storage.and_then(|used| reserve.checked_add(used)));
        U128(protected.map_or(0, |amount| {
            env::account_balance().as_yoctonear().saturating_sub(amount)
        }))
    }

    #[payable]
    pub fn withdraw_near(&mut self, recipient: AccountId, amount: U128) -> Promise {
        self.assert_safety_owner();
        assert!(amount.0 > 0, "ZeroAmount");
        assert_ne!(recipient, env::current_account_id(), "InvalidRecipient");
        assert!(
            amount.0 <= self.get_withdrawable_near().0,
            "ReserveBreached"
        );
        // A log proves the request, not delivery. Follow this returned promise
        // to the transfer receipt; a failed transfer leaves the funds here.
        Self::safety_event(
            "treasury_withdrawn",
            near_sdk::serde_json::json!({
                "recipient": recipient, "amount": amount, "status": "scheduled"
            }),
        );
        Promise::new(recipient).transfer(NearToken::from_yoctonear(amount.0))
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
        Board::new(accounts(5), U128(100))
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
        rejected("Paused", || board.draw(0, 0, 1));
        rejected("Paused", || {
            board.draw_many(vec![DrawCell {
                x: 0,
                y: 0,
                color: 1,
            }])
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
        board.draw(0, 0, 1);
        assert_eq!(board.get_credits(accounts(1)), Some(U128(9)));
    }

    #[test]
    fn withdrawal_exact_boundary_protects_existing_storage_and_outstanding_credits() {
        let mut board = setup();
        let before = board.get_withdrawable_near().0;
        assert_eq!(
            before,
            env::account_balance().as_yoctonear()
                - MIN_RESERVE
                - u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
        );
        board.payments.outstanding = 10_000;
        let available = board.get_withdrawable_near().0;
        assert_eq!(before - available, 10_000 * STORAGE_PER_PIXEL);
        rejected("ReserveBreached", || {
            let _ = board.withdraw_near(accounts(2), U128(available + 1));
        });
        drop(board.withdraw_near(accounts(2), U128(available)));
        // Promise creation reserves funds in the runtime immediately. A second
        // withdrawal cannot count the money already committed to this receipt.
        assert_eq!(board.get_withdrawable_near(), U128(0));
        rejected("ReserveBreached", || {
            let _ = board.withdraw_near(accounts(2), U128(1));
        });
        assert!(!get_created_receipts().is_empty());
        assert!(get_logs()
            .iter()
            .any(|log| log.contains("treasury_withdrawn")));
    }

    #[test]
    fn underfunded_or_overflowed_liability_has_no_withdrawable_balance() {
        let mut board = setup();
        board.payments.outstanding = u128::MAX;
        assert_eq!(board.get_withdrawable_near(), U128(0));
        rejected("ReserveBreached", || {
            let _ = board.withdraw_near(accounts(2), U128(1));
        });
    }

    #[test]
    fn prices_emit_old_and_new_values_and_enforce_exact_cooldown_boundary() {
        let mut board = setup();
        let original = board.get_payment_config().near_per_credit.0;
        board.set_credit_prices(U128(original * 2), U128(50));
        let log = get_logs().pop().unwrap();
        assert!(log.contains("price_changed") && log.contains("old_near_per_credit"));
        context(0, MIN_COOLDOWN_NS - 1);
        rejected("PriceCooldown", || {
            board.set_credit_prices(U128(original), U128(100))
        });
        context(0, MIN_COOLDOWN_NS);
        board.set_credit_prices(U128(original), U128(100));
        assert_eq!(
            board.get_tunables().last_price_change_ns,
            Some(MIN_COOLDOWN_NS)
        );
    }

    #[test]
    fn general_tunables_cannot_bypass_history_cooldown_or_reserve_minimum() {
        let mut board = setup();
        let original = board.get_payment_config().near_per_credit;
        board.set_credit_prices(original, U128(100));
        let mut config = board.get_tunables();
        config.last_price_change_ns = None;
        rejected("PriceHistoryImmutable", || board.set_tunables(config));
        let mut config = board.get_tunables();
        config.price_cooldown_ns = 0;
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
        rejected("OwnerOnly", || {
            let _ = board.withdraw_near(accounts(2), U128(1));
        });
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .build());
        rejected("OneYoctoRequired", || board.set_paused(true));
    }

    #[test]
    fn price_halving_rounds_up_and_checks_each_currency() {
        let mut board = setup();
        let near = board.get_payment_config().near_per_credit;
        rejected("PriceStepTooLarge", || {
            board.set_credit_prices(near, U128(49))
        });
        rejected("PriceStepTooLarge", || {
            board.set_credit_prices(near, U128(201))
        });
        board.set_credit_prices(near, U128(51));
        context(0, MIN_COOLDOWN_NS);
        rejected("PriceStepTooLarge", || {
            board.set_credit_prices(near, U128(25))
        });
        board.set_credit_prices(near, U128(26));
    }
}
