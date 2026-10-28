//! Stage-one payments: credits are prepaid paint, not a transferable token.
//! ECONOMY NEXT: keep purchased credits separate from earned rewards, staking
//! principal and treasury allocations. Never count outstanding credits as profit.
use crate::{Board, BoardExt};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId};

// Fixed launch price: 0.0069 NEAR, represented exactly in yoctoNEAR.
// No USD oracle: dollar value moves with NEAR. Owner updates remain explicit.
pub(crate) const INITIAL_NEAR_PRICE: u128 = 6_900_000_000_000_000_000_000;

// A conservative, fixed registration fee funds one bounded balance record.
// ECONOMY NEXT: replace this with measured storage billing and explicit refunds.
const REGISTRATION: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

#[near(serializers = [borsh])]
pub(crate) struct Payments {
    pub(crate) owner: AccountId,
    token: AccountId,
    near_price: u128,
    mpoo_price: u128,
    pub(crate) balances: LookupMap<AccountId, u128>,
    /// Credits sold but not yet spent. Prepaid service, not free revenue: each
    /// unspent credit still owes one storage-backed pixel. Tracked from the first
    /// deployment so the float cap and any future distribution rule never need a
    /// state migration to discover it.
    pub(crate) outstanding: u128,
}

#[near(serializers = [json])]
pub struct PaymentConfig {
    pub mpoo_token: AccountId,
    pub near_per_credit: U128,
    pub mpoo_per_credit: U128,
    pub registration_fee: U128,
}

// Prices and minimum output travel with the payment, preventing an interface
// from silently purchasing fewer credits than the buyer agreed to.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct Purchase {
    pub min_credits: U128,
    pub expected_price: U128,
}

impl Payments {
    pub(crate) fn new(token: AccountId, near_price: u128, mpoo_price: u128) -> Self {
        assert!(near_price > 0 && mpoo_price > 0, "ZeroPrice");
        assert_ne!(token, env::current_account_id(), "InvalidToken");
        Self {
            owner: env::predecessor_account_id(),
            token,
            near_price,
            mpoo_price,
            balances: LookupMap::new(b"c"),
            outstanding: 0,
        }
    }

    /// `max_outstanding` of 0 means uncapped. The cap is a game rule (scarcity),
    /// not a solvency rule: credits are non-refundable prepaid service.
    fn credit(
        &mut self,
        account: &AccountId,
        amount: u128,
        price: u128,
        minimum: u128,
        max_outstanding: u128,
    ) -> Option<u128> {
        // Exact multiples avoid silently keeping dust or scheduling a second,
        // potentially taxed outgoing transfer. Invalid FT purchases refund all.
        if amount == 0 || !amount.is_multiple_of(price) || minimum == 0 {
            return None;
        }
        let credits = amount / price;
        if credits < minimum {
            return None;
        }
        let outstanding = self.outstanding.checked_add(credits)?;
        if max_outstanding > 0 && outstanding > max_outstanding {
            return None;
        }
        let previous = *self.balances.get(account)?;
        let next = previous.checked_add(credits)?;
        self.balances.insert(account.clone(), next);
        self.outstanding = outstanding;
        Some(credits)
    }

    pub(crate) fn spend(&mut self, account: &AccountId, count: u128) {
        if count == 0 {
            return;
        }
        let balance = *self.balances.get(account).expect("AccountNotRegistered");
        let next = balance.checked_sub(count).expect("InsufficientCredits");
        let outstanding = self
            .outstanding
            .checked_sub(count)
            .expect("CreditInvariant");
        // ECONOMY NEXT: pressure pricing belongs here, after quote/max-cost checks.
        // A receipt failure rolls back this debit and all pixel writes together.
        self.balances.insert(account.clone(), next);
        self.outstanding = outstanding;
    }
}

#[near]
impl Board {
    /// ECONOMY NEXT: move pricing authority to governed, bounded quotes with
    /// freshness checks if USD pricing is automated. No pool spot-price oracle.
    #[payable]
    pub fn set_credit_prices(&mut self, near_per_credit: U128, mpoo_per_credit: U128) {
        near_sdk::assert_one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.owner,
            "OwnerOnly"
        );
        assert!(near_per_credit.0 > 0 && mpoo_per_credit.0 > 0, "ZeroPrice");
        // Compare via differences rather than multiplication: even a u128::MAX
        // price can be checked without wrapping at 2 × old_price.
        for (old, new) in [
            (self.payments.near_price, near_per_credit.0),
            (self.payments.mpoo_price, mpoo_per_credit.0),
        ] {
            assert!(
                if new >= old {
                    new - old <= old
                } else {
                    old - new <= new
                },
                "PriceStepTooLarge"
            );
        }
        let now = env::block_timestamp();
        if let Some(last) = self.tunables.last_price_change_ns {
            assert!(
                now.checked_sub(last)
                    .is_some_and(|elapsed| elapsed >= self.tunables.price_cooldown_ns),
                "PriceCooldown"
            );
        }
        Self::safety_event(
            "price_changed",
            near_sdk::serde_json::json!({
                "old_near_per_credit": U128(self.payments.near_price),
                "new_near_per_credit": near_per_credit,
                "old_mpoo_per_credit": U128(self.payments.mpoo_price),
                "new_mpoo_per_credit": mpoo_per_credit,
                "changed_at_ns": now.to_string()
            }),
        );
        self.payments.near_price = near_per_credit.0;
        self.payments.mpoo_price = mpoo_per_credit.0;
        self.tunables.last_price_change_ns = Some(now);
    }

    pub fn get_payment_config(&self) -> PaymentConfig {
        PaymentConfig {
            mpoo_token: self.payments.token.clone(),
            near_per_credit: U128(self.payments.near_price),
            mpoo_per_credit: U128(self.payments.mpoo_price),
            registration_fee: U128(REGISTRATION),
        }
    }

    /// Credits sold and not yet spent. With the float cap set, this is the number
    /// the page shows as "paint still owed", never as profit.
    pub fn get_outstanding_credits(&self) -> U128 {
        U128(self.payments.outstanding)
    }

    pub fn get_credits(&self, account_id: AccountId) -> Option<U128> {
        self.payments.balances.get(&account_id).copied().map(U128)
    }

    /// Register once before either purchase path. Fee is separate from credits.
    #[payable]
    pub fn register_credit_account(&mut self) {
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            REGISTRATION,
            "ExactRegistrationFeeRequired"
        );
        let account = env::predecessor_account_id();
        assert!(
            !self.payments.balances.contains_key(&account),
            "AlreadyRegistered"
        );
        self.payments.balances.insert(account, 0);
    }

    /// Attach native NEAR in yoctoNEAR; no wrap/swap/oracle is involved.
    #[payable]
    pub fn buy_credits_near(&mut self, min_credits: U128, expected_price: U128) -> U128 {
        self.assert_unpaused();
        assert_eq!(expected_price.0, self.payments.near_price, "PriceChanged");
        let account = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        let cap = self.tunables.max_outstanding_credits;
        let credits = self
            .payments
            .credit(
                &account,
                amount,
                self.payments.near_price,
                min_credits.0,
                cap,
            )
            .expect("InvalidPurchaseOrUnregisteredAccountOrFloatFull");
        Self::purchase_event(&account, "near", amount, credits);
        U128(credits)
    }

    /// NEP-141 receiver. Call ft_transfer_call on the configured token, never
    /// this method directly. Only that token contract can authenticate payment.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        assert_eq!(
            env::predecessor_account_id(),
            self.payments.token,
            "WrongToken"
        );
        if self.tunables.paused {
            return amount;
        }
        // NEARLY taxes Rhea-bound transfers, not direct wallet transfers.
        // Reject routed deposits: do not interpret a gross DEX quote as receipts.
        // ECONOMY NEXT: a swap adapter needs independently verified net output,
        // tax-aware minimums, partial-fill handling and refund reconciliation.
        if sender_id != env::signer_account_id() || sender_id.as_str() == "dclv2.ref-labs.near" {
            return amount;
        }
        let Ok(purchase) = near_sdk::serde_json::from_str::<Purchase>(&msg) else {
            return amount;
        };
        if purchase.expected_price.0 != self.payments.mpoo_price {
            return amount;
        }
        let cap = self.tunables.max_outstanding_credits;
        match self.payments.credit(
            &sender_id,
            amount.0,
            self.payments.mpoo_price,
            purchase.min_credits.0,
            cap,
        ) {
            Some(credits) => {
                Self::purchase_event(&sender_id, "mpoo", amount.0, credits);
                U128(0) // All delivered tokens accepted; no manual refund transfer.
            }
            None => amount, // Token's resolver handles the unused amount.
        }
    }
}

impl Board {
    fn purchase_event(account: &AccountId, asset: &str, amount: u128, credits: u128) {
        let event = near_sdk::serde_json::json!({
            "standard": "mpoo_payments", "version": "1.0.0", "event": "credits_purchased",
            "data": [{"account_id": account, "asset": asset, "amount": amount.to_string(), "credits": credits.to_string()}]
        });
        env::log_str(&format!("EVENT_JSON:{event}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn context(caller: usize, signer: usize, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(4))
            .predecessor_account_id(accounts(caller))
            .signer_account_id(accounts(signer))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }
    fn setup() -> Board {
        context(0, 0, 0);
        let mut board = Board::new(accounts(5), U128(100));
        // Tiny prices keep arithmetic edge-case tests readable; production
        // initialization is exercised separately below.
        board.payments.near_price = 10;
        context(1, 1, REGISTRATION);
        board.register_credit_account();
        board
    }
    fn message() -> String {
        r#"{"min_credits":"2","expected_price":"100"}"#.into()
    }

    #[test]
    #[should_panic(expected = "PriceStepTooLarge")]
    fn threefold_price_change_is_rejected() {
        let mut board = setup();
        context(0, 0, 1);
        board.set_credit_prices(U128(30), U128(100));
    }

    #[test]
    fn launch_price_is_exactly_0069_near_per_pixel() {
        context(0, 0, 0);
        let mut board = Board::new(accounts(5), U128(100));
        let price = 6_900_000_000_000_000_000_000u128;
        assert_eq!(board.get_payment_config().near_per_credit, U128(price));
        context(1, 1, REGISTRATION);
        board.register_credit_account();
        context(1, 1, price * 10);
        assert_eq!(board.buy_credits_near(U128(10), U128(price)), U128(10));
        assert_eq!(board.get_credits(accounts(1)), Some(U128(10)));
    }

    #[test]
    fn near_purchase_and_both_paint_methods_spend_credits() {
        let mut board = setup();
        context(1, 1, 30);
        assert_eq!(board.buy_credits_near(U128(3), U128(10)), U128(3));
        context(1, 1, 0);
        board.draw(0, 0, 1);
        board.draw_many(vec![
            crate::DrawCell {
                x: 1,
                y: 0,
                color: 1,
            },
            crate::DrawCell {
                x: 2,
                y: 0,
                color: 1,
            },
        ]);
        assert_eq!(board.get_credits(accounts(1)), Some(U128(0)));
    }
    #[test]
    fn direct_mpoo_accepts_only_delivered_exact_amount() {
        let mut board = setup();
        context(5, 1, 0);
        assert_eq!(
            board.ft_on_transfer(accounts(1), U128(200), message()),
            U128(0)
        );
        assert_eq!(board.get_credits(accounts(1)), Some(U128(2)));
        // A hypothetical reduced delivery cannot mint the gross amount's credits.
        assert_eq!(
            board.ft_on_transfer(accounts(1), U128(196), message()),
            U128(196)
        );
        assert_eq!(board.get_credits(accounts(1)), Some(U128(2)));
    }
    #[test]
    fn invalid_ft_inputs_refund_without_credit() {
        let mut board = setup();
        context(5, 1, 0);
        for (sender, amount, msg) in [
            (accounts(1), 200, "{}".into()),
            (accounts(1), 100, message()),
            (accounts(1), 0, message()),
            (accounts(2), 200, message()),
            (
                accounts(1),
                200,
                r#"{"min_credits":"2","expected_price":"99"}"#.into(),
            ),
        ] {
            assert_eq!(
                board.ft_on_transfer(sender, U128(amount), msg),
                U128(amount)
            );
        }
        assert_eq!(board.get_credits(accounts(1)), Some(U128(0)));
    }
    #[test]
    #[should_panic(expected = "WrongToken")]
    fn forged_callback_rejected() {
        let mut board = setup();
        context(2, 1, 0);
        board.ft_on_transfer(accounts(1), U128(200), message());
    }
    #[test]
    #[should_panic(expected = "InsufficientCredits")]
    fn free_draw_rejected() {
        let mut board = setup();
        context(1, 1, 0);
        board.draw(0, 0, 1);
    }
    #[test]
    #[should_panic(expected = "OwnerOnly")]
    fn price_update_requires_owner() {
        let mut board = setup();
        context(1, 1, 1);
        board.set_credit_prices(U128(20), U128(200));
    }
    #[test]
    #[should_panic(expected = "PriceChanged")]
    fn stale_near_price_rejected() {
        let mut board = setup();
        context(0, 0, 1);
        board.set_credit_prices(U128(20), U128(200));
        context(1, 1, 20);
        board.buy_credits_near(U128(1), U128(10));
    }
    #[test]
    fn rejected_near_payment_does_not_credit() {
        let mut board = setup();
        context(1, 1, 19);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            board.buy_credits_near(U128(1), U128(10));
        }));
        assert!(result.is_err());
        assert_eq!(board.get_credits(accounts(1)), Some(U128(0)));
    }

    #[test]
    fn insufficient_batch_leaves_pixels_and_balance_unchanged() {
        let mut board = setup();
        context(1, 1, 10);
        board.buy_credits_near(U128(1), U128(10));
        context(1, 1, 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            board.draw_many(vec![
                crate::DrawCell {
                    x: 0,
                    y: 0,
                    color: 1,
                },
                crate::DrawCell {
                    x: 1,
                    y: 0,
                    color: 1,
                },
            ]);
        }));
        assert!(result.is_err());
        assert_eq!(board.get_credits(accounts(1)), Some(U128(1)));
        assert!(board.get_pixel(0, 0).color.is_none());
    }

    #[test]
    fn price_change_preserves_credits_and_rejects_old_ft_quote() {
        let mut board = setup();
        context(1, 1, 20);
        board.buy_credits_near(U128(2), U128(10));
        context(0, 0, 1);
        board.set_credit_prices(U128(20), U128(200));
        context(5, 1, 0);
        assert_eq!(
            board.ft_on_transfer(accounts(1), U128(200), message()),
            U128(200)
        );
        assert_eq!(board.get_credits(accounts(1)), Some(U128(2)));
    }

    #[test]
    fn registration_fee_covers_balance_record_storage() {
        let mut board = setup();
        board.payments.balances.flush();
        context(2, 2, REGISTRATION);
        // Context changes preserve mocked storage but reset the usage counter;
        // take the baseline after changing context for an accurate delta.
        let baseline = env::storage_usage();
        board.register_credit_account();
        board.payments.balances.flush();
        let cost =
            u128::from(env::storage_usage() - baseline) * env::storage_byte_cost().as_yoctonear();
        assert!(cost > 0 && cost <= REGISTRATION);
    }

    #[test]
    fn overflow_refunds_ft() {
        let mut board = setup();
        board.payments.balances.insert(accounts(1), u128::MAX);
        context(5, 1, 0);
        assert_eq!(
            board.ft_on_transfer(accounts(1), U128(200), message()),
            U128(200)
        );
    }

    #[test]
    fn outstanding_overflow_refunds_without_changing_the_account() {
        let mut board = setup();
        board.payments.outstanding = u128::MAX;
        context(5, 1, 0);
        assert_eq!(
            board.ft_on_transfer(accounts(1), U128(200), message()),
            U128(200)
        );
        assert_eq!(board.get_credits(accounts(1)), Some(U128(0)));
        assert_eq!(board.get_outstanding_credits(), U128(u128::MAX));
    }

    #[test]
    fn outstanding_rises_on_purchase_and_falls_on_spend() {
        let mut board = setup();
        assert_eq!(board.get_outstanding_credits(), U128(0));
        context(1, 1, 30);
        board.buy_credits_near(U128(3), U128(10));
        assert_eq!(board.get_outstanding_credits(), U128(3));
        context(1, 1, 0);
        board.draw(0, 0, 1);
        assert_eq!(board.get_outstanding_credits(), U128(2));
        board.draw(1, 0, 1);
        assert_eq!(board.get_outstanding_credits(), U128(1));
    }

    #[test]
    fn float_cap_blocks_purchases_until_paint_frees_room() {
        let mut board = setup();
        let mut tunables = board.get_tunables();
        tunables.max_outstanding_credits = 2;
        context(0, 0, 1);
        board.set_tunables(tunables);
        context(1, 1, 20);
        assert_eq!(board.buy_credits_near(U128(2), U128(10)), U128(2));
        // At the cap the whole call is rejected; its deposit reverts with it.
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            board.buy_credits_near(U128(1), U128(10));
        }));
        assert!(rejected.is_err());
        assert_eq!(board.get_credits(accounts(1)), Some(U128(2)));
        // Painting consumes the float, so room exists again.
        context(1, 1, 0);
        board.draw(0, 0, 1);
        context(1, 1, 10);
        assert_eq!(board.buy_credits_near(U128(1), U128(10)), U128(1));
        assert_eq!(board.get_outstanding_credits(), U128(2));
    }

    #[test]
    fn float_cap_of_zero_means_uncapped() {
        let mut board = setup();
        assert_eq!(board.get_tunables().max_outstanding_credits, 0);
        context(1, 1, 100);
        board.buy_credits_near(U128(10), U128(10));
        assert_eq!(board.get_outstanding_credits(), U128(10));
    }
}
