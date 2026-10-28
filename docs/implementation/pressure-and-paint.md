# Pressure pricing and paint implementation specification

Status: **superseded for the current payment stage (2026-10-28)** — the paid board sells fixed-price prepaid credits, not TOILET, and has no regional heat. Kept as the later-stage pressure design ([decision record](../payments/2026-10-28-paid-model-decisions.md)). Original status: proposed R1 protocol; prototype parameters below are test fixtures, not selected production economics. Owner: Board/Economy agent. Scope complements the [economy plan](../2026-10-12-paint-economy-and-swap-plan.md); it does not redefine staking, rewards or swap/shop flows.

## Current code and target

`contracts/board/src/lib.rs` schema 2 has free `draw(x,y,color)`, sparse latest pixels, no balances/pressure/nonce/session budget. `shared/types.ts` has no paid models. New paid deployment must have no free-write bypass. Preserve Open wall: nobody buys exclusive territory. No per-wallet discount advertised as per-person fairness.

R1 uses fixed MPOO paint packs and a nontransferable internal TOILET ledger co-located with board state. Variable placement costs are denominated in TOILET integer units. This is an internal spend, not an external token-standard burn. Testnet uses a clearly named mock MPOO token; live token behavior requires separate validation.

## Deterministic local pressure, version 1

Prototype fixture partitions 128×128 into 8×8 regions, 16×16 regions total. General rule: region columns = ceil(board_width/region_size); region ID = floor(y/region_size)*region_columns + floor(x/region_size). Support clipped edge regions for non-divisible dimensions. Board and region sizes come from versioned metadata; the proposed larger-board target is in core-board.md. Region boundaries appear in the optional overlay. Simulate boundary exploitation before changing geometry; do not introduce overlapping neighborhoods during R1.

Per-region state: `heat`, `updated_at_seconds`. Config: `version`, `base_cost`, `max_cost`, `heat_cap`, `heat_increment`, `decay_per_second`, `surcharge_numerator`, `surcharge_denominator`, `effective_at`. Integers only; checked u128 arithmetic for money/heat, u64 time internally. Large JSON values are decimal strings.

At chain second t:

1. `elapsed = max(0, t - updated_at_seconds)`.
2. `cooled_heat = max(0, heat - decay_per_second * elapsed)` using saturating decay (bound elapsed before multiplication to prevent overflow).
3. `cost = min(max_cost, base_cost + floor(cooled_heat * surcharge_numerator / surcharge_denominator))`.
4. Validate request, maximum cost, balance, session budget and no-op before any mutation.
5. Deduct cost, replace pixel, and set `heat = min(heat_cap, cooled_heat + heat_increment)`, `updated_at_seconds = t`, increment board revision; commit together.

The next successful placement in the region sees the updated heat. Same-artist/same-color is rejected before charging; other-account/same-color is a real attribution change and charges normally. Failed calls do not add heat. Own recolors cost the same as any placement; no defender discount that alternate wallets can abuse. This prices activity, not unique humans or artistic merit.

Fixture config: base 10, max 50, heat cap 400, increment 10, decay 1/second, surcharge 1/10. At t=100 cold region costs 10; a second placement at t=100 costs 11; after 10 seconds its heat 20 cools to 10 and costs 11; at heat cap cost is 50. These values exist solely for deterministic tests. Unit name and precision must be displayed consistently.

No hourly cliff, external market oracle or floating point. Ceiling does not prevent wealth domination; it only bounds a single placement's price. A region can be deliberately heated to obstruct restoration. Simulator must report that attack, not describe pricing as anti-bot protection.

For R1, freeze pressure config for a test season. To change live config, pause new writes, migrate regions in bounded, cursor-tracked batches by cooling with old config at the same frozen boundary, clamp to new cap, activate version only when all batches complete, then resume. The 128×128 fixture has 256 regions; a larger board must not attempt all regions in one transaction. Never retroactively apply a new cooling rate to an old interval. Balances remain intact. Mainnet upgrade governance remains a launch decision.

## Contract API proposal and wire rules

- `get_board()` adds paid schema, board_id/epoch, palette_version, current `revision`, pricing_version, token IDs and ledger unit metadata.
- `get_quote({x,y,color,account_id})` returns `cost`, `region_id`, `cooled_heat`, `pricing_version`, `observed_at_ns`, `expires_at_ns` (fixture TTL 30 seconds), `balance`, `revision`. View is advisory, not a reservation.
- `draw({x,y,color,max_cost,pricing_version,expires_at_ns,action_nonce,session_id})` zero attached deposit, registered session only. `paint_with_wallet` takes the same price/coordinate/nonce fields without session ID and requires exactly one yoctoNEAR. Both enter the same private paint validation/mutation routine. Recalculate at execution; reject expired/version mismatch/price greater than max. Price decreases charge the lower actual cost. Reject expiry more than configured max TTL into execution-time future. Nonce must equal stored account/epoch nonce + 1; increment only on success, and retain the last outcome. Duplicate/stale nonces reject without debit; client reconciles prior success from event evidence/last outcome rather than treating rejection as an instruction to resend.
- `get_account({account_id})` returns paint balance, last accepted action nonce and recent bounded operation outcome for reconciliation.
- `get_regions({from_index,limit})` bounded ≤64 regions, prices evaluated at the same block/time.
- `ft_on_transfer(sender_id,amount,msg)` accepts only configured token predecessor. Message includes version, pack_id, schedule_version, purchase reference. Reject wrong token, wrong amount, expired schedule and malformed data via documented refund behavior. Credit original sender; never credit a claimed browser artist.

Purchase protocol: accept exact pack amounts only; refund all otherwise; fixed non-expiring paint in prototype. Disable purchases when backing storage or configured purchase allocation is insufficient. Real token tests must establish whether the receiver sees taxed/net amounts. Do not count rejected/refunded funds as revenue. Each actual token transfer is a purchase; replayed UI requests are reconciled to receipts rather than blindly replayed. Product-level purchase IDs require token-resolver-safe idempotency design at interface freeze.

All state-changing economic events include schema, board_id, account, actual amount and operation ID. Only successful pixel writes increment the board `revision`; funding and session events never consume revisions or create replay gaps. Price quote/pending overlay never changes confirmed balance. No batch painting in initial R1; add only after single-action proof and measured throughput. Future bounded batches must specify sequential pressure changes and all-or-nothing validation.

## Restricted drawing sessions

A NEAR access-key gas allowance does not limit TOILET expenditure. Introduce wallet-authorized `register_paint_session(public_key,max_total_cost,expires_at_ns,board_epoch)` and `revoke_paint_session(session_id)`; require predecessor == signer and exactly one yoctoNEAR attached, so a function-call key that cannot attach deposits cannot register its own budget. Bind zero-deposit `draw` to predecessor == signer, `signer_account_pk`, epoch and the active registered budget. Missing session ID always rejects; budget decreases atomically with paint balance. A supplied session ID alone grants nothing.

Ordinary wallet `paint_with_wallet` likewise requires predecessor == signer and exactly one yoctoNEAR, so the restricted draw key cannot use it to bypass its budget. Keep that NEAR deposit separate from MPOO revenue and disclose it with network/storage costs. This changes the ordinary-wallet method/deposit adapter, not the session's zero-deposit draw. Verify the installed connector's signed transaction behavior and restricted-key rejection in sandbox/testnet. If budget registration cannot be completed reliably, disable paid local sessions and use the ordinary wallet method; never permit unbudgeted zero-deposit draws.

On-chain registration method must not be callable by the draw-only key. A lost/forgotten browser key is revoked via wallet, with on-chain verification. Never extend its permissions to fund bounties, transfer tokens or mint. Browser queue reserves pending spend locally but only contract checks guarantee atomic balances across devices. Stop queue on changed price/expiry/account/network/session; require fresh user intent rather than automatic higher bids.

## Reward compatibility

R1 does not enable longevity rewards. Later reward caps must use actual cost of the placement and cumulative settlement, not the fluctuating future quote; own recolors cannot reset lifetime caps. Bounty awards are separately funded MPOO claims, never TOILET issuance or staking revenue. Pressure spend creates no new MPOO income until a paid pack purchase occurs.

## Simulation and acceptance

Add `simulations/pressure/` with seeded deterministic scenarios and a fixed-price control: quiet artist, two crews, wealthy warmer, alternating wallets, region-boundary migration, sudden demand spike, inactive wall. Emit JSON + short human report: spend, successful placements, restoration cost, time above price threshold, concentration by true simulated operator and by account. Do not treat a simulated result as measured player retention.

Required correctness checks: fixture vectors shared Rust/TS; cap/floor and long inactivity; same second ordering; boundary coordinates; overflow/rounding; zero denominator rejected; no-op no cost; quote expiry equality; version drift; insufficient balance; concurrent last units; duplicate nonce; draw rollback; forged token receiver; refund resolution; storage exhaustion; missing session ID bypass; unknown key; session expiry/cap; pause and config transition; metadata mismatch blocks frontend write.

Tests must call contract entrypoints directly, bypassing client validation. Rust unit tests plus a sandbox/testnet token receiver integration exercise asynchronous transfer resolution. Production asset trials remain outside this spec's execution authorization.
