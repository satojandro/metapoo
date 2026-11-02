//! One-off generator for `fixtures/state_v1.json`: real version-1 state written by
//! the version-1 code (the layout deployed on `board3.metapoo-player1.testnet`).
//!
//! Run with `cargo test write_v1_state_fixture -- --ignored` on the commit that
//! adds this file. The migration commit deletes it, because the v1 code it drives
//! no longer exists after that; the fixture is the permanent record.
#![cfg(test)]

use crate::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const PRICE: u128 = 2_500_000_000_000_000_000_000;
const REGISTRATION: u128 = 10_000_000_000_000_000_000_000;

fn ctx(caller: &AccountId, signer: &AccountId, deposit: u128, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("board3.metapoo-player1.testnet".parse().unwrap())
        .predecessor_account_id(caller.clone())
        .signer_account_id(signer.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts)
        .build());
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
#[ignore]
fn write_v1_state_fixture() {
    let owner = accounts(0);
    let token = accounts(5);
    // A 64-character id: the longest NEAR allows, so the fixture covers it.
    let long: AccountId = format!("{}.testnet", "x".repeat(56)).parse().unwrap();
    assert_eq!(long.as_str().len(), 64);
    let (bob, charlie, danny, eugene) = (accounts(1), accounts(2), accounts(3), accounts(4));
    let painters = [bob.clone(), charlie.clone(), danny.clone(), eugene.clone(), long.clone()];

    let t0 = 1_761_700_000_000_000_000u64; // late Oct 2026, in ns
    ctx(&owner, &owner, 0, t0);
    let mut board = Board::new(token.clone(), U128(100));

    for who in painters.iter() {
        ctx(who, who, REGISTRATION, t0 + 1);
        board.register_credit_account();
    }
    // NEAR purchases.
    ctx(&bob, &bob, PRICE * 10, t0 + 2);
    board.buy_credits_near(U128(10), U128(PRICE));
    ctx(&charlie, &charlie, PRICE * 5, t0 + 3);
    board.buy_credits_near(U128(5), U128(PRICE));
    ctx(&long, &long, PRICE * 20, t0 + 4);
    board.buy_credits_near(U128(20), U128(PRICE));
    // mPOO purchase: danny buys 3 credits and paints nothing (outstanding).
    ctx(&token, &danny, 0, t0 + 5);
    let refund = board.ft_on_transfer(
        danny.clone(),
        U128(300),
        r#"{"min_credits":"3","expected_price":"100"}"#.into(),
    );
    assert_eq!(refund, U128(0));

    // Paint: single draws, strokes, a duplicate inside a stroke, an overwrite.
    let minute = 60_000_000_000u64;
    ctx(&bob, &bob, 0, t0 + minute);
    board.draw(0, 0, 1);
    board.draw_many(vec![
        DrawCell { x: 1, y: 0, color: 2 },
        DrawCell { x: 2, y: 0, color: 3 },
        DrawCell { x: 2, y: 0, color: 4 },
    ]);
    ctx(&charlie, &charlie, 0, t0 + 20 * minute);
    board.draw(0, 0, 5); // overwrite bob's cell, mid tier (2 credits)
    board.draw(127, 127, 7);
    ctx(&long, &long, 0, t0 + 90 * minute);
    board.draw_many(vec![
        DrawCell { x: 10, y: 10, color: 0 },
        DrawCell { x: 11, y: 10, color: 1 },
        DrawCell { x: 12, y: 10, color: 6 },
        DrawCell { x: 1, y: 0, color: 7 }, // takes a cell from bob, base tier by now
    ]);

    // One owner price change, so the cooldown history is non-empty.
    ctx(&owner, &owner, 1, t0 + 100 * minute);
    board.set_credit_prices(U128(PRICE), U128(150));

    // Persist exactly what a transaction end would persist.
    board.pixels.flush();
    board.holders.flush();
    board.payments.balances.flush();
    env::state_write(&board);

    let mut accounts_json = Vec::new();
    for who in [owner.clone()].iter().chain(painters.iter()) {
        accounts_json.push(serde_json::json!({
            "account_id": who,
            "credits": board.get_credits(who.clone()),
            "cells_owned": board.get_cells_owned(who.clone()),
        }));
    }
    let pixels = board.get_pixels(0, 256);
    let expected = serde_json::json!({
        "owner": owner,
        "mpoo_token": token,
        "accounts": accounts_json,
        "pixels": pixels.pixels.iter().map(|p| serde_json::json!({
            "x": p.x, "y": p.y, "color": p.color, "artist": p.artist, "written_at_ns": p.written_at_ns
        })).collect::<Vec<_>>(),
        "total_cells": board.total_cells,
        "outstanding": board.get_outstanding_credits(),
        "payment_config": board.get_payment_config(),
        "tunables": board.get_tunables(),
        "acc_per_cell": board.acc_per_cell.to_string(),
        "last_accrual_ns": board.last_accrual_ns,
        "accrued_total": board.accrued_total.to_string(),
    });

    let mut storage: Vec<(Vec<u8>, Vec<u8>)> =
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()).into_iter().collect();
    storage.sort();
    let fixture = serde_json::json!({
        "about": "Version-1 paid-board state written by the v1 code (schema 4, as deployed on board3.metapoo-player1.testnet). Generated by src/v1_fixture.rs; do not edit by hand.",
        "storage": storage.iter().map(|(k, v)| [hex(k), hex(v)]).collect::<Vec<_>>(),
        "expected": expected,
    });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/state_v1.json");
    std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures")).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
}
