# TOILET economy v1 — issuance, staking, burns, and what the flywheel actually needs

**Date:** 2026-10-28 · Status: **proposed design, not ratified** — three decisions at the end block
implementation. Supersedes the TOILET mechanics in the 12 October economy plan for everything that
concerns issuance, staking and burning; the paint-credit payment model is unchanged
([paid model v1](../payments/2026-10-28-paid-model-decisions.md)).

Owner's stated thesis: *"It becomes expensive (opportunity cost) not to be earning TOILET, so there is
constant demand for paint credits for constantly overwritten cells. The more people paint over each
other, the more valuable TOILET becomes, because there is more revenue to distribute."*

That thesis is directionally right. It has one hard arithmetic constraint that changes the design.

---

## 1. The one equation that sets the emission schedule

Let `R` be annual paint revenue, `M` the TOILET market cap, `S` the 1B supply, `e` the annual emission
as a fraction of `S`, and `y = R/M` the yield stakers actually receive from revenue.

The value emitted per year is `e × M`. For stakers not to be paid mostly in new tokens:

```
e ≤ y
```

**Annual emission as a % of supply must be at most the target yield.** Emit 100 %/year and every
"yield" is dilution. Emit 10 %/year and a 10 % revenue yield is fully backed by revenue.

Consequence: **"1B lasting at least one year" is the least sustainable option, not the safest.**
It means emitting 100 % of supply per year.

| schedule | per day | TOILET per cell-day, full board (16,384) | per cell-day at today's 2,301 painted | emitted value vs revenue @10 % yield |
|---|---|---|---|---|
| 1B over 1 year | 2.74 M | 167 | 1,191 | **10× revenue** |
| 1B over 2 years | 1.37 M | 84 | 595 | 5× revenue |
| 1B over 4 years | 685 k | 42 | 298 | 2.5× revenue |
| **1B over 10 years** | **274 k** | **17** | **119** | **1× revenue (sustainable)** |

## 2. What a cell actually earns (and why the flywheel is real but small)

Cell-day yield depends on how many cells share the emission, so early adoption pays enormously and a
full board pays little. At 10 % target yield, TOILET price = `R/10` per 1B supply:

| paint revenue/yr | TOILET price | market cap | cell-day @2,301 painted | payback on a $0.0116 pixel | cell-day @full board | payback |
|---|---|---|---|---|---|---|
| $5,000 | $0.00005 | $50k | $0.0298 | **0.4 days** | $0.0042 | 2.8 days |
| $25,000 | $0.00025 | $250k | $0.149 | 0.1 days | $0.021 | 0.6 days |
| $100,000 | $0.001 | $1M | $0.595 | 0.02 days | $0.084 | 0.1 days |

Read this honestly, two ways:

- **Good news:** at any plausible revenue, holding a painted cell for a day or two repays its purchase
  price. The "opportunity cost of not earning TOILET" is genuine — it is not a narrative, it is
  arithmetic.
- **Bad news:** the payoff is that large because the board only holds 16,384 cells and they cost
  $0.0116 each. **The entire board costs $190** (41 NEAR at 0.0025 NEAR/pixel; $523 at 0.0069).

### The capture problem this creates

One account can buy every cell for **$190** and farm 100 % of emission, forever. That is not a game
economy, it is a coupon.

Required mitigations, pick one or combine:

1. **Cap earning cells per account** (e.g. the first 128 cells earn; the rest are paint-only). Simple,
   visible in the UI, and it makes breadth of artists — not capital — the yield driver.
2. **Quadratic weight**: a cell's emission weight = `1/√(cells held by that account)`.
3. **Emission keyed to paint revenue, not time** (§3 below), so a static board earns nothing new.

## 3. Recommended: revenue-keyed emission with a hard 1B cap

Instead of a calendar schedule, emit per unit of paint revenue:

```
emit = k × (NEAR of paint revenue recognised this epoch)
cap  = 1,000,000,000 TOILET, hard, never raised
```

Choosing `k` fixes how long the cap lasts **in revenue terms**, which is the only thing that actually
backstops the token. Example: `k = 40,000 TOILET per NEAR of revenue` → the cap is reached after
25,000 NEAR of cumulative revenue (≈ $116k at $4.63).

Why this is better than a calendar:

- Emission cannot outrun revenue, so `e ≤ y` holds by construction.
- A quiet month emits little; a paint war emits a lot. The flywheel's own activity funds the reward.
- "Lasts at least a year" becomes a *floor* you can guarantee with a minimum rate, and a cap you cannot
  break.
- The burn page gets an honest numerator: *issued / remaining* is a function of money actually spent.

Add a minimum (e.g. `max(revenue-keyed, 0.02 % of cap per day)`) if you want a guaranteed drip during
quiet periods — but a minimum is dilution by definition, so keep it small and disclose it.

## 4. Staking: this contradicts a decision already in the repo

`docs/00-shared-decisions.md:79` and the economy plan both say, as user-confirmed:

> "**MPOO is the staking asset** … Users stake MPOO … and receive net game revenue in MPOO after a
> disclosed operating reserve and liabilities."

The new design says TOILET is staked to receive platform profit. **Both assets cannot claim the same
revenue.** This is a real fork:

| option | what stakers hold | revenue split | consequence |
|---|---|---|---|
| **A (recommended)** | TOILET only | 100 % of net revenue to TOILET stakers, paid in mPOO | one yield asset, clean accounting, MPOO holders lose the revenue claim (was never live) |
| B | both | split, e.g. 60 % TOILET / 40 % MPOO | two claim stacks on one cash flow; needs a governance-set split and two accounting trails |
| C | MPOO only (old decision) | 100 % to MPOO stakers | TOILET becomes a pure points token with no cash flow — kills the owner's thesis |

Also unresolved and blocking: **revenue currently cannot leave the contract at all.** The paid board has
no withdraw/treasury method (`pub fn` inventory in `payments.rs` / `lib.rs`). "Distribute profit" is
unimplementable until M2 adds treasury withdrawal with an explicit outstanding-credit liability rule.

Payout currency note: paying in mPOO means the game must *acquire* mPOO with NEAR revenue. Buying on
NEARLY is a taxed DEX trade whose buy tax applies **after** the exchange's minimum-output check
(per NEARLY's own docs), so a quote is not the delivered amount. Budget for slippage + tax, or hold a
mPOO treasury reserve and pay from it.

## 5. Burns: what is actually enforceable where

Owner asked for mPOO-style buy/sell tax plus a 10 % paperhand tax on vault withdrawal, and a burn page.

**Verified on chain:** `mpoo.nearlytrade.near` exposes `burn`, `ft_transfer`, `ft_transfer_call`,
`storage_deposit/withdraw`, `ft_total_supply` — and **no** `get_tax_rate`, `tax_rate`, `mint`, or
`owner` method. So:

- mPOO has **no mint** → its supply is fixed and burns are irreversible. Good precedent for TOILET.
- mPOO's tax is **not a token feature**. It is enforced by NEARLY's Rhea pool on transfers into/out of
  that pool. A plain wallet transfer is untaxed.

Therefore, for TOILET:

| mechanism | enforceable? | where |
|---|---|---|
| 10 % tax on vault withdrawal (paperhand) | **yes** | your own staking/vault contract — you control `withdraw` |
| burn on staking exit | **yes** | same |
| buy/sell tax on a DEX | **only if** TOILET is listed on a pool that supports it (NEARLY/Rhea), or you ship a wrapper token you control | not a property of the token |
| trade tax on wallet-to-wallet | **no** — and it would need a wrapper contract | n/a |

Design consequence: if you want buy/sell tax, **TOILET must be a tradeable NEP-141** and either listed
on NEARLY with their tax configuration or wrapped. If TOILET stays an internal ledger, the only taxes
possible are the ones your own contract enforces (vault exit, and optionally a fee on claiming).

A 10 % exit tax is a strong commitment device but it is also a gameable burn: stake/unstake cycles
burn 10 % each round for whoever wants to manufacture burn metrics. Cap the tax at one application per
position and it is honest.

## 6. Burn page — exactly what is derivable

| Display | Source | Status |
|---|---|---|
| mPOO total supply | `ft_total_supply` on `mpoo.nearlytrade.near` | ✅ live: 971,848,387.679277849689475796 MPOO |
| mPOO **burned** | genesis supply − current supply | ⚠️ genesis must be confirmed. **If genesis was 1,000,000,000, burned ≈ 28.15 M** — plausible, not verified |
| mPOO **circulating** | total − treasury − LP − vault | ⚠️ not on-chain-derivable; needs a labelled address list maintained by us |
| TOILET issued | `issued_total` in the board/economy contract | ✅ once the contract tracks it |
| TOILET burned | `burned_total` | ✅ same |
| TOILET left to issue | cap − issued | ✅ same (decide whether burned tokens reduce *issuable* or only circulating) |
| Emission schedule / next epoch | contract view (`emission_config`) | ✅ same |

Rule for the page: **every number must name its source and its block height.** A "circulating supply"
figure with no address list behind it is the same class of fabrication as a mock quote — and this page
is the one users will screenshot when they accuse the project of lying.

## 7. Roadmap change

This pulls TOILET from "deferred, unspecified" to "specified, blocked on three prerequisites". It does
**not** move into the MVP path — the paint economics still have to work first.

- **M2 gains a hard prerequisite:** treasury withdrawal + revenue accounting. Without it there is no
  profit to stake against, and the whole thesis is undefined.
- **M4 becomes concrete** and splits into: TOILET contract (fixed supply, emission config, per-account
  earning cap), vault/staking contract (revenue distribution, exit tax), and the burn page.
- **M1/M3 unchanged.** The free-paint window and the launch price are still the near-term decisions.

## 8. Decisions needed before any of this is built

1. **Staking asset:** TOILET replaces MPOO as the revenue claim (option A), or both split it (B)?
2. **Emission model:** revenue-keyed with a 1B cap and a floor (recommended), or a calendar schedule —
   and if calendar, accept `e > y` dilution and say so in the docs.
3. **TOILET tradeability:** internal ledger (no buy/sell tax possible), or NEP-141 (tax possible, plus
   DEX/tax compliance work and a wrapper decision)?
4. **Earning cap:** max cells per account that earn emission (recommend 128), otherwise one wallet buys
   the board for $190 and farms everything.

## 9. One contract change this asks for regardless

`set_credit_prices` is owner-only, callable **at any time**, requires 1 yocto, has **no bounds**, and
**emits no event**. In-flight purchases are protected by `expected_price`, so buyers cannot be
sandbagged — but there is no on-chain record that the price moved, and no limit on the move. Before a
mainnet paid board: emit a `price_changed` event and bound the change (e.g. ≤ 2× per call, or a 24 h
cooldown), so a compromised owner key cannot reprice to 1 NEAR mid-session.
