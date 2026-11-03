//! Unit tests in the mocked NEAR runtime. Cross-contract calls are inspected as created
//! receipts and their outcomes are fed back to the callbacks by hand, in the order the
//! test chooses; that is how the races are exercised. The sandbox simulation with the
//! real board and token wasm lives in `sim/`.
use super::*;
use crate::math::{DAY_NS, MPOO_BOUND};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const T: u128 = 1_000_000_000_000_000_000; // one token, 18 decimals

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    id("staking.near")
}
fn toilet() -> AccountId {
    id("toilet.near")
}
fn mpoo() -> AccountId {
    id("mpoo.near")
}
fn board() -> AccountId {
    id("board.near")
}
fn alice() -> AccountId {
    id("alice.near")
}
fn bob() -> AccountId {
    id("bob.near")
}

fn ctx_full(caller: AccountId, ts: u64, deposit: u128, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(me())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(100))
            .block_timestamp(ts)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn ctx(caller: AccountId, ts: u64, deposit: u128) {
    ctx_full(caller, ts, deposit, vec![]);
}
fn callback(ts: u64, result: PromiseResult) {
    ctx_full(me(), ts, 0, vec![result]);
}
fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

/// Each function call created in the current context: (receiver, method, args).
fn calls() -> Vec<(AccountId, String, near_sdk::serde_json::Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } => Some((
                    receiver.clone(),
                    String::from_utf8(method_name).unwrap(),
                    near_sdk::serde_json::from_slice(&args).unwrap_or_default(),
                )),
                _ => None,
            })
        })
        .collect()
}
fn has_event(name: &str) -> bool {
    get_logs()
        .iter()
        .any(|l| l.contains(&format!("\"event\":\"{name}\"")))
}

/// The mocked contract plus the chain facts a real run would have: our mPOO balance on
/// the token, and the clock.
struct World {
    c: Staking,
    mpoo_balance: u128,
}

impl World {
    fn new() -> Self {
        ctx(id("deployer.near"), 0, 0);
        let c = Staking::new(toilet(), mpoo(), board());
        World { c, mpoo_balance: 0 }
    }
    fn register(&mut self, who: AccountId) {
        let min = self.c.storage_balance_bounds().min.as_yoctonear();
        ctx(who.clone(), 0, min);
        self.c.storage_deposit(None, None);
    }
    fn stake(&mut self, who: AccountId, amount: u128, ts: u64) -> u128 {
        ctx(toilet(), ts, 0);
        self.c.ft_on_transfer(who, U128(amount), "stake".into()).0
    }
    /// A balance read scheduled now; returns the counters it carries.
    fn start_sync(&mut self, ts: u64) -> (U128, U128) {
        ctx(id("keeper.near"), ts, 0);
        let _ = self.c.sync_inflow();
        let (_, method, args) = calls()
            .into_iter()
            .find(|(_, m, _)| m == "on_mpoo_balance")
            .expect("callback scheduled");
        assert_eq!(method, "on_mpoo_balance");
        (
            U128(args["inflow_at"].as_str().unwrap().parse().unwrap()),
            U128(args["outflow_at"].as_str().unwrap().parse().unwrap()),
        )
    }
    fn finish_sync(&mut self, at: (U128, U128), balance_read: u128, ts: u64) {
        let bytes = near_sdk::serde_json::to_vec(&U128(balance_read)).unwrap();
        callback(ts, PromiseResult::Successful(bytes));
        self.c.on_mpoo_balance(at.0, at.1);
    }
    fn sync(&mut self, ts: u64) {
        let at = self.start_sync(ts);
        self.finish_sync(at, self.mpoo_balance, ts);
    }
    /// The board's plain `ft_transfer` of the stakers' share, then the keeper's sync.
    fn board_pays(&mut self, amount: u128, ts: u64) {
        self.mpoo_balance += amount;
        self.sync(ts);
    }
    fn view(&self, who: AccountId, ts: u64) -> StakerView {
        ctx(id("viewer.near"), ts, 0);
        self.c.get_staker(who)
    }
    fn pending(&self, who: AccountId, ts: u64) -> u128 {
        self.view(who, ts).pending_rewards.0
    }
    fn staked(&self, who: AccountId) -> u128 {
        self.c.stakers.get(&who).map_or(0, |s| s.staked)
    }
    /// Claim and confirm (or fail) the payout. Returns the amount sent.
    fn claim(&mut self, who: AccountId, ts: u64, succeed: bool) -> u128 {
        ctx(who.clone(), ts, 1);
        let _ = self.c.claim_rewards();
        let (receiver, method, args) = calls().into_iter().next().unwrap();
        assert_eq!((receiver, method.as_str()), (mpoo(), "ft_transfer"));
        assert_eq!(args["receiver_id"], who.to_string());
        let amount: u128 = args["amount"].as_str().unwrap().parse().unwrap();
        if succeed {
            self.mpoo_balance -= amount;
            callback(ts, ok());
        } else {
            callback(ts, PromiseResult::Failed);
        }
        assert_eq!(self.c.on_claim(who, U128(amount)), succeed);
        amount
    }
    /// Start an unstake; returns (net sent, tax) from the scheduled receipts.
    fn start_unstake(&mut self, who: AccountId, amount: u128, ts: u64) -> (u128, u128) {
        ctx(who.clone(), ts, 1);
        let _ = self.c.unstake(U128(amount));
        let calls = calls();
        let (receiver, method, args) = &calls[0];
        assert_eq!((receiver, method.as_str()), (&toilet(), "ft_transfer"));
        assert_eq!(args["receiver_id"], who.to_string());
        let net: u128 = args["amount"].as_str().unwrap().parse().unwrap();
        let cb = &calls[1].2;
        assert_eq!(calls[1].1, "on_unstake");
        let tax: u128 = cb["tax"].as_str().unwrap().parse().unwrap();
        (net, tax)
    }
    /// Invariants that must hold between any two calls.
    fn check(&self, accounts: &[AccountId], ts: u64) {
        let accounted = self.c.pool + self.c.rewards_owed;
        let claimable: u128 = accounts.iter().map(|a| self.pending(a.clone(), ts)).sum();
        // What stakers can claim, plus what is on its way to them, never exceeds what
        // was released and not yet paid; and nothing is promised that is not held.
        let (_, charged) = self.c.preview_release(ts);
        assert!(claimable + self.c.payouts_in_flight <= self.c.rewards_owed + charged);
        assert!(accounted <= self.mpoo_balance + self.c.payouts_in_flight);
    }
}

// ------------------------------------------------------------------ release (S2)

#[test]
fn release_is_ten_percent_per_whole_day() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    w.board_pays(1_000 * T, 0);
    assert_eq!(w.pending(alice(), DAY_NS), 100 * T);
    w.sync(DAY_NS);
    assert_eq!(w.c.get_pool().pool, U128(900 * T));
    assert_eq!(w.c.get_pool().released_total, U128(100 * T));
    assert_eq!(w.pending(alice(), 3 * DAY_NS), 100 * T + 90 * T + 81 * T);
    w.sync(3 * DAY_NS);
    assert_eq!(w.c.pool, 729 * T);
    w.check(&[alice()], 3 * DAY_NS);
}

#[test]
fn partial_day_releases_proportionally() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    w.board_pays(1_000 * T, 0);
    assert_eq!(w.pending(alice(), DAY_NS / 2), 50 * T);
    assert_eq!(w.pending(alice(), DAY_NS / 4), 25 * T);
    // 1.5 days in one release: 100, then 900 × ½ ÷ 10 = 45.
    assert_eq!(w.pending(alice(), DAY_NS + DAY_NS / 2), 145 * T);
    // Released in two steps it compounds on the smaller pool, never more.
    w.sync(DAY_NS / 2);
    assert_eq!(w.c.pool, 950 * T);
    assert!(w.pending(alice(), DAY_NS + DAY_NS / 2) <= 145 * T);
}

#[test]
fn nothing_releases_with_no_stakers() {
    let mut w = World::new();
    w.board_pays(1_000 * T, 0);
    w.sync(5 * DAY_NS);
    let pool = w.c.get_pool();
    assert_eq!(pool.pool, U128(1_000 * T));
    assert_eq!(pool.released_total, U128(0));
    assert_eq!(pool.last_release_ns, U64(5 * DAY_NS));
    // The pool waited: the first staker gets the drip from when they staked, not before.
    w.register(alice());
    w.stake(alice(), 10 * T, 5 * DAY_NS);
    assert_eq!(w.pending(alice(), 5 * DAY_NS), 0);
    assert_eq!(w.pending(alice(), 6 * DAY_NS), 100 * T);
}

#[test]
fn release_never_exceeds_the_pool() {
    let mut w = World::new();
    let people = [alice(), bob(), id("carol.near")];
    for p in &people {
        w.register(p.clone());
    }
    // Awkward stakes so every division leaves a remainder.
    w.stake(alice(), 3, 0);
    w.stake(bob(), 7 * T + 1, 0);
    w.stake(id("carol.near"), 13, 0);
    w.board_pays(1_000 * T + 17, 0);
    let start = w.c.pool;
    let mut ts = 0;
    // Releases at irregular intervals, with claims in between.
    for (i, step) in [
        1u64,
        999,
        DAY_NS / 3,
        7,
        DAY_NS,
        3 * DAY_NS + 11,
        1,
        400 * DAY_NS,
    ]
    .into_iter()
    .enumerate()
    {
        ts += step;
        w.sync(ts);
        assert!(w.c.released_total <= start);
        assert_eq!(w.c.pool + w.c.released_total, start);
        w.check(&people, ts);
        let who = people[i % 3].clone();
        if w.pending(who.clone(), ts) > 0 {
            w.claim(who, ts, true);
        }
        w.check(&people, ts);
    }
    // Nobody can be paid more than the pool held.
    let paid = start - w.c.pool - w.c.rewards_owed;
    assert!(paid <= start);
    // The cap path: a 400-day gap releases everything but dust, and never more.
    assert!(w.c.pool < start / 1_000_000);
    // Splitting a day into many releases never beats one release over the day.
    let single = math::drip(start, DAY_NS);
    let mut pool = start;
    for _ in 0..24 {
        pool -= math::drip(pool, DAY_NS / 24);
    }
    assert!(start - pool <= single);
}

#[test]
fn inflow_above_the_bound_is_left_unaccounted() {
    let mut w = World::new();
    w.board_pays(MPOO_BOUND + 5, 0);
    assert_eq!(w.c.pool, MPOO_BOUND);
    w.check(&[], 0);
}

// ------------------------------------------------------------------ pro rata

#[test]
fn rewards_split_pro_rata_by_stake() {
    let mut w = World::new();
    w.register(alice());
    w.register(bob());
    w.stake(alice(), 100 * T, 0);
    w.stake(bob(), 300 * T, 0);
    w.board_pays(1_000 * T, 0);
    assert_eq!(w.pending(alice(), DAY_NS), 25 * T);
    assert_eq!(w.pending(bob(), DAY_NS), 75 * T);
    w.check(&[alice(), bob()], DAY_NS);
}

#[test]
fn late_staker_gets_nothing_released_before_they_staked() {
    let mut w = World::new();
    w.register(alice());
    w.register(bob());
    w.stake(alice(), 100 * T, 0);
    w.board_pays(1_000 * T, 0);
    // Bob stakes after one day: day one is Alice's alone.
    assert_eq!(w.stake(bob(), 100 * T, DAY_NS), 0);
    assert_eq!(w.pending(bob(), DAY_NS), 0);
    assert_eq!(w.pending(alice(), DAY_NS), 100 * T);
    // Day two (90) is split evenly.
    assert_eq!(w.pending(bob(), 2 * DAY_NS), 45 * T);
    assert_eq!(w.pending(alice(), 2 * DAY_NS), 145 * T);
}

// ------------------------------------------------------------------ inflow (S3)

#[test]
fn sync_inflow_adds_only_new_mpoo() {
    let mut w = World::new();
    w.board_pays(700, 0);
    assert_eq!(w.c.pool, 700);
    w.sync(1);
    w.sync(2);
    assert_eq!(w.c.pool, 700);
    w.board_pays(300, 3);
    assert_eq!(w.c.pool, 1_000);
    assert!(has_event("inflow_synced"));
    // Released and unclaimed rewards are accounted too: a sync never re-adds them.
    w.register(alice());
    w.stake(alice(), 1_000, 3);
    w.sync(3 + DAY_NS);
    assert_eq!(w.c.pool, 900);
    assert_eq!(w.c.rewards_owed, 100);
    w.sync(3 + DAY_NS);
    assert_eq!(w.c.pool + w.c.rewards_owed, 1_000);
}

#[test]
fn sync_and_payout_race_does_not_double_count() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), T, 0);
    w.board_pays(1_000 * T, 0);
    let ts = DAY_NS;

    // Race 1: the balance is read before the payout leaves, and the payout is confirmed
    // before the read comes back. The stale balance still holds the payout.
    let at = w.start_sync(ts);
    let stale = w.mpoo_balance;
    let paid = w.claim(alice(), ts, true);
    assert_eq!(paid, 100 * T);
    w.finish_sync(at, stale, ts);
    assert_eq!(
        w.c.pool,
        900 * T,
        "a confirmed payout is not counted as inflow"
    );
    w.check(&[alice()], ts);

    // Race 2: the payout leaves, the balance is read, and the read returns before the
    // payout's callback. The lower balance is not mistaken for a loss.
    let ts = 2 * DAY_NS;
    ctx(alice(), ts, 1);
    let _ = w.c.claim_rewards();
    let amount = w.c.payouts_in_flight;
    assert_eq!(amount, 90 * T);
    w.mpoo_balance -= amount; // the transfer executed on the token
    w.sync(ts);
    assert_eq!(w.c.pool, 810 * T, "an in-flight payout is not a deficit");
    callback(ts, ok());
    w.c.on_claim(alice(), U128(amount));
    w.sync(ts);
    assert_eq!(w.c.pool, 810 * T);
    w.check(&[alice()], ts);

    // Race 3: two reads in flight, the board's transfer lands between them.
    let first = w.start_sync(ts);
    let before = w.mpoo_balance;
    w.mpoo_balance += 50 * T;
    let second = w.start_sync(ts);
    w.finish_sync(second, w.mpoo_balance, ts);
    assert_eq!(w.c.pool, 860 * T);
    w.finish_sync(first, before, ts);
    assert_eq!(
        w.c.pool,
        860 * T,
        "an older read cannot undo a newer inflow"
    );
    w.check(&[alice()], ts);
}

#[test]
fn a_refunded_transfer_seen_by_a_sync_is_taken_back_out() {
    // Someone sends mPOO with a message we refuse. Between the token crediting us and
    // refunding them, a sync reads the balance and counts it.
    let mut w = World::new();
    w.board_pays(100 * T, 0);
    w.mpoo_balance += 40 * T;
    w.sync(1);
    assert_eq!(w.c.pool, 140 * T);
    ctx(mpoo(), 1, 0);
    assert_eq!(
        w.c.ft_on_transfer(bob(), U128(40 * T), "nope".into()),
        U128(40 * T)
    );
    w.mpoo_balance -= 40 * T; // the token refunds bob
    w.sync(2);
    assert_eq!(w.c.pool, 100 * T);
    w.check(&[], 2);
}

#[test]
fn fund_message_adds_to_the_pool() {
    let mut w = World::new();
    // The token credits us, then notifies us.
    w.mpoo_balance += 250 * T;
    ctx(mpoo(), 10, 0);
    assert_eq!(
        w.c.ft_on_transfer(bob(), U128(250 * T), "fund".into()),
        U128(0)
    );
    assert!(has_event("pool_funded"));
    let calls = calls();
    assert_eq!(
        (calls[0].0.clone(), calls[0].1.as_str()),
        (mpoo(), "ft_balance_of")
    );
    assert_eq!(calls[0].2["account_id"], me().to_string());
    let at = (
        U128(calls[1].2["inflow_at"].as_str().unwrap().parse().unwrap()),
        U128(calls[1].2["outflow_at"].as_str().unwrap().parse().unwrap()),
    );
    w.finish_sync(at, w.mpoo_balance, 10);
    assert_eq!(w.c.pool, 250 * T);
    assert_eq!(w.c.funded_total, 250 * T);
    // A sync that had already seen the funded tokens does not count them again.
    w.sync(11);
    assert_eq!(w.c.pool, 250 * T);
}

#[test]
fn stake_from_the_wrong_token_is_refused() {
    let mut w = World::new();
    w.register(alice());
    ctx(mpoo(), 0, 0);
    assert_eq!(
        w.c.ft_on_transfer(alice(), U128(5), "stake".into()),
        U128(5)
    );
    ctx(id("fake-toilet.near"), 0, 0);
    assert_eq!(
        w.c.ft_on_transfer(alice(), U128(5), "stake".into()),
        U128(5)
    );
    ctx(toilet(), 0, 0);
    assert_eq!(w.c.ft_on_transfer(alice(), U128(5), "fund".into()), U128(5));
    assert_eq!(w.c.ft_on_transfer(alice(), U128(5), "".into()), U128(5));
    // Staking without storage is refused too.
    assert_eq!(w.c.ft_on_transfer(bob(), U128(5), "stake".into()), U128(5));
    assert_eq!(w.c.total_staked, 0);
    assert_eq!(w.stake(alice(), 5, 0), 0);
    assert_eq!(w.c.total_staked, 5);
}

// ------------------------------------------------------------------ unstake (S5)

#[test]
fn unstake_burns_ten_percent_of_the_amount() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    let (net, tax) = w.start_unstake(alice(), 100 * T, 1);
    assert_eq!((net, tax), (90 * T, 10 * T));
    assert_eq!(w.c.total_staked, 0);
    callback(1, ok());
    assert!(w.c.on_unstake(alice(), U128(100 * T), U128(net), U128(tax)));
    assert!(has_event("unstaked"));
    let burn = calls();
    assert_eq!(
        (burn[0].0.clone(), burn[0].1.as_str()),
        (toilet(), "ft_transfer")
    );
    assert_eq!(burn[0].2["receiver_id"], BURN_ACCOUNT);
    assert_eq!(burn[0].2["amount"], (10 * T).to_string());
    assert_eq!(w.c.burn_in_flight, 10 * T);
    callback(1, ok());
    assert!(w.c.on_burn(U128(10 * T)));
    assert!(has_event("tax_burned"));
    let pool = w.c.get_pool();
    assert_eq!(
        (pool.burned_total, pool.burn_pending),
        (U128(10 * T), U128(0))
    );
    assert_eq!(w.c.burn_in_flight, 0);
    // An odd amount: the tax rounds down and tax + net is exact.
    w.stake(alice(), 19, 2);
    assert_eq!(w.start_unstake(alice(), 19, 2), (18, 1));
}

#[test]
fn partial_unstake_taxes_only_what_comes_out() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 1_000 * T, 0);
    w.board_pays(1_000 * T, 0);
    let (net, tax) = w.start_unstake(alice(), 300 * T, DAY_NS);
    assert_eq!((net, tax), (270 * T, 30 * T));
    assert_eq!(w.staked(alice()), 700 * T);
    callback(DAY_NS, ok());
    w.c.on_unstake(alice(), U128(300 * T), U128(net), U128(tax));
    // Rewards are untouched by the tax and stay claimable.
    assert_eq!(w.pending(alice(), DAY_NS), 100 * T);
    assert_eq!(w.claim(alice(), DAY_NS, true), 100 * T);
    // An unstake beyond the stake is refused.
    ctx(alice(), DAY_NS, 1);
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = w.c.unstake(U128(700 * T + 1));
    }));
    assert!(refused.is_err());
}

#[test]
fn failed_unstake_transfer_restores_the_full_stake_and_burns_nothing() {
    let mut w = World::new();
    w.register(alice());
    w.register(bob());
    w.stake(alice(), 100 * T, 0);
    w.stake(bob(), 100 * T, 0);
    w.board_pays(1_000 * T, 0);
    let (net, tax) = w.start_unstake(alice(), 100 * T, DAY_NS);
    // While it is in flight Alice's stake earns nothing; Bob gets the whole release.
    callback(2 * DAY_NS, PromiseResult::Failed);
    assert!(!w.c.on_unstake(alice(), U128(100 * T), U128(net), U128(tax)));
    assert!(has_event("unstake_failed"));
    assert!(calls().is_empty(), "no burn is scheduled");
    assert_eq!(w.staked(alice()), 100 * T);
    assert_eq!(w.c.total_staked, 200 * T);
    assert_eq!(w.c.unstakes_in_flight, 0);
    let pool = w.c.get_pool();
    assert_eq!((pool.burned_total, pool.burn_pending), (U128(0), U128(0)));
    assert_eq!(w.pending(alice(), 2 * DAY_NS), 50 * T);
    assert_eq!(w.pending(bob(), 2 * DAY_NS), 50 * T + 90 * T);
    // And the restored stake earns again from now.
    assert_eq!(w.pending(alice(), 3 * DAY_NS), 50 * T + 81 * T / 2);
    w.check(&[alice(), bob()], 3 * DAY_NS);
}

#[test]
fn failed_burn_goes_to_burn_pending_and_flushes() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    let (net, tax) = w.start_unstake(alice(), 50 * T, 1);
    callback(1, ok());
    w.c.on_unstake(alice(), U128(50 * T), U128(net), U128(tax));
    callback(1, PromiseResult::Failed);
    assert!(!w.c.on_burn(U128(tax)));
    assert!(has_event("burn_failed"));
    assert_eq!(w.c.get_pool().burn_pending, U128(5 * T));
    // Anyone may retry.
    ctx(id("anyone.near"), 2, 0);
    w.c.flush_burn();
    assert_eq!(w.c.burn_pending, 0);
    let burn = calls();
    assert_eq!(burn[0].2["receiver_id"], BURN_ACCOUNT);
    assert_eq!(burn[0].2["amount"], (5 * T).to_string());
    callback(2, ok());
    assert!(w.c.on_burn(U128(5 * T)));
    assert_eq!(w.c.get_pool().burned_total, U128(5 * T));
    // Nothing left to flush.
    ctx(id("anyone.near"), 3, 0);
    let empty = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.c.flush_burn()));
    assert!(empty.is_err());
}

// ------------------------------------------------------------------ claim (S6)

#[test]
fn claim_without_unstake() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    w.board_pays(1_000 * T, 0);
    assert_eq!(w.claim(alice(), DAY_NS, true), 100 * T);
    assert!(has_event("rewards_claimed"));
    assert_eq!(w.staked(alice()), 100 * T);
    assert_eq!(w.c.rewards_owed, 0);
    assert_eq!(w.pending(alice(), DAY_NS), 0);
    // Unstaking does not claim.
    w.start_unstake(alice(), 10 * T, 2 * DAY_NS);
    assert_eq!(w.c.stakers.get(&alice()).unwrap().pending, 90 * T);
}

#[test]
fn failed_claim_restores_pending() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    w.board_pays(1_000 * T, 0);
    assert_eq!(w.claim(alice(), DAY_NS, false), 100 * T);
    assert!(has_event("claim_failed"));
    assert_eq!(w.pending(alice(), DAY_NS), 100 * T);
    assert_eq!(w.c.rewards_owed, 100 * T);
    assert_eq!(w.c.payouts_in_flight, 0);
    // A failed payout is not inflow either.
    w.sync(DAY_NS);
    assert_eq!(w.c.pool, 900 * T);
    assert_eq!(w.claim(alice(), DAY_NS, true), 100 * T);
    w.check(&[alice()], DAY_NS);
}

// ------------------------------------------------------------------ guards, storage

#[test]
fn claim_and_unstake_need_one_yocto_and_registration() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), T, 0);
    for deposit in [0, 2] {
        ctx(alice(), 1, deposit);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = w.c.unstake(U128(1));
        }))
        .is_err());
        ctx(alice(), 1, deposit);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = w.c.claim_rewards();
        }))
        .is_err());
    }
    ctx(bob(), 1, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = w.c.unstake(U128(1));
    }))
    .is_err());
}

#[test]
fn storage_registration_is_fixed_and_refunds_excess() {
    let mut w = World::new();
    let bounds = w.c.storage_balance_bounds();
    assert_eq!(bounds.max, Some(bounds.min));
    // 69-byte key ("s" + borsh of a 64-char id) + 52-byte record + 40 bytes trie overhead,
    // at 10^19 yoctoNEAR a byte: 0.00161 NEAR.
    assert_eq!(bounds.min.as_yoctonear(), 161 * 10u128.pow(19));
    ctx(alice(), 0, bounds.min.as_yoctonear() + 5);
    w.c.storage_deposit(None, None);
    assert!(get_created_receipts()
        .iter()
        .any(|r| r.receiver_id == alice()));
    assert!(w.c.storage_balance_of(alice()).is_some());
    // Too little is refused.
    ctx(bob(), 0, bounds.min.as_yoctonear() - 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.c.storage_deposit(None, None);
    }))
    .is_err());
}

#[test]
fn unregister_refuses_while_anything_is_held() {
    let mut w = World::new();
    w.register(alice());
    w.stake(alice(), 100 * T, 0);
    ctx(alice(), 1, 1);
    let held = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.c.storage_unregister(Some(true))
    }));
    assert!(held.is_err(), "force does not forfeit a stake");
    let (net, tax) = w.start_unstake(alice(), 100 * T, 2);
    ctx(alice(), 2, 1);
    let in_flight = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.c.storage_unregister(None)
    }));
    assert!(in_flight.is_err(), "an unstake in flight keeps the record");
    callback(2, ok());
    w.c.on_unstake(alice(), U128(100 * T), U128(net), U128(tax));
    ctx(alice(), 3, 1);
    assert!(w.c.storage_unregister(None));
    assert!(w.c.storage_balance_of(alice()).is_none());
}

#[test]
fn config_is_fixed_at_new() {
    let w = World::new();
    let c = w.c.get_config();
    assert_eq!((c.toilet, c.mpoo, c.board), (toilet(), mpoo(), board()));
    assert_eq!((c.drip_bps, c.exit_tax_bps), (1_000, 1_000));
    assert_eq!(c.burn_account.as_str(), BURN_ACCOUNT);
}

#[test]
fn many_stakers_never_claim_more_than_was_released() {
    // A deterministic pseudo-random walk over stakes, unstakes, claims and inflows.
    let mut w = World::new();
    let people: Vec<AccountId> = (0..5).map(|i| id(&format!("p{i}.near"))).collect();
    for p in &people {
        w.register(p.clone());
    }
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut ts = 0u64;
    let mut paid_out = 0u128;
    let mut paid_in = 0u128;
    for _ in 0..400 {
        ts += next() % (DAY_NS / 3);
        let who = people[(next() % 5) as usize].clone();
        match next() % 4 {
            0 => {
                let amount = u128::from(next() % 1_000_000) * 1_000_003 + 1;
                w.stake(who, amount, ts);
            }
            1 => {
                let staked = w.staked(who.clone());
                if staked > 0 {
                    let amount = u128::from(next()) % staked + 1;
                    let (net, tax) = w.start_unstake(who.clone(), amount, ts);
                    callback(ts, ok());
                    w.c.on_unstake(who, U128(amount), U128(net), U128(tax));
                }
            }
            2 => {
                if w.pending(who.clone(), ts) > 0 {
                    let succeed = next() % 5 != 0;
                    let amount = w.claim(who, ts, succeed);
                    if succeed {
                        paid_out += amount;
                    }
                }
            }
            _ => {
                let amount = u128::from(next() % 1_000_000_007);
                paid_in += amount;
                w.board_pays(amount, ts);
            }
        }
        w.check(&people, ts);
    }
    assert!(paid_out <= paid_in);
    assert_eq!(w.c.pool + w.c.rewards_owed + paid_out, paid_in);
}
