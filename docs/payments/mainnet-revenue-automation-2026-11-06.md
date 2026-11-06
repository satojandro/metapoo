# Revenue automation standing order — 2026-11-06

The buyback loop on the mainnet testing board is now unattended. Testers' credit purchases
trickle in; once the board's withdrawable crosses zero, everything below runs by itself.

## What runs, and where

Both keepers run as launchd user agents on the Mac Mini, hourly:

| job | label | fires | script | repo |
|---|---|---|---|---|
| Revenue keeper | `org.metapoo.keeper` | :07 | `~/.hermes/profiles/crypto-builder/bin/run-metapoo-keeper.sh` | `ops/keeper` |
| Buyback keeper | `org.metapoo.buyback` | :23 | `~/.hermes/profiles/crypto-builder/bin/run-metapoo-buyback.sh` | `ops/buyback` |

Logs: `~/Hermes-crypto-builder/metapoo-keeper-logs/keeper-YYYY-MM-DD.log` and
`buyback-YYYY-MM-DD.log` (one JSON line per step), plus `*-launchd.err` for script crashes.

Control: `launchctl kickstart gui/$(id -u)/org.metapoo.<keeper|buyback>` (run now),
`launchctl bootout gui/$(id -u)/org.metapoo.<name>` (stop). Plists in `~/Library/LaunchAgents/`.

## The loop, end to end

1. Testers buy credits → NEAR accrues on the board above its reserve floor.
2. Revenue keeper: `get_revenue_state` pre-read (free); signs `distribute_near` only when
   withdrawable > 0 (10% team, 90% buyback), `distribute_mpoo` only when mPOO is waiting
   (10/20/70 split — the 70% goes straight to the staking contract since 2026-11-06).
3. After a successful `distribute_mpoo`, the keeper calls `sync_inflow` on the staking
   contract, signing with a function-call key restricted to exactly that
   (allowance 0.25 NEAR, receiver `57590a9e…`, method `sync_inflow`; added to the fee signer
   on chain 2026-11-06).
4. Buyback keeper: preflight → returns stray mPOO/wNEAR → sizes a chunk (spendable − 0.1
   gas reserve, min 0.05, max 0.5 NEAR, impact cap 50 bps) → swaps wNEAR→RHEA (Ref #6458)
   then RHEA→DIARHEA→mPOO (DCL) → returns the mPOO to the board via `ft_transfer_call`.
5. Next keeper hour distributes the fresh mPOO; stakers' pool grows.

## The buyback account's trust exposure (unchanged, K spec)

The buyback FA key can take whatever sits on that account between runs. With a 0.5 NEAR cap
and hourly runs the standing balance stays small. Recovery path if the key leaks:
`set_buyback_account` (owner, 7-day wait) onto a fresh account.

## Config facts

- Route evidence (fresh quotes, all candidates): `ops/buyback/evidence/2026-11-06-mainnet-route.json`.
  Configured route `near-ref6458-rhea-dcl-diarhea-mpoo` quoted best: 5433.7 mPOO gross per
  0.01 NEAR. Route is configuration, not code — re-verify before touching it.
- Keeper signer: `247460301d7086e5586a6aaae5a1e361e87f3c5ef4779aef54be883eea803147`
  (0.05+ NEAR; idle hours cost nothing since the preflight; a distribution hour costs
  ~0.0006 NEAR in fees). **Top it up with ~0.5 NEAR when it drops below ~0.2.**
- Buyback account registered for storage on wrap.near, token.rhealab.near,
  mpoo.nearlytrade.near (2026-11-06). Staking contract registered on TOILET + mPOO; burn
  address registered on TOILET.
- Keys are read at runtime from `~/.near-credentials/mainnet/` — no secret is stored in the
  scripts, the plists, or the logs.

## First-fire expectations

The very first swap of the buyback keeper will be its first-ever executed swap on mainnet
(unit tests only before this). Watch the first `swap` step's JSON lines
(`quotedOut` vs `received`, `differenceBps` — the 2% mPOO buy tax shows up as
`received_below_quote`, which is expected and logged, not a failure). Failure semantics:
value never leaves the loop; it waits on the buyback account as NEAR, wNEAR, or an
intermediate token, and the next hourly run resumes from where it stopped.

## Not yet proven

- Any executed swap (route validated by quotes only).
- `distribute_near`'s callbacks on real failed legs (unit-tested, sandbox-tested).
- The launchd jobs surviving a reboot of the Mini (agents reload at login; verify with
  `launchctl list | grep metapoo` after the next restart).
