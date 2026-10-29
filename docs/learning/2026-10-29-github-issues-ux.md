# 2026-10-29 — GitHub issues #25–#29 (paid wall UX)

## What was tried

Five owner-reported testnet issues against `board3.metapoo-player1.testnet`:
wallet session lost on refresh (#25), buy-credits price fetch looking dead (#26),
Paint & wallet panel stuck open (#27), mPOO / NEARLY CTAs while NEAR-only (#28),
credits dock not moving after spend (#29).

Live `get_payment_config` / `get_credits` / `get_cell_cost` views on that board
succeed; the failures were frontend wiring.

## What was observed

- App wallet identity lived only in a module-level `session`. `NearConnector` was
  constructed lazily on Connect; boot never called `getConnectedWallet()`, so a
  Meteor reload after sign-in or a tx looked logged out.
- Buy credits already gated mPOO behind `TOKEN_PAYMENTS_ENABLED`, but Paint & wallet
  always rendered Buy mPOO on NEARLY.
- Credits dock refreshed on wallet change / shortfall / buy — not after a confirmed
  paint or stroke. The chain did debit; the dock lied.
- `<details class="wallet-details">` had no Close, Escape, or outside-click path.

## What this evidence proves

Unit/regression coverage for restore, Close/Escape/outside-click, NEAR-only CTAs,
Retry on payment-config failure, and dock refresh after confirmed paint
(`credits-dock-refresh.test.ts`). Full suite + `tsc`/vite build green.

## What it does not prove

Live Brave + Meteor continuity after refresh, or a real paid paint on testnet with
the dock dropping from N to N−1 in the browser. Chain evidence for this PR is the
existing board views used during diagnosis, not a new settlement.

## Learned

Restore-only wallet hydration (`getConnectedWallet` on boot) is enough for
session continuity and does not need a new key scope or allowance change. Dock
credits and panel CTAs must share the same launch flag and the same post-spend
refresh path — gating one surface and not the other is how #28 and #29 shipped.

A Retry button does not fix #26. Owner follow-up (2026-10-29 16:13 Australia/Sydney):
the sheet fails because `quoteRepaint` floods the same RPC with ~129 reads on a
64-cell stroke. Session-cached tunables + pixel-cache `written_at_ns` + unique
cells cut that to 65 (`get_tunables` once + `get_cell_cost` per cell).
