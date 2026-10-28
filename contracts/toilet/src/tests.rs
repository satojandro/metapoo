use super::*;
use near_sdk::{
    test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder},
    testing_env, PromiseResult, RuntimeFeesConfig,
};
use std::collections::HashMap;

fn context(caller: usize, deposit: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(accounts(5))
        .predecessor_account_id(accounts(caller))
        .signer_account_id(accounts(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(100));
    testing_env!(builder.build());
    builder
}
fn tax() -> Tax {
    Tax {
        buy_bps: 200,
        sell_bps: 300,
        exchange: accounts(3),
        treasury: accounts(4),
        burn_bps: 3300,
        treasury_bps: 6700,
        exempt: vec![],
    }
}
fn setup() -> Toilet {
    setup_with_tax(tax())
}
fn setup_with_tax(config: Tax) -> Toilet {
    context(0, 0);
    let mut token = Toilet::new(accounts(1), config);
    let fee = token.storage_balance_bounds().min.as_yoctonear();
    for caller in 0..4 {
        context(caller, fee);
        token.storage_deposit(None, None);
    }
    token
}
fn mint(token: &mut Toilet, account: usize, amount: u128) {
    context(1, 0);
    token.mint(accounts(account), U128(amount));
}
fn balance(token: &Toilet, account: usize) -> u128 {
    token.ft_balance_of(accounts(account)).0
}
fn rejected(code: &str, f: impl FnOnce()) {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("must reject");
    let message = err
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| err.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains(code), "unexpected error: {message}");
}
fn resolve(
    token: &mut Toilet,
    sender: usize,
    receiver: usize,
    net: u128,
    fee: u128,
    result: PromiseResult,
) -> u128 {
    let builder = context(5, 0);
    testing_env!(
        builder.build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::new(),
        vec![result]
    );
    token
        .ft_resolve_transfer(accounts(sender), accounts(receiver), U128(net), U128(fee))
        .0
}
fn invariant(token: &Toilet) {
    let info = token.get_supply_info();
    assert_eq!(
        info.issued_total.0,
        info.total_supply.0 + info.burned_total.0
    );
    assert_eq!(info.cap.0, info.issued_total.0 + info.remaining_issuable.0);
    assert_eq!(
        (0..5).map(|i| balance(token, i)).sum::<u128>(),
        info.total_supply.0
    );
}

fn assert_resolution_event(receiver: usize, delivered: u128, used: u128, fee: u128) {
    let logs = get_logs();
    let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
        logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap(),
    )
    .unwrap();
    assert_eq!(event["event"], "transfer_resolved");
    assert_eq!(
        event["data"][0],
        near_sdk::serde_json::json!({
            "receiver_id": accounts(receiver), "delivered": U128(delivered),
            "used": U128(used), "tax": U128(fee)
        })
    );
}

#[test]
fn resolver_full_rejection_returns_zero() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
    assert_eq!(resolve(&mut token, 2, 3, 970, 30, PromiseResult::Failed), 0);
    assert_resolution_event(3, 970, 0, 30);
}

#[test]
fn resolver_full_consumption_returns_net_delivered() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
    assert_eq!(
        resolve(
            &mut token,
            2,
            3,
            970,
            30,
            PromiseResult::Successful(b"\"0\"".to_vec())
        ),
        970
    );
    assert_resolution_event(3, 970, 970, 30);
}

#[test]
fn tax_config_stays_exact_through_emitter_controls_and_transfers() {
    let mut config = tax();
    config.exempt = vec![accounts(0), accounts(2), accounts(0)];
    let mut token = setup_with_tax(config.clone());
    assert_eq!(token.get_tax(), config);
    mint(&mut token, 2, 1000);
    context(2, 1);
    token.ft_transfer(accounts(3), U128(1000), None);
    context(1, 1);
    token.set_paused(true);
    token.set_paused(false);
    token.set_emitter(accounts(0));
    assert_eq!(token.get_tax(), config);
}

#[test]
fn only_current_emitter_can_pause_or_handoff_with_exactly_one_yocto() {
    let mut token = setup();
    // Even the initializer has no authority over the configured emitter.
    for caller in [0, 2] {
        context(caller, 1);
        rejected("EmitterOnly", || token.set_paused(true));
        rejected("EmitterOnly", || token.set_emitter(accounts(caller)));
    }
    for deposit in [0, 2] {
        context(1, deposit);
        rejected("OneYoctoRequired", || token.set_paused(true));
        rejected("OneYoctoRequired", || token.set_emitter(accounts(0)));
    }
    context(1, 1);
    token.set_paused(true);
    assert!(token.is_paused());
    token.set_emitter(accounts(0));
    assert_eq!(token.get_emitter(), accounts(0));
    context(1, 1);
    rejected("EmitterOnly", || token.set_paused(false));
    rejected("EmitterOnly", || token.set_emitter(accounts(1)));
    context(0, 1);
    token.set_paused(false);
    assert!(!token.is_paused());
}

#[test]
fn only_emitter_can_mint_and_burning_never_reopens_lifetime_cap() {
    let mut token = setup();
    context(0, 0);
    rejected("EmitterOnly", || token.mint(accounts(2), U128(1)));
    mint(&mut token, 2, CAP);
    context(2, 1);
    token.burn(U128(1000));
    context(1, 0);
    rejected("SupplyCapExceeded", || token.mint(accounts(2), U128(1)));
    assert_eq!(token.get_supply_info().remaining_issuable, U128(0));
    assert_eq!(token.get_supply_info().issued_total, U128(CAP));
    invariant(&token);
}

#[test]
fn wallet_transfer_untaxed_buy_and_sell_split_exactly() {
    let mut token = setup();
    mint(&mut token, 2, 10_000);
    context(2, 1);
    token.ft_transfer(accounts(0), U128(1000), None);
    assert_eq!(balance(&token, 0), 1000);
    assert_eq!(balance(&token, 4), 0);
    token.ft_transfer(accounts(3), U128(1000), None); // sell: 30 tax = 9 burn + 21 treasury
    assert_eq!(balance(&token, 3), 970);
    assert_eq!(balance(&token, 4), 21);
    context(3, 1);
    token.ft_transfer(accounts(0), U128(100), None); // buy: 2 tax = 0 burn + 2 treasury
    assert_eq!(balance(&token, 0), 1098);
    assert_eq!(balance(&token, 4), 23);
    assert_eq!(token.get_supply_info().tax_burned_total, U128(9));
    assert_eq!(token.get_supply_info().tax_treasury_total, U128(23));
    invariant(&token);
}

#[test]
fn tax_rounding_conserves_every_atomic_unit_including_tiny_transfers() {
    for gross in 0..20_000u128 {
        let fee = share(gross, 300);
        let burned = share(fee, 3300);
        let treasury = fee - burned;
        assert_eq!(gross, (gross - fee) + burned + treasury);
        assert_eq!(fee, gross * 300 / 10_000);
    }
    assert_eq!(share(u128::MAX, 10_000), u128::MAX);
}

#[test]
fn exempt_sender_or_receiver_skips_venue_tax() {
    let mut config = tax();
    config.exempt = vec![accounts(2)];
    let mut token = setup_with_tax(config);
    mint(&mut token, 2, 1000);
    context(2, 1);
    token.ft_transfer(accounts(3), U128(1000), None);
    context(3, 1);
    token.ft_transfer(accounts(2), U128(1000), None);
    assert_eq!(balance(&token, 2), 1000);
    assert_eq!(balance(&token, 4), 0);
    invariant(&token);
}

#[test]
fn transfer_call_sends_net_and_resolves_failed_receiver_without_taxing_refund() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "deposit".into()));
    let receipts = get_created_receipts();
    // Inspect the actual promise payload, not just the direct balance change.
    let mut calls = Vec::new();
    for receipt in receipts {
        for action in receipt.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } = action
            {
                let payload: near_sdk::serde_json::Value =
                    near_sdk::serde_json::from_slice(&args).unwrap();
                assert_eq!(payload["amount"], "970");
                let name = String::from_utf8(method_name).unwrap();
                if name == "ft_resolve_transfer" {
                    assert_eq!(payload["tax"], "30");
                }
                calls.push(name);
            }
        }
    }
    assert!(calls.contains(&"ft_on_transfer".to_string()));
    assert!(calls.contains(&"ft_resolve_transfer".to_string()));
    assert_eq!(balance(&token, 3), 970);
    context(1, 1);
    token.set_paused(true);
    assert_eq!(
        resolve(&mut token, 2, 3, 970, 30, PromiseResult::Failed),
        0
    );
    assert_eq!(balance(&token, 2), 970);
    assert_eq!(balance(&token, 3), 0);
    assert_eq!(balance(&token, 4), 21);
    invariant(&token);
}

#[test]
fn partial_refund_is_clamped_to_net_and_available_balance() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
    assert_eq!(
        resolve(
            &mut token,
            2,
            3,
            970,
            30,
            PromiseResult::Successful(b"\"100\"".to_vec())
        ),
        870
    );
    assert_eq!(balance(&token, 2), 100);
    invariant(&token);
}

#[test]
fn malformed_or_oversized_refund_requests_cannot_take_more_than_net() {
    for payload in [
        b"garbage".to_vec(),
        b"\"999999\"".to_vec(),
        vec![b'0'; 1000],
    ] {
        let mut token = setup();
        mint(&mut token, 2, 1000);
        context(2, 1);
        drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
        assert_eq!(
            resolve(
                &mut token,
                2,
                3,
                970,
                30,
                PromiseResult::Successful(payload)
            ),
            0
        );
        invariant(&token);
        // The next loop uses the same mocked storage; clear it before constructing anew.
        near_sdk::mock::with_mocked_blockchain(|b| {
            b.take_storage();
        });
    }
}

#[test]
fn deleted_sender_refund_burn_updates_supply_counters() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
    token.storage_unregister(Some(false));
    resolve(&mut token, 2, 3, 970, 30, PromiseResult::Failed);
    assert_eq!(token.get_supply_info().burned_total, U128(979));
    assert_eq!(token.get_supply_info().tax_burned_total, U128(9));
    invariant(&token);
}

#[test]
fn storage_registers_refunds_excess_and_withdraws_only_available_balance() {
    context(0, 0);
    let mut token = Toilet::new(accounts(1), tax());
    let bounds = token.storage_balance_bounds();
    assert_eq!(bounds.max, Some(bounds.min));
    context(2, bounds.min.as_yoctonear() + 100);
    let storage = token.storage_deposit(None, Some(true));
    assert_eq!(storage.total, bounds.min);
    assert_eq!(storage.available, NearToken::from_yoctonear(0));
    assert!(!get_created_receipts().is_empty());
    assert!(token.storage_balance_of(accounts(2)).is_some());
    context(2, 1);
    assert_eq!(
        token.storage_withdraw(None).available,
        NearToken::from_yoctonear(0)
    );
    assert!(token.storage_unregister(None));
    assert!(token.storage_balance_of(accounts(2)).is_none());
}

#[test]
#[should_panic(expected = "greater than the available")]
fn registered_storage_cannot_be_withdrawn_while_account_exists() {
    let mut token = setup();
    context(2, 1);
    token.storage_withdraw(Some(NearToken::from_yoctonear(1)));
}

#[test]
fn pause_stops_both_transfer_paths_but_not_mint_or_burn() {
    let mut token = setup();
    context(1, 1);
    token.set_paused(true);
    mint(&mut token, 2, 1000);
    context(2, 1);
    rejected("Paused", || token.ft_transfer(accounts(0), U128(1), None));
    rejected("Paused", || {
        let _ = token.ft_transfer_call(accounts(0), U128(1), None, "".into());
    });
    token.burn(U128(1));
    assert_eq!(balance(&token, 2), 999);
    invariant(&token);
}

#[test]
fn emitter_controls_deposits_registration_and_callback_are_enforced() {
    let mut token = setup();
    context(2, 1);
    rejected("EmitterOnly", || token.set_emitter(accounts(2)));
    rejected("EmitterOnly", || token.set_paused(true));
    rejected("PrivateOnly", || {
        token.ft_resolve_transfer(accounts(2), accounts(3), U128(1), U128(0));
    });
    context(2, 0);
    rejected("OneYoctoRequired", || {
        token.ft_transfer(accounts(0), U128(1), None)
    });
    context(1, 1);
    token.set_emitter(accounts(0));
    context(1, 0);
    rejected("EmitterOnly", || token.mint(accounts(2), U128(1)));
    context(0, 0);
    let player: AccountId = "unregistered.near".parse().unwrap();
    token.mint(player.clone(), U128(1));
    assert_eq!(token.ft_balance_of(player), U128(1));
}

#[test]
fn invalid_tax_splits_and_rates_rejected_at_initialization() {
    context(0, 0);
    let mut invalid = tax();
    invalid.sell_bps = 10_001;
    rejected("InvalidTaxRate", || {
        Toilet::new(accounts(1), invalid);
    });
    let mut invalid = tax();
    invalid.burn_bps = 100;
    rejected("InvalidTaxSplit", || {
        Toilet::new(accounts(1), invalid);
    });
}

#[test]
fn forced_unregister_counts_burn_and_metadata_is_valid() {
    let mut token = setup();
    token.ft_metadata().assert_valid();
    assert_eq!(token.ft_metadata().decimals, 18);
    mint(&mut token, 2, 1000);
    context(2, 1);
    token.storage_unregister(Some(true));
    assert_eq!(token.get_supply_info().burned_total, U128(1000));
    invariant(&token);
}

#[test]
fn accepted_transfer_and_spent_receiver_balance_resolve_correctly() {
    let mut token = setup();
    mint(&mut token, 2, 2000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
    assert_eq!(
        resolve(
            &mut token,
            2,
            3,
            970,
            30,
            PromiseResult::Successful(b"\"0\"".to_vec())
        ),
        970
    );
    context(2, 1);
    drop(token.ft_transfer_call(accounts(0), U128(1000), None, "".into()));
    context(0, 1);
    token.ft_transfer(accounts(1), U128(900), None);
    assert_eq!(
        resolve(&mut token, 2, 0, 1000, 0, PromiseResult::Failed),
        900
    );
    assert_eq!(balance(&token, 2), 100);
    invariant(&token);
}

#[test]
fn full_tax_and_treasury_as_sender_preserve_supply() {
    let mut config = tax();
    config.sell_bps = 10_000;
    let mut token = setup_with_tax(config);
    mint(&mut token, 2, 1000);
    context(2, 1);
    drop(token.ft_transfer_call(accounts(3), U128(1000), None, "".into()));
    assert_eq!(balance(&token, 3), 0);
    assert_eq!(balance(&token, 4), 670);
    assert_eq!(
        resolve(&mut token, 2, 3, 0, 1000, PromiseResult::Failed),
        0
    );
    context(4, 1);
    token.ft_transfer(accounts(3), U128(100), None);
    assert_eq!(balance(&token, 4), 637);
    invariant(&token);
}

#[test]
fn duplicate_storage_registration_refunds_without_erasing_balance() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, NearToken::from_near(1).as_yoctonear());
    token.storage_deposit(None, Some(false));
    assert_eq!(balance(&token, 2), 1000);
    let refund = get_created_receipts().into_iter().flat_map(|r| r.actions).any(|action| {
        matches!(action, near_sdk::mock::MockAction::Transfer { deposit, .. } if deposit == NearToken::from_near(1))
    });
    assert!(refund);
    invariant(&token);
}

#[test]
fn invalid_transfers_do_not_debit_any_balance_or_supply() {
    let mut token = setup();
    mint(&mut token, 2, 1000);
    context(2, 1);
    rejected("AccountNotRegistered", || {
        token.ft_transfer("missing.near".parse().unwrap(), U128(1), None)
    });
    rejected("InsufficientBalance", || {
        token.ft_transfer(accounts(3), U128(1001), None)
    });
    rejected("SelfTransfer", || {
        token.ft_transfer(accounts(2), U128(1), None)
    });
    rejected("ZeroAmount", || {
        token.ft_transfer(accounts(3), U128(0), None)
    });
    assert_eq!(balance(&token, 2), 1000);
    invariant(&token);
}

#[test]
fn claim_auto_registers_an_unregistered_player() {
    let mut token = setup();
    let player: AccountId = "new-player.near".parse().unwrap();
    assert!(token.storage_balance_of(player.clone()).is_none());
    context(1, 0);
    token.mint(player.clone(), U128(70));
    assert_eq!(token.ft_balance_of(player.clone()), U128(70));
    assert!(token.storage_balance_of(player.clone()).is_some());
    assert!(get_logs().iter().any(|log| log.contains("account_auto_registered") && log.contains(player.as_str())));
    context(1, 0);
    token.mint(player, U128(3));
    assert!(!get_logs().iter().any(|log| log.contains("account_auto_registered")));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn token_refuses_auto_registration_below_the_reserve() {
    let mut token = setup();
    let player: AccountId = "new-player.near".parse().unwrap();
    let mut builder = context(1, 0);
    let storage_usage = 10_000;
    let boundary = MIN_REGISTRATION_RESERVE
        + u128::from(storage_usage) * env::storage_byte_cost().as_yoctonear()
        + token.storage_balance_bounds().min.as_yoctonear();
    builder.storage_usage(storage_usage).account_balance(NearToken::from_yoctonear(boundary - 1));
    testing_env!(builder.build());
    rejected("RegistrationReserveLow", || token.mint(player.clone(), U128(70)));
    assert!(token.storage_balance_of(player.clone()).is_none());
    assert_eq!(token.get_supply_info().issued_total, U128(0));
    // An existing recipient needs no further registration reserve.
    token.mint(accounts(2), U128(1));
    builder.account_balance(NearToken::from_yoctonear(boundary));
    testing_env!(builder.build());
    token.mint(player.clone(), U128(70));
    assert_eq!(token.ft_balance_of(player), U128(70));
}
