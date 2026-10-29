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
