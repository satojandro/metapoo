//! TOILET: lifetime-capped issuance, ordinary NEP-141 transfers, and configured
//! exchange taxation. The standard library owns account storage and refunds.
use near_contract_standards::fungible_token::{
    core::FungibleTokenCore,
    events::{FtBurn, FtMint, FtTransfer},
    metadata::{FungibleTokenMetadata, FT_METADATA_SPEC},
    receiver::ext_ft_receiver,
    FungibleToken,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

/// 1 billion tokens, each divisible into 10^18 atomic units.
pub const CAP: u128 = 1_000_000_000_000_000_000_000_000_000;
const BPS: u128 = 10_000;
const MAX_EXEMPT: usize = 64;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tax {
    pub buy_bps: u16,
    pub sell_bps: u16,
    pub exchange: AccountId,
    pub treasury: AccountId,
    pub burn_bps: u16,
    pub treasury_bps: u16,
    pub exempt: Vec<AccountId>,
}

impl Tax {
    fn validate(&self) {
        assert!(
            self.buy_bps <= 10_000 && self.sell_bps <= 10_000,
            "InvalidTaxRate"
        );
        assert_eq!(
            u32::from(self.burn_bps) + u32::from(self.treasury_bps),
            10_000,
            "InvalidTaxSplit"
        );
        assert!(self.exempt.len() <= MAX_EXEMPT, "TooManyExemptAccounts");
    }

    fn rate(&self, sender: &AccountId, receiver: &AccountId) -> u16 {
        if self.exempt.contains(sender) || self.exempt.contains(receiver) {
            return 0;
        }
        if sender == &self.exchange {
            self.buy_bps
        } else if receiver == &self.exchange {
            self.sell_bps
        } else {
            0
        }
    }
}

#[near(serializers = [json])]
pub struct SupplyInfo {
    pub cap: U128,
    pub total_supply: U128,
    pub issued_total: U128,
    pub burned_total: U128,
    pub tax_burned_total: U128,
    pub tax_treasury_total: U128,
    pub remaining_issuable: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Toilet {
    token: FungibleToken,
    owner: AccountId,
    emitter: AccountId,
    tax: Tax,
    transfers_paused: bool,
    issued_total: u128,
    burned_total: u128,
    tax_burned_total: u128,
    tax_treasury_total: u128,
}

#[near]
impl Toilet {
    #[init]
    pub fn new(emitter: AccountId, tax: Tax) -> Self {
        tax.validate();
        let mut token = FungibleToken::new(b"t");
        // Bootstrap only the treasury; its one account record is funded by the
        // deployer. All other recipients must pay standard storage registration.
        token.internal_register_account(&tax.treasury);
        Self {
            token,
            owner: env::predecessor_account_id(),
            emitter,
            tax,
            transfers_paused: false,
            issued_total: 0,
            burned_total: 0,
            tax_burned_total: 0,
            tax_treasury_total: 0,
        }
    }

    /// Only the configured game/emitter can issue tokens. Burns never restore
    /// this lifetime allowance: issued_total is deliberately separate from supply.
    pub fn mint(&mut self, account: AccountId, amount: U128) {
        assert_eq!(env::predecessor_account_id(), self.emitter, "EmitterOnly");
        assert!(amount.0 > 0, "ZeroAmount");
        self.registered_balance(&account);
        let issued = self
            .issued_total
            .checked_add(amount.0)
            .expect("SupplyCapExceeded");
        assert!(issued <= CAP, "SupplyCapExceeded");
        self.token.internal_deposit(&account, amount.0);
        self.issued_total = issued;
        FtMint {
            owner_id: &account,
            amount,
            memo: Some("emission"),
        }
        .emit();
    }

    #[payable]
    pub fn burn(&mut self, amount: U128) {
        one_yocto();
        assert!(amount.0 > 0, "ZeroAmount");
        let caller = env::predecessor_account_id();
        assert!(
            self.registered_balance(&caller) >= amount.0,
            "InsufficientBalance"
        );
        self.token.internal_withdraw(&caller, amount.0);
        self.record_burn(amount.0);
        FtBurn {
            owner_id: &caller,
            amount,
            memo: Some("voluntary"),
        }
        .emit();
    }

    #[payable]
    pub fn set_emitter(&mut self, emitter: AccountId) {
        self.assert_owner();
        event(
            "emitter_changed",
            near_sdk::serde_json::json!({"old": self.emitter, "new": emitter}),
        );
        self.emitter = emitter;
    }

    #[payable]
    pub fn set_tax(&mut self, tax: Tax) {
        self.assert_owner();
        tax.validate();
        self.registered_balance(&tax.treasury);
        event(
            "tax_changed",
            near_sdk::serde_json::json!({"old": self.tax, "new": tax}),
        );
        self.tax = tax;
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.transfers_paused = paused;
        event(
            "pause_changed",
            near_sdk::serde_json::json!({"paused": paused}),
        );
    }

    pub fn is_paused(&self) -> bool {
        self.transfers_paused
    }
    pub fn get_tax(&self) -> Tax {
        self.tax.clone()
    }
    pub fn get_emitter(&self) -> AccountId {
        self.emitter.clone()
    }
    pub fn get_supply_info(&self) -> SupplyInfo {
        SupplyInfo {
            cap: U128(CAP),
            total_supply: U128(self.token.total_supply),
            issued_total: U128(self.issued_total),
            burned_total: U128(self.burned_total),
            tax_burned_total: U128(self.tax_burned_total),
            tax_treasury_total: U128(self.tax_treasury_total),
            remaining_issuable: U128(CAP.checked_sub(self.issued_total).expect("SupplyInvariant")),
        }
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.into(),
            name: "TOILET".into(),
            symbol: "TOILET".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }
    pub fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        one_yocto();
        self.transfer(&env::predecessor_account_id(), &receiver_id, amount.0, memo);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        one_yocto();
        assert!(
            env::prepaid_gas().as_gas() >= Gas::from_tgas(30).as_gas(),
            "InsufficientGas"
        );
        let sender = env::predecessor_account_id();
        let (delivered, fee) = self.transfer(&sender, &receiver_id, amount.0, memo);
        // Tell the receiver what actually arrived. The tax is final at transfer
        // time; refunds move only unused net tokens, with no second venue tax.
        let callback = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "sender_id": sender, "receiver_id": receiver_id,
            "amount": U128(delivered), "tax": U128(fee)
        }))
        .expect("SerializationFailed");
        ext_ft_receiver::ext(receiver_id)
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender, U128(delivered), msg)
            .then(Promise::new(env::current_account_id()).function_call(
                "ft_resolve_transfer",
                callback,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            ))
            .into()
    }

    /// Always callable by our own callback, including while transfers are
    /// paused. A pause must never strand an already-started refund.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        tax: U128,
    ) -> U128 {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "PrivateOnly"
        );
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        self.record_burn(burned);
        U128(used.checked_add(tax.0).expect("AmountOverflow"))
    }

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account, balance)) = self.token.internal_storage_unregister(force) {
            self.record_burn(balance);
            if balance > 0 {
                FtBurn {
                    owner_id: &account,
                    amount: U128(balance),
                    memo: Some("unregister"),
                }
                .emit();
            }
            true
        } else {
            false
        }
    }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
}

impl Toilet {
    fn assert_owner(&self) {
        one_yocto();
        assert_eq!(env::predecessor_account_id(), self.owner, "OwnerOnly");
    }
    fn registered_balance(&self, account: &AccountId) -> u128 {
        self.token
            .accounts
            .get(account)
            .expect("AccountNotRegistered")
    }
    fn record_burn(&mut self, amount: u128) {
        self.burned_total = self
            .burned_total
            .checked_add(amount)
            .expect("AmountOverflow");
    }
    fn transfer(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        gross: u128,
        memo: Option<String>,
    ) -> (u128, u128) {
        assert!(!self.transfers_paused, "Paused");
        assert!(gross > 0, "ZeroAmount");
        assert_ne!(sender, receiver, "SelfTransfer");
        assert!(
            self.registered_balance(sender) >= gross,
            "InsufficientBalance"
        );
        self.registered_balance(receiver);
        let fee = share(gross, self.tax.rate(sender, receiver));
        let burned = share(fee, self.tax.burn_bps);
        // Assign the fractional-unit remainder to treasury, so burn + treasury
        // always equals the tax. Rounding cannot create or lose an extra unit.
        let treasury = fee.checked_sub(burned).expect("AmountOverflow");
        let net = gross.checked_sub(fee).expect("AmountOverflow");
        if treasury > 0 {
            self.registered_balance(&self.tax.treasury);
        }
        let tax_burned = self
            .tax_burned_total
            .checked_add(burned)
            .expect("AmountOverflow");
        let tax_treasury = self
            .tax_treasury_total
            .checked_add(treasury)
            .expect("AmountOverflow");
        self.token.internal_withdraw(sender, gross);
        self.token.internal_deposit(receiver, net);
        if net > 0 {
            FtTransfer {
                old_owner_id: sender,
                new_owner_id: receiver,
                amount: U128(net),
                memo: memo.as_deref(),
            }
            .emit();
        }
        if treasury > 0 {
            self.token.internal_deposit(&self.tax.treasury, treasury);
            if sender != &self.tax.treasury {
                FtTransfer {
                    old_owner_id: sender,
                    new_owner_id: &self.tax.treasury,
                    amount: U128(treasury),
                    memo: Some("venue tax"),
                }
                .emit();
            }
        }
        if burned > 0 {
            FtBurn {
                owner_id: sender,
                amount: U128(burned),
                memo: Some("venue tax"),
            }
            .emit();
        }
        self.record_burn(burned);
        self.tax_burned_total = tax_burned;
        self.tax_treasury_total = tax_treasury;
        (net, fee)
    }
}

// Divide first to avoid overflowing amount * bps, even for arbitrary u128 input.
fn share(amount: u128, bps: u16) -> u128 {
    let whole = amount
        .checked_div(BPS)
        .expect("AmountOverflow")
        .checked_mul(u128::from(bps))
        .expect("AmountOverflow");
    let fraction = amount
        .checked_rem(BPS)
        .expect("AmountOverflow")
        .checked_mul(u128::from(bps))
        .expect("AmountOverflow")
        .checked_div(BPS)
        .expect("AmountOverflow");
    whole.checked_add(fraction).expect("AmountOverflow")
}
fn one_yocto() {
    assert_eq!(
        env::attached_deposit().as_yoctonear(),
        1,
        "OneYoctoRequired"
    );
}
fn event(name: &str, data: near_sdk::serde_json::Value) {
    let value = near_sdk::serde_json::json!({"standard":"toilet", "version":"1.0.0", "event":name, "data":[data]});
    env::log_str(&format!("EVENT_JSON:{value}"));
}

#[cfg(test)]
mod tests;
