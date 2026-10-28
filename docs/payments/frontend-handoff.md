# Paid-paint UI handoff

Accepted product direction, 2026-10-28. **Read-only display implemented locally; checkout remains pending.**
Applies to the separate schema-4 paid board. Do not substitute the older schema-3
pressure/TOILET fixtures or enable payments on the free schema-2 board.

## What the user sees

| Display | Source / behavior |
|---|---|
| Price per paint pixel | Board `get_payment_config().near_per_credit`: initially **0.0069 NEAR**. Also show the configured mPOO price when available; it is not yet a chosen launch rate. |
| Paint pixels available | `get_credits(account_id)`: one credit = one pixel placement, no expiry. Null means not registered, not an RPC failure. |
| NEAR available in wallet | Network-matched account balance with storage backing / locked balance accounted for. Label spendable estimate accurately; reserve gas before enabling checkout or Max. Do not mistake function-call-key allowance for wallet funds. |
| mPOO in wallet | `ft_balance_of(account_id)` on the board-configured token; decimals from verified `ft_metadata`, not a floating-point approximation. |
| Buy mPOO on NEARLY | External link to the verified mPOO token page, visibly leaves the app; new tab preserves the current canvas/checkout. No embedded swap or inventory sales in this stage. |

Amounts use exact integer arithmetic internally and readable decimal formatting.
No USD peg is claimed. If a dollar estimate is added, label it approximate and
show source/freshness. Never round a purchase amount down below the exact required deposit.

The existing research records `https://nearly.trade/mpoo.nearlytrade.near` as the
mPOO page; verify the destination identifies `mpoo.nearlytrade.near` before shipping.
This is a mainnet market. Testnet must not imply that buying real mPOO funds testnet
credits; hide the CTA there or label it as a separate mainnet external market.

## Checkout and refresh behavior

- Quantity plus total: 10 credits = 0.069 NEAR; 100 = 0.69 NEAR.
- Choose NEAR or mPOO; disclose registration and estimated network fees separately.
- Read prices from the deployed board; send expected price and minimum credits.
- Insufficient mPOO offers the NEARLY link. Return/focus triggers a fresh balance read;
  a click, tab return or wallet success message is not proof that a purchase settled.
- Refresh after account/network changes, confirmed purchases/paints and manual refresh.
  Discard stale responses from previously connected accounts or networks.
- Show disconnected, loading, unregistered, ready, stale and failed states distinctly.
  A failed read displays “Unavailable / Retry”, never a fabricated zero balance.
- Wrong network or unsupported schema disables checkout; missing paid deployment
  says “Paid painting not available yet”, not a fictional live balance/price.
- Keep confirmed credits separate from pending purchase/spend amounts. Reconcile
  receipt outcomes and fresh state before showing confirmation; do not auto-resubmit
  an unknown broadcast. Confirmed wallet activity can occur outside this app.
- Credit purchase is not painting; the user returns to the canvas with usable credits.

## Frontend acceptance gates (local evidence below; live gates remain open)

- [ ] Contract-driven prices and exact totals, including very large integer balances.
- [ ] Correct NEAR spendable display and gas reserve; independent token/credit balances.
- [ ] Null registration, zero funds, RPC failure, loading and stale states are distinct.
- [x] Account/network switch cannot show a previous user's balances (local regression test).
- [ ] External destination and network labeling verified; return refreshes actual funds.
- [ ] Price update during checkout, cancellation, insufficient funds and unknown tx outcome.
- [ ] Successful and failed purchases/paints reconcile credits without double counting.
- [ ] Keyboard and narrow-screen accessibility; full web tests and production build.
- [ ] Testnet full-loop evidence before mainnet; mainnet cost checklist afterward.

The read-only display is in the header’s **Paint & wallet** disclosure. Checkout placement remains open; avoid crowding the canvas dock. No wallet permission changes are specified here.

## Implementation evidence — 2026-10-28

`web/src/paint-wallet.ts` reads prices/credits, token metadata/balances and NEAR
account/storage configuration. `web/src/app/paint-wallet-panel.ts` mounts inside
**Paint & wallet**, with refresh, account/network isolation, explicit failures and
a mainnet-labelled external NEARLY link. No transaction or wallet-permission changes.
Mainnet market URL checked against its Meta Poo page title. On free/unconfigured
boards the 0.0069 NEAR price is labelled Planned and credits are unavailable.

Verification: 9 new focused tests; full suite 284 tests / 41 files passed; production
build passed. Browser inspection confirmed the disconnected panel and live schema-2
testnet board handling. Connected wallet values and schema-4 paid state remain
fixture-tested, not live-verified. Narrow-screen visual review and paid checkout
remain pending. Existing dependency bundle warnings (`util` externalization and
crypto chunk imports) persist; balance reads themselves do not import those packages.

Automatic refresh: wallet/network changes, operations-store changes, window focus,
visible-tab return and a 30-second interval; a manual Refresh button is also available.
Late responses are discarded after account switches or disposal. No balance change
is treated as proof that a specific purchase succeeded.
