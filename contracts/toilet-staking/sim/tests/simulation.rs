//! Workspace simulation (spec §S tests, last item): the real paid board and the real
//! TOILET token wasm, in a local NEAR sandbox.
//!
//! board `distribute_mpoo` → staking `sync_inflow` → time passes → two stakers claim and
//! unstake, with every amount asserted exactly against chain timestamps.
//!
//! mPOO is NEARLY's token and its wasm is not in this repository. A second instance of
//! the TOILET wasm with every tax at zero stands in for it: a plain NEP-141 with
//! `ft_transfer`, `ft_transfer_call`, `ft_balance_of` and NEP-145 storage.
//!
//! `set_staking_contract` is called here, on a throwaway sandbox board, because the board
//! forwards nothing without it. It is never called on a real board by this work order.
//!
//! The test builds the three wasm files itself with `cargo build --release --target
//! wasm32-unknown-unknown`, and near-workspaces downloads the sandbox binary on first run.
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const T: u128 = 1_000_000_000_000_000_000;
const BURN: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const DAY_NS: u128 = 86_400_000_000_000;
const ACC_SCALE: u128 = 100_000_000_000;

fn build(crate_dir: &str, wasm_name: &str) -> anyhow::Result<Vec<u8>> {
    let dir: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(crate_dir);
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let status = Command::new(cargo)
        .args([
            "build",
            "--locked",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
        ])
        .current_dir(&dir)
        // Each crate keeps its own target directory, as CI builds them.
        .env_remove("CARGO_TARGET_DIR")
        .status()?;
    anyhow::ensure!(status.success(), "building {crate_dir} failed");
    Ok(std::fs::read(
        dir.join("target/wasm32-unknown-unknown/release")
            .join(wasm_name),
    )?)
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().expect("decimal string").parse().expect("u128")
}

async fn account(worker: &Worker<Sandbox>, name: &str) -> anyhow::Result<Account> {
    Ok(worker
        .root_account()?
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(30))
        .transact()
        .await?
        .into_result()?)
}

async fn deploy(worker: &Worker<Sandbox>, name: &str, wasm: &[u8]) -> anyhow::Result<Contract> {
    let acc = account(worker, name).await?;
    Ok(acc.deploy(wasm).await?.into_result()?)
}

async fn call(
    who: &Account,
    contract: &near_workspaces::AccountId,
    method: &str,
    args: Value,
    deposit: u128,
    tgas: u64,
) -> anyhow::Result<()> {
    let out = who
        .call(contract, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?;
    anyhow::ensure!(out.is_success(), "{method} failed: {:?}", out.failures());
    anyhow::ensure!(
        out.receipt_failures().is_empty(),
        "{method} had failed receipts: {:?}",
        out.receipt_failures()
    );
    eprintln!(
        "gas: {method} on {contract}: {} Tgas burnt",
        out.total_gas_burnt.as_tgas()
    );
    Ok(())
}

async fn view(contract: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

async fn balance(token: &Contract, who: &str) -> anyhow::Result<u128> {
    Ok(u128_of(
        &view(token, "ft_balance_of", json!({"account_id": who})).await?,
    ))
}

async fn register(token: &Contract, payer: &Account, who: &str) -> anyhow::Result<()> {
    let min = u128_of(&view(token, "storage_balance_bounds", json!({})).await?["min"]);
    call(
        payer,
        token.id(),
        "storage_deposit",
        json!({"account_id": who}),
        min,
        30,
    )
    .await?;
    Ok(())
}

/// Independent reference for a release shorter than a day (spec S2, partial day).
fn partial_release(pool: u128, elapsed: u128) -> u128 {
    assert!(
        elapsed < DAY_NS,
        "the simulation keeps each step under a day"
    );
    pool * elapsed / (10 * DAY_NS)
}
/// `(acc increment, charged)` exactly as specified in the README.
fn split(release: u128, total: u128) -> (u128, u128) {
    let inc = release * ACC_SCALE / total;
    let product = inc * total;
    (inc, product.div_ceil(ACC_SCALE))
}

async fn last_release(staking: &Contract) -> anyhow::Result<u128> {
    Ok(u128_of(
        &view(staking, "get_pool", json!({})).await?["last_release_ns"],
    ))
}

#[tokio::test]
async fn distribute_sync_drip_claim_unstake() -> anyhow::Result<()> {
    let token_wasm = build("contracts/toilet", "metapoo_toilet.wasm")?;
    let board_wasm = build("contracts/paid-board", "metapoo_paid_board.wasm")?;
    let staking_wasm = build("contracts/toilet-staking", "metapoo_toilet_staking.wasm")?;

    let worker = near_workspaces::sandbox().await?;
    let minter = account(&worker, "minter").await?;
    let owner = account(&worker, "owner").await?;
    let team = account(&worker, "team").await?;
    let buyback = account(&worker, "buyback").await?;
    let keeper = account(&worker, "keeper").await?;
    let alice = account(&worker, "alice").await?;
    let bob = account(&worker, "bob").await?;

    let tax = |treasury: &Account| {
        json!({"buy_bps": 0, "sell_bps": 0, "exchange": "exchange.test.near",
               "treasury": treasury.id(), "burn_bps": 10_000, "treasury_bps": 0, "exempt": []})
    };
    let mpoo = deploy(&worker, "mpoo", &token_wasm).await?;
    call(
        &minter,
        mpoo.id(),
        "new",
        json!({"emitter": minter.id(), "tax": tax(&team)}),
        0,
        50,
    )
    .await?;
    let toilet = deploy(&worker, "toilet", &token_wasm).await?;
    call(
        &minter,
        toilet.id(),
        "new",
        json!({"emitter": minter.id(), "tax": tax(&team)}),
        0,
        50,
    )
    .await?;
    let board = deploy(&worker, "board", &board_wasm).await?;
    call(
        &owner,
        board.id(),
        "new",
        json!({"mpoo_token": mpoo.id(), "mpoo_per_credit": "1",
               "team_account": team.id(), "buyback_account": buyback.id()}),
        0,
        100,
    )
    .await?;
    let staking = deploy(&worker, "staking", &staking_wasm).await?;
    call(
        &keeper,
        staking.id(),
        "new",
        json!({"toilet": toilet.id(), "mpoo": mpoo.id(), "board": board.id()}),
        0,
        50,
    )
    .await?;

    // The deploy procedure's registrations (README): the staking contract on both
    // tokens, the burn address on both, the board and the team on mPOO.
    for who in [
        board.id().as_str(),
        buyback.id().as_str(),
        staking.id().as_str(),
        BURN,
        alice.id().as_str(),
        bob.id().as_str(),
    ] {
        register(&mpoo, &owner, who).await?;
    }
    for who in [
        staking.id().as_str(),
        BURN,
        alice.id().as_str(),
        bob.id().as_str(),
    ] {
        register(&toilet, &owner, who).await?;
    }
    for who in [&alice, &bob] {
        let min = u128_of(&view(&staking, "storage_balance_bounds", json!({})).await?["min"]);
        call(who, staking.id(), "storage_deposit", json!({}), min, 30).await?;
    }

    // Balances: 1,000 mPOO for the buyback to return, TOILET for two stakers.
    call(
        &minter,
        mpoo.id(),
        "mint",
        json!({"account": buyback.id(), "amount": (1_000 * T).to_string()}),
        0,
        30,
    )
    .await?;
    call(
        &minter,
        toilet.id(),
        "mint",
        json!({"account": alice.id(), "amount": (100 * T).to_string()}),
        0,
        30,
    )
    .await?;
    call(
        &minter,
        toilet.id(),
        "mint",
        json!({"account": bob.id(), "amount": (300 * T).to_string()}),
        0,
        30,
    )
    .await?;

    // Sandbox only: point the throwaway board at this staking contract.
    call(
        &owner,
        board.id(),
        "set_staking_contract",
        json!({"account_id": staking.id()}),
        1,
        30,
    )
    .await?;

    // Stake 100 and 300.
    for (who, amount) in [(&alice, 100 * T), (&bob, 300 * T)] {
        call(
            who,
            toilet.id(),
            "ft_transfer_call",
            json!({"receiver_id": staking.id(), "amount": amount.to_string(), "msg": "stake"}),
            1,
            100,
        )
        .await?;
    }
    assert_eq!(
        u128_of(&view(&staking, "get_pool", json!({})).await?["total_staked"]),
        400 * T
    );

    // Revenue: the buyback returns 1,000 mPOO; the board splits 100 / 200 / 700.
    call(&buyback, mpoo.id(), "ft_transfer_call",
         json!({"receiver_id": board.id(), "amount": (1_000 * T).to_string(), "msg": "{\"revenue\":{}}"}), 1, 100).await?;
    call(&keeper, board.id(), "distribute_mpoo", json!({}), 0, 150).await?;
    assert_eq!(balance(&mpoo, team.id().as_str()).await?, 100 * T);
    assert_eq!(balance(&mpoo, BURN).await?, 200 * T);
    assert_eq!(balance(&mpoo, staking.id().as_str()).await?, 700 * T);
    // Arrived, but not counted until the keeper syncs.
    assert_eq!(
        u128_of(&view(&staking, "get_pool", json!({})).await?["pool"]),
        0
    );

    call(&keeper, staking.id(), "sync_inflow", json!({}), 0, 60).await?;
    let pool = view(&staking, "get_pool", json!({})).await?;
    assert_eq!(u128_of(&pool["pool"]), 700 * T);
    let t0 = u128_of(&pool["last_release_ns"]);
    // A second sync with nothing new adds nothing.
    call(&keeper, staking.id(), "sync_inflow", json!({}), 0, 60).await?;
    let t0b = last_release(&staking).await?;
    let (inc0, charged0) = split(partial_release(700 * T, t0b - t0), 400 * T);
    let mut pool_left = 700 * T - charged0;
    assert_eq!(
        u128_of(&view(&staking, "get_pool", json!({})).await?["pool"]),
        pool_left
    );

    // Time passes.
    worker.fast_forward(200).await?;

    // Alice claims.
    call(&alice, staking.id(), "claim_rewards", json!({}), 1, 100).await?;
    let t1 = last_release(&staking).await?;
    let (inc1, charged1) = split(partial_release(pool_left, t1 - t0b), 400 * T);
    pool_left -= charged1;
    let alice_claim = 100 * T * (inc0 + inc1) / ACC_SCALE;
    assert!(alice_claim > 0);
    assert_eq!(balance(&mpoo, alice.id().as_str()).await?, alice_claim);

    worker.fast_forward(100).await?;

    // Bob claims: his share of every release so far.
    call(&bob, staking.id(), "claim_rewards", json!({}), 1, 100).await?;
    let t2 = last_release(&staking).await?;
    let (inc2, charged2) = split(partial_release(pool_left, t2 - t1), 400 * T);
    pool_left -= charged2;
    let bob_claim = 300 * T * (inc0 + inc1 + inc2) / ACC_SCALE;
    assert_eq!(balance(&mpoo, bob.id().as_str()).await?, bob_claim);
    assert_eq!(
        u128_of(&view(&staking, "get_pool", json!({})).await?["pool"]),
        pool_left
    );

    // Both unstake everything: 10% burned, 90% returned, rewards untouched.
    call(
        &alice,
        staking.id(),
        "unstake",
        json!({"amount": (100 * T).to_string()}),
        1,
        200,
    )
    .await?;
    let t3 = last_release(&staking).await?;
    let (inc3, charged3) = split(partial_release(pool_left, t3 - t2), 400 * T);
    pool_left -= charged3;
    call(
        &bob,
        staking.id(),
        "unstake",
        json!({"amount": (300 * T).to_string()}),
        1,
        200,
    )
    .await?;
    let t4 = last_release(&staking).await?;
    let (inc4, charged4) = split(partial_release(pool_left, t4 - t3), 300 * T);
    pool_left -= charged4;

    assert_eq!(balance(&toilet, alice.id().as_str()).await?, 90 * T);
    assert_eq!(balance(&toilet, bob.id().as_str()).await?, 270 * T);
    assert_eq!(balance(&toilet, BURN).await?, 40 * T);
    assert_eq!(balance(&toilet, staking.id().as_str()).await?, 0);
    let pool = view(&staking, "get_pool", json!({})).await?;
    assert_eq!(u128_of(&pool["burned_total"]), 40 * T);
    assert_eq!(u128_of(&pool["burn_pending"]), 0);
    assert_eq!(u128_of(&pool["total_staked"]), 0);
    assert_eq!(u128_of(&pool["pool"]), pool_left);

    // Unstaking did not claim: what accrued since each claim is still pending.
    let alice_left = 100 * T * (inc0 + inc1 + inc2 + inc3) / ACC_SCALE - alice_claim;
    let bob_left = 300 * T * (inc0 + inc1 + inc2 + inc3 + inc4) / ACC_SCALE - bob_claim;
    let a = view(&staking, "get_staker", json!({"account_id": alice.id()})).await?;
    let b = view(&staking, "get_staker", json!({"account_id": bob.id()})).await?;
    assert_eq!(
        (u128_of(&a["staked"]), u128_of(&a["pending_rewards"])),
        (0, alice_left)
    );
    assert_eq!(
        (u128_of(&b["staked"]), u128_of(&b["pending_rewards"])),
        (0, bob_left)
    );

    // The books balance: what is held equals what is owed plus what waits in the pool.
    let acct = view(&staking, "get_accounting", json!({})).await?;
    let held = balance(&mpoo, staking.id().as_str()).await?;
    assert_eq!(u128_of(&acct["accounted"]), held);
    assert_eq!(held + alice_claim + bob_claim, 700 * T);
    assert_eq!(u128_of(&acct["payouts_in_flight"]), 0);
    eprintln!(
        "simulation: alice claimed {alice_claim}, bob claimed {bob_claim}, still pending \
         {alice_left} / {bob_left}, pool {pool_left}, {} ns from first sync to last unstake",
        t4 - t0
    );
    Ok(())
}
