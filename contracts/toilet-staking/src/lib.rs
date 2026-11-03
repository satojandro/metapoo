//! TOILET staking (spec `docs/economy/2026-11-02-toilet-round-spec.md` §S).
//!
//! Stakers lock TOILET. The contract holds an mPOO pool, releases at most 10% of it per
//! day to stakers pro rata through a MasterChef accumulator, and burns 10% of every
//! unstaked amount by sending it to the 64-zero burn address.
//!
//! There is no owner, no upgrade, no pause and no admin method (T9, S8). Every parameter
//! is a constant or an argument to `new`, which runs once.
//!
//! mPOO accounting. `accounted = pool + rewards_owed`, where `rewards_owed` is every mPOO
//! released to stakers and not yet confirmed paid out (claimable, unsettled, and payouts in
//! flight). The board pays with a plain `ft_transfer`, so new mPOO is found by comparing
//! the token balance with `accounted` (`sync_inflow`).
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

pub mod math;
use math::{
    drip, earned, exit_tax, split_release, ACC_SCALE, DAY_NS, DRIP_BPS, EXIT_TAX_BPS, MPOO_BOUND,
};

/// Where the exit tax goes: nobody holds a key for the all-zero implicit account, so
/// tokens sent there are out of circulation for good (burn route recorded 2 Nov in
/// `docs/handover-2026-10-29.md`). It must be storage-registered on the TOILET token.
pub const BURN_ACCOUNT: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Gas for one outgoing `ft_transfer` (the TOILET token runs its tax check).
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Gas for `ft_balance_of` on mPOO.
const FT_BALANCE_GAS: Gas = Gas::from_tgas(10);
/// Gas for a callback that only writes state and logs.
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// The unstake callback may schedule the burn transfer and its own callback.
const UNSTAKE_CALLBACK_GAS: Gas = Gas::from_tgas(15 + 15 + 15);

/// Prepaid gas required up front, so a callback that restores value can never be starved.
const CLAIM_MIN_GAS: Gas = Gas::from_tgas(50);
const UNSTAKE_MIN_GAS: Gas = Gas::from_tgas(90);
const FLUSH_MIN_GAS: Gas = Gas::from_tgas(50);
const SYNC_MIN_GAS: Gas = Gas::from_tgas(40);

const PREFIX_STAKERS: &[u8] = b"s";

/// One staker's record. `snapshot` is the accumulator value at the last settlement; the
/// spec's `debt` is `staked × snapshot / ACC_SCALE`, kept unscaled so no rounding can let
/// a staker claim more than was released (see `math::earned`).
#[near(serializers = [borsh])]
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub struct Staker {
    pub staked: u128,
    pub snapshot: u128,
    pub pending: u128,
    /// Unstakes and claims whose callbacks have not run. Blocks `storage_unregister`.
    pub in_flight: u32,
}

#[near(serializers = [json])]
pub struct PoolView {
    pub pool: U128,
    pub released_total: U128,
    pub total_staked: U128,
    pub last_release_ns: U64,
    pub burn_pending: U128,
    pub burned_total: U128,
}

/// The whole mPOO and TOILET ledger, for audits and the public page.
#[near(serializers = [json])]
pub struct AccountingView {
    pub pool: U128,
    pub rewards_owed: U128,
    pub payouts_in_flight: U128,
    pub accounted: U128,
    pub acc_per_share: U128,
    pub total_staked: U128,
    pub unstakes_in_flight: U128,
    pub burn_pending: U128,
    pub burn_in_flight: U128,
    pub burned_total: U128,
    pub inflow_total: U128,
    pub funded_total: U128,
}

#[near(serializers = [json])]
pub struct StakerView {
    pub registered: bool,
    pub staked: U128,
    pub pending_rewards: U128,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub toilet: AccountId,
    pub mpoo: AccountId,
    pub board: AccountId,
    pub burn_account: AccountId,
    pub drip_bps: u32,
    pub exit_tax_bps: u32,
    pub day_ns: U64,
    pub acc_scale: U128,
    pub storage_min: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Staking {
    toilet: AccountId,
    mpoo: AccountId,
    board: AccountId,
    stakers: LookupMap<AccountId, Staker>,
    storage_bytes_per_staker: u64,

    total_staked: u128,
    /// mPOO waiting to be released.
    pool: u128,
    /// Scaled mPOO per staked unit. Wraps on overflow by design: only differences
    /// between it and a staker's `snapshot` are used, and those always fit.
    acc_per_share: u128,
    last_release_ns: u64,
    /// mPOO released and not yet confirmed paid out.
    rewards_owed: u128,
    /// Claims sent and not yet confirmed (a subset of `rewards_owed`).
    payouts_in_flight: u128,
    released_total: u128,

    /// Cumulative increases (`inflow_total`) and decreases (`outflow_total`) of
    /// `accounted`, wrapping. A balance read compares against them to ignore movements
    /// that happened while the read was in flight.
    inflow_total: u128,
    outflow_total: u128,
    /// mPOO announced through `ft_on_transfer` with `fund` (attribution only).
    funded_total: u128,

    unstakes_in_flight: u128,
    burn_pending: u128,
    burn_in_flight: u128,
    burned_total: u128,
}

#[near]
impl Staking {
    /// Runs once (`#[init]` refuses an initialised account). There is nothing else to set.
    #[init]
    pub fn new(toilet: AccountId, mpoo: AccountId, board: AccountId) -> Self {
        assert_ne!(toilet, mpoo, "TokensMustDiffer");
        let me = env::current_account_id();
        assert!(toilet != me && mpoo != me, "InvalidToken");
        let mut this = Self {
            toilet,
            mpoo,
            board,
            stakers: LookupMap::new(PREFIX_STAKERS),
            storage_bytes_per_staker: 0,
            total_staked: 0,
            pool: 0,
            acc_per_share: 0,
            last_release_ns: env::block_timestamp(),
            rewards_owed: 0,
            payouts_in_flight: 0,
            released_total: 0,
            inflow_total: 0,
            outflow_total: 0,
            funded_total: 0,
            unstakes_in_flight: 0,
            burn_pending: 0,
            burn_in_flight: 0,
            burned_total: 0,
        };
        this.measure_staker_storage();
        this
    }

    // ---------------------------------------------------------------- inflow (S3)

    /// Permissionless. Reads this contract's mPOO balance and adds anything new to the
    /// pool. The keeper calls it after each `distribute_mpoo`.
    pub fn sync_inflow(&mut self) -> Promise {
        assert!(env::prepaid_gas() >= SYNC_MIN_GAS, "InsufficientGas");
        self.balance_read()
    }

    /// Callback of the balance read. `inflow_at` / `outflow_at` are the counters when the
    /// read was scheduled.
    #[private]
    pub fn on_mpoo_balance(&mut self, inflow_at: U128, outflow_at: U128) {
        let balance = match env::promise_result_checked(0, 64) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes).ok(),
            Err(_) => None,
        };
        let Some(U128(balance)) = balance else {
            event("inflow_sync_failed", near_sdk::serde_json::json!({}));
            return;
        };
        self.release(env::block_timestamp());
        let accounted = self.accounted();
        // Movements of `accounted` since the read was scheduled may or may not be in the
        // balance we read. Take the widest legitimate range and act only outside it:
        // - above `high`: new mPOO arrived (board transfer, a fund, a donation);
        // - below `low`: something counted earlier is gone. That only happens when a
        //   transfer we saw in the balance was refunded before its `ft_on_transfer`
        //   finished (a refused or failed notification); take it back out of the pool.
        let since_out = self.outflow_total.wrapping_sub(outflow_at.0);
        let since_in = self.inflow_total.wrapping_sub(inflow_at.0);
        let high = accounted.saturating_add(since_out);
        let low = accounted
            .saturating_sub(self.payouts_in_flight)
            .saturating_sub(since_in);
        let mut added = 0;
        let mut removed = 0;
        if balance > high {
            added = (balance - high).min(MPOO_BOUND.saturating_sub(accounted));
            self.pool += added;
            self.inflow_total = self.inflow_total.wrapping_add(added);
        } else if balance < low {
            removed = (low - balance).min(self.pool);
            self.pool -= removed;
            self.outflow_total = self.outflow_total.wrapping_add(removed);
        }
        event(
            "inflow_synced",
            near_sdk::serde_json::json!({
                "board": self.board, "balance": U128(balance), "accounted": U128(accounted),
                "added": U128(added), "removed": U128(removed), "pool": U128(self.pool),
            }),
        );
    }

    /// NEP-141 receiver. TOILET with `stake` stakes; mPOO with `fund` funds the pool.
    /// Anything else is refused and returned in full.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        if token == self.toilet && msg == "stake" {
            return self.stake(sender_id, amount.0);
        }
        if token == self.mpoo && msg == "fund" {
            // The tokens are already in our balance. Count them through the same balance
            // read as every other inflow, so a sync that raced this notification and
            // already saw them cannot make us count them twice.
            self.funded_total = self.funded_total.saturating_add(amount.0);
            event(
                "pool_funded",
                near_sdk::serde_json::json!({"sender_id": sender_id, "amount": amount}),
            );
            self.balance_read().detach();
            return U128(0);
        }
        env::log_str("transfer_refused: UnsupportedTokenOrMessage");
        amount
    }

    // ---------------------------------------------------------------- unstake (S5)

    /// Unstake `amount` TOILET. 10% of it is burned, 90% is sent to the caller. Rewards
    /// stay claimable and are not taxed. 1 yoctoNEAR.
    #[payable]
    pub fn unstake(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        assert!(env::prepaid_gas() >= UNSTAKE_MIN_GAS, "InsufficientGas");
        let amount = amount.0;
        assert!(amount > 0, "ZeroAmount");
        self.release(env::block_timestamp());
        let account = env::predecessor_account_id();
        let mut staker = self.settled(&account);
        assert!(staker.staked >= amount, "InsufficientStake");
        staker.staked -= amount;
        staker.in_flight += 1;
        self.stakers.insert(account.clone(), staker);
        self.total_staked -= amount;
        self.unstakes_in_flight += amount;
        let (tax, net) = exit_tax(amount);
        ft_transfer(&self.toilet, &account, net).then(
            Self::ext(env::current_account_id())
                .with_static_gas(UNSTAKE_CALLBACK_GAS)
                .on_unstake(account, U128(amount), U128(net), U128(tax)),
        )
    }

    /// Net transfer settled. On success, burn the tax; on failure, restore the full
    /// `amount` to the stake and burn nothing.
    #[private]
    pub fn on_unstake(
        &mut self,
        account_id: AccountId,
        amount: U128,
        net: U128,
        tax: U128,
    ) -> bool {
        let ok = promise_succeeded();
        self.unstakes_in_flight -= amount.0;
        let mut staker = self
            .stakers
            .get(&account_id)
            .cloned()
            .expect("StakerInvariant");
        staker.in_flight -= 1;
        if ok {
            self.stakers.insert(account_id.clone(), staker);
            event(
                "unstaked",
                near_sdk::serde_json::json!({
                    "account_id": account_id, "amount": amount, "net": net, "tax_burned": tax
                }),
            );
            if tax.0 > 0 {
                self.send_burn(tax.0);
            }
        } else {
            // The stake was out of `total_staked` while in flight, so it earned nothing;
            // release up to now first so it does not earn retroactively either.
            self.release(env::block_timestamp());
            let acc = self.acc_per_share;
            let mut staker = settle(staker, acc);
            staker.staked += amount.0;
            self.stakers.insert(account_id.clone(), staker);
            self.total_staked += amount.0;
            event(
                "unstake_failed",
                near_sdk::serde_json::json!({
                    "account_id": account_id, "amount": amount, "restored": true
                }),
            );
        }
        ok
    }

    /// Permissionless: retry the burn of taxes whose burn transfer failed.
    pub fn flush_burn(&mut self) {
        assert!(env::prepaid_gas() >= FLUSH_MIN_GAS, "InsufficientGas");
        let amount = self.burn_pending;
        assert!(amount > 0, "NothingToBurn");
        self.burn_pending = 0;
        self.send_burn(amount);
    }

    #[private]
    pub fn on_burn(&mut self, amount: U128) -> bool {
        let ok = promise_succeeded();
        self.burn_in_flight -= amount.0;
        if ok {
            self.burned_total = self.burned_total.saturating_add(amount.0);
            event(
                "tax_burned",
                near_sdk::serde_json::json!({
                    "amount": amount, "burn_account": BURN_ACCOUNT,
                    "burned_total": U128(self.burned_total)
                }),
            );
        } else {
            self.burn_pending += amount.0;
            event(
                "burn_failed",
                near_sdk::serde_json::json!({
                    "amount": amount, "burn_pending": U128(self.burn_pending)
                }),
            );
        }
        ok
    }

    // ---------------------------------------------------------------- claim (S6)

    /// Send the caller's released mPOO. Does not touch the stake. 1 yoctoNEAR.
    #[payable]
    pub fn claim_rewards(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        assert!(env::prepaid_gas() >= CLAIM_MIN_GAS, "InsufficientGas");
        self.release(env::block_timestamp());
        let account = env::predecessor_account_id();
        let mut staker = self.settled(&account);
        let amount = staker.pending;
        assert!(amount > 0, "NothingToClaim");
        staker.pending = 0;
        staker.in_flight += 1;
        self.stakers.insert(account.clone(), staker);
        self.payouts_in_flight += amount;
        ft_transfer(&self.mpoo, &account, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_claim(account, U128(amount)),
        )
    }

    #[private]
    pub fn on_claim(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = promise_succeeded();
        self.payouts_in_flight -= amount.0;
        let mut staker = self
            .stakers
            .get(&account_id)
            .cloned()
            .expect("StakerInvariant");
        staker.in_flight -= 1;
        if ok {
            self.rewards_owed -= amount.0;
            self.outflow_total = self.outflow_total.wrapping_add(amount.0);
            event(
                "rewards_claimed",
                near_sdk::serde_json::json!({"account_id": account_id, "amount": amount}),
            );
        } else {
            staker.pending += amount.0;
            event(
                "claim_failed",
                near_sdk::serde_json::json!({
                    "account_id": account_id, "amount": amount, "restored": true
                }),
            );
        }
        self.stakers.insert(account_id, staker);
        ok
    }

    // ---------------------------------------------------------------- views (S7)

    /// Persisted values; a view cannot advance the release clock.
    pub fn get_pool(&self) -> PoolView {
        PoolView {
            pool: U128(self.pool),
            released_total: U128(self.released_total),
            total_staked: U128(self.total_staked),
            last_release_ns: U64(self.last_release_ns),
            burn_pending: U128(self.burn_pending),
            burned_total: U128(self.burned_total),
        }
    }

    pub fn get_accounting(&self) -> AccountingView {
        AccountingView {
            pool: U128(self.pool),
            rewards_owed: U128(self.rewards_owed),
            payouts_in_flight: U128(self.payouts_in_flight),
            accounted: U128(self.accounted()),
            acc_per_share: U128(self.acc_per_share),
            total_staked: U128(self.total_staked),
            unstakes_in_flight: U128(self.unstakes_in_flight),
            burn_pending: U128(self.burn_pending),
            burn_in_flight: U128(self.burn_in_flight),
            burned_total: U128(self.burned_total),
            inflow_total: U128(self.inflow_total),
            funded_total: U128(self.funded_total),
        }
    }

    /// Includes release up to the current block, without mutating anything.
    pub fn get_staker(&self, account_id: AccountId) -> StakerView {
        let Some(staker) = self.stakers.get(&account_id) else {
            return StakerView {
                registered: false,
                staked: U128(0),
                pending_rewards: U128(0),
            };
        };
        let (acc, _) = self.preview_release(env::block_timestamp());
        let settled = settle(staker.clone(), acc);
        StakerView {
            registered: true,
            staked: U128(settled.staked),
            pending_rewards: U128(settled.pending),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            toilet: self.toilet.clone(),
            mpoo: self.mpoo.clone(),
            board: self.board.clone(),
            burn_account: burn_account(),
            drip_bps: DRIP_BPS as u32,
            exit_tax_bps: EXIT_TAX_BPS as u32,
            day_ns: U64(DAY_NS),
            acc_scale: U128(ACC_SCALE),
            storage_min: U128(self.storage_min().as_yoctonear()),
        }
    }

    // ---------------------------------------------------------------- NEP-145

    /// Registers one fixed-size staker record. Min equals max; excess and duplicate
    /// deposits are refunded.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only; // min == max: every registration is registration-only.
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit();
        let min = self.storage_min();
        let refund = if self.stakers.contains_key(&account) {
            attached
        } else {
            assert!(attached >= min, "InsufficientStorageDeposit");
            self.stakers.insert(account.clone(), Staker::default());
            attached.saturating_sub(min)
        };
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
        self.storage_balance()
    }

    /// Nothing is ever available to withdraw (min equals max). 1 yoctoNEAR.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        assert!(self.stakers.contains_key(&account), "NotRegistered");
        assert!(amount.is_none_or(|a| a.is_zero()), "NothingToWithdraw");
        self.storage_balance()
    }

    /// Removes an empty record and refunds its deposit. Refuses (even with `force`) while
    /// the account has stake, unclaimed rewards or a transfer in flight: there is no
    /// path that forfeits a stake. 1 yoctoNEAR.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        near_sdk::assert_one_yocto();
        let _ = force;
        let account = env::predecessor_account_id();
        self.release(env::block_timestamp());
        let Some(_) = self.stakers.get(&account) else {
            return false;
        };
        let staker = self.settled(&account);
        assert!(
            staker.staked == 0 && staker.pending == 0 && staker.in_flight == 0,
            "AccountNotEmpty"
        );
        self.stakers.remove(&account);
        Promise::new(account).transfer(self.storage_min()).detach();
        true
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.stakers
            .contains_key(&account_id)
            .then(|| self.storage_balance())
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let min = self.storage_min();
        StorageBalanceBounds {
            min,
            max: Some(min),
        }
    }
}

impl Staking {
    fn accounted(&self) -> u128 {
        self.pool + self.rewards_owed
    }

    /// What `release(now)` would do: `(acc_per_share, charged)`.
    fn preview_release(&self, now: u64) -> (u128, u128) {
        let elapsed = now.saturating_sub(self.last_release_ns);
        if elapsed == 0 || self.total_staked == 0 || self.pool == 0 {
            return (self.acc_per_share, 0);
        }
        let release = drip(self.pool, elapsed);
        let (inc, charged) = split_release(release, self.total_staked);
        (self.acc_per_share.wrapping_add(inc), charged)
    }

    /// S2. Runs first in every state-changing call. With nobody staked the clock advances
    /// and nothing is released: the pool waits for stakers.
    pub(crate) fn release(&mut self, now: u64) {
        if now <= self.last_release_ns {
            return;
        }
        let (acc, charged) = self.preview_release(now);
        self.last_release_ns = now;
        if charged == 0 {
            return;
        }
        self.acc_per_share = acc;
        self.pool -= charged;
        self.rewards_owed += charged;
        self.released_total = self.released_total.saturating_add(charged);
    }

    /// The stored record brought up to the current accumulator. Panics if unregistered.
    fn settled(&self, account: &AccountId) -> Staker {
        let staker = self.stakers.get(account).cloned().expect("NotRegistered");
        settle(staker, self.acc_per_share)
    }

    fn stake(&mut self, sender: AccountId, amount: u128) -> U128 {
        if amount == 0 {
            return U128(0);
        }
        if !self.stakers.contains_key(&sender) {
            env::log_str("stake_refused: NotRegistered");
            return U128(amount);
        }
        self.release(env::block_timestamp());
        let mut staker = self.settled(&sender);
        staker.staked += amount;
        self.stakers.insert(sender.clone(), staker);
        self.total_staked += amount;
        event(
            "staked",
            near_sdk::serde_json::json!({
                "account_id": sender, "amount": U128(amount),
                "total_staked": U128(self.total_staked)
            }),
        );
        U128(0)
    }

    fn balance_read(&self) -> Promise {
        Promise::new(self.mpoo.clone())
            .function_call(
                "ft_balance_of",
                near_sdk::serde_json::to_vec(
                    &near_sdk::serde_json::json!({"account_id": env::current_account_id()}),
                )
                .expect("SerializationFailed"),
                NearToken::from_yoctonear(0),
                FT_BALANCE_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_mpoo_balance(U128(self.inflow_total), U128(self.outflow_total)),
            )
    }

    fn send_burn(&mut self, amount: u128) {
        self.burn_in_flight += amount;
        ft_transfer(&self.toilet, &burn_account(), amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_burn(U128(amount)),
            )
            .detach();
    }

    fn storage_min(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(u128::from(self.storage_bytes_per_staker))
    }

    fn storage_balance(&self) -> StorageBalance {
        StorageBalance {
            total: self.storage_min(),
            available: NearToken::from_yoctonear(0),
        }
    }

    /// Bytes one staker record costs, measured with the longest possible account id.
    fn measure_staker_storage(&mut self) {
        let before = env::storage_usage();
        let longest: AccountId = "a".repeat(64).parse().expect("valid account id");
        self.stakers.insert(longest.clone(), Staker::default());
        self.stakers.flush();
        self.storage_bytes_per_staker = env::storage_usage() - before;
        self.stakers.remove(&longest);
        self.stakers.flush();
    }
}

/// Credit what `staker` earned since its snapshot and move the snapshot to `acc`.
fn settle(mut staker: Staker, acc: u128) -> Staker {
    let delta = acc.wrapping_sub(staker.snapshot);
    let gained = earned(staker.staked, delta).expect("RewardInvariant");
    staker.pending = staker.pending.checked_add(gained).expect("RewardInvariant");
    staker.snapshot = acc;
    staker
}

fn ft_transfer(token: &AccountId, receiver: &AccountId, amount: u128) -> Promise {
    Promise::new(token.clone()).function_call(
        "ft_transfer",
        near_sdk::serde_json::to_vec(
            &near_sdk::serde_json::json!({"receiver_id": receiver, "amount": U128(amount)}),
        )
        .expect("SerializationFailed"),
        NearToken::from_yoctonear(1),
        FT_TRANSFER_GAS,
    )
}

/// A transfer succeeded unless its receipt failed. A result too long to read still
/// means the receipt ran (the board's rule, `revenue.rs`).
fn promise_succeeded() -> bool {
    env::promise_results_count() > 0
        && !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        )
}

pub fn burn_account() -> AccountId {
    BURN_ACCOUNT.parse().expect("valid implicit account")
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    let value = near_sdk::serde_json::json!({
        "standard": "toilet_staking", "version": "1.0.0", "event": name, "data": [data]
    });
    env::log_str(&format!("EVENT_JSON:{value}"));
}

#[cfg(test)]
mod tests;
