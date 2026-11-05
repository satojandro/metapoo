//! Revenue leaves the board only through a fixed split (spec §R1, §R2).
//!
//! - `distribute_near`: withdrawable NEAR → 10% team, 90% buyback (dust to buyback).
//! - `distribute_mpoo`: undistributed mPOO → 10% team, 20% burn address, 70% staker
//!   reserve (dust to the reserve). The reserve is forwarded only once the owner has
//!   set `staking_contract`, which can happen exactly once.
//!
//! Both are open to anyone and rate-limited by `distribution_interval_ns`, so a
//! keeper (or any user) can drive them and nothing depends on the owner key.
//! There is no other way for NEAR or mPOO to leave the board: `withdraw_near` is
//! gone (owner, 1 Nov 2026).
use crate::{Board, BoardExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseError};

/// Where the 20% mPOO burn goes. An `ft_transfer` here, not the token's `burn`
/// method (spec R2, owner update): nobody holds a key for the all-zero implicit
/// account, so tokens sent to it are out of circulation for good. It must be
/// storage-registered on the mPOO contract; until it is, the leg fails and its
/// callback puts the amount back.
pub const BURN_ACCOUNT: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Minimum time between changes of `team_account` or `buyback_account`.
pub(crate) const REVENUE_ACCOUNT_COOLDOWN_NS: u64 = 7 * 86_400_000_000_000;

/// Gas attached to each outgoing `ft_transfer`. mPOO's transfer runs its tax
/// check; 15 Tgas leaves headroom over a plain NEP-141 transfer (~3–5 Tgas).
pub(crate) const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Gas reserved for each leg's callback (one storage write and one log).
pub(crate) const CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// What `get_revenue_state` returns: the public "where the money goes" panel.
/// Nanosecond times are `U64` strings: they exceed JavaScript's safe integers.
#[near(serializers = [json])]
pub struct RevenueState {
    /// NEAR the next `distribute_near` would send (above the protected reserve).
    pub withdrawable_near: U128,
    /// mPOO accepted and not yet split.
    pub mpoo_undistributed: U128,
    /// The 70% staker share waiting for `staking_contract`.
    pub mpoo_staker_reserve: U128,
    pub distribution_interval_ns: U64,
    /// Earliest block time at which `distribute_near` is accepted. 0 = now.
    pub next_near_distribution_ns: U64,
    /// Earliest block time at which `distribute_mpoo` is accepted. 0 = now.
    pub next_mpoo_distribution_ns: U64,
    pub team_account: AccountId,
    pub buyback_account: AccountId,
    pub staking_contract: Option<AccountId>,
    pub burn_account: AccountId,
    pub mpoo_token: AccountId,
}

/// What `get_buyback_totals` returns: cumulative buyback flows since `new`, as
/// decimal strings. JSON `{"near_to_buyback":"…","mpoo_returned":"…"}`.
#[near(serializers = [json])]
pub struct BuybackTotalsView {
    /// yoctoNEAR that reached `buyback_account` through `distribute_near`: counted
    /// when the buyback leg's transfer is confirmed, so a failed leg (refunded and
    /// sent again later) counts once.
    pub near_to_buyback: U128,
    /// mPOO base units the buyback account returned with `{"revenue":{}}`, the same
    /// amounts as the `mpoo_revenue_received` events. Credit purchases paid in mPOO
    /// are not included.
    pub mpoo_returned: U128,
}

/// Which mPOO leg a callback is settling.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MpooLeg {
    Team,
    Burn,
    Stakers,
}

#[near]
impl Board {
    /// Send the withdrawable NEAR: 10% to `team_account`, 90% (with rounding dust)
    /// to `buyback_account`. Anyone may call it, at most once per
    /// `distribution_interval_ns`. Works while the board is paused: pause stops
    /// paint and purchases, not revenue.
    ///
    /// The time is recorded before the transfers leave. A native transfer that
    /// fails (say, a deleted recipient) refunds its deposit to this account, so the
    /// NEAR is back in `get_withdrawable_near` and the next call sends it again;
    /// there is no counter to restore. `on_near_distributed` logs the outcome of
    /// each leg and, for a confirmed buyback leg only, adds it to
    /// `get_buyback_totals().near_to_buyback`.
    pub fn distribute_near(&mut self) {
        let now = env::block_timestamp();
        assert_interval(
            self.payments.last_near_distribution_ns,
            self.tunables.distribution_interval_ns,
            now,
        );
        let amount = self.get_withdrawable_near().0;
        assert!(amount > 0, "NothingToDistribute");
        let team = amount / 10;
        let buyback = amount - team;
        self.payments.last_near_distribution_ns = Some(now);
        Self::safety_event(
            "near_distributed",
            near_sdk::serde_json::json!({
                "amount": U128(amount),
                "team_account": self.payments.team_account, "team": U128(team),
                "buyback_account": self.payments.buyback_account, "buyback": U128(buyback),
                "status": "scheduled"
            }),
        );
        for (account, share, to_buyback) in [
            (self.payments.team_account.clone(), team, false),
            (self.payments.buyback_account.clone(), buyback, true),
        ] {
            if share == 0 {
                continue;
            }
            Promise::new(account.clone())
                .transfer(NearToken::from_yoctonear(share))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_near_distributed(account, U128(share), Some(to_buyback)),
                )
                .detach();
        }
    }

    /// Callback for one NEAR leg. A failed transfer has already returned its
    /// deposit to this account (see `distribute_near`), so failure only logs. A
    /// confirmed buyback leg (`to_buyback`, set by `distribute_near`; the leg's
    /// role, not a comparison of account ids, so a team account equal to the
    /// buyback account is not counted twice) adds `amount` to
    /// `total_near_to_buyback`. A failed leg is resent by a later call and counted
    /// when that one is confirmed: once.
    #[private]
    pub fn on_near_distributed(&mut self, account: AccountId, amount: U128, to_buyback: Option<bool>) -> bool {
        let ok = leg_succeeded();
        if ok && to_buyback == Some(true) {
            // Saturating: a total of all NEAR ever sent cannot reach u128::MAX.
            self.total_near_to_buyback = self.total_near_to_buyback.saturating_add(amount.0);
        }
        Self::safety_event(
            if ok {
                "near_distribution_leg_sent"
            } else {
                "near_distribution_leg_failed"
            },
            near_sdk::serde_json::json!({"account": account, "amount": amount}),
        );
        ok
    }

    /// Split `mpoo_undistributed`: 10% `ft_transfer` to `team_account`, 20%
    /// `ft_transfer` to `BURN_ACCOUNT`, 70% (with dust) into
    /// `mpoo_staker_reserve`. If `staking_contract` is set, the whole reserve is
    /// then forwarded to it. Anyone may call it, at most once per
    /// `distribution_interval_ns` (its own clock, independent of NEAR).
    ///
    /// Each outgoing leg has a callback: a failed team or burn leg returns its
    /// amount to `mpoo_undistributed`; a failed staker forward returns to
    /// `mpoo_staker_reserve`, so the stakers' share is never re-split.
    ///
    /// Attach at least 100 Tgas: up to three legs × (15 + 10) Tgas, plus this call.
    pub fn distribute_mpoo(&mut self) {
        let now = env::block_timestamp();
        assert_interval(
            self.payments.last_mpoo_distribution_ns,
            self.tunables.distribution_interval_ns,
            now,
        );
        let amount = self.payments.mpoo_undistributed;
        let team = amount / 10;
        let burn = amount / 5;
        let stakers = amount - team - burn;
        let reserve = self
            .payments
            .mpoo_staker_reserve
            .checked_add(stakers)
            .expect("MpooRevenueOverflow");
        let forward = self
            .payments
            .staking_contract
            .clone()
            .filter(|_| reserve > 0);
        assert!(amount > 0 || forward.is_some(), "NothingToDistribute");

        self.payments.last_mpoo_distribution_ns = Some(now);
        self.payments.mpoo_undistributed = 0;
        self.payments.mpoo_staker_reserve = reserve;
        let forwarded = if forward.is_some() { reserve } else { 0 };
        Self::safety_event(
            "mpoo_distributed",
            near_sdk::serde_json::json!({
                "amount": U128(amount),
                "team_account": self.payments.team_account, "team": U128(team),
                "burn_account": BURN_ACCOUNT, "burn": U128(burn),
                "stakers": U128(stakers),
                "staking_contract": forward, "forwarded": U128(forwarded),
                "status": "scheduled"
            }),
        );
        let team_account = self.payments.team_account.clone();
        self.send_mpoo_leg(MpooLeg::Team, team_account, team);
        self.send_mpoo_leg(MpooLeg::Burn, burn_account(), burn);
        if let Some(staking) = forward {
            self.payments.mpoo_staker_reserve = 0;
            self.send_mpoo_leg(MpooLeg::Stakers, staking, reserve);
        }
    }

    /// Callback for one mPOO leg. On failure the amount goes back where it came
    /// from: team and burn to `mpoo_undistributed`, stakers to the reserve.
    #[private]
    pub fn on_mpoo_distributed(&mut self, leg: MpooLeg, receiver: AccountId, amount: U128) -> bool {
        let ok = leg_succeeded();
        if !ok {
            let pot = match leg {
                MpooLeg::Team | MpooLeg::Burn => &mut self.payments.mpoo_undistributed,
                MpooLeg::Stakers => &mut self.payments.mpoo_staker_reserve,
            };
            // Saturating: the amount left this pot moments ago, so it fits.
            *pot = pot.saturating_add(amount.0);
        }
        Self::safety_event(
            if ok {
                "mpoo_distribution_leg_sent"
            } else {
                "mpoo_distribution_leg_restored"
            },
            near_sdk::serde_json::json!({"leg": leg, "receiver": receiver, "amount": amount}),
        );
        ok
    }

    /// Owner, 1 yocto, at most once per 7 days. The first change is allowed at
    /// any time (history `None`), like the price cooldowns.
    #[payable]
    pub fn set_team_account(&mut self, account_id: AccountId) {
        let now = self
            .assert_revenue_account_change(&account_id, self.payments.last_team_account_change_ns);
        let old = std::mem::replace(&mut self.payments.team_account, account_id.clone());
        self.payments.last_team_account_change_ns = Some(now);
        revenue_account_event("team", &old, &account_id, now);
    }

    /// Owner, 1 yocto, at most once per 7 days; its own history, independent of
    /// the team account's.
    #[payable]
    pub fn set_buyback_account(&mut self, account_id: AccountId) {
        let now = self.assert_revenue_account_change(
            &account_id,
            self.payments.last_buyback_account_change_ns,
        );
        let old = std::mem::replace(&mut self.payments.buyback_account, account_id.clone());
        self.payments.last_buyback_account_change_ns = Some(now);
        revenue_account_event("buyback", &old, &account_id, now);
    }

    /// Owner, 1 yocto, exactly once. Until this is set, the staker reserve cannot
    /// move at all; afterwards every `distribute_mpoo` forwards it here.
    #[payable]
    pub fn set_staking_contract(&mut self, account_id: AccountId) {
        self.assert_revenue_owner();
        assert!(
            self.payments.staking_contract.is_none(),
            "StakingContractAlreadySet"
        );
        assert_ne!(
            account_id,
            env::current_account_id(),
            "InvalidRevenueAccount"
        );
        Self::safety_event(
            "staking_contract_set",
            near_sdk::serde_json::json!({"staking_contract": account_id}),
        );
        self.payments.staking_contract = Some(account_id);
    }

    /// Cumulative buyback totals: NEAR delivered to the buyback, mPOO returned.
    pub fn get_buyback_totals(&self) -> BuybackTotalsView {
        BuybackTotalsView {
            near_to_buyback: U128(self.total_near_to_buyback),
            mpoo_returned: U128(self.total_mpoo_returned),
        }
    }

    pub fn get_revenue_state(&self) -> RevenueState {
        let interval = self.tunables.distribution_interval_ns;
        let next = |last: Option<u64>| U64(last.map_or(0, |t| t.saturating_add(interval)));
        RevenueState {
            withdrawable_near: self.get_withdrawable_near(),
            mpoo_undistributed: U128(self.payments.mpoo_undistributed),
            mpoo_staker_reserve: U128(self.payments.mpoo_staker_reserve),
            distribution_interval_ns: U64(interval),
            next_near_distribution_ns: next(self.payments.last_near_distribution_ns),
            next_mpoo_distribution_ns: next(self.payments.last_mpoo_distribution_ns),
            team_account: self.payments.team_account.clone(),
            buyback_account: self.payments.buyback_account.clone(),
            staking_contract: self.payments.staking_contract.clone(),
            burn_account: burn_account(),
            mpoo_token: self.payments.token.clone(),
        }
    }
}

impl Board {
    /// Every mPOO the board keeps is revenue: purchases and buyback returns alike.
    /// A panic here (overflow) rolls back the purchase and the resolver refunds.
    pub(crate) fn add_mpoo_revenue(&mut self, amount: u128) {
        self.payments.mpoo_undistributed = self
            .payments
            .mpoo_undistributed
            .checked_add(amount)
            .expect("MpooRevenueOverflow");
    }

    /// `ft_on_transfer` for `{"revenue":{}}`. The caller has already checked that
    /// the token is the configured mPOO. Returns the amount to refund: 0 when
    /// accepted, all of it when the sender isn't `buyback_account`.
    pub(crate) fn receive_mpoo_revenue(&mut self, sender_id: &AccountId, amount: U128) -> U128 {
        if *sender_id != self.payments.buyback_account {
            env::log_str("revenue_rejected: NotBuybackAccount");
            return amount;
        }
        self.add_mpoo_revenue(amount.0);
        // Same amount as the event below. add_mpoo_revenue already proved the
        // undistributed pot did not overflow; the lifetime total saturates.
        self.total_mpoo_returned = self.total_mpoo_returned.saturating_add(amount.0);
        Self::safety_event(
            "mpoo_revenue_received",
            near_sdk::serde_json::json!({"sender_id": sender_id, "amount": amount}),
        );
        U128(0)
    }

    fn send_mpoo_leg(&self, leg: MpooLeg, receiver: AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "receiver_id": receiver, "amount": U128(amount)
        }))
        .expect("SerializationFailed");
        Promise::new(self.payments.token.clone())
            .function_call(
                "ft_transfer",
                args,
                NearToken::from_yoctonear(1),
                FT_TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_mpoo_distributed(leg, receiver, U128(amount)),
            )
            .detach();
    }

    fn assert_revenue_owner(&self) {
        near_sdk::assert_one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.owner,
            "OwnerOnly"
        );
    }

    fn assert_revenue_account_change(&self, account: &AccountId, last: Option<u64>) -> u64 {
        self.assert_revenue_owner();
        assert_ne!(*account, env::current_account_id(), "InvalidRevenueAccount");
        let now = env::block_timestamp();
        if let Some(last) = last {
            assert!(
                now.checked_sub(last)
                    .is_some_and(|elapsed| elapsed >= REVENUE_ACCOUNT_COOLDOWN_NS),
                "RevenueAccountCooldown"
            );
        }
        now
    }
}

/// True for exactly `{"revenue":{}}` (whitespace aside).
pub(crate) fn is_revenue_message(msg: &str) -> bool {
    near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(msg)
        .is_ok_and(|v| v == near_sdk::serde_json::json!({"revenue": {}}))
}

pub(crate) fn burn_account() -> AccountId {
    BURN_ACCOUNT.parse().expect("valid implicit account")
}

/// `DistributionTooSoon` while less than `interval` has passed since `last`.
/// The keeper matches this code: do not rename it.
fn assert_interval(last: Option<u64>, interval: u64, now: u64) {
    if let Some(last) = last {
        assert!(
            now.checked_sub(last)
                .is_some_and(|elapsed| elapsed >= interval),
            "DistributionTooSoon"
        );
    }
}

/// A leg succeeded unless its receipt failed. A result too long to read still
/// means the receipt ran.
fn leg_succeeded() -> bool {
    !matches!(
        env::promise_result_checked(0, 64),
        Err(PromiseError::Failed)
    )
}

fn revenue_account_event(role: &str, old: &AccountId, new: &AccountId, now: u64) {
    Board::safety_event(
        "revenue_account_changed",
        near_sdk::serde_json::json!({
            "role": role, "old_account": old, "new_account": new,
            "changed_at_ns": now.to_string()
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safety::STORAGE_PER_PIXEL;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    const HOUR: u64 = 3_600_000_000_000;

    fn board_id() -> AccountId {
        accounts(4)
    }
    fn token() -> AccountId {
        accounts(5)
    }
    fn ctx_full(
        caller: AccountId,
        signer: AccountId,
        ts: u64,
        deposit: u128,
        balance: u128,
        results: Vec<PromiseResult>,
    ) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(board_id())
                .predecessor_account_id(caller)
                .signer_account_id(signer)
                .attached_deposit(NearToken::from_yoctonear(deposit))
                .account_balance(NearToken::from_yoctonear(balance))
                .storage_usage(1000)
                .block_timestamp(ts)
                .build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }
    fn balance() -> u128 {
        NearToken::from_near(200).as_yoctonear() + 7
    }
    fn ctx(caller: AccountId, ts: u64, deposit: u128) {
        ctx_full(caller.clone(), caller, ts, deposit, balance(), vec![]);
    }
    fn callback_ctx(result: PromiseResult) {
        ctx_full(board_id(), board_id(), 0, 0, balance(), vec![result]);
    }
    fn setup() -> Board {
        ctx(accounts(0), 0, 0);
        Board::new(
            token(),
            U128(100),
            crate::test_team(),
            crate::test_buyback(),
            crate::test_toilet(),
        )
    }
    fn rejected(code: &str, f: impl FnOnce()) {
        let err =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
        let message = err
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains(code), "expected {code}, got {message}");
    }
    /// Native transfers created this call, as (receiver, yoctoNEAR).
    fn transfers() -> Vec<(AccountId, u128)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.clone();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::Transfer { deposit, .. } => {
                        Some((to.clone(), deposit.as_yoctonear()))
                    }
                    _ => None,
                })
            })
            .collect()
    }
    type Call = (AccountId, String, near_sdk::serde_json::Value, u128, Gas);
    /// Function calls created this call, as (receiver, method, args, deposit, gas).
    fn calls() -> Vec<Call> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.clone();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        ..
                    } => Some((
                        to.clone(),
                        String::from_utf8(method_name).unwrap(),
                        near_sdk::serde_json::from_slice(&args).unwrap(),
                        attached_deposit.as_yoctonear(),
                        prepaid_gas,
                    )),
                    _ => None,
                })
            })
            .collect()
    }
    /// The ft_transfer legs sent to the mPOO token, as (receiver, amount).
    fn ft_legs() -> Vec<(String, u128)> {
        calls()
            .into_iter()
            .filter(|(to, method, ..)| *to == token() && method == "ft_transfer")
            .map(|(_, _, args, deposit, gas)| {
                assert_eq!(deposit, 1, "ft_transfer needs exactly 1 yocto");
                assert_eq!(gas, FT_TRANSFER_GAS);
                (
                    args["receiver_id"].as_str().unwrap().to_string(),
                    args["amount"].as_str().unwrap().parse().unwrap(),
                )
            })
            .collect()
    }
    fn revenue() -> String {
        r#"{"revenue":{}}"#.into()
    }

    // ---------------- R1: NEAR ----------------

    #[test]
    fn distribute_near_non_owner_can_call_and_splits_exactly_10_90_with_dust_to_buyback() {
        let mut board = setup();
        ctx(accounts(3), 0, 0);
        let amount = board.get_withdrawable_near().0;
        assert_ne!(amount % 10, 0, "fixture must leave rounding dust");
        board.distribute_near();
        let sent = transfers();
        assert_eq!(
            sent,
            vec![
                (crate::test_team(), amount / 10),
                (crate::test_buyback(), amount - amount / 10)
            ]
        );
        assert_eq!(sent[0].1 + sent[1].1, amount);
        let callbacks: Vec<_> = calls()
            .into_iter()
            .filter(|(to, m, ..)| *to == board_id() && m == "on_near_distributed")
            .collect();
        assert_eq!(callbacks.len(), 2);
        assert!(callbacks.iter().all(|c| c.4 == CALLBACK_GAS));
        assert_eq!(board.payments.last_near_distribution_ns, Some(0));
        assert!(get_logs().iter().any(|l| l.contains("near_distributed")));
    }

    #[test]
    fn distribute_near_second_call_inside_interval_rejects_distribution_too_soon() {
        let mut board = setup();
        ctx(accounts(3), 5, 0);
        board.distribute_near();
        ctx(accounts(3), 5 + HOUR - 1, 0);
        rejected("DistributionTooSoon", || board.distribute_near());
        assert!(get_created_receipts().is_empty());
        ctx(accounts(3), 5 + HOUR, 0);
        board.distribute_near();
        assert_eq!(board.payments.last_near_distribution_ns, Some(5 + HOUR));
    }

    #[test]
    fn distribute_near_with_nothing_above_the_reserve_rejects_nothing_to_distribute() {
        let mut board = setup();
        ctx_full(
            accounts(3),
            accounts(3),
            0,
            0,
            NearToken::from_near(2).as_yoctonear(),
            vec![],
        );
        rejected("NothingToDistribute", || board.distribute_near());
        // A rejected call records no time: the next caller is not locked out.
        assert_eq!(board.payments.last_near_distribution_ns, None);
    }

    #[test]
    fn distribute_near_withdrawable_never_dips_into_the_reserve() {
        let mut board = setup();
        ctx(accounts(3), 0, 0);
        board.distribute_near();
        // The transfers are already debited from the account in this receipt.
        assert_eq!(board.get_withdrawable_near(), U128(0));
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        let protected = storage
            + u128::from(crate::board_cells()) * STORAGE_PER_PIXEL
            + board.tunables.reserve_floor.0;
        assert_eq!(env::account_balance().as_yoctonear(), protected);
    }

    #[test]
    fn failed_near_transfer_is_logged_and_the_refund_is_distributed_next_time() {
        let mut board = setup();
        callback_ctx(PromiseResult::Failed);
        assert!(!board.on_near_distributed(crate::test_team(), U128(42), Some(false)));
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("near_distribution_leg_failed") && l.contains("\"42\"")));
        callback_ctx(PromiseResult::Successful(vec![]));
        assert!(board.on_near_distributed(crate::test_team(), U128(42), Some(false)));
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("near_distribution_leg_sent")));
        // The runtime returned the failed deposit to the board's balance; the
        // next distribution after the interval sends it again.
        ctx(accounts(3), 0, 0);
        board.distribute_near();
        ctx(accounts(3), HOUR, 0);
        assert!(board.get_withdrawable_near().0 > 0);
        board.distribute_near();
        assert_eq!(transfers().len(), 2);
    }

    #[test]
    fn distribute_near_still_works_while_paused() {
        let mut board = setup();
        board.tunables.paused = true;
        ctx(accounts(3), 0, 0);
        board.distribute_near();
        assert_eq!(transfers().len(), 2);
    }

    /// Owner decision, 2 Nov (docs/handover-2026-10-29.md): pause stops paint and
    /// purchases, never revenue. Both distributions must keep running.
    #[test]
    fn distributions_run_while_paused() {
        let mut board = setup();
        ctx(accounts(0), 0, 1);
        board.set_paused(true);
        assert!(board.get_tunables().paused);
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 0, 0);
        board.distribute_near();
        assert_eq!(transfers().len(), 2);
        assert_eq!(board.payments.last_near_distribution_ns, Some(0));
        ctx(accounts(3), 0, 0);
        board.distribute_mpoo();
        assert_eq!(ft_legs().len(), 2);
        assert_eq!(board.payments.mpoo_undistributed, 0);
        assert_eq!(board.payments.last_mpoo_distribution_ns, Some(0));
        assert!(board.get_tunables().paused);
    }

    // ---------------- Buyback totals (owner, 3 Nov) ----------------

    #[test]
    fn buyback_totals_are_zero_on_a_fresh_board() {
        let board = setup();
        let totals = board.get_buyback_totals();
        assert_eq!(
            near_sdk::serde_json::to_value(&totals).unwrap(),
            near_sdk::serde_json::json!({"near_to_buyback": "0", "mpoo_returned": "0"})
        );
    }

    /// The scheduled `on_near_distributed` callback for the buyback leg.
    fn buyback_callback_args() -> near_sdk::serde_json::Value {
        calls()
            .into_iter()
            .filter(|(to, m, ..)| *to == board_id() && m == "on_near_distributed")
            .map(|(_, _, args, ..)| args)
            .find(|args| args["account"] == crate::test_buyback().as_str())
            .expect("buyback leg callback")
    }

    /// Run the scheduled buyback callback with `result`, as the runtime would.
    fn settle_buyback_leg(board: &mut Board, args: &near_sdk::serde_json::Value, result: PromiseResult) -> bool {
        callback_ctx(result);
        board.on_near_distributed(
            args["account"].as_str().unwrap().parse().unwrap(),
            U128(args["amount"].as_str().unwrap().parse().unwrap()),
            args.get("to_buyback").and_then(|v| v.as_bool()),
        )
    }

    #[test]
    fn a_successful_buyback_leg_counts_once() {
        let mut board = setup();
        ctx(accounts(3), 0, 0);
        let amount = board.get_withdrawable_near().0;
        board.distribute_near();
        let buyback = amount - amount / 10;
        // Scheduling alone counts nothing.
        assert_eq!(board.get_buyback_totals().near_to_buyback, U128(0));
        let args = buyback_callback_args();
        assert_eq!(args["amount"], buyback.to_string());
        assert!(settle_buyback_leg(&mut board, &args, PromiseResult::Successful(vec![])));
        assert_eq!(board.get_buyback_totals().near_to_buyback, U128(buyback));
        // The team leg's success adds nothing, even if the team is the buyback account.
        callback_ctx(PromiseResult::Successful(vec![]));
        board.on_near_distributed(crate::test_buyback(), U128(amount / 10), Some(false));
        assert_eq!(board.get_buyback_totals().near_to_buyback, U128(buyback));
    }

    #[test]
    fn a_failed_then_resent_buyback_leg_counts_once() {
        let mut board = setup();
        ctx(accounts(3), 0, 0);
        board.distribute_near();
        let first = buyback_callback_args();
        assert!(!settle_buyback_leg(&mut board, &first, PromiseResult::Failed));
        assert_eq!(board.get_buyback_totals().near_to_buyback, U128(0));
        // The refund is back in the withdrawable balance; the next run resends it.
        ctx(accounts(3), HOUR, 0);
        board.distribute_near();
        let second = buyback_callback_args();
        assert_eq!(second["amount"], first["amount"]);
        assert!(settle_buyback_leg(&mut board, &second, PromiseResult::Successful(vec![])));
        let sent: u128 = second["amount"].as_str().unwrap().parse().unwrap();
        assert_eq!(board.get_buyback_totals().near_to_buyback, U128(sent));
    }

    #[test]
    fn a_revenue_receipt_adds_exactly_its_amount_and_mpoo_purchases_do_not() {
        let mut board = setup();
        ctx_full(token(), crate::test_buyback(), 0, 0, balance(), vec![]);
        board.ft_on_transfer(crate::test_buyback(), U128(500), revenue());
        board.ft_on_transfer(crate::test_buyback(), U128(7), revenue());
        assert_eq!(board.get_buyback_totals().mpoo_returned, U128(507));
        // Refused revenue (not the buyback account) counts nothing.
        ctx_full(token(), crate::test_team(), 0, 0, balance(), vec![]);
        board.ft_on_transfer(crate::test_team(), U128(900), revenue());
        assert_eq!(board.get_buyback_totals().mpoo_returned, U128(507));
        // A credit purchase in mPOO is revenue but not a buyback return.
        board.tunables.mpoo_daily_credit_cap = 1_000_000;
        let fee = board.get_payment_config().registration_fee.0;
        ctx(accounts(1), 0, fee);
        board.register_credit_account();
        ctx_full(token(), accounts(1), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(
                accounts(1),
                U128(200),
                r#"{"min_credits":"2","expected_price":"100"}"#.into()
            ),
            U128(0)
        );
        assert_eq!(board.payments.mpoo_undistributed, 707);
        assert_eq!(board.get_buyback_totals().mpoo_returned, U128(507));
        // NEAR is untouched by mPOO flows.
        assert_eq!(board.get_buyback_totals().near_to_buyback, U128(0));
    }

    // ---------------- R2: receiving mPOO ----------------

    #[test]
    fn revenue_message_from_buyback_adds_to_undistributed() {
        let mut board = setup();
        ctx_full(token(), crate::test_buyback(), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(crate::test_buyback(), U128(500), revenue()),
            U128(0)
        );
        assert_eq!(
            board.ft_on_transfer(
                crate::test_buyback(),
                U128(1),
                " { \"revenue\" : { } } ".into()
            ),
            U128(0)
        );
        assert_eq!(board.payments.mpoo_undistributed, 501);
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("mpoo_revenue_received")));
    }

    #[test]
    fn revenue_message_from_non_buyback_is_refunded() {
        let mut board = setup();
        for sender in [accounts(0), accounts(1), crate::test_team()] {
            ctx_full(token(), sender.clone(), 0, 0, balance(), vec![]);
            assert_eq!(
                board.ft_on_transfer(sender, U128(500), revenue()),
                U128(500)
            );
        }
        // Extra fields are not a revenue message, and not a purchase either.
        ctx_full(token(), crate::test_buyback(), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(
                crate::test_buyback(),
                U128(500),
                r#"{"revenue":{"x":1}}"#.into()
            ),
            U128(500)
        );
        assert_eq!(board.payments.mpoo_undistributed, 0);
    }

    #[test]
    fn revenue_message_from_another_token_rejects_wrong_token() {
        let mut board = setup();
        ctx_full(accounts(2), crate::test_buyback(), 0, 0, balance(), vec![]);
        rejected("WrongToken", || {
            board.ft_on_transfer(crate::test_buyback(), U128(500), revenue());
        });
        assert_eq!(board.payments.mpoo_undistributed, 0);
    }

    #[test]
    fn revenue_message_is_accepted_while_paused() {
        let mut board = setup();
        board.tunables.paused = true;
        ctx_full(token(), crate::test_buyback(), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(crate::test_buyback(), U128(500), revenue()),
            U128(0)
        );
        assert_eq!(board.payments.mpoo_undistributed, 500);
    }

    #[test]
    fn mpoo_purchase_adds_the_paid_amount_to_undistributed() {
        let mut board = setup();
        // Open mPOO sales whatever the cap rule (REV-B) defaults to.
        board.tunables.mpoo_daily_credit_cap = 1_000_000;
        let fee = board.get_payment_config().registration_fee.0;
        ctx(accounts(1), 0, fee);
        board.register_credit_account();
        ctx_full(token(), accounts(1), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(
                accounts(1),
                U128(200),
                r#"{"min_credits":"2","expected_price":"100"}"#.into()
            ),
            U128(0)
        );
        assert_eq!(board.get_credits(accounts(1)), Some(U128(2)));
        assert_eq!(board.payments.mpoo_undistributed, 200);
        // A refunded purchase adds nothing.
        assert_eq!(
            board.ft_on_transfer(
                accounts(1),
                U128(150),
                r#"{"min_credits":"1","expected_price":"100"}"#.into()
            ),
            U128(150)
        );
        assert_eq!(board.payments.mpoo_undistributed, 200);
    }

    // ---------------- R2: distributing mPOO ----------------

    #[test]
    fn distribute_mpoo_non_owner_can_call_and_splits_10_20_70_with_dust_to_reserve() {
        let mut board = setup();
        board.payments.mpoo_undistributed = 1_009;
        ctx(accounts(3), 0, 0);
        board.distribute_mpoo();
        assert_eq!(
            ft_legs(),
            vec![
                (crate::test_team().to_string(), 100),
                (BURN_ACCOUNT.to_string(), 201)
            ]
        );
        assert_eq!(board.payments.mpoo_staker_reserve, 708);
        assert_eq!(100 + 201 + 708, 1_009);
        assert_eq!(board.payments.mpoo_undistributed, 0);
        assert_eq!(board.payments.last_mpoo_distribution_ns, Some(0));
        let callbacks: Vec<_> = calls()
            .into_iter()
            .filter(|(to, m, ..)| *to == board_id() && m == "on_mpoo_distributed")
            .collect();
        assert_eq!(callbacks.len(), 2);
        assert_eq!(callbacks[1].2["leg"], "burn");
        assert!(callbacks.iter().all(|c| c.4 == CALLBACK_GAS));
        // No NEAR leaves on the mPOO path.
        assert!(transfers().is_empty());
    }

    #[test]
    fn distribute_mpoo_too_soon_rejects_and_keeps_its_own_clock() {
        let mut board = setup();
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 0, 0);
        board.distribute_near(); // NEAR's clock does not block mPOO
        board.distribute_mpoo();
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), HOUR - 1, 0);
        rejected("DistributionTooSoon", || board.distribute_mpoo());
        assert_eq!(board.payments.mpoo_undistributed, 1_000);
        ctx(accounts(3), HOUR, 0);
        board.distribute_mpoo();
        assert_eq!(board.payments.mpoo_undistributed, 0);
    }

    #[test]
    fn distribute_mpoo_with_nothing_rejects_nothing_to_distribute() {
        let mut board = setup();
        ctx(accounts(3), 0, 0);
        rejected("NothingToDistribute", || board.distribute_mpoo());
        assert_eq!(board.payments.last_mpoo_distribution_ns, None);
    }

    #[test]
    fn failed_burn_leg_restores_its_20_percent() {
        let mut board = setup();
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 0, 0);
        board.distribute_mpoo();
        callback_ctx(PromiseResult::Failed);
        assert!(!board.on_mpoo_distributed(MpooLeg::Burn, burn_account(), U128(200)));
        assert_eq!(board.payments.mpoo_undistributed, 200);
        assert_eq!(board.payments.mpoo_staker_reserve, 700);
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("mpoo_distribution_leg_restored")));
    }

    #[test]
    fn failed_team_leg_restores_and_successful_leg_changes_nothing() {
        let mut board = setup();
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 0, 0);
        board.distribute_mpoo();
        callback_ctx(PromiseResult::Successful(vec![]));
        assert!(board.on_mpoo_distributed(MpooLeg::Burn, burn_account(), U128(200)));
        assert_eq!(board.payments.mpoo_undistributed, 0);
        callback_ctx(PromiseResult::Failed);
        assert!(!board.on_mpoo_distributed(MpooLeg::Team, crate::test_team(), U128(100)));
        assert_eq!(board.payments.mpoo_undistributed, 100);
    }

    #[test]
    fn reserve_accumulates_until_staking_contract_set_then_forwards_all_of_it() {
        let mut board = setup();
        let staking: AccountId = "stake.metapoo.testnet".parse().unwrap();
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 0, 0);
        board.distribute_mpoo();
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), HOUR, 0);
        board.distribute_mpoo();
        assert_eq!(board.payments.mpoo_staker_reserve, 1_400);
        assert_eq!(ft_legs().len(), 2, "no staker leg before staking_contract");

        // Nobody, the owner included, can move the reserve before it is set.
        ctx(accounts(0), 2 * HOUR, 0);
        rejected("NothingToDistribute", || board.distribute_mpoo());
        assert_eq!(board.payments.mpoo_staker_reserve, 1_400);

        ctx(accounts(0), 2 * HOUR, 1);
        board.set_staking_contract(staking.clone());
        // With nothing new undistributed, the reserve alone is forwarded.
        ctx(accounts(3), 2 * HOUR, 0);
        board.distribute_mpoo();
        assert_eq!(ft_legs(), vec![(staking.to_string(), 1_400)]);
        assert_eq!(board.payments.mpoo_staker_reserve, 0);

        // From then on the 70% goes straight through.
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 3 * HOUR, 0);
        board.distribute_mpoo();
        assert_eq!(
            ft_legs(),
            vec![
                (crate::test_team().to_string(), 100),
                (BURN_ACCOUNT.to_string(), 200),
                (staking.to_string(), 700)
            ]
        );
        assert_eq!(board.payments.mpoo_staker_reserve, 0);
    }

    #[test]
    fn failed_staker_forward_restores_the_reserve_not_undistributed() {
        let mut board = setup();
        let staking: AccountId = "stake.metapoo.testnet".parse().unwrap();
        board.payments.staking_contract = Some(staking.clone());
        board.payments.mpoo_staker_reserve = 300;
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 0, 0);
        board.distribute_mpoo();
        assert_eq!(ft_legs()[2], (staking.to_string(), 1_000));
        callback_ctx(PromiseResult::Failed);
        board.on_mpoo_distributed(MpooLeg::Stakers, staking, U128(1_000));
        assert_eq!(board.payments.mpoo_staker_reserve, 1_000);
        assert_eq!(board.payments.mpoo_undistributed, 0);
    }

    // ---------------- owner setters ----------------

    #[test]
    fn staking_contract_can_be_set_only_once_by_the_owner() {
        let mut board = setup();
        let staking: AccountId = "stake.metapoo.testnet".parse().unwrap();
        ctx(accounts(1), 0, 1);
        rejected("OwnerOnly", || board.set_staking_contract(staking.clone()));
        ctx(accounts(0), 0, 0);
        rejected("exactly 1 yoctoNEAR", || {
            board.set_staking_contract(staking.clone())
        });
        ctx(accounts(0), 0, 1);
        rejected("InvalidRevenueAccount", || {
            board.set_staking_contract(board_id())
        });
        board.set_staking_contract(staking.clone());
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("staking_contract_set")));
        rejected("StakingContractAlreadySet", || {
            board.set_staking_contract(accounts(2))
        });
        assert_eq!(board.payments.staking_contract, Some(staking));
    }

    #[test]
    fn team_and_buyback_changes_need_owner_and_separate_7_day_cooldowns() {
        let mut board = setup();
        let week = REVENUE_ACCOUNT_COOLDOWN_NS;
        ctx(accounts(1), 0, 1);
        rejected("OwnerOnly", || board.set_team_account(accounts(2)));
        ctx(accounts(0), 0, 0);
        rejected("exactly 1 yoctoNEAR", || {
            board.set_team_account(accounts(2))
        });
        ctx(accounts(0), 0, 1);
        rejected("InvalidRevenueAccount", || {
            board.set_team_account(board_id())
        });
        rejected("InvalidRevenueAccount", || {
            board.set_buyback_account(board_id())
        });

        ctx(accounts(0), 10, 1);
        board.set_team_account(accounts(2));
        let log = get_logs().pop().unwrap();
        assert!(log.contains("revenue_account_changed") && log.contains("\"team\""));
        assert!(log.contains(crate::test_team().as_str()));
        // The team change does not start the buyback cooldown.
        board.set_buyback_account(accounts(3));
        ctx(accounts(0), 10 + week - 1, 1);
        rejected("RevenueAccountCooldown", || {
            board.set_team_account(accounts(1))
        });
        rejected("RevenueAccountCooldown", || {
            board.set_buyback_account(accounts(1))
        });
        ctx(accounts(0), 10 + week, 1);
        board.set_team_account(accounts(1));
        board.set_buyback_account(accounts(1));
        assert_eq!(board.payments.last_team_account_change_ns, Some(10 + week));
        assert_eq!(
            board.payments.last_buyback_account_change_ns,
            Some(10 + week)
        );
    }

    #[test]
    fn distributions_follow_changed_accounts_and_only_buyback_sends_revenue() {
        let mut board = setup();
        ctx(accounts(0), 0, 1);
        board.set_team_account(accounts(2));
        board.set_buyback_account(accounts(3));
        ctx_full(token(), crate::test_buyback(), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(crate::test_buyback(), U128(10), revenue()),
            U128(10)
        );
        ctx_full(token(), accounts(3), 0, 0, balance(), vec![]);
        assert_eq!(
            board.ft_on_transfer(accounts(3), U128(10), revenue()),
            U128(0)
        );
        ctx(accounts(1), 0, 0);
        board.distribute_near();
        let sent = transfers();
        assert_eq!(sent[0].0, accounts(2));
        assert_eq!(sent[1].0, accounts(3));
    }

    #[test]
    fn revenue_state_reports_balances_accounts_and_next_times() {
        let mut board = setup();
        let state = board.get_revenue_state();
        assert_eq!(state.next_near_distribution_ns, U64(0));
        assert_eq!(state.burn_account.as_str(), BURN_ACCOUNT);
        assert_eq!(state.withdrawable_near, board.get_withdrawable_near());
        board.payments.mpoo_undistributed = 1_000;
        ctx(accounts(3), 7, 0);
        board.distribute_mpoo();
        let state = board.get_revenue_state();
        assert_eq!(state.mpoo_undistributed, U128(0));
        assert_eq!(state.mpoo_staker_reserve, U128(700));
        assert_eq!(state.next_mpoo_distribution_ns, U64(7 + HOUR));
        assert_eq!(state.next_near_distribution_ns, U64(0));
        assert_eq!(state.distribution_interval_ns, U64(HOUR));
        assert_eq!(state.team_account, crate::test_team());
        assert_eq!(state.buyback_account, crate::test_buyback());
        assert_eq!(state.staking_contract, None);
        assert_eq!(state.mpoo_token, token());
    }
}
