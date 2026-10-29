# Berry Club parity matrix

Date: 29 October 2026. Baseline: `main` = `725a9dd` (after #31). Step 2 of the
[audit's order of work](2026-10-29-code-audit.md#5-order-of-work-revised-for-the-mainnet-goal).

Every Berry Club fact below comes from the original source code, not from memory:

| repo | commit | what it is |
|---|---|---|
| [`evgenykuzyakov/berryclub`](https://github.com/evgenykuzyakov/berryclub) | `be63065` (14 Jul 2022) | board contract (`berryclub.ek.near`) and React frontend |
| [`evgenykuzyakov/berryfarm`](https://github.com/evgenykuzyakov/berryfarm) | 7 Jul 2021 | Berry Farm contract (`farm.berryclub.ek.near`) and frontend |
| [`evgenykuzyakov/wayback`](https://github.com/evgenykuzyakov/wayback) | 14 Mar 2021 | off-chain board history fetcher and frame renderer |

Meta Poo facts come from `contracts/paid-board`, `contracts/toilet` and `web/src` on `main`.
Nothing here was checked on chain or in a browser.

Status key: **done** = built and on `main`. **partial** = some of it is built, or it's built but not
reachable by a user. **missing** = not built. **departure** = Meta Poo does it differently on purpose;
that's for the owner to confirm, not a gap to fill.

## How Berry Club actually works

The audit guessed avocados ≈ credits, bananas ≈ TOILET and the Farm ≈ TOILET staking. Mostly right,
with three corrections that matter:

1. **Held pixels earn paint, not only tokens.** The README's one-line pitch: *"Your pixels earn you more
   pixels, so better artists get more pixels to draw."* Every held pixel earns **1 berry per day**
   (`REWARD_PER_PIXEL_PER_NANOSEC`, `account.rs`). The account picks which berry: **avocados** (paint,
   plus a +1/day bonus) or **bananas** (the token). Avocados are the default. Meta Poo credits can only
   be bought.
2. **The Farm is funded automatically on chain, not by the operator.** On any `draw`, at most once a
   minute, the board sends **1/1440 of its liquid NEAR** (balance minus storage minus a 50 NEAR safety
   bar) to `farm.<board>` via `take_my_near` (`lib.rs` `maybe_send_reward`). So about all revenue flows
   out within a day, with no owner withdrawal step. There is no buyback and no burn.
3. **Staking is one-way.** `ft_transfer_call` bananas to the Farm with `"DepositAndStake"` and you get
   the same number of **cucumbers** (a transferable NEP-141). There is no unstake: bananas sent in never
   come back. Cucumbers earn NEAR pro rata (`near_per_cucumber` accumulator) and `claim_near` pays it out.
   In effect, staking carries a 100% exit tax, and the cucumber itself is the tradable claim on revenue.

## Matrix

### Painting

| Berry Club feature | source | Meta Poo | status |
|---|---|---|---|
| Board of 50×50 = 2,500 pixels | `board.rs` | 128×128 = 16,384 cells | departure |
| Flat price: 1 avocado per pixel, always | `account.rs` `charge` | recency pricing: 1, 2 or 4 credits depending on how recently the cell was painted (`Tunables::cost`) | departure (anti-griefing; see C1/C2) |
| Any 24-bit colour | `board.rs` `assert_valid` | 8 named colours, enforced by the contract (`ColorOutOfRange`) | departure |
| Opacity slider, blended over the existing pixel on the client | `App.js` `rgbaToInt`, `AlphaPicker` | no | missing (only possible with free colour) |
| Hue picker, 31-shade gamma row and 31 recent colours | `App.js` | fixed 8-colour palette | departure |
| Eyedropper: hold Alt and click to pick a pixel's colour | `App.js` `pickColor` | no | missing |
| Image upload, scaled to ≤50 px, previewed, then painted (hidden behind the `idkfa` cheat) | `Weapons.js` | no | missing |
| Many pixels per transaction: a client queue of 100-pixel batches every 500 ms, with retries | `App.js` `_sendQueue` | `draw_many` (≤64 cells), atomic strokes, `paint-queue.ts` | done |
| No wallet popup per paint: a function-call access key, with a prompt to sign in again when its allowance runs out | `App.js` `refreshAllowance` | session key in `localStorage` | done (CSP still open, audit §1) |
| Live board: polls `get_line_versions` and refetches only changed rows | `App.js` `refreshBoard` | polling `get_pixels` every 4–30 s (`board-sync.ts`) | done (not yet recorded across two browsers: step 3) |
| Watch mode: board only, no controls, keeps refreshing | `App.js` `enableWatchMode` | no | missing |
| "Please don't destroy art" warning at high opacity | `App.js` | no equivalent | missing (minor) |

### Paint currency (avocados ↔ credits)

| Berry Club feature | source | Meta Poo | status |
|---|---|---|---|
| 25 free avocados on registration | `DEFAULT_AVOCADO_BALANCE` | none; registration costs 0.01 NEAR | missing |
| Buy with NEAR: 250 avocados per NEAR (0.004 NEAR per pixel) | `PIXEL_TOKEN_PRICE` | `buy_credits_near` at 0.0025 NEAR per credit, with `expected_price` and `min_credits` guards | done |
| Bulk discount: 20% more avocados at 5 NEAR or more | `PIXEL_TOKEN_PRICE_WITH_DISCOUNT` | no bulk tiers | missing |
| Fixed buy buttons (0.1, 0.4, 1, 5 NEAR) | `App.js` | buy-credits sheet | done |
| Pay with the community token | — (NEAR only) | mPOO via `ft_on_transfer`; hidden (`TOKEN_PAYMENTS_ENABLED=false`) until C8 | partial (Meta Poo-only) |
| **Held pixels earn paint** (1 avocado per pixel per day, +1/day bonus) | `Account::touch` | no: credits can only be bought | **missing (core loop)** |
| Weekly free-drawing day ("BANANZA"): one day in seven, painting costs nothing and everyone farms avocados | `get_free_drawing_timestamp`, `draw` | no | missing |

### Token (bananas ↔ TOILET)

| Berry Club feature | source | Meta Poo | status |
|---|---|---|---|
| Held pixels earn the token pro rata, settled lazily per account | `Account::touch` | `emission.rs` accumulator per held cell; rate is a tunable, currently 0 | partial (off until C3, C6) |
| Farming choice: avocados or bananas | `select_farming_preference` | TOILET only | missing (follows from "held pixels earn paint") |
| NEP-141 token, 18 decimals | `fungible_token_*.rs` | `contracts/toilet`, NEP-141, 18 decimals | done |
| Supply = whatever was farmed, uncapped | `ft_total_supply` | 1 billion lifetime cap | departure |
| No transfer tax | — | buy/sell tax on the configured exchange, split between burn and treasury | departure |
| Claim is automatic: the balance lives on the board, which is the token | board = token | separate token; `claim_toilet` mints | departure |
| Claim screen | n/a (balance is shown live) | `claim_toilet` exists; no UI | missing (step 6) |
| Balance and earning rate shown: "+N 🍌/day" | `App.js` `Balance` | no TOILET or earning-rate display | missing |
| Listed on a DEX (link to Ref Finance) | `App.js` header | not listed; tax assumes one exchange | missing (launch task, not code) |

### Revenue (Berry Farm ↔ TOILET staking)

| Berry Club feature | source | Meta Poo | status |
|---|---|---|---|
| Revenue leaves the board on chain, automatically: 1/1440 of liquid NEAR per minute | `maybe_send_reward` | `withdraw_near` by the owner, then a manual weekly buyback (audit §1b) | departure (designed, not built) |
| Safety bar kept on the board (storage plus 50 NEAR) | `get_expected_reward` | `get_withdrawable_near`: storage, outstanding credits and a 5 NEAR floor | done (C5: storage estimate unverified) |
| Stake the token, receive a transferable receipt (cucumbers) 1:1 | `berryfarm` `ft_on_transfer` | TOILET staking contract | missing (step 6) |
| Stake is permanent, with no unstake | `berryfarm` (no withdraw method) | spec suggests unstaking with a ≤10% exit tax | open question 2 in the handover |
| Revenue paid in NEAR, pro rata, claimed with `claim_near` | `take_my_near`, `touch` | paid in mPOO; 70% to stakers, 30% burned | departure (owner decision) |
| Farm stats: total staked, NEAR received, NEAR claimed | `get_stats` | — | missing |

### Social and history

| Berry Club feature | source | Meta Poo | status |
|---|---|---|---|
| Leaderboard: every pixel owner, sorted by pixels held, with balances and earning rate | `App.js` `Leaderboard` | no | missing |
| Hover a leaderboard row to highlight that owner's pixels | `App.js` `setHover` | no | missing |
| Click a cell to see who painted it | — | cell inspector shows the latest artist | done (Meta Poo extra) |
| Board-wide stats: accounts, bought, burned and farmed per berry | `stats` | `get_outstanding_credits`, `get_toilet_emission` | partial (no page shows them) |
| Wayback: per-account history pages and a timelapse video built from per-block board state | `wayback` | history service removed in #31 (tag `archive/pre-cleanup-2026-10-29`) | missing |
| Chat: IRC channel embedded for signed-in users | `App.js` iframe | no | missing (could be a Telegram link) |
| Berry Cards: a separate game linked from the header | `App.js` header | — | out of scope |

## What this means for the plan

**The biggest gap is the core loop, not a widget.** In Berry Club, a good spot on the wall pays for your
next painting. In Meta Poo, held cells only earn TOILET, so paint is always bought. That's a product
choice with money attached: if held cells earn credits, some painting stops generating NEAR or mPOO
revenue. Options for the owner:

- **A. Keep credits buy-only** (today's model). Parity is "held cells earn the token", which TOILET
  emission already covers once it's on.
- **B. Earnable credits**, as in Berry Club: a held cell earns a small amount of credits per day. This
  needs C3's earning cap first, or one wallet that holds most of the board earns most of the free paint.
- **C. A weekly free-paint day** ("Bananza"). It's cheap to build (a time window in `draw`), easy to
  explain, brings people back every week, and caps the lost revenue at one day in seven.

My recommendation is **A plus C**. It keeps the revenue model the owner decided and adds Berry Club's
best retention hook, and the free day bounds what it costs.

**Small items that cost little and match the original:**

1. **Starter credits** on registration. Berry Club gave 25. This needs a sybil limit, because
   `register_credit_account` is cheap.
2. **A leaderboard with owner highlight.** It's mostly frontend; `get_pixels` already returns the artist
   for every cell.
3. **A bulk discount tier** in `buy_credits_near`.
4. **An eyedropper.** Frontend only; it works with the 8-colour palette.
5. **Watch mode.** Frontend only. It's also good for a stream or a display above an actual toilet.

**Departures the owner should confirm, not gaps:** the 8-colour palette (which also rules out opacity
and image upload at full fidelity), recency pricing, the TOILET cap and tax, and paying stakers in mPOO
instead of NEAR.

**One design point from the Farm worth copying:** revenue left Berry Club's board on a schedule written
in the contract, with no owner step. Meta Poo's weekly manual buyback is a reasonable start (§1b), but
the trustless version is what Berry Club users had. It belongs on the list for after launch.

### Questions for the owner

1. Credits: **A**, **B** or **A plus C**?
2. Starter credits: yes or no, and how many?
3. Staking: permanent like the Farm (bananas in, transferable receipt out), or unstakeable with an exit
   tax? This is the handover's open question 2, now with Berry Club's answer next to it.
4. Free colour (24-bit plus opacity) or keep the 8-colour palette?

## Owner answers, 29 Oct (second round), and proposals

Context from the owner: Berry Club launched before NEAR had a DEX, and for a while before token
transfers were switched on, so its token economy was primitive by necessity. Parity means **the game
loop**, not Berry Club's tokenomics. Meta Poo's TOILET is meant to be desirable (revenue share),
tradable, and deflationary (vault exit tax).

| topic | owner answer | status |
|---|---|---|
| team share | **yes, about 10%** of revenue. Until now the team earns from liquidity-pool fees, which is why volume matters | decided; placement below needs confirming |
| exit tax | **yes**: the vault exit tax is one of TOILET's deflationary forces. Staking is unstakeable, with a tax (economy spec: capped 10%) | decided; rate to confirm |
| revenue distribution | **automate it** as far as possible | direction decided; design below |
| held cells earning paint | idea: let a holder choose TOILET or paint; "gets tricky fast if TOILET has real market value" | proposal below |
| starter credits | idea: until the board is full, **the first paint on every cell is free** | proposal below |

### Team share: where the 10% comes off

Proposal: take 10% **at the source, in the currency paid**, before anything else. NEAR revenue: 10% NEAR to
the team, 90% to the buyback. mPOO revenue: 10% mPOO to the team, 90% into the split. The remainder splits
70/30, so the gross split is **10% team / 63% stakers / 27% burn**.

Taking the team's share in NEAR covers running costs (RPC, hosting, gas) without the team selling mPOO,
which would work against the buyback. To confirm: 10 / 63 / 27, or keep stakers at 70% and take the team
share out of the burn (10 / 70 / 20)?

### Automating revenue distribution

Berry Club's board pushed revenue to the Farm on chain, on every paint, at most once a minute, with no
owner step. Meta Poo can go further, in three stages, each shippable on its own:

1. **On-chain split, callable by anyone.** A `distribute()` method replaces `withdraw_near` as the only
   way revenue leaves the board. It takes what `get_withdrawable_near()` already computes, sends the team
   share, and holds the rest for the buyback. For mPOO, the 30% burn and 70% to stakers are already planned
   (`distribute_mpoo()`, audit §1b). It can be rate-limited (once an hour, for example) and called by
   anyone: a keeper bot, the frontend after a paint, or any user. No owner key is involved, so nobody has
   to be trusted to do it.
2. **Buyback in small, frequent chunks.** The hard part is NEAR → mPOO on Rhea: there's no oracle, and a
   cross-contract swap on NEAR spans blocks, so any price quote can go stale. Copy Berry Club's trick of
   sending a small slice often: a `buyback()` that is also permissionless, swaps at most a fixed fraction
   of the NEAR it holds per period, and requires a minimum output read from the pool's own reserves.
   Small chunks limit the damage from a bad fill or a sandwich, and the buy pressure becomes a steady
   stream instead of one weekly candle. Every buy pays the NEARLY pool's tax, because it's enforced on
   transfers in and out of the pool (economy §5). Budget for up to 5% per trade, or ask NEARLY to exempt
   the board.
3. **Staking contract pays out automatically.** Stakers accrue mPOO pro rata (the Farm's accumulator
   pattern) and claim whenever they like. With stages 1 and 2 in place, nothing in the money path needs
   an owner.

Until stage 2 is built and reviewed, the operator can do the buyback by hand (audit §1b). Stage 1 is
cheap and can go into the contract revision (step 4).

### Held cells earning paint: use the quota, not a TOILET/credit choice

The owner is right that a choice gets tricky. If one claim can be taken as X TOILET or Y credits, that
fixes an exchange rate between TOILET and paint, and paint has a NEAR price. Whenever TOILET's market price
moves, everyone takes whichever side is worth more, and the credits side becomes a guaranteed revenue leak
whenever TOILET is cheap. It's the same problem as C8, aimed at TOILET.

Proposal: **held cells earn a daily paint allowance alongside TOILET, not instead of it.** The tunables
for this are already stored and unused (`quota_base`, `quota_per_cell`, `quota_max`; audit C3):

- The allowance is `min(quota_max, quota_base + quota_per_cell × cells_owned)` free paints per day.
- It **resets daily and can't be saved, sold or transferred**, so it has no market price and no peg to
  TOILET.
- `quota_max` caps it, so a whale gets a bounded advantage. What it costs in revenue is at most
  `quota_max` paints per active holder per day.
- It brings back Berry Club's "your pixels earn you more pixels". Holders can defend their art cheaply,
  and TOILET stays the only thing with market value.

### Starter credits: the first paint of every cell is free, until the board is full

The idea seeds the wall (audit §4.4) and switches itself off once every cell has been painted.

Costs, from the contract's own constants:

- **Revenue given up:** 16,384 cells × 0.0025 NEAR ≈ **41 NEAR**, once.
- **Storage:** 16,384 × 0.00664 NEAR (`STORAGE_PER_PIXEL`, still unverified, C5) ≈ **109 NEAR**. The board
  pays this whether the first paint is free or not; at 0.0025 NEAR, a paid first paint doesn't cover its
  own storage either. The board has to be funded for this before launch anyway.

The risk is a bot claiming the whole board on day one. A per-account cap alone doesn't stop it: at the
0.01 NEAR registration fee and, say, 25 free cells per account, one sybil pays 0.0004 NEAR per cell. So
take away the reason to do it:

- **A cell painted for free earns no TOILET and no allowance** until someone paints it with a paid credit.
  Free cells are art, not yield.
- **Plus a per-account cap** (Berry Club gave 25) to keep the free fill spread across many people.

The contract needs one extra bit per cell (paid or free) and a free-paint counter per account. Both fit
in the step-4 revision with the migration.

### Still open

1. Team share: 10 / 63 / 27, or 10 / 70 / 20?
2. Exit tax rate: the spec's capped 10%?
3. Free first paints: how many per account (25)?
4. Colour: any colour, or keep the 8-colour palette?
