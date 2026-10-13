//! Local NEAR sandbox joins between the prints registry and this escrow.
//!
//! A unit test pretends another contract answered. This file does not.
//! It compiles both contracts to WASM, boots a local chain (a "sandbox"),
//! and lets the real receipts call each other.
//!
//! This is not testnet and not mainnet. No funds leave the machine.
//!
//! T2.DE — prints publishes a snapshot reference; escrow accepts it because
//! its `registry` account is the prints contract, then an artist can propose.
//! T2.EDH — after the sponsor awards, `mint_bounty_print` asks escrow for the
//! entitlement and the private callback mints exactly one bounty edition.

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker, sandbox};
use near_workspaces::network::Sandbox;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Same genesis bytes as Worker C's history fixture. Bounty series ids mix
/// this hash with the escrow account and the bounty id, so both contracts
/// must be initialized with it.
const GENESIS: &str =
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

/// Not the fixture snapshot id. That capture is timestamped in 2023, and a
/// bounty window has to contain "now" on the sandbox clock. The attester
/// registers a fresh manifest whose timestamp is the moment the bounty was funded.
const SNAPSHOT_ID: &str =
    "1111111111111111111111111111111111111111111111111111111111111111";
const STATE_HASH: &str =
    "2222222222222222222222222222222222222222222222222222222222222222";
const MANIFEST_HASH: &str =
    "3333333333333333333333333333333333333333333333333333333333333333";
const BLOCK_HASH: &str =
    "4444444444444444444444444444444444444444444444444444444444444444";

const DAY_NS: u64 = 86_400_000_000_000;

fn near(whole: u128) -> NearToken {
    NearToken::from_near(whole)
}

fn gas(tgas: u64) -> Gas {
    Gas::from_tgas(tgas)
}

/// `bounty-` + hex(SHA256(domain || genesis || length-prefixed escrow || bounty id)).
/// Copied from the spec so this test does not trust the contract's own helper.
fn expected_bounty_series_id(escrow: &str, bounty_id: u64) -> String {
    let genesis = hex::decode(GENESIS).expect("genesis hex");
    let escrow_bytes = escrow.as_bytes();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"MPOO_BOUNTY_SERIES_V1\0");
    bytes.extend_from_slice(&genesis);
    bytes.extend_from_slice(&(escrow_bytes.len() as u32).to_be_bytes());
    bytes.extend_from_slice(escrow_bytes);
    bytes.extend_from_slice(&bounty_id.to_be_bytes());
    format!("bounty-{}", hex::encode(Sha256::digest(bytes)))
}

fn expected_print_id() -> String {
    let snap = hex::decode(SNAPSHOT_ID).expect("snapshot hex");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"MPOO_PRINT_V1\0");
    bytes.extend_from_slice(&snap);
    // Crop used below: x=16, y=16, width=32, height=32.
    for part in [16u32, 16, 32, 32] {
        bytes.extend_from_slice(&part.to_be_bytes());
    }
    hex::encode(Sha256::digest(bytes))
}

fn build_wasm(crate_rel: &str, artifact: &str) -> Vec<u8> {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(crate_rel);
    // A nested `cargo build` must not reuse the test runner's target dir.
    // The runner holds that directory's lock, so sharing it deadlocks.
    let target_dir = crate_dir.join("target").join("sandbox-wasm");
    let status = Command::new("cargo")
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--no-default-features",
        ])
        .env("CARGO_TARGET_DIR", &target_dir)
        .current_dir(&crate_dir)
        .status()
        .unwrap_or_else(|e| panic!("spawn cargo for {crate_rel}: {e}"));
    assert!(status.success(), "wasm build failed for {crate_rel}");
    let path = target_dir
        .join("wasm32-unknown-unknown")
        .join("release")
        .join(format!("{artifact}.wasm"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn prints_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build_wasm("../prints", "metapoo_prints"))
}

fn bounties_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build_wasm(".", "metapoo_bounties"))
}

fn ok(
    label: &str,
    result: near_workspaces::result::Result<near_workspaces::result::ExecutionFinalResult>,
) -> near_workspaces::result::ExecutionFinalResult {
    let result = result.unwrap_or_else(|e| panic!("{label}: {e}"));
    assert!(result.is_success(), "{label} failed: {result:?}");
    result
}

async fn view_json(contract: &Contract, method: &str, args: Value) -> Value {
    contract
        .view(method)
        .args_json(args)
        .await
        .unwrap_or_else(|e| panic!("view {method}: {e}"))
        .json()
        .unwrap_or_else(|e| panic!("json {method}: {e}"))
}

async fn chain_time(worker: &Worker<Sandbox>) -> u64 {
    worker
        .view_block()
        .await
        .expect("view block")
        .timestamp()
}

/// Move the sandbox clock to at least `target_ns` without jumping a full week.
/// One block is measured first so the step size is whatever this sandbox uses.
async fn advance_to_at_least(worker: &Worker<Sandbox>, target_ns: u64) {
    let now = chain_time(worker).await;
    if now >= target_ns {
        return;
    }
    worker.fast_forward(1).await.expect("probe fast_forward");
    let after = chain_time(worker).await;
    if after >= target_ns {
        return;
    }
    let step = after.saturating_sub(now).max(1);
    let blocks = (target_ns - after) / step + 1;
    worker
        .fast_forward(blocks)
        .await
        .unwrap_or_else(|e| panic!("fast_forward {blocks} blocks: {e}"));
}

struct World {
    worker: Worker<Sandbox>,
    prints: Contract,
    escrow: Contract,
    attester: Account,
    sponsor: Account,
    artist: Account,
    token: Account,
}

async fn boot() -> World {
    let worker = sandbox().await.expect("start local sandbox");
    let attester = worker.dev_create_account().await.expect("attester");
    let sponsor = worker.dev_create_account().await.expect("sponsor");
    let artist = worker.dev_create_account().await.expect("artist");
    // Stand-in for the MPOO token. Funding calls `ft_on_transfer` from this
    // account. We never need a full fungible-token contract for the print join.
    let token = worker.dev_create_account().await.expect("token");

    let prints = worker.dev_deploy(prints_wasm()).await.expect("deploy prints");
    let escrow = worker
        .dev_deploy(bounties_wasm())
        .await
        .expect("deploy escrow");

    ok(
        "prints new",
        prints
            .call("new")
            .args_json(json!({
                "attester": attester.id(),
                "chain_genesis_hash": GENESIS,
                "board_width": 128,
                "board_height": 128,
                "public_series_cap": 100,
            }))
            .transact()
            .await,
    );
    ok(
        "escrow new",
        escrow
            .call("new")
            .args_json(json!({
                "network_id": "testnet",
                "mpoo_token": token.id(),
                // The join: escrow trusts this prints account, not a mock id.
                "registry": prints.id(),
            }))
            .transact()
            .await,
    );

    World {
        worker,
        prints,
        escrow,
        attester,
        sponsor,
        artist,
        token,
    }
}

fn crop() -> Value {
    json!({ "x": 16, "y": 16, "width": 32, "height": 32 })
}

#[tokio::test]
async fn t2_de_then_edh_sandbox_joins() {
    let world = boot().await;

    let identity = view_json(&world.escrow, "get_deployment_identity", json!({})).await;
    assert_eq!(
        identity["registry"].as_str().unwrap(),
        world.prints.id().as_str(),
        "escrow registry must be the deployed prints account"
    );
    let prints_identity = view_json(&world.prints, "get_deployment_identity", json!({})).await;
    assert_eq!(prints_identity["chain_genesis_hash"], GENESIS);

    // Allowlist bootstrap: publish and bounty mint both refuse an unknown escrow.
    ok(
        "allowlist escrow",
        world
            .attester
            .call(world.prints.id(), "allowlist_escrow")
            .args_json(json!({ "escrow": world.escrow.id() }))
            .transact()
            .await,
    );
    let allowlisted = view_json(
        &world.prints,
        "is_escrow_allowlisted",
        json!({ "escrow": world.escrow.id() }),
    )
    .await;
    assert_eq!(allowlisted, Value::Bool(true));

    let now = chain_time(&world.worker).await;
    let fund_by = now + 3_600_000_000_000; // 1 hour, still inside the 7-day fund cap
    let submit_by = fund_by + DAY_NS;
    let review_by = submit_by + 7 * DAY_NS;

    let created = ok(
        "create bounty",
        world
            .sponsor
            .call(world.escrow.id(), "create_bounty")
            .args_json(json!({
                "terms": {
                    "board_id": "testnet:board.mpoo.testnet:1",
                    "crop": crop(),
                    "brief_uri": "fixture://sandbox-brief",
                    "brief_hash": "sandbox-brief-hash",
                    "award_amount": "1000",
                    "terms_version": "bounty-terms-v1",
                    "fund_by_ns": fund_by.to_string(),
                    "submit_by_ns": submit_by.to_string(),
                    "review_by_ns": review_by.to_string(),
                },
                "client_nonce": "sandbox-create-1",
            }))
            .deposit(near(1))
            .gas(gas(50))
            .transact()
            .await,
    );
    let bounty_id: String = created.json().expect("bounty id");

    let funded = ok(
        "fund bounty",
        world
            .token
            .call(world.escrow.id(), "ft_on_transfer")
            .args_json(json!({
                "sender_id": world.sponsor.id(),
                "amount": "1000",
                "msg": format!(
                    r#"{{"version":1,"action":"fund_bounty","bounty_id":"{bounty_id}"}}"#
                ),
            }))
            .transact()
            .await,
    );
    let unused: String = funded.json().expect("unused token amount");
    assert_eq!(unused, "0", "escrow must accept the exact award");

    let bounty = view_json(
        &world.escrow,
        "get_bounty",
        json!({ "bounty_id": bounty_id }),
    )
    .await;
    assert_eq!(bounty["status"], "ACTIVE");
    let funded_at = bounty["funded_at_ns"]
        .as_str()
        .expect("funded_at")
        .to_string();

    ok(
        "register snapshot",
        world
            .attester
            .call(world.prints.id(), "register_snapshot")
            .args_json(json!({
                "manifest": {
                    "snapshot_id": SNAPSHOT_ID,
                    "state_hash": STATE_HASH,
                    "board": {
                        "chain_id": "testnet",
                        "board_account_id": "board.mpoo.testnet",
                        "board_epoch": "1",
                    },
                    "width": 128,
                    "height": 128,
                    "palette_version": "palette-v2",
                    "finalized_block_hash": BLOCK_HASH,
                    "finalized_block_height": "1005",
                    "finalized_block_timestamp_ns": funded_at,
                    "revision": "1",
                    "receipt_id": "sandbox-receipt-1",
                    "manifest_uri": "fixture://sandbox-manifest",
                    "manifest_hash": MANIFEST_HASH,
                    "attester_account_id": world.attester.id(),
                    "media_hash": null,
                }
            }))
            .deposit(near(1))
            // Refunds schedule a 10 TGas callback. The sandbox default (10 TGas)
            // is spent before that callback can be created.
            .gas(gas(100))
            .transact()
            .await,
    );

    // T2.DE: prints calls escrow.register_snapshot_reference and forwards NEAR
    // so the new escrow record can pay for its storage.
    ok(
        "publish snapshot reference",
        world
            .attester
            .call(world.prints.id(), "publish_snapshot_reference")
            .args_json(json!({
                "snapshot_id": SNAPSHOT_ID,
                "bounty_contract": world.escrow.id(),
            }))
            .deposit(near(1))
            .gas(gas(100))
            .transact()
            .await,
    );

    let proposed = ok(
        "propose submission",
        world
            .artist
            .call(world.escrow.id(), "propose_submission")
            .args_json(json!({
                "bounty_id": bounty_id,
                "snapshot_id": SNAPSHOT_ID,
                "crop": crop(),
                "note_hash": "sandbox-note",
                "recipients": [{
                    "account_id": world.artist.id(),
                    "share_bps": 10_000,
                }],
                "client_nonce": "sandbox-propose-1",
            }))
            .deposit(near(1))
            .gas(gas(50))
            .transact()
            .await,
    );
    let proposed: Value = proposed.json().expect("propose result");
    let proposal_id = proposed["proposal_id"].as_str().unwrap().to_string();
    let digest = proposed["consent_digest"].as_str().unwrap().to_string();
    assert!(!proposal_id.is_empty());
    assert!(!digest.is_empty(), "eligible snapshot produced a consent digest");

    ok(
        "approve",
        world
            .artist
            .call(world.escrow.id(), "approve_submission")
            .args_json(json!({
                "proposal_id": proposal_id,
                "expected_digest": digest,
            }))
            .transact()
            .await,
    );
    ok(
        "submit",
        world
            .artist
            .call(world.escrow.id(), "submit")
            .args_json(json!({
                "proposal_id": proposal_id,
                "expected_digest": digest,
            }))
            .transact()
            .await,
    );

    // Review opens at submit_by. The longest review window is 7 days, so the
    // clock must land inside that span.
    advance_to_at_least(&world.worker, submit_by).await;
    let review_now = chain_time(&world.worker).await;
    assert!(
        review_now >= submit_by && review_now < review_by,
        "sandbox clock {review_now} is outside review [{submit_by}, {review_by})"
    );

    ok(
        "accept submission",
        world
            .sponsor
            .call(world.escrow.id(), "accept_submission")
            .args_json(json!({
                "bounty_id": bounty_id,
                "submission_id": proposal_id,
            }))
            .transact()
            .await,
    );

    let entitlement = view_json(
        &world.escrow,
        "get_print_entitlement",
        json!({ "bounty_id": bounty_id }),
    )
    .await;
    assert_eq!(entitlement["snapshot_id"], SNAPSHOT_ID);
    assert_eq!(entitlement["manifest_hash"], MANIFEST_HASH);
    assert_eq!(entitlement["sponsor"], world.sponsor.id().as_str());
    assert_eq!(entitlement["crop"], crop());

    // T2.EDH: the mint asks escrow over a real cross-contract call. The
    // callback, not the caller, chooses the recipient (the sponsor).
    ok(
        "mint bounty print",
        world
            .sponsor
            .call(world.prints.id(), "mint_bounty_print")
            .args_json(json!({
                "bounty_contract": world.escrow.id(),
                "bounty_id": bounty_id,
                "operation_id": "sandbox-mint-1",
            }))
            .deposit(near(5))
            .gas(gas(280))
            .transact()
            .await,
    );

    let op = view_json(
        &world.prints,
        "get_print_operation",
        json!({
            "caller": world.sponsor.id(),
            "operation_id": "sandbox-mint-1",
        }),
    )
    .await;
    assert_eq!(op["status"], "minted");
    assert_eq!(op["edition_number"], 1);

    let bounty_id_num: u64 = bounty_id.parse().unwrap();
    let series_id = expected_bounty_series_id(world.escrow.id().as_str(), bounty_id_num);
    assert_eq!(op["series_id"], series_id);
    let print_id = expected_print_id();
    assert_eq!(op["print_id"], print_id);
    let token_id = format!("{print_id}:{series_id}:1");
    assert_eq!(op["token_id"], token_id);

    let token = view_json(
        &world.prints,
        "nft_token",
        json!({ "token_id": token_id }),
    )
    .await;
    assert_eq!(token["owner_id"], world.sponsor.id().as_str());

    let edition = view_json(
        &world.prints,
        "get_print_edition",
        json!({ "token_id": token_id }),
    )
    .await;
    assert_eq!(edition["mint_recipient"], world.sponsor.id().as_str());
    assert_eq!(edition["series_kind"], "bounty");
    assert_eq!(edition["source_bounty_id"], bounty_id);

    let print = view_json(
        &world.prints,
        "get_print",
        json!({ "print_id": print_id }),
    )
    .await;
    let series = print["series"].as_array().expect("series list");
    let public = series
        .iter()
        .find(|s| s["series_id"] == "public-v1")
        .expect("public series");
    assert_eq!(public["issued"], 0, "bounty mint must not consume the public series");
    assert_eq!(public["cap"], 100);
    let bounty_series = series
        .iter()
        .find(|s| s["series_kind"] == "bounty")
        .expect("bounty series");
    assert_eq!(bounty_series["cap"], 1);
    assert_eq!(bounty_series["issued"], 1);
    assert_eq!(bounty_series["series_id"], series_id);

    // A second operation cannot mint another edition of the same bounty series.
    ok(
        "second bounty mint",
        world
            .artist
            .call(world.prints.id(), "mint_bounty_print")
            .args_json(json!({
                "bounty_contract": world.escrow.id(),
                "bounty_id": bounty_id,
                "operation_id": "sandbox-mint-2",
            }))
            .deposit(near(5))
            .gas(gas(280))
            .transact()
            .await,
    );
    let conflict = view_json(
        &world.prints,
        "get_print_operation",
        json!({
            "caller": world.artist.id(),
            "operation_id": "sandbox-mint-2",
        }),
    )
    .await;
    assert_eq!(conflict["status"], "conflict");
    assert_eq!(conflict["error_code"], "BOUNTY_SERIES_ALREADY_MINTED");
    assert!(conflict["token_id"].is_null());
}
