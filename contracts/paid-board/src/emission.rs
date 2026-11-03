//! Fresh-init claim emission. Reservations consume the lifetime cap at accrual.
//!
//! Only **earning** tiles accrue (spec 2026-11-02 §B1, owner decision T4): a cell
//! that holds paint whose latest paint was paid with credits. A free paint (F1
//! first paints, F2 happy hour) still owns its cell but earns nothing until it is
//! repainted with credits. Its share is never reserved, so it stays in the
//! unissued part of the cap: nothing is minted for it and nothing is burned.
use crate::{Board, BoardExt};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

pub(crate) const CAP: u128 = 1_000_000_000_000_000_000_000_000_000;
const SCALE: u128 = 1_000_000_000;
const NANOS_PER_SECOND: u128 = 1_000_000_000;
const _: () = assert!(CAP <= u128::MAX / SCALE);
pub(crate) const MAX_RATE: u128 = u128::MAX / (86_400_000_000_000 * 16_384);
/// B3: a non-zero rate may change at most once per 24 hours. A constant, not a tunable.
pub(crate) const TOILET_RATE_COOLDOWN_NS: u64 = 86_400_000_000_000;
/// B5 (audit C6): the smallest claim, 1 TOILET in atomic units (18 decimals).
/// Dust claims would drain the token's auto-registration balance. Proposed
/// value; the owner confirms it.
pub(crate) const MIN_CLAIM: u128 = 1_000_000_000_000_000_000;

/// One account's emission record, map `h`.
///
/// `cells` is ownership (what `get_cells_owned` reports); `earning` is the subset
/// that accrues (§B1), and `debt` is checkpointed against `earning`.
///
/// Borsh layout: `cells, debt, pending, earning`. `earning` is last so a
/// version-1 record (`cells, debt, pending`, written before free paints existed)
/// still decodes; it reads as `earning = cells`, which is exact for version 1:
/// with no free paints, every held cell was paid for.
#[derive(Default, Clone, Debug, PartialEq, Eq, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub(crate) struct Holder {
    pub cells: u32,
    pub debt: u128,
    pub pending: u128,
    pub earning: u32,
}

impl BorshDeserialize for Holder {
    fn deserialize_reader<R: near_sdk::borsh::io::Read>(
        reader: &mut R,
    ) -> near_sdk::borsh::io::Result<Self> {
        let cells = u32::deserialize_reader(reader)?;
        let debt = u128::deserialize_reader(reader)?;
        let pending = u128::deserialize_reader(reader)?;
        // Exactly zero or four more bytes: none is a version-1 record.
        let mut word = [0u8; 4];
        let mut read = 0;
        while read < word.len() {
            match reader.read(&mut word[read..])? {
                0 => break,
                n => read += n,
            }
        }
        let earning = match read {
            0 => cells,
            4 => u32::from_le_bytes(word),
            _ => {
                return Err(near_sdk::borsh::io::Error::new(
                    near_sdk::borsh::io::ErrorKind::InvalidData,
                    "HolderTruncated",
                ))
            }
        };
        Ok(Self {
            cells,
            debt,
            pending,
            earning,
        })
    }
}

#[near(serializers = [json])]
pub struct EmissionView {
    pub per_cell_second: U128,
    pub accrued_total: U128,
    pub cap: U128,
    pub remaining: U128,
    /// B4: the TOILET token `claim_toilet` mints on, fixed at `new`.
    pub toilet: AccountId,
    /// B3: when the rate was last set to a non-zero value; `None` before the first switch-on.
    pub last_toilet_rate_change_ns: Option<U64>,
    /// B3: the last non-zero rate, which bounds a switch-on after an emergency stop.
    pub last_nonzero_toilet_rate: U128,
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
            toilet: self.toilet_token.clone(),
            last_toilet_rate_change_ns: self.last_toilet_rate_change_ns.map(U64),
            last_nonzero_toilet_rate: U128(self.last_nonzero_toilet_rate),
        }
    }

    /// Owner-only, 1 yocto. The only way to change `toilet_per_cell_second` (§B3,
    /// owner decision T2: the rate gets the same safeguards as prices).
    ///
    /// - The old rate is accrued up to now first, so a change never applies
    ///   retroactively.
    /// - **0 is allowed at any time**: it is the emergency stop. It does not
    ///   restart the cooldown.
    /// - Every non-zero rate is at most `MAX_RATE` (`ToiletRateTooHigh`).
    /// - The **first** switch-on ever may be any value up to `MAX_RATE`.
    /// - A later switch-on from 0 may be at most 2× the last non-zero rate.
    /// - A change between non-zero rates stays within ×2 and ÷2 of the current
    ///   rate (`ToiletRateStepTooLarge`).
    /// - Any change to a non-zero value, a switch-on after a stop included, needs
    ///   `TOILET_RATE_COOLDOWN_NS` (24 h) since the last change to a non-zero value
    ///   (`ToiletRateCooldown`). Without that, stop → switch on at 2× → stop → … would
    ///   double the rate without limit inside one block.
    ///
    /// Emits `toilet_rate_changed {old, new, changed_at_ns}`.
    #[payable]
    pub fn set_toilet_rate(&mut self, per_cell_second: U128) {
        near_sdk::assert_one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.owner,
            "OwnerOnly"
        );
        let now = env::block_timestamp();
        let old = self.tunables.toilet_per_cell_second;
        let new = per_cell_second.0;
        if new != 0 {
            assert!(new <= MAX_RATE, "ToiletRateTooHigh");
            let reference = if old == 0 {
                self.last_nonzero_toilet_rate
            } else {
                old
            };
            if reference > 0 {
                // Differences, not 2 × rate: nothing here can wrap.
                let within = if old == 0 {
                    new <= reference || new - reference <= reference
                } else if new >= old {
                    new - old <= old
                } else {
                    old - new <= new
                };
                assert!(within, "ToiletRateStepTooLarge");
            }
            assert!(
                crate::cooldown_elapsed(
                    self.last_toilet_rate_change_ns,
                    TOILET_RATE_COOLDOWN_NS,
                    now
                ),
                "ToiletRateCooldown"
            );
        }
        self.accrue(now);
        self.tunables.toilet_per_cell_second = new;
        if new != 0 {
            self.last_toilet_rate_change_ns = Some(now);
            self.last_nonzero_toilet_rate = new;
        }
        Self::safety_event(
            "toilet_rate_changed",
            near_sdk::serde_json::json!({
                "old": U128(old), "new": per_cell_second, "changed_at_ns": now.to_string()
            }),
        );
    }

    /// Mint the caller's pending TOILET on the token stored at `new` (§B4). At
    /// least `MIN_CLAIM` must be pending (§B5, `ClaimBelowMinimum`).
    #[payable]
    pub fn claim_toilet(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        self.accrue(env::block_timestamp());
        let caller = env::predecessor_account_id();
        let mut holder = self.settled_holder(&caller, self.acc_per_cell);
        let amount = holder.pending;
        assert!(amount > 0, "NothingToClaim");
        assert!(amount >= MIN_CLAIM, "ClaimBelowMinimum");
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
        Promise::new(self.toilet_token.clone())
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
        if elapsed == 0 || self.total_earning == 0 || self.accrued_total == CAP {
            return (self.acc_per_cell, self.accrued_total);
        }
        let remaining = CAP.checked_sub(self.accrued_total).expect("AccrualInvariant");
        let units = self.tunables
            .toilet_per_cell_second
            .checked_mul(u128::from(elapsed))
            .map(|units| units / NANOS_PER_SECOND)
            .and_then(|units| units.checked_mul(u128::from(self.total_earning)))
            // Overflow of the pre-division product implies more than
            // u128::MAX / 1e9 units, already greater than CAP. Long idle
            // intervals therefore safely reserve only the remaining cap.
            .unwrap_or(remaining)
            .min(remaining);
        let increment = units.checked_mul(SCALE).expect("AccrualOverflow")
            / u128::from(self.total_earning);
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
        let earned = entitlement(holder.earning, acc);
        holder.pending = holder.pending
            .checked_add(earned.checked_sub(holder.debt).expect("DebtInvariant"))
            .expect("PendingOverflow");
        holder.debt = earned;
        holder
    }
}

/// Divide first: earning cells * acc can overflow after a late expansion of ownership,
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
        test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder},
        testing_env,
    };

    /// 0.1 TOILET. Rates in these tests are multiples of it so that ten seconds of
    /// one cell clears `MIN_CLAIM`.
    const UNIT: u128 = 100_000_000_000_000_000;
    const DAY_S: u64 = 86_400;

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

    /// Paid painting only (F1 off), accounts(0..4) funded, and `rate` switched on
    /// through `set_toilet_rate` at time 0 when it is non-zero.
    fn setup(rate: u128) -> Board {
        context(0, 0);
        let mut board = Board::new(accounts(5), U128(100), crate::test_team(), crate::test_buyback(), crate::test_toilet());
        assert_eq!(board.get_tunables().toilet_per_cell_second, 0);
        board.tunables.free_first_paints_per_account = 0;
        for i in 0..4 {
            board.payments.balances.insert(accounts(i), 1000);
        }
        board.payments.outstanding = 4000;
        if rate > 0 {
            board.set_toilet_rate(U128(rate));
        }
        board
    }

    fn rejected(code: &str, f: impl FnOnce()) {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
        let message = err.downcast_ref::<String>().map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains(code), "unexpected error: {message}");
    }

    #[test]
    fn accrual_is_zero_until_a_rate_is_set() {
        let mut board = setup(0);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 0);
        board.set_toilet_rate(U128(7 * UNIT));
        context(0, 20);
        board.draw(0, 0, 3, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70 * UNIT);
    }

    #[test]
    fn one_cell_accrues_rate_times_elapsed() {
        let mut board = setup(7 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70 * UNIT);
    }

    #[test]
    fn overwrite_settles_the_previous_owner_and_starts_the_new_one() {
        let mut board = setup(7 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(1, 10);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70 * UNIT);
        assert_eq!(board.get_pending_toilet(accounts(1)).0, 0);
        context(1, 20);
        board.draw(0, 0, 3, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)).0, 70 * UNIT);
        assert_eq!(board.get_pending_toilet(accounts(1)).0, 70 * UNIT);
        assert_eq!(env::block_timestamp(), 20_000_000_000);
    }

    #[test]
    fn a_holder_keeps_accrual_after_losing_every_cell() {
        let mut board = setup(11 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(1, 10);
        board.draw_many(vec![crate::DrawCell { x: 0, y: 0, color: 2 }], u32::MAX);
        assert_eq!(board.get_cells_owned(accounts(0)), 0);
        context(0, 100);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(110 * UNIT));
        drop(board.claim_toilet());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
    }

    #[test]
    fn accrual_clamps_at_the_cap_and_stops() {
        let mut board = setup(MAX_RATE);
        board.draw(0, 0, 1, u32::MAX);
        context(1, 10);
        board.draw(1, 0, 2, u32::MAX);
        let earlier = board.get_pending_toilet(accounts(0)).0;
        context(1, 10_000_000);
        board.draw(1, 0, 3, u32::MAX);
        assert_eq!(board.get_toilet_emission().accrued_total, U128(CAP));
        let pending = board.get_pending_toilet(accounts(0)).0;
        assert!(pending >= earlier);
        let acc = board.acc_per_cell;
        context(0, 20_000_000);
        drop(board.claim_toilet());
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
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10_000_000);
        board.draw(0, 0, 2, u32::MAX);
        assert_eq!(board.accrued_total, CAP);
        assert_eq!(board.acc_per_cell, CAP * SCALE);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(CAP));
        drop(board.claim_toilet());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        // A fresh holder gaining many cells after cap exhaustion must also fit.
        context(1, 10_000_000);
        board.draw_many(
            (0..64).map(|x| crate::DrawCell { x, y: 0, color: 1 }).collect(), u32::MAX,
        );
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
        assert_eq!(board.get_cells_owned(accounts(1)), 64);
    }

    #[test]
    fn claim_mints_exactly_the_pending_and_zeroes_it() {
        let mut board = setup(7 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(70 * UNIT));
        assert_eq!(board.accrued_total, 0); // a view never reserves
        drop(board.claim_toilet());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        assert_eq!(board.accrued_total, 70 * UNIT);
        let receipts = get_created_receipts();
        // The mint to the token, then the private callback that restores a failed claim.
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0].receiver_id, crate::test_toilet());
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
                assert_eq!(args, near_sdk::serde_json::json!({"account": accounts(0), "amount": (70 * UNIT).to_string()}));
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
        assert_eq!(event["data"][0], near_sdk::serde_json::json!({
            "account_id": accounts(0),
            "amount": (70 * UNIT).to_string(),
            "accrued_total": (70 * UNIT).to_string()
        }));
    }

    #[test]
    fn claim_twice_mints_nothing_the_second_time() {
        let mut board = setup(7 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10);
        drop(board.claim_toilet());
        context(0, 10);
        rejected("NothingToClaim", || {
            drop(board.claim_toilet());
        });
        assert!(get_created_receipts().is_empty());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
    }

    #[test]
    fn multi_owner_scenario_keeps_cells_and_pending_consistent() {
        let mut board = setup(6 * UNIT);
        board.draw_many(vec![
            crate::DrawCell { x: 0, y: 0, color: 1 },
            crate::DrawCell { x: 1, y: 0, color: 1 },
        ], u32::MAX);
        context(1, 10);
        board.draw_many(vec![
            crate::DrawCell { x: 0, y: 0, color: 2 },
            crate::DrawCell { x: 0, y: 0, color: 3 },
            crate::DrawCell { x: 2, y: 0, color: 2 },
        ], u32::MAX);
        assert_eq!(board.total_cells, 3);
        assert_eq!(board.total_earning, 3);
        assert_eq!(board.get_cells_owned(accounts(0)), 1);
        assert_eq!(board.get_cells_owned(accounts(1)), 2);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(120 * UNIT));
        context(2, 20);
        board.draw(1, 0, 4, u32::MAX);
        assert_eq!(board.get_cells_owned(accounts(0)), 0);
        assert_eq!(board.get_cells_owned(accounts(1)), 2);
        assert_eq!(board.get_cells_owned(accounts(2)), 1);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(180 * UNIT));
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(120 * UNIT));
        context(1, 30);
        // Same-artist repaint does not move ownership or reset debt.
        board.draw(0, 0, 5, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(180 * UNIT));
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(240 * UNIT));
        assert_eq!(board.get_pending_toilet(accounts(2)), U128(60 * UNIT));
        assert_eq!(board.accrued_total, 480 * UNIT);
        for caller in 0..3 {
            context(caller, 30);
            drop(board.claim_toilet());
        }
        assert_eq!(board.accrued_total, 480 * UNIT);
        assert_eq!(board.total_cells, 3);
        assert_eq!(board.total_earning, 3);
    }

    #[test]
    fn rate_changes_settle_the_old_rate_and_empty_time_earns_nothing() {
        let mut board = setup(8 * UNIT);
        context(0, 10);
        board.draw(0, 0, 1, u32::MAX);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        context(0, DAY_S);
        board.set_toilet_rate(U128(4 * UNIT));
        let before = 8 * UNIT * u128::from(DAY_S - 10);
        assert_eq!(board.accrued_total, before);
        context(0, DAY_S + 10);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(before + 40 * UNIT));
        // Painting pause does not block accrued claims.
        board.set_paused(true);
        drop(board.claim_toilet());
        assert_eq!(board.accrued_total, before + 40 * UNIT);
    }

    #[test]
    fn rate_ceiling_and_extreme_idle_intervals_are_safe() {
        let mut board = setup(MAX_RATE);
        context(0, DAY_S);
        rejected("ToiletRateTooHigh", || board.set_toilet_rate(U128(MAX_RATE + 1)));
        // The first switch-on is bounded by the ceiling too.
        let mut fresh = setup(0);
        rejected("ToiletRateTooHigh", || fresh.set_toilet_rate(U128(MAX_RATE + 1)));
        fresh.set_toilet_rate(U128(MAX_RATE));
        board.total_earning = 16_384;
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
        let mut board = setup(7 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        for deposit in [0, 2] {
            let ctx = VMContextBuilder::new()
                .predecessor_account_id(accounts(0))
                .attached_deposit(NearToken::from_yoctonear(deposit))
                .block_timestamp(10_000_000_000)
                .build();
            testing_env!(ctx);
            rejected("Requires attached deposit of exactly 1 yoctoNEAR", || {
                drop(board.claim_toilet());
            });
        }
        assert_eq!(board.accrued_total, 0);
    }

    #[test]
    fn a_failed_mint_restores_the_claim_and_a_successful_one_does_not() {
        let mut board = setup(7 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10);
        drop(board.claim_toilet());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        // The token refused the mint: reserve floor, wrong address, or gas.
        // The claim must come back rather than vanish.
        board.settle_claim_result(accounts(0), 70 * UNIT, false);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(70 * UNIT));
        // A successful mint must not double-credit.
        board.settle_claim_result(accounts(0), 70 * UNIT, true);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(70 * UNIT));
        // ...and the restored claim is claimable again.
        context(0, 10);
        drop(board.claim_toilet());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
    }

    // ---------------- TR-B (spec 2026-11-02 §B) ----------------

    /// accounts(0) owns the board; accounts(1..=3) are registered with 1,000
    /// credits each and keep the default 25 free first paints (F1). The rate is
    /// written straight into state so the fixture does not depend on the setter.
    fn earning_board(rate: u128) -> Board {
        context(0, 0);
        let mut board = Board::new(accounts(5), U128(100), crate::test_team(), crate::test_buyback(), crate::test_toilet());
        for i in 0..4 {
            board.payments.balances.insert(accounts(i), 1000);
        }
        board.payments.outstanding = 4000;
        board.tunables.toilet_per_cell_second = rate;
        board
    }

    fn credits(board: &Board, who: usize) -> u128 {
        board.get_credits(accounts(who)).map_or(0, |c| c.0)
    }

    #[test]
    fn free_paint_earns_nothing() {
        let mut board = earning_board(7);
        context(1, 0);
        board.draw(0, 0, 1, u32::MAX);
        assert_eq!(credits(&board, 1), 1000, "fixture: the paint must be a free first paint");
        assert_eq!(board.get_cells_owned(accounts(1)), 1, "ownership still counts");
        context(1, 10);
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
        // Settling (any paint accrues) must not reserve anything either.
        context(2, 10);
        board.tunables.free_first_paints_per_account = 0;
        board.draw(5, 5, 1, u32::MAX);
        assert_eq!(board.accrued_total, 0);
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
    }

    #[test]
    fn repainting_a_free_cell_with_credits_starts_earning() {
        let mut board = earning_board(7);
        // Two free first paints: (0,0) by accounts(1), (1,0) by accounts(2).
        context(1, 0);
        board.draw(0, 0, 1, u32::MAX);
        context(2, 0);
        board.draw(1, 0, 1, u32::MAX);
        assert_eq!((credits(&board, 1), credits(&board, 2)), (1000, 1000));
        board.tunables.free_first_paints_per_account = 0;
        // Another artist repaints accounts(1)'s free cell with credits.
        context(3, 10);
        board.draw(0, 0, 2, u32::MAX);
        assert!(credits(&board, 3) < 1000, "fixture: a paid repaint");
        // Same artist: accounts(2) repaints its own free cell with credits.
        context(2, 10);
        board.draw(1, 0, 2, u32::MAX);
        assert!(credits(&board, 2) < 1000, "fixture: a paid repaint");
        assert_eq!(board.get_cells_owned(accounts(2)), 1);
        context(2, 20);
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
        assert_eq!(board.get_pending_toilet(accounts(3)), U128(70));
        assert_eq!(board.get_pending_toilet(accounts(2)), U128(70));
        assert_eq!((board.total_cells, board.total_earning), (2, 2));
    }

    #[test]
    fn set_tunables_refuses_a_rate_change() {
        let mut board = earning_board(0);
        context(0, 10);
        let tunables = crate::Tunables {
            toilet_per_cell_second: 7,
            ..board.get_tunables()
        };
        rejected("RateViaSetter", || board.set_tunables(tunables));
        assert_eq!(board.get_tunables().toilet_per_cell_second, 0);
        // An unchanged rate is fine: other knobs still go through set_tunables.
        board.set_tunables(crate::Tunables {
            quota_base: 33,
            ..board.get_tunables()
        });
    }

    fn rate_events() -> Vec<near_sdk::serde_json::Value> {
        get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
            .filter(|e| e["event"] == "toilet_rate_changed")
            .map(|e| e["data"][0].clone())
            .collect()
    }

    #[test]
    fn rate_step_is_bounded_and_cooled_down() {
        let mut board = setup(10 * UNIT);
        // Inside the 24 h cooldown even an in-bounds step is refused.
        context(0, DAY_S - 1);
        rejected("ToiletRateCooldown", || board.set_toilet_rate(U128(20 * UNIT)));
        context(0, DAY_S);
        rejected("ToiletRateStepTooLarge", || board.set_toilet_rate(U128(20 * UNIT + 1)));
        rejected("ToiletRateStepTooLarge", || board.set_toilet_rate(U128(5 * UNIT - 1)));
        board.set_toilet_rate(U128(20 * UNIT)); // exactly ×2
        assert_eq!(
            rate_events(),
            vec![near_sdk::serde_json::json!({
                "old": (10 * UNIT).to_string(),
                "new": (20 * UNIT).to_string(),
                "changed_at_ns": (DAY_S * 1_000_000_000).to_string()
            })]
        );
        context(0, 2 * DAY_S - 1);
        rejected("ToiletRateCooldown", || board.set_toilet_rate(U128(10 * UNIT)));
        context(0, 2 * DAY_S);
        board.set_toilet_rate(U128(10 * UNIT)); // exactly ÷2
        let view = board.get_toilet_emission();
        assert_eq!(view.per_cell_second, U128(10 * UNIT));
        assert_eq!(view.last_toilet_rate_change_ns, Some(U64(2 * DAY_S * 1_000_000_000)));
        assert_eq!(view.last_nonzero_toilet_rate, U128(10 * UNIT));
        // Owner only, exactly one yocto.
        context(1, 3 * DAY_S);
        rejected("OwnerOnly", || board.set_toilet_rate(U128(10 * UNIT)));
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .block_timestamp(3 * DAY_S * 1_000_000_000)
            .build());
        rejected("Requires attached deposit of exactly 1 yoctoNEAR", || {
            board.set_toilet_rate(U128(10 * UNIT))
        });
    }

    #[test]
    fn rate_can_drop_to_zero_any_time() {
        let mut board = setup(10 * UNIT);
        context(0, 1);
        board.set_toilet_rate(U128(0));
        assert_eq!(board.get_tunables().toilet_per_cell_second, 0);
        // The stop does not restart the cooldown or forget the last rate.
        let view = board.get_toilet_emission();
        assert_eq!(view.last_toilet_rate_change_ns, Some(U64(0)));
        assert_eq!(view.last_nonzero_toilet_rate, U128(10 * UNIT));
        context(0, 2);
        board.set_toilet_rate(U128(0));
        assert_eq!(rate_events().len(), 1);
        assert_eq!(rate_events()[0]["old"], "0");
        assert_eq!(rate_events()[0]["new"], "0");
    }

    #[test]
    fn switch_on_after_zero_is_bounded_by_the_last_rate() {
        // The first switch-on ever may be anything up to MAX_RATE.
        let mut first = setup(0);
        first.set_toilet_rate(U128(MAX_RATE));
        assert_eq!(first.get_tunables().toilet_per_cell_second, MAX_RATE);

        let mut board = setup(10 * UNIT);
        context(0, 1);
        board.set_toilet_rate(U128(0));
        // A switch-on is a change to a non-zero rate: it waits out the cooldown
        // too, or stop / 2× / stop / 2× would compound inside one block.
        context(0, 2);
        rejected("ToiletRateCooldown", || board.set_toilet_rate(U128(10 * UNIT)));
        context(0, DAY_S);
        rejected("ToiletRateStepTooLarge", || board.set_toilet_rate(U128(20 * UNIT + 1)));
        board.set_toilet_rate(U128(20 * UNIT));
        // Lower than the last rate is always fine on a switch-on.
        let mut low = setup(10 * UNIT);
        context(0, 1);
        low.set_toilet_rate(U128(0));
        context(0, DAY_S);
        low.set_toilet_rate(U128(1));
        assert_eq!(low.get_toilet_emission().last_nonzero_toilet_rate, U128(1));
    }

    #[test]
    fn rate_change_accrues_the_old_rate_first() {
        let mut board = setup(8 * UNIT);
        board.draw(0, 0, 1, u32::MAX);
        context(0, DAY_S);
        board.set_toilet_rate(U128(4 * UNIT));
        assert_eq!(board.accrued_total, 8 * UNIT * u128::from(DAY_S));
        assert_eq!(board.last_accrual_ns, DAY_S * 1_000_000_000);
        context(0, DAY_S + 10);
        assert_eq!(
            board.get_pending_toilet(accounts(0)),
            U128(8 * UNIT * u128::from(DAY_S) + 40 * UNIT)
        );
        // A stop accrues first too: nothing after it, everything before it.
        board.set_toilet_rate(U128(0));
        context(0, DAY_S + 1_000);
        assert_eq!(
            board.get_pending_toilet(accounts(0)),
            U128(8 * UNIT * u128::from(DAY_S) + 40 * UNIT)
        );
    }

    #[test]
    fn claim_uses_the_stored_token() {
        let mut board = setup(7 * UNIT);
        assert_eq!(board.get_toilet_emission().toilet, crate::test_toilet());
        assert_ne!(crate::test_toilet(), board.get_payment_config().mpoo_token);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 10);
        drop(board.claim_toilet());
        let receipts = get_created_receipts();
        assert_eq!(receipts[0].receiver_id, crate::test_toilet());
    }

    #[test]
    fn claim_below_minimum_is_refused() {
        // 10^17 per second: nine seconds is just under 1 TOILET, ten is exactly it.
        let mut board = setup(MIN_CLAIM / 10);
        board.draw(0, 0, 1, u32::MAX);
        context(0, 9);
        rejected("ClaimBelowMinimum", || drop(board.claim_toilet()));
        assert!(get_created_receipts().is_empty());
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(MIN_CLAIM - MIN_CLAIM / 10));
        context(0, 10);
        drop(board.claim_toilet());
        assert_eq!(board.accrued_total, MIN_CLAIM);
        assert_eq!(board.get_pending_toilet(accounts(0)), U128(0));
        assert_eq!(MIN_CLAIM, 1_000_000_000_000_000_000);
    }

    #[test]
    fn free_cells_never_reserve_against_the_cap() {
        let mut board = earning_board(MAX_RATE);
        context(1, 0);
        board.draw_many(
            (0..25).map(|x| crate::DrawCell { x, y: 0, color: 1 }).collect(),
            0,
        );
        assert_eq!((board.total_cells, board.total_earning), (25, 0));
        context(1, 10_000);
        board.accrue(env::block_timestamp());
        assert_eq!(board.accrued_total, 0);
        assert_eq!(board.acc_per_cell, 0);
        assert_eq!(board.get_toilet_emission().remaining, U128(CAP));
        assert_eq!(board.get_pending_toilet(accounts(1)), U128(0));
    }

    #[test]
    fn get_tunables_has_no_earning_cap() {
        let board = setup(0);
        let tunables = near_sdk::serde_json::to_value(board.get_tunables()).unwrap();
        assert!(tunables.get("max_earning_cells").is_none(), "{tunables}");
        assert!(tunables.get("toilet_per_cell_second").is_some());
    }

    #[test]
    fn holder_records_from_version_1_decode_with_every_cell_earning() {
        use near_sdk::borsh::{to_vec, BorshDeserialize};
        let current = Holder { cells: 3, debt: 5, pending: 7, earning: 2 };
        let bytes = to_vec(&current).unwrap();
        assert_eq!(bytes.len(), 4 + 16 + 16 + 4);
        assert_eq!(Holder::try_from_slice(&bytes).unwrap(), current);
        // Version 1: cells, debt, pending and nothing after.
        let v1 = &bytes[..36];
        assert_eq!(
            Holder::try_from_slice(v1).unwrap(),
            Holder { cells: 3, debt: 5, pending: 7, earning: 3 }
        );
        // A torn earning word, or anything after it, is not a holder.
        assert!(Holder::try_from_slice(&bytes[..38]).is_err());
        let mut long = bytes.clone();
        long.push(0);
        assert!(Holder::try_from_slice(&long).is_err());
    }
}
