# mPOO → NEAR price route — 3 November 2026

Scope: public read-only NEAR mainnet quotes. No key was loaded, no approval was requested, and no
swap, deposit, transfer or deployment occurred. This settles two questions for C8: **how** the weekly
mPOO price is measured, and whether a mPOO pool of our own would replace that measurement.

Capture: `2026-11-03T02:24:45Z`, blocks `222806538`–`222806541`. Prices move; every number here is a
dated observation, not a setting.

## The route

`mPOO → DIARHEA → RHEA → NEAR`. Two DCL pools then one classic pool, because the DCL near-side is dry
(see "Dead legs"):

| hop | venue | pool | depth | quoted output |
|---|---|---|---|---|
| 1. mPOO → DIARHEA | RHEA DCL | `diarhea.nearlytrade.near\|mpoo.nearlytrade.near\|10000` | ~$4.2k, $554/24h | `0.116385968324762626` DIARHEA per 1 mPOO |
| 2. DIARHEA → RHEA | RHEA DCL | `diarhea.nearlytrade.near\|token.rhealab.near\|10000` | ~$22.6k, $1,166/24h | `0.000183632963650275` RHEA per 1 mPOO (hops 1+2 in one `quote`) |
| 3. RHEA → wNEAR | ref classic | pool `#6458`, fee 0.3% | **~$942k, $149k/24h** | `2259087258147499309` yocto wNEAR for that RHEA |

Implied: **1 mPOO ≈ `0.0000022591` NEAR**. With NEAR at $3.85 that is ~$0.0000087, and a
**~$8.4k market cap** on the 971,039,157 mPOO supply.

The RHEA exit is what makes this route worth using: pool #6458 holds 9,963,779 RHEA and 122,945 wNEAR
and turns over $149k a day — about **40× the entire mPOO market**. The mPOO price is therefore limited by
the mPOO side, not by the NEAR side.

Reproduce (all read-only `query` calls against `https://rpc.mainnet.fastnear.com`):

```sh
# hops 1+2 (DCL quote takes a pool_ids route)
dclv2.ref-labs.near.quote
  {"pool_ids":["diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000",
               "diarhea.nearlytrade.near|token.rhealab.near|10000"],
   "input_token":"mpoo.nearlytrade.near","output_token":"token.rhealab.near",
   "input_amount":"1000000000000000000"}

# hop 3 (classic pool, different method)
v2.ref-finance.near.get_return
  {"pool_id":6458,"token_in":"token.rhealab.near","token_out":"wrap.near",
   "amount_in":"183632963650275"}
```

A single `quote` cannot cover the whole route: `dclv2` quotes only DCL pools, and the only liquid
RHEA/wNEAR venue is classic. The weekly number is therefore two calls and one multiplication.

## Dead legs, and one mislabel to fix

- **DCL RHEA/wNEAR has no liquidity at any fee tier.** `token.rhealab.near|wrap.near` at 100, 400,
  2000 and 10000 all report `liquidity: 0`, and a three-hop DCL `quote` for mPOO→wNEAR returns `0`.
- **DCL DIARHEA/wNEAR** (`diarhea.nearlytrade.near|wrap.near|10000`) also quotes `0`; the classic
  `#8715` pool does answer (`1.9967e-6` NEAR per mPOO) but carries $1.9k and **$28 of 24h volume**.
  Usable as a cross-check, not as the primary exit.
- **Correction to [`2026-11-03-rhea-route-evidence.md`](2026-11-03-rhea-route-evidence.md):**
  `token.v2.ref-finance.near|wrap.near|400` is **REF/wNEAR**, not RHEA/wNEAR. RHEA is
  `token.rhealab.near`. Anyone who builds a "RHEA has a NEAR leg on DCL" assumption from that line
  will ship a route that returns zero.
- `token.rhealab.near` is RHEA; `diarhea.nearlytrade.near` is DIARHEA; `mpoo.nearlytrade.near` is
  mPOO with 18 decimals. Three similarly-named tokens — verify by `ft_metadata`, not by name.

## Derived settings for the board

`mpoo_per_credit = near_per_credit / (mPOO per NEAR) × 0.8`, i.e. mPOO pays 20% less than NEAR:

| quantity | value at this capture |
|---|---|
| mPOO per NEAR | ~442,657 |
| fair (no discount) mPOO per 0.0025-NEAR credit | ~1,107 |
| with the 20% holder discount (C8 rule) | ~885 |
| **launch value decided by the owner** | **1,000 mPOO per credit** |

1,000 is a deliberate round number: at this price it is a **~9.6% discount** to the NEAR price
(0.0022591 NEAR received against 0.0025), conservative to the board and inside the 20% rule. When the
weekly recompute lands near 885 the discount reaches the full 20%; drift between 885 and 1,107 stays
inside the intended band. Record the number used in each update.

Two consequences worth keeping visible:

- **Set it at deploy, in `new()`.** `new()` takes `mpoo_per_credit` directly; the setters are bounded
  to ×2 / ÷2 per 24 h (`set_mpoo_price`). A board launched at `1` would need ten doublings — ten days —
  to reach 1,000. Getting this wrong at init is not a one-transaction fix.
- **The daily cap is value-bounded.** `mpoo_daily_credit_cap` is already enforced
  (`MpooDailyCapReached`, default `0` = sales closed). At 1,000 mPOO per credit and the 20,000-credit
  testnet cap, the maximum mPOO intake is 20M mPOO ≈ 45 NEAR ≈ $174/day of credit value. That number,
  not the credit count, is what bounds pump exposure between weekly updates.

## Would our own mPOO/NEAR pool change the price? No — decided

Creating a mPOO/NEAR pool is permissionless and would make the route one hop. It does **not** replace
the weekly measurement, for three reasons:

1. **A seeded pool reports the ratio we chose.** The "market price" would be our own liquidity, so the
   pool is a hand-set constant with capital at risk. At this price, 1 NEAR is ~442,657 mPOO, so even a
   modest pool needs a large share of supply:

   | NEAR side | mPOO required | share of the 971M supply |
   |---|---|---|
   | 50 NEAR ($192) | 22.1M | 2.3% |
   | 250 NEAR ($962) | 110.7M | 11.4% |
   | 1,300 NEAR ($5,005) | 575M | 59.3% |

   A pool small enough to be affordable is small enough that a few hundred dollars moves it — and a
   contract that prices credits from it can be moved the same way.
2. **It would price against our own flow.** The board already takes mPOO and the buyback keeper (TR-K)
   is specified to buy mPOO with NEAR. Owning the only mPOO/NEAR pool means the keeper trades against
   our own LP, and the quote becomes a function of our own activity.
3. **The decision is already in the contract.** `set_mpoo_price`'s doc comment states the intent:
   "move pricing authority to governed, bounded quotes with freshness checks if USD pricing is
   automated. **No pool spot-price oracle.**"

**Decision: the pool is a route, not a price.** If one is created later, it is for ACQ-3 (the RHEA
acquisition module is blocked precisely because the NEAR→mPOO route is two venues and a dead DCL leg)
and for user funding — not for measuring credits. Two constraints apply if it happens:

- **Create it on DCL**, not classic. mPOO's tax (`get_tax`) is 200 bps buy / 300 bps sell against
  `pairs: ["dclv2.ref-labs.near"]`, admin `nearlytrade.near`. A DCL pool stays taxed; a **classic pool
  would be an untaxed 3% sell venue** for a token we do not control. Ask `nearlytrade.near` before
  adding a venue rather than after.
- **Size it to what we will keep there permanently.** A withdrawal is a price event if anything reads
  the pool, and impermanent loss on a memecoin pair is real.

If automation is ever wanted, the honest form is a keeper-posted price with a staleness bound and a
±band, reusing the board's existing price history and cooldown machinery (same operator discipline as
TR-K). That is an oracle with an audit trail; a pool we seeded is an oracle with a balance sheet.
