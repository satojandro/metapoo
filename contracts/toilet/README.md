# TOILET token — local implementation

Implements [toilet-token](../../docs/implementation/toilet-token.task.json) as a new,
independent Rust contract. **Not deployed, independently audited, or AMM-tested.**
No staking vault, emission schedule, board reward accumulator or holder payouts are
included. The board only exposes the pause passthrough; it does not mint rewards yet.

## Supply and authority

`new(emitter, tax)` starts at zero supply. TOILET has no owner or admin account. It has
18 decimals and a lifetime issuance cap of 1,000,000,000 tokens (10^27 atomic units).
Only `emitter` can call `mint(account, amount)`; the recipient must already be
registered. Only the current emitter can call `set_emitter(emitter)` or
`set_paused(paused)`, each with exactly 1 yoctoNEAR. Handoff immediately removes
the previous emitter's authority. The intended emitter is the game contract;
the paid board exposes an owner-gated pause passthrough so that circuit breaker
is reachable. Emitter handoff remains a token method; a board handoff path is
not implemented in this task.

D4 freezes the entire validated `Tax` exactly as supplied to `new()`: rates,
exchange, treasury, split and exempt list have no mutating path. There is no
`set_tax`, no token owner and no upgrade entrypoint in either contract. Removing
the old owner field changes Borsh state. This token is **fresh-init only**;
there is no migration for an initialized older token.

`burn(amount)` removes the caller's tokens. `issued_total` never falls when tokens
burn. For example, issuing all 1 billion and burning half leaves 500 million in
circulation, but **zero** remaining issuance. Burns cannot reopen the cap.

`get_supply_info()` returns decimal strings for cap, total_supply, issued_total,
burned_total, tax_burned_total, tax_treasury_total and remaining_issuable.
Burned total includes voluntary burns, venue burns, forced account removal, and
refunds burned because their sender unregistered. Tax counters are lifetime totals.

## Transfers and tax

Standard interfaces use `near-contract-standards = 5.29.1`:
[NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md),
[NEP-145](https://github.com/near/NEPs/blob/master/neps/nep-0145.md), and
[NEP-148](https://github.com/near/NEPs/blob/master/neps/nep-0148.md).
Taxed transfers are a **fee-on-transfer extension**: they do not promise the
standard gross delivery amount. Do not assume compatibility merely because a
wallet or exchange recognizes these method names.

`new(emitter, tax)` configures this immutable shape; `get_tax()` returns it:

| Field | Meaning |
|---|---|
| buy_bps / sell_bps | Rate when the exchange sends / receives; 100 basis points = 1%, maximum 10,000 |
| exchange / treasury | Venue and tax-recipient account IDs |
| burn_bps / treasury_bps | Shares of the tax, required to sum to 10,000 |
| exempt | Up to 64 accounts; either endpoint being exempt skips tax |

Wallet-to-wallet transfers are untaxed. The transfer amount is **gross**, inclusive
of tax. Integer arithmetic rounds the tax down, then rounds its burn share down;
treasury gets the remainder so there is no unassigned dust. Example in atomic units:
a 1,000-unit sale at 300 bps takes 30 units. With a 3300/6700 split, 9 burn,
21 reach treasury, and 970 reach the exchange. The same treasury share is credited
even if treasury is an endpoint, so its net balance change can differ from gross.

`ft_transfer_call(receiver_id, amount, memo, msg)` reports **net delivered** tokens
to `ft_on_transfer`. The private resolver returns only net tokens consumed by the
receiver (`used`): full rejection returns 0 and full consumption returns the net
delivered amount. Its `transfer_resolved` event records `{receiver_id, delivered,
used, tax}` with decimal-string token amounts; the callback retains `tax` for
this event. Tax is settled immediately and **is not refunded** if the receiver rejects.
Only unused net tokens can return, bounded by the receiver's remaining balance;
refunds are not taxed again. Pausing while a call is in flight does
not change its refund terms. A 100% rate delivers zero and retains the entire tax.

**AMM risk:** a pool that records `amount` instead of actual received tokens can
mis-account deposits or payouts. Failed deposits can still cost the tax, and a buy
tax can reduce output below a pool's quoted minimum. Validate the exact venue in
sandbox/testnet before enabling tax or liquidity. This implementation mirrors the
requested mPOO configuration shape, not a claim of byte-for-byte mPOO behavior.
There is no default live exchange or tax rate: initialization requires an explicit
configuration. It cannot change after initialization.

## Storage, pause and methods

- `storage_deposit(account_id?, registration_only?)` registers one fixed-size
  balance record. Pay at least `storage_balance_bounds().min`; excess and duplicate
  registration deposits are refunded. Min equals max; available balance is zero.
- `storage_withdraw(amount?)` accepts zero/omitted amounts only. To recover the
  registration deposit, use `storage_unregister(force?)`; forcing removal burns
  any remaining tokens. Standard-library storage errors retain its standard text.
- The initial treasury record is funded by the deployer. Other accounts pay their
  own registration. Unregistering the fixed treasury blocks transfers with a
  treasury tax until it registers again.
- `ft_transfer`, `ft_transfer_call`, `burn`, storage withdrawal/removal,
  `set_emitter` and `set_paused` require exactly **1 yoctoNEAR**. `mint` is nonpayable.
- `set_paused(paused)` stops both transfer entrypoints; mint, burn, storage, views
  and already-pending refunds continue. `is_paused()` exposes that state.
- `ft_balance_of(account_id)`, `ft_total_supply()`, `ft_metadata()`, `get_emitter()`
  and the supply/tax views are read-only. Token amounts are JSON decimal strings.
- Standard mint/transfer/burn events and custom tax/emitter/pause/resolver events are emitted.

## Verification

Run `cargo test --locked --manifest-path contracts/toilet/Cargo.toml`.
Build with `cargo build --locked --release --target wasm32-unknown-unknown
--manifest-path contracts/toilet/Cargo.toml`.

22 local tests cover cap permanence, authority, supply conservation, tax rounding,
exemptions, storage refunds, pause, full/partial/failed receiver handling, spent
receiver balances, and deleted-sender refund burns. Promise payloads are inspected
in the mocked NEAR runtime. These are not executed cross-contract receipts on a
sandbox or public chain. Gas budgets, deployed WASM execution and AMM compatibility
still require rehearsal. No deploy or upgrade entrypoint is included.
