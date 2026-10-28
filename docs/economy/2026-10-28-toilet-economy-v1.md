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

> **These figures assume a static holder who keeps the cell all day.** They are the upper bound only.
> Once a cell is repainted several times a day the emission splits between the successive owners and
> the per-paint return collapses — see §10, which supersedes the payback column below.

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

---

## 10. Correction: repaints dominate the model (owner's objection, accepted)

The §2 payback column assumed one owner keeps a cell for a full day. In the actual game a cell changes
hands many times a day, so the emission for that cell-day is split between every successive owner.

With `n` = repaints of a cell per day, `N` = painted cells, `PX` = pixel price, `p` = TOILET price,
`E_day` = daily emission:

```
per-paint emission value = (E_day / (N × n)) × p
per-paint cost           = PX
ratio                    = (E_day × p) / (N × n × PX)      ← n cancels
```

**Repaint frequency cancels out.** The per-paint return equals *annual emission value ÷ annual
revenue*, whatever `n` is. Measured at 0.0025 NEAR/pixel, full board, 1B over two years, $0.00025 TOILET:

| repaints/cell/day | paint revenue/day | emission value/day | return per paint |
|---|---|---|---|
| 1 | $190 | $342 | **1.81×** |
| 3 | $569 | $342 | 0.60× |
| 10 | $1,896 | $342 | 0.18× |
| 50 | $9,482 | $342 | 0.04× |

What this actually means — and it is better news than a rebate, once stated properly:

- **High activity raises revenue without raising emission.** The token's implied yield falls, which
  means at a fixed price it becomes cheap; the market repriced against a real cash flow is where the
  value comes from. The owner's thesis is correct, but the mechanism is *revenue growth*, not a
  per-paint subsidy.
- **`e` chooses the whole character of the token.** Fast emission ⇒ high yield ⇒ cheap token ⇒ generous
  per-paint rebate. Slow emission ⇒ low yield ⇒ expensive token ⇒ small rebate. Total paint economics
  are unchanged; only the split between "cheap token now" and "valuable token later" moves.
- **Equilibrium is `y = e`.** Emission rate is effectively the yield promise. Pick it as a promise, not
  as a calendar convenience.

Implementation consequence (proven pattern, not cleverness): a **MasterChef-style accumulator** —
global `reward_per_cell_accumulator`, per-account `reward_debt` and `cells_owned` — settles emission
on every `draw`/`draw_many` without iterating over cells. Per-cell checkpointing would be both more
expensive and more bug-prone at 16,384 cells with dozens of daily ownership changes each.

## 11. Anti-capture measures: two different caps for two different problems

The owner asked for a daily cell limit, optionally proportional to holdings. There are two distinct
threats and they need different limits:

| threat | limit | why |
|---|---|---|
| **Emission capture** — one wallet buys the board for $190 and farms 100 % of TOILET | **cap earning cells per account** (recommend 128) | a painting cap does not stop a holder; a holding cap does |
| **Capital dominance** — one funded bot repaints everything every minute, so the wall stops being communal | **daily paint quota** | converts money into time-gated influence; also the revenue dial |

### Which holding should the quota scale with?

| basis | verdict |
|---|---|
| **cells currently owned** | ✅ **recommended.** No bootstrap problem, no external token, and it makes defence matter: losing cells loses capacity. Also needs state you already need (below). |
| TOILET held | ❌ chicken-and-egg — TOILET is the reward, so a new player could not paint until they earned. Also conflicts with staking the same tokens. |
| mPOO held | ⚠️ workable, gives mPOO an access utility, but double-charges the player (mPOO for access *and* mPOO for credits) and ties access to an external price. |

Recommended shape: `quota = min(512, 32 + 4 × cells_owned)` per day.

| cells owned | paints/day | max spend/day |
|---|---|---|
| 0 | 32 | $0.37 |
| 10 | 72 | $0.83 |
| 64 | 288 | $3.33 |
| 256+ | 512 | $5.93 |

One map, `cells_owned[account]`, serves **both** the earning cap (§2) and the quota — increment the new
artist, decrement the displaced one, on every draw. No separate index is needed.

### The quota is also the revenue dial

| cap/day | 25 users | 100 users |
|---|---|---|
| 32 | $3.4 k/yr | $13.5 k/yr |
| 64 | $6.8 k/yr | $27 k/yr |
| 128 | $13.5 k/yr | $54 k/yr |
| 256 | $27 k/yr | **$108 k/yr** |

So choose the cap from the revenue target, then size the emission schedule against it — not from
anti-bot anxiety alone.

## 12. Which asset stakes for revenue: recommendation

**TOILET holds the revenue claim. mPOO is the money.** One cash flow, one claim stack.

Reasons:

1. **TOILET has no other source of value.** Without the claim it is a fixed-supply points token with a
   burn page — decoration. With it, earning TOILET is a claim on the game's future, which is exactly the
   "opportunity cost of not earning" the owner described.
2. **mPOO keeps a stronger, simpler job**: pay for credits, and burn. Burning a share of mPOO credit
   receipts is a direct, enforceable sink (the token exposes `burn`, and the board owns the mPOO it
   receives), and it serves the recorded primary objective — genuine mPOO acquisition and supply burn.
3. **It avoids mPOO becoming a revenue-share staking asset** with its own vault, accounting and
   regulatory shape, on top of everything else.

Honest counter-argument, which the owner should weigh: mPOO staking would support mPOO's price more
directly (stakers buy and hold), whereas paying TOILET stakers *in mPOO* is buy-and-distribute, so the
stakers may immediately sell — volume without durable price support. If mPOO price is the primary
objective, that point deserves a deliberate answer, not a hand-wave.

**Still blocking either choice:** revenue cannot leave the contract. No withdraw/treasury method exists,
so there is nothing to distribute until M2 adds one with an outstanding-credit liability rule.

---

## 13. Capital dominance: the bot is expensive, and the community can tax it

Owner's question: how much can a bot realistically spend? Answer: **the same as the community, plus a
speed premium.** Overwriting costs exactly what painting costs, so dominance is priced 1:1 with
resistance. There is no cheap way to entrench ownership.

At 0.0025 NEAR/pixel ($0.0116), full board = 16,384 cells = 41 NEAR = **$190**:

| community | paints/day | community spend/day | bot must match/day | bot per year |
|---|---|---|---|---|
| 25 users × 32/day | 800 | $9 | $9 | $3,380 |
| 100 users × 32/day | 3,200 | $37 | $37 | $13,520 |
| 100 users × 128/day | 12,800 | $148 | $148 | $54,078 |
| 500 users × 512/day | 256,000 | $2,963 | $2,963 | $1,081,568 |

So a determined whale can suppress a small community for four figures a year. That is cheap enough to
be a real risk, and the quota does **not** fix it:

> **The daily quota is a 15 % surcharge, not a wall.** Bypassing it costs one registered account
> (0.01 NEAR fee + ~0.0018 NEAR storage ≈ $0.055) for 32 extra paints/day worth $0.37. Sybil is
> cheap; the quota merely taxes the whale's volume.

The bot's only genuine advantages are **uptime and reaction speed** — it repaints within seconds, humans
sleep. Price that advantage directly and it disappears:

### Repaint multiplier — the anti-dominance mechanic (uses state we already have)

`PixelRecord.written_at_ns` already stores when a cell was last painted, so the cost can be a function
of recency with **no new contract field**:

| time since the cell was last painted | credit cost |
|---|---|
| more than 60 min | 1 credit |
| 10–60 min | 2 credits |
| under 10 min | 4 credits |

Consequences:

- A human painting fresh territory pays 1×. A bot reacting instantly pays 4×.
- The community can **deliberately tax the bot**: every cheap poke forces a 4× response. 100 users
  spending $37/day of pokes force the bot to spend $148/day. The war becomes a mechanism where being
  annoying is a winning strategy — which is exactly the communal dynamic the owner described, and it is
  funny rather than unfair.
- It also restores, in a minimal and honest form, the pressure-pricing idea retired in D1. Not global
  region heat — just per-cell recency.

Product surface for it: a **contested cells** counter (cells repainted in the last hour) and a "poked
the bot" leaderboard. Cheap to compute from data already on chain.

## 14. Splitting revenue: 70 % stakers / 30 % mPOO — make the 30 % a rule, not discretion

Owner's proposal: 70 % to TOILET stakers, 30 % to burn mPOO or an mPOO treasury with discretion to
burn or fund a TOILET/mPOO liquidity pool.

Recommendation: **three named buckets with fixed, published rules** rather than owner discretion:

| bucket | share | rule |
|---|---|---|
| TOILET stakers | 70 % | paid pro rata to staked weight, monthly batch |
| mPOO burn | 15 % | automatic burn of mPOO receipts; no discretion, no swap needed |
| treasury / LP incentives | 15 % | published policy, capped, reported on the page |

Why not discretion: the burn page's credibility *is* the product. "30 % at owner discretion" is
indistinguishable from "30 % to the team" to anyone auditing it. A rule that is observable on chain is
worth more than a promise of good judgement — and it costs nothing to implement.

### What NEARLY actually allows (verified 2026-10-28, nearly.trade/docs)

| item | rule |
|---|---|
| tax | **0–4 % per side**, fixed at launch, written into the token, **cannot be changed afterwards** |
| total cost per trade | tax + 1 % Rhea DCL pool fee = at most 5 % |
| tax currency | taken **in the token** |
| destinations | creator (sold for NEAR) · **buyback and burn** · **holders (pro rata balance payouts)** |
| holder payouts | automatic ~every 15 min once ≥ $0.10 is owed |
| wallet-to-wallet | **never taxed** |

**Verified directly from the token contract** (`get_tax` on `mpoo.nearlytrade.near`, mainnet):

```json
{"tax": {"buy_bps": 200, "sell_bps": 300,
         "pairs": ["dclv2.ref-labs.near"],
         "admin": "nearlytrade.near",
         "exempt": ["lock_6.nearlytrade.near", "feeswap.near"]},
 "pending": "0"}
```

Three things this settles, and one it opens:

- **2 % / 3 % confirmed on chain**, not just on the page.
- **The tax is venue-scoped, not a transfer tax.** It fires when the counterparty is the Rhea DCL
  exchange contract (`dclv2.ref-labs.near`). Every DCL pool trade is taxed — including the second
  mPOO/stNEAR pool — but wallet-to-wallet and trades on other venues are not.
- **The split is not in the token.** 34/33/33 lives in `nearlytrade.near` (the `admin`), so a burn page
  reading only the token cannot compute the burn share. It needs the factory, or the page's own figures
  must be labelled as sourced from NEARLY.
- **Open: `admin: nearlytrade.near` exists**, plus a `pending` balance. The docs say rates are fixed at
  launch, but the contract exposes an admin field. Treat "immutable tax" as a documentation claim until
  the token code is read — it matters if anyone models future burn rates from it.

Three consequences for the plan:

1. **The 4 % ceiling is a NEARLY-launch constraint, not a TOILET constraint.** TOILET is a separate
   token, so its tax is whatever we code — there is no 4 % cap on it. But a token-level transfer tax
   makes TOILET a fee-on-transfer asset, which breaks pooling on standard AMMs (LPs mis-account the
   deposit). If TOILET must trade on Rhea, the burn belongs in **our** exit paths, not in `ft_transfer`.
2. **"Buyback and burn" already exists as a launch parameter** — it is live on mPOO today. Verified from
   the token page: **2 % buy / 3 % sell, split 34 % holders · 33 % creator · 33 % burn**.
3. **mPOO holders already receive a pro-rata payout** (34 % of every tax, paid automatically). That is a
   live claim stack. Adding mPOO *staking* for game revenue would be a second claim on the same token,
   and TOILET staking a third. This is why TOILET should hold the game-revenue claim and mPOO should keep
   the trade-tax payout it already has.

### Decided 2026-10-28: the tax is immutable, and the token has no owner

The authority question — who can change what a holder pays — was answered by removing the power rather
than bounding it. Rates, split, treasury and the exempt list are set in `new()` with no setter, and
`mint`, `set_paused` and the handoff of the emitter role are emitter-only. The only account with any
authority over the token is the game contract, whose own authority is already documented.

Three consequences worth stating before anyone builds against it:

1. **The AMM/sandbox tax rehearsal must pass before the deploy**, because the rates are frozen at deploy.
   This inverts the usual order and is the single schedule risk of the decision.
2. **A bug in v1 is fixed by redeploying a new token, not by an upgrade.** Acceptable only while issued
   supply is small; revisit before emission reaches meaningful volume and record the trigger in the
   contract README.
3. **The 34/33/33-style split cannot be tuned after launch.** Pick it from the burn-page story, not from
   a guess that can be corrected later.

A bounded owner with a cooldown was the alternative. It was rejected because it still means someone can
raise a holder's cost — the exact question listings and holders ask — and it needs a timelock to be
honest, which is more machinery than deleting the setter.

Technical constraint worth recording: NEARLY's factory **mints a new 1B token** and puts the whole
supply in its own pool at 1,000 NEAR FDV. It cannot launch an existing token. A game-emitted TOILET
therefore cannot be launched through NEARLY — it would need a pool created directly on Rhea with
liquidity we supply. Decide that before promising "TOILET/mPOO LP incentives", because those incentives
require a pool that does not exist yet.

### The constraint nobody has priced: revenue dwarfs the mPOO market

Verified from the token page, 2026-10-28:

| mPOO metric | value |
|---|---|
| market cap | **$16.5 K** |
| price | $0.0000165 |
| liquidity | $7.0 K ($3.0 K of it in DIARHEA) |
| 24 h volume | $1.2 K |
| holders | 153 |
| ATH → now | $55.5 K → $16.5 K (−70 %) |
| tax | 2 % buy / 3 % sell, 34 % holders · 33 % creator · 33 % burn |

At those numbers **the game's projected revenue is larger than the entire mPOO market cap**: $27 k/yr
is 1.6× the token, and a single monthly distribution ($2,250) is 32 % of the pool's liquidity. A
"buy mPOO with NEAR revenue" step is therefore not a small friction cost — at any real revenue it is a
price-moving event every month, and TOILET stakers paid in mPOO would be dumping into a $7 K pool.

Two honest readings:

- **If the goal is volume and attention on mPOO**, this is a feature: monthly revenue buys would be the
  largest recurring buy pressure the token has ever had. Say so explicitly and size the batches.
- **If the goal is stakers receiving a stable claim**, pay in NEAR. Converting to mPOO adds pool fee,
  tax, slippage, and a price impact that grows with success.

Also note mPOO holders already earn roughly `$1.2 K × 2.5 % × 34 % ≈ $10/day` from trade tax. That is a
live, working holder payout — not something to duplicate.

## 15. Paying in mPOO costs about 5 % to convert

Owner's flywheel includes converting NEAR revenue into mPOO before distributing. Verified cost:
1 % pool fee + up to 4 % tax + slippage on each conversion. On $27 k/yr of revenue that is roughly
**$1,350/yr** burned in friction — acceptable if volume is the point, but it must be disclosed, and it
means stakers receive ~95 % of the headline share.

Cheaper alternative with the same volume effect on the buy side: burn the mPOO you receive directly
(no swap), and pay stakers in NEAR. Choose deliberately; both are defensible, but "70 % of revenue"
should name whether that is before or after conversion.

---

## 16. Repaint multiplier — implementation status (not built yet)

The owner read "uses state we already have" as "already in the code". It is not. Precise status:

| piece | status |
|---|---|
| `PixelRecord.written_at_ns` — when the cell was last painted | ✅ already stored and returned by `get_pixel`/`get_pixels` |
| `draw` charging **1 credit** | ✅ current behaviour, flat |
| `draw_many` charging **`cells.len()`** | ✅ current behaviour, flat |
| recency-based pricing | ✅ **implemented 2026-10-28** — `Tunables` + per-cell cost in `draw`/`draw_many` |

Shipped with **54 contract tests** and a 365 KB wasm. Defaults: **1 credit** for an empty cell or a
repaint older than 60 min, **2 credits** at 10–60 min, **4 credits** under 10 min. `draw_many` prices every
entry and charges a single debit, so a rejected stroke stores nothing and costs nothing; a cell repeated
inside one drag pays the repaint rate on its second entry. `get_cell_cost(x, y)` returns the live price
and `get_tunables()` returns every knob — the page never re-implements the rule.

The original change list, for the record:

1. In `draw`/`draw_many`, read the existing record for each cell, compute `now − written_at_ns`, map it to
   a tier, and charge the sum instead of `1` / `len()`. Cost is bounded by `MAX_DRAW_BATCH = 64` extra
   storage reads per stroke.
2. Insufficient credits must reject the whole stroke before any write (the existing all-or-nothing
   property must survive).
3. `get_pixel` should return the current price tier so the page never has to duplicate the rule.

Front-end requirement (owner asked for clarity — this is the part that decides whether it feels fair):

- **Per-cell badge** on hover/tap: "repaint 2 min ago · 4 credits".
- **Stroke total before submit**: "this stroke: 23 cells · 31 credits". A mixed-age drag costs a mixed
  amount, so a single price shown in the dock would be a lie.
- **A one-line legend in the default view**, not behind `About`: "Fresh cells cost more to repaint.
  Wait an hour and it is 1 credit again."
- **Never** show the multiplier only as a rejection message after the user has committed the gesture.

## 17. Can these dynamics change after mainnet launch? What must be decided now?

Short answer: **most of them can, if and only if we keep an upgrade path and put the tunables in
storage now.** The dynamics themselves do not have to be decided today; the *upgradeability* does.

On NEAR, contract code can be replaced on the same account while the state persists, so the real
question is state compatibility, not deployment:

| change | cost after launch |
|---|---|
| price, repaint tiers, quota, caps, earning cap — **if stored as parameters** | owner transaction, no code change |
| pure logic change that reads existing fields (e.g. the repaint multiplier) | code upgrade, **no migration** — layout unchanged |
| new counters (`cells_owned`, `outstanding_credits`, `issued_total`) | code upgrade **plus a migration** — adding Borsh fields breaks deserialization of old state |
| changing the credit ledger's meaning or key prefix | migration + explicit review; the highest-risk class |

Status, 2026-10-28: **items 1, 2 and 4 are implemented in `contracts/paid-board`.** `upgrade(code)` is
owner-only, `Tunables` holds every knob including the ones disabled at launch, and `cells_owned` +
`outstanding_credits` ship from the first deployment. Item 3 — a rehearsed migration — remains open, and
it is the only one that still blocks mainnet money.

The decisions, for the record:

1. **Keep a documented upgrade path** — a full-access key or a self-upgrade method. The paid contract
   currently has neither, and without one every item in the table means redeploying to a new account and
   abandoning all credits and pixels.
2. **Ship a `Tunables`/`Config` struct from day one** holding price, repaint tier boundaries and
   multipliers, quota base/multiplier/cap, float cap, earning cap — even the ones disabled at launch.
   This is the cheapest possible insurance: ~30 lines and a few tests now, versus a migration for every
   knob later.
3. **Rehearse one migration on testnet state** before mainnet money, so the first real one is not the
   first one ever attempted.
4. **Decide `cells_owned` and `outstanding_credits` now, or accept a migration later.** They are needed
   by the quota, the earning cap, the MasterChef accumulator and the float cap — four features sharing
   two counters. Adding them at launch costs almost nothing; adding them after is a migration of the
   whole state.

Rule of thumb for the owner's "reversible choices advance" criterion: **anything we expect to tune
should be a parameter, and anything we expect to add should be additive state planned now.** The game
dynamics are then post-launch work, not a post-launch crisis.
