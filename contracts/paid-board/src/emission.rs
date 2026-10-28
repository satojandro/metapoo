//! Fresh-init claim emission. Reservations consume the lifetime cap at accrual.
use crate::{Board, BoardExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

pub(crate) const CAP: u128 = 1_000_000_000_000_000_000_000_000_000;
const SCALE: u128 = 1_000_000_000;
const NANOS_PER_SECOND: u128 = 1_000_000_000;
const _: () = assert!(CAP <= u128::MAX / SCALE);
pub(crate) const MAX_RATE: u128 = u128::MAX / (86_400_000_000_000 * 16_384);

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub(crate) struct Holder {
    pub cells: u32,
    pub debt: u128,
    pub pending: u128,
}

#[near(serializers = [json])]
pub struct EmissionView {
    pub per_cell_second: U128,
    pub accrued_total: U128,
    pub cap: U128,
    pub remaining: U128,
}

#[near]
impl Board {
    /// Includes emission up to the current block, without mutating reservations.
    pub fn get_pending_toilet(&self, account: AccountId) -> U128 {
        let (acc, _) = self.emission_at(env::block_timestamp());
        U128(self.settled_holder(&account, acc).pending)
    }

    /// Persisted reservations; a view cannot advance the accrual clock.
    pub fn get_toilet_emission(&self) -> EmissionView {
        EmissionView {
            per_cell_second: U128(self.tunables.toilet_per_cell_second),
            accrued_total: U128(self.accrued_total),
            cap: U128(CAP),
            remaining: U128(CAP.checked_sub(self.accrued_total).expect("AccrualInvariant")),
        }
    }

    #[payable]
    pub fn claim_toilet(&mut self, toilet: AccountId) -> Promise {
        near_sdk::assert_one_yocto();
        self.accrue(env::block_timestamp());
        let caller = env::predecessor_account_id();
        let mut holder = self.settled_holder(&caller, self.acc_per_cell);
        let amount = holder.pending;
        assert!(amount > 0, "NothingToClaim");
        holder.pending = 0;
        self.holders.insert(caller.clone(), holder);
        Self::safety_event(
            "toilet_claimed",
            near_sdk::serde_json::json!({
                "account_id": caller, "amount": U128(amount), "accrued_total": U128(self.accrued_total)
            }),
        );
        let callback = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "account_id": caller, "amount": U128(amount)
        }))
        .expect("SerializationFailed");
        Promise::new(toilet)
            .function_call(
                "mint",
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                    "account": caller, "amount": U128(amount)
                }))
                .expect("SerializationFailed"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "resolve_claim",
                callback,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            ))
    }

    /// A zeroed claim whose mint failed has to come back.
    ///
    /// Without this callback the sequence is: zero `pending`, fire the mint, and
    /// discover on chain that the token refused it — reserve floor, a wrong token
    /// address, or not enough gas — leaving the player's accrued TOILET destroyed
    /// with nothing minted. The zero happens before the promise on purpose
    /// (re-entrancy), so the restore belongs here.
    #[private]
    pub fn resolve_claim(&mut self, account_id: AccountId, amount: U128) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "PrivateOnly"
        );
        // `promise_result` is deprecated: an unbounded read can run out of gas.
        // TooLong still means the call succeeded — we simply could not read the
        // payload — so only an explicit Failed restores the claim.
        let minted = env::promise_results_count() > 0
            && !matches!(
                env::promise_result_checked(0, 128),
                Err(near_sdk::PromiseError::Failed)
            );
        self.settle_claim_result(account_id, amount.0, minted);
    }

    pub(crate) fn settle_claim_result(&mut self, account_id: AccountId, amount: u128, minted: bool) {
        if minted || amount == 0 {
            return;
        }
        let mut holder = self.holders.get(&account_id).cloned().unwrap_or_default();
        holder.pending = holder
            .pending
            .checked_add(amount)
            .expect("PendingOverflow");
        self.holders.insert(account_id.clone(), holder);
        Self::safety_event(
            "claim_failed",
            near_sdk::serde_json::json!({
                "account_id": account_id, "amount": U128(amount), "restored": true
            }),
        );
    }
}

impl Board {
    fn emission_at(&self, now: u64) -> (u128, u128) {
        let elapsed = now
            .checked_sub(self.last_accrual_ns)
            .expect("AccrualClockReversed");
        if elapsed == 0 || self.total_cells == 0 || self.accrued_total == CAP {
            return (self.acc_per_cell, self.accrued_total);
        }
        let remaining = CAP.checked_sub(self.accrued_total).expect("AccrualInvariant");
        let units = self.tunables
            .toilet_per_cell_second
            .checked_mul(u128::from(elapsed))
            .map(|units| units / NANOS_PER_SECOND)
            .and_then(|units| units.checked_mul(u128::from(self.total_cells)))
            // Overflow of the pre-division product implies more than
            // u128::MAX / 1e9 units, already greater than CAP. Long idle
            // intervals therefore safely reserve only the remaining cap.
            .unwrap_or(remaining)
            .min(remaining);
        let increment = units.checked_mul(SCALE).expect("AccrualOverflow")
            / u128::from(self.total_cells);
        (
            self.acc_per_cell.checked_add(increment).expect("AccrualOverflow"),
            self.accrued_total.checked_add(units).expect("AccrualOverflow"),
        )
    }

    pub(crate) fn accrue(&mut self, now: u64) {
        (self.acc_per_cell, self.accrued_total) = self.emission_at(now);
        self.last_accrual_ns = now;
    }

    pub(crate) fn settled_holder(&self, account: &AccountId, acc: u128) -> Holder {
        let mut holder = self.holders.get(account).cloned().unwrap_or_default();
        let earned = entitlement(holder.cells, acc);
        holder.pending = holder.pending
            .checked_add(earned.checked_sub(holder.debt).expect("DebtInvariant"))
            .expect("PendingOverflow");
        holder.debt = earned;
        holder
    }
}

/// Divide first: cells * acc can overflow after a late expansion of ownership,
/// even though the final entitlement (at most cells * CAP) fits comfortably.
pub(crate) fn entitlement(cells: u32, acc: u128) -> u128 {
    let cells = u128::from(cells);
    (acc / SCALE).checked_mul(cells)
        .and_then(|whole| {
            (acc % SCALE).checked_mul(cells)
                .and_then(|fraction| whole.checked_add(fraction / SCALE))
        })
        .expect("EntitlementOverflow")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{
        test_utils::{accounts, VMContextBuilder},
        testing_env,
    };

    fn context(caller: usize, seconds: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(4))
            .predecessor_account_id(accounts(caller))
            .signer_account_id(accounts(caller))
            .attached_deposit(NearToken::from_yoctonear(1))
            .account_balance(NearToken::from_near(100))
            .block_timestamp(seconds * 1_000_000_000)
            .build());
    }

    fn setup(rate: u128) -> Board {
        context(0, 0);
        let mut board = Board::new(accounts(5), U128(100));
        assert_eq!(board.get_tunables().toilet_per_cell_second, 0);
        for i in 0..4 {
            board.payments.balances.insert(accounts(i), 1000);
        }
        board.payments.outstanding = 4000;
        let mut tunables = board.get_tunables();
        tunables.toilet_per_cell_second = rate;
        board.set_tunables(tunables);
        board
    }

    #[test]
    fn accrual_is_zero_until_a_rate_is_set() {
        let mut board = setup(0);
        board.draw(0, 0, 1);
        context(0, 10);
        board.draw(0, 0, 2);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 0);
        let mut tunables = board.get_tunables();
        tunables.toilet_per_cell_second = 7;
        board.set_tunables(tunables);
        context(0, 20);
        board.draw(0, 0, 3);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70);
    }

    #[test]
    fn one_cell_accrues_rate_times_elapsed() {
        let mut board = setup(7);
        board.draw(0, 0, 1);
        context(0, 10);
        board.draw(0, 0, 2);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70);
    }

    #[test]
    fn overwrite_settles_the_previous_owner_and_starts_the_new_one() {
        let mut board = setup(7);
        board.draw(0, 0, 1);
        context(1, 10);
        board.draw(0, 0, 2);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70);
        assert_eq!(board.get_pending_toilet(accounts(1)).0, 0);
        context(1, 20);
        board.draw(0, 0, 3);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70);
        assert_eq!(board.get_pending_toilet(accounts(1)).0, 70);
        assert_eq!(env::block_timestamp(), 20_000_000_000);
    }

    fn rejected(code: &str, f: impl FnOnce()) {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
        let message = err.downcast_ref::<String>().map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains(code), "unexpected error: {message}");
    }

    #[test]
    fn a_holder_keeps_accrual_after_losing_every_cell() {
        let mut board = setup(11);
        board.draw(0, 0, 1);
        context(1, 10);
        board.draw_many(vec![crate::DrawCell { x: 0, y: 0, color: 2 }]);
        assert_eq!(board.get_cells_owned(accounts(0)), 0);
        context(0, 100);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(110));
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
    }

    #[test]
    fn accrual_clamps_at_the_cap_and_stops() {
        let mut board = setup(MAX_RATE);
        board.draw(0, 0, 1);
        context(1, 10);
        board.draw(1, 0, 2);
        let earlier = board.get_pending_toilet(accounts(0)).0;
        context(1, 10_000_000);
        board.draw(1, 0, 3);
        assert_eq!(board.get_toilet_emission().accrued_total, U128(CAP));
        let pending = board.get_pending_toilet(accounts(0)).0;
        assert!(pending >= earlier);
        let acc = board.acc_per_cell;
        context(0, 20_000_000);
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.acc_per_cell, acc);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        let view = board.get_toilet_emission();
        assert_eq!(view.accrued_total, U128(CAP));
        assert_eq!(view.remaining, U128(0));
        assert_eq!(view.cap, U128(CAP));
        assert_eq!(view.per_cell_second, U128(MAX_RATE));
    }

    #[test]
    fn accrual_reaches_the_cap_without_overflow() {
        let mut board = setup(100_000_000_000_000_000_000);
        board.draw(0, 0, 1);
        context(0, 10_000_000);
        board.draw(0, 0, 2);
        assert_eq!(board.accrued_total, CAP);
        assert_eq!(board.acc_per_cell, CAP * SCALE);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(CAP));
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        // A fresh holder gaining many cells after cap exhaustion must also fit.
        context(1, 10_000_000);
        board.draw_many(
            (0..64).map(|x| crate::DrawCell { x, y: 0, color: 1 }).collect(),
        );
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
        assert_eq!(board.get_cells_owned(accounts(1)), 64);
    }

    #[test]
    fn claim_mints_exactly_the_pending_and_zeroes_it() {
        use near_sdk::test_utils::{get_created_receipts, get_logs};
        let mut board = setup(7);
        board.draw(0, 0, 1);
        context(0, 10);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(70));
        assert_eq!(board.accrued_total, 0); // a view never reserves
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        assert_eq!(board.accrued_total, 70);
        let receipts = get_created_receipts();
        // The mint to the token, then the private callback that restores a failed claim.
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0].receiver_id, accounts(5));
        let mut calls = 0;
        for action in &receipts[0].actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } = action {
                calls += 1;
                assert_eq!(method_name, b"mint");
                assert_eq!(*attached_deposit, NearToken::from_yoctonear(0));
                assert_eq!(*prepaid_gas, Gas::from_tgas(10));
                let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
                assert_eq!(args, near_sdk::serde_json::json!({"account": accounts(0), "amount": "70"}));
            }
        }
        assert_eq!(calls, 1);
        assert_eq!(receipts[1].receiver_id, accounts(4));
        let mut callbacks = 0;
        for action in &receipts[1].actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } = action {
                assert_eq!(method_name, b"resolve_claim");
                callbacks += 1;
            }
        }
        assert_eq!(callbacks, 1);
        let log = get_logs().into_iter()
            .find(|log| log.contains("toilet_claimed")).unwrap();
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
            log.strip_prefix("EVENT_JSON:").unwrap(),
        ).unwrap();
        assert_eq!(event["data"][0], near_sdk::serde_json::json!({"account_id": accounts(0), "amount": "70", "accrued_total": "70"}));
    }

    #[test]
    fn claim_twice_mints_nothing_the_second_time() {
        let mut board = setup(7);
        board.draw(0, 0, 1);
        context(0, 10);
        drop(board.claim_toilet(accounts(5)));
        context(0, 10);
        rejected("NothingToClaim", || {
            drop(board.claim_toilet(accounts(5)));
        });
        assert!(near_sdk::test_utils::get_created_receipts().is_empty());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
    }

    #[test]
    fn multi_owner_scenario_keeps_cells_and_pending_consistent() {
        let mut board = setup(6);
        board.draw_many(vec![
            crate::DrawCell { x: 0, y: 0, color: 1 },
            crate::DrawCell { x: 1, y: 0, color: 1 },
        ]);
        context(1, 10);
        board.draw_many(vec![
            crate::DrawCell { x: 0, y: 0, color: 2 },
            crate::DrawCell { x: 0, y: 0, color: 3 },
            crate::DrawCell { x: 2, y: 0, color: 2 },
        ]);
        assert_eq!(board.total_cells, 3);
        assert_eq!(board.get_cells_owned(accounts(0)), 1);
        assert_eq!(board.get_cells_owned(accounts(1)), 2);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(120));
        context(2, 20);
        board.draw(1, 0, 4);
        assert_eq!(board.get_cells_owned(accounts(0)), 0);
        assert_eq!(board.get_cells_owned(accounts(1)), 2);
        assert_eq!(board.get_cells_owned(accounts(2)), 1);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(180));
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(120));
        context(1, 30);
        // Same-artist repaint does not move ownership or reset debt.
        board.draw(0, 0, 5);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(180));
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(240));
        assert_eq!(board.get_pending_toilet(accounts(2)), U128(60));
        assert_eq!(board.accrued_total, 480);
        for caller in 0..3 {
            context(caller, 30);
            drop(board.claim_toilet(accounts(5)));
        }
        assert_eq!(board.accrued_total, 480);
        assert_eq!(board.total_cells, 3);
    }

    #[test]
    fn rate_changes_settle_the_old_rate_and_empty_time_earns_nothing() {
        let mut board = setup(7);
        context(0, 10);
        board.draw(0, 0, 1);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        context(0, 20);
        let mut tunables = board.get_tunables();
        tunables.toilet_per_cell_second = 3;
        board.set_tunables(tunables);
        assert_eq!(board.accrued_total, 70);
        context(0, 30);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(100));
        // Painting pause does not block accrued claims.
        board.set_paused(true);
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.accrued_total, 100);
    }

    #[test]
    fn rate_ceiling_and_extreme_idle_intervals_are_safe() {
        let mut board = setup(MAX_RATE);
        let mut tunables = board.get_tunables();
        tunables.toilet_per_cell_second = MAX_RATE + 1;
        rejected("ToiletRateTooHigh", || board.set_tunables(tunables));
        board.total_cells = 16_384;
        board.accrue(86_400_000_000_000);
        assert_eq!(board.accrued_total, CAP);
        assert!(board.acc_per_cell <= CAP * SCALE);
        // Reset only in this arithmetic fixture to exercise pre-division overflow.
        board.accrued_total = 0;
        board.acc_per_cell = 0;
        board.accrue(u64::MAX);
        assert_eq!(board.accrued_total, CAP);
    }

    #[test]
    fn claim_requires_exactly_one_yocto() {
        let mut board = setup(7);
        board.draw(0, 0, 1);
        for deposit in [0, 2] {
            let ctx = VMContextBuilder::new()
                .predecessor_account_id(accounts(0))
                .attached_deposit(NearToken::from_yoctonear(deposit))
                .block_timestamp(10_000_000_000)
                .build();
            testing_env!(ctx);
            rejected("Requires attached deposit of exactly 1 yoctoNEAR", || {
                drop(board.claim_toilet(accounts(5)));
            });
        }
        assert_eq!(board.accrued_total, 0);
    }

    #[test]
    fn a_failed_mint_restores_the_claim_and_a_successful_one_does_not() {
        let mut board = setup(7);
        board.draw(0, 0, 1);
        context(0, 10);
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        // The token refused the mint: reserve floor, wrong address, or gas.
        // The claim must come back rather than vanish.
        board.settle_claim_result(accounts(0), 70, false);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(70));
        // A successful mint must not double-credit.
        board.settle_claim_result(accounts(0), 70, true);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(70));
        // ...and the restored claim is claimable again.
        context(0, 10);
        drop(board.claim_toilet(accounts(5)));
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
    }
}
