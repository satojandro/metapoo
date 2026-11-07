# Backlog — verified state

> **Agents own this file. Keep it current.**
> **Since 2 Nov: PRs don't edit this file.** The status goes in the PR description; whoever merges
> updates this file on `main` right after, with the merge commit (see `AGENT.md`). A stale backlog is not
> a cosmetic problem: on 2026-10-27 it had six rows wrong, and dispatching from it would have
> had agents rebuild working code.
>
> The rule is not "don't write it" — it is **prove it**. Every row carries the commit, file,
> grep or command that establishes it. Never carry a status forward. Re-derive it every time.

## How to update this file

1. Run the check, do not recall the answer:
   `git log --oneline origin/main -- <the paths involved>` and grep for the artefact itself
   (e.g. `grep -rn "devicePixelRatio" web/src` for T1).
2. Move the row between sections. Keep the commit id that proves it in the Delivered row — that
   is what stops the next agent from re-dispatching it.
3. If you cannot establish a row this revision, mark it **unverified** with what is missing.
   Never guess, and never downgrade a delivered row because you did not look.
4. If you find a row wrong, fix it and say which commit proved you wrong, as the table below does.

## The incident this rewrite fixes

On 2026-10-27 the previous backlog claimed six items were "NOT delivered" or "PARTIAL".
Three of them were already shipped, by commits inside that document's own ancestry:

| claimed by the 2026-10-26 refresh | actually delivered by |
|---|---|
| T2 keyboard/a11y operability — "NOT delivered" | `6080412 feat: wall-controls-a11y-keyboard` |
| T3 mobile 390 px ergonomics — "PARTIAL" | `db4d50a feat: wall-mobile-paint-ergonomics-r2` |
| T4 stall composition — "PARTIAL" | `ff08ccf feat: stall scenery framing layers…` |
| T8 orientation — "not captured" | `2615cef feat: wall zoom controls + first-visit hint` |
| zoom readout — "does not exist" (my claim) | `b8a0861 feat: always-reachable wall position readout (zoom %)` |

**A status line is a claim, not evidence.** Every row below carries the command, file or commit
that proves it, and anything that cannot be proved that way is marked *unverified*.

To re-check any row:

```bash
git log --oneline origin/main -- web/src/pages/wall web/src/style.css web/src/wall-design.css
grep -rn "devicePixelRatio" web/src     # the T1 check, as an example
```

Baseline for the T-rows: `origin/main = 5b40b63`, 263 tests / 39 files, build clean. Payment rows re-checked at `09965fe` (2026-10-29).
Latest full runs on `0b03bef` (after #58/#59/#61/#62), 3 Nov, Node 22.23.4: web `npx vitest run` **729/729, 81 files**; keeper 36/36; buyback 50/50; toilet-staking 28/28; paid-board 173/173 (TR-B not yet on `main`).

---

## Delivered — do not dispatch

| id | item | evidence |
|---|---|---|
| T2 | Keyboard/a11y operability of wall controls | `6080412`. Swatches are `<button>` with `aria-pressed`, updated on click (`mount-wall.ts:2319-2339`); `.focus-visible` rings (`style.css:656,839`); arrow-key selection on the board (`mount-wall.ts:552`) |
| T3 | Mobile paint ergonomics | `db4d50a`. `@media (max-width:600px)` block in `wall-design.css:110` sizes the dock, flexes swatches, keeps a 44 px target |
| T4a | Stall scenery/composition layers | `ff08ccf`. Ceiling, side walls, back-wall art, toilet, floor, bezel and scene labels in `wall-template.ts:7-33` |
| T6 | Session discoverability (unlock in dock, plain copy) | `499c42f` |
| T7 | Pending-cell marker no longer repaints the cell | `a351516` |
| T11a | Drag paints at any zoom; pan is an explicit gesture | `9d13412` |
| T11b | Zoom floor at fit; wheel scaled by delta | `2322c84` |
| T11c | Duplicate zoom readout I introduced removed | `5b40b63` |
| R2.1 | Stroke cells stamped from the transaction receipt | `c547bcd` |
| R5 | Learning records + traps in the repo | `6860508` |
| — | Second tap queued while a paint confirms | `993842d` |
| — | Place button hidden while painting is armed | `c7f5af0` |
| — | Browser `Buffer` polyfill (strokes never reached the chain) | `4152d73` |
| — | Zoom controls + first-visit hint | `2615cef` |
| — | Always-reachable zoom % + cell coords readout | `b8a0861` |
| **T1** | Device-resolution canvas (DPR clamped 1–3, whole-block cells, bitmapHex read seam) | `19e95bd`. **Manual visual gate still open** — see below |
| **T9** | Drag preconditions named individually | `34eb5a1` (`strokeBlockedReason`) |
| **T8r** | Plain-language contract line + state legend | `34eb5a1` |
| — | Paid board launches at 64 × 64 and grows only, to 128 max (`expand_board`, pixel stride pinned at 128, side kept in a raw `s` key so board3/board5 still read 128) | `f3d68a6`. Rehearsed end to end on `board64.metapoo-player1.testnet`: launch size, out-of-range rejection, growth, paint past the old edge, `get_pixels` faithful. Runbook: [`payments/board-growth-runbook.md`](payments/board-growth-runbook.md) |
| **T5** | Schema-driven board dimensions | `f3d68a6`. `contract-meta.ts` now accepts any square 1–128 and returns `side`; `setBoardSide` is a live binding and the wall refits on change. The old constant-check rejection is gone |
| — | Buy NEAR links to near.com, not near.org (#69) | `9101794`. `BUY_NEAR_URL` and the panel copy; near.com resolves 200 |
| — | Painting with an active drawing key no longer opens the wallet; drawing-key pre-send reads use the shared transport (#70.3) | `9101794`. `local-draw.ts` goes through `readRpcFetch`, `gas_price` added to the allowlist; a pre-send failure returns a retryable failure, `mayHaveBroadcast` still beats both |
| — | Pending pixels expire after 90 s instead of sticking forever (#70.1) | `9101794`. `PENDING_PAINT_MAX_AGE_MS`; overlay only, nothing resubmitted, a late execution still lands via the board poll |
| — | Board/price/balance reads share one paced transport: 2 in flight, in-flight dedupe, price priority, per-endpoint cooldown, network-matched backup, reads only | `5b61530`. Fallback re-probed 2026-11-05: `rpc.testnet.near.org` and `rpc.mainnet.near.org` both answer browser `query`/`call_function` with 200 + `access-control-allow-origin: *` in ~3.4 s, so the "deprecated on every call" note was stale |
| — | Stroke latency: one read set per stroke (allowance+nonce, finalized block, gas price in parallel), every batch signed with nonces `n+1…n+k` against one pinned final block, `wait_until: NONE` sends with a single execution wait, and a per-batch result (`confirmed` / `failed` / `uncertain` / `not_sent`). Taps that queue behind an in-flight paint now go as one `draw_many` | `ae0b95c` (PR #78); web live as `dpl_DDqreV6hd7ucjd6nhajRGBR82nhX`. **Open:** not yet exercised on mainnet; `MAX_DRAW_BATCH` stays 64 because the per-receipt event log reaches 16 KB at ~100 cells (measured: 64 cells = 10,441 B with a 64-char painter, 128 = 20,837 B) |
| — | Lone-tap latency: a session tap takes the same pipeline (`draw_many` of one cell), with the key, finalized block and gas price prefetched *while the price is quoted* and the credit balance read alongside it. Settles on the receipt — no confirming `get_pixel` (which retried up to 5 times, 400 ms apart); the stamp's block height is looked up in the background, and the pending marker survives until the stamp replaces it. Also fixes `paintOperationId` recomputing per phase, which left a `submitted` record listed as recoverable forever for every grouped tap | `08499a1` (PR #79); web live as `dpl_H3NTNtMxhRyDJSXH4XfScnEsEewL`. Request counts, not timings, are tested (1 key + 1 block + 1 gas-price read, 1 send, no status poll). **Open:** the **Place paint** button still uses the single-`draw` path; a tap now emits a `draw_many` event with one cell; the queue releases one round trip earlier, so a stale-nonce refusal is more likely after a lagging read — client-side nonce tracking is the follow-up |
| — | Wall page: one-screen layout, controls over the wall, no Look/Paint toggle (owner, 6 Nov) | `633c5dd` (PR #81, merged with the beta-banner height folded into the sizing). Evidence: `--wall-size` is one height/width `min()` and subtracts `--beta-banner-h` (`wall-page.css:8-20`); `.wall-panel-body` scrolls with `.wall-panel-foot` pinned (`.wall-page` grid columns `--wall-size` + `--wall-panel-w: 380px`); `#wall-mode-look` / `#wall-mode-paint` no longer exist — `mount-wall.ts` sets `data-signed-in` and `modes.setMode("paint"\|"look")` on sign-in/out; `buy-credits` sheet opens as a modal from the pinned dock. Pinned by `mount-wall.behaviour.test.ts` › "has no Look / Paint toggle: signing in opens Paint, signing out returns to Look". Measured on the live mainnet board at 1920×1080 / 1440×900 / 1280×720 / 1024×768 / 390×844: board+panel+primary action inside the viewport in all five. **Open:** (a) the collapsed About row still leaves ~93 px of document scroll at ≥1280 wide; (b) signed-in users cannot return to Look, and a tap paints once the key is armed, so inspecting a tile signed in risks a spend; (c) `paintOver()` still scrolls `.wall-dock`, which the footer split made a no-op | **M** |

| — | Wall paint panel: quiet edition — the active view's key above the palette, a one-line tally (this stroke / your credits) in the footer, one-off confirmations fade, tap-to-paint moved under About / details (owner, 6 Nov) | `976bc03` (PR #82). `.wall-panel-foot` (`wall-template.ts:140`), `.wall-tally` (`:145`), `#wall-view-legend` now precedes `#palette`; `#repaint-legend` / `#cell-price` / `#tap-to-paint-status` kept in the DOM for screen readers only; unlocked copy is "no wallet popup per tile" (`paint-session-panel.ts:246`). 856 web tests, build clean. **Open:** the author verified signed-out only — no real wallet session was checked against this panel |
| — | Wall after a paint: one confirmation, no disabled button standing in for one. Closes #82's open item — the owner's real signed-in session (7 Nov) showed a disabled "Tap or drag on the wall to paint" button, four confirmations of one paint (status, "Pixel painted" block with raw tx id, green on-wall box, tile card's "Paint over this") and the tx id pushing the footer past the panel | `746efa8` (PR #84). A disabled `#dock-primary` is hidden (`wall-page.css`, `#dock-primary:disabled`); a confirmed `#result` keeps only its explorer link; footer grids are `minmax(0, 1fr)`; placement outcomes are CSS pills ("Painted · 52, 22", `placement-outcome.ts`) that fade when confirmed; "Paint over this" hidden in Paint. No change to `dockPrimaryState`, paint path, pricing or keys. 879 web tests, build clean. **Open:** verified by recreating the owner's screenshot state in the DOM, not by a fresh wallet paint |
| — | Drawing-key renewal from the dock: a chain allowance refusal becomes plain copy and one approval that **adds the new key and deletes the old one in the same transaction**, then offers Renew in the dock instead of a raw `Access Key … does not have enough balance` | `aeab9ed` (PR #83, web live as `dpl_3qqijgF9beUyiS7gHNdMZwKQcdVY`). `#paint-renew` (`wall-template.ts:112`), `submitDraw` returns an explicit `keyLow` flag (`submit-draw.ts:97,151`) instead of re-reading its own copy, `isRetirableDrawingKey` deletes only a scoped key for this board, `logAllowanceRefusal` (`local-draw.ts:635,650`). Chain evidence: `misfits-validator.near` holds exactly **one** board-scoped key (`ed25519:CNwjDjv…`, `draw`/`draw_many`, 0.05 with 0.0471 left), so the add **and** the delete landed, and its 4 full-access keys are intact. 878 web tests. **Open:** (a) the 0.0309 NEAR quote for a 30 Tgas call is unexplained — capture `quotedOverExpected` / `impliedGasPriceYocto` on a real refusal before sizing anything from it; (b) `0.05` buys ~16 prepared calls (allowance is debited at the prepaid rate, refunds go to the account), so the allowance value itself is the next lever |

## Open — verified not done

| id | item | evidence that it is missing | size |
|---|---|---|---|
| **R2.2** | Cheap change detection before paging | **Delivered in `7edcdec`** (PR #76), deployed and live: an unchanged poll is one `get_board_version` call, a changed one walks `get_pixels` pinned to the version's block, and an untouched visible tab stops after 10 min. Mainnet board `fcd66acf…` upgraded in `2t1cApxbrgk3BB7Bb6aL5bt69bdLmorZCsQyAsYZJHZw` — evidence: [`payments/mainnet-board-version-upgrade-2026-11-06.md`](payments/mainnet-board-version-upgrade-2026-11-06.md). **Open:** a busy board still walks every painted cell once per change; per-row/per-region versions or a Berry Fast-style server is the follow-up | **M** |
| **T2b** | *(unverified)* roving tabindex over swatches | Not checked this revision. Tab moves through all 8 swatches rather than arrow keys within the group — cosmetic a11y, not a blocker | **S** |
| **MAINNET-TEST** | Mainnet testing round | **Deployed 2026-11-05** from `10632a2`: board `fcd66acf…` (64 × 64, schema 4, owner = itself), TOILET `a571dead…` (tax 200/300 bps buy/sell, 7000 bps burn / 3000 bps treasury, owner decision), rate 1e15, one free pixel at (10,10), page live at https://metapoo-testnet.vercel.app. Record: [`payments/mainnet-test-deployment-2026-11-05.md`](payments/mainnet-test-deployment-2026-11-05.md). **Open:** wallet-signed paint E2E, paid-repaint credit decrement, mPOO path, C02+ cost rows, board ~1.1 NEAR short of its reserve so `get_withdrawable_near` is 0, key custody is a file on the Mini | **M** |

## Next, owner-approved order (1 Nov)

All of this is broken into parallel work orders in
[`implementation/2026-11-01-work-queue.md`](implementation/2026-11-01-work-queue.md): 14 tasks in three
waves, each with its own `*.task.json`. Specs: [paid board revision](payments/2026-11-01-paid-board-revision-spec.md),
[wall split](implementation/2026-11-01-wall-split-spec.md).

| id | item | evidence / gate | size |
|---|---|---|---|
| **REV-1** | Paid board revision (REV-A…REV-F in the queue) | spec reviewed by the owner 1 Nov; open: testnet account ids, mPOO cap value; **decided 2 Nov: distributions keep running while paused** (handover; REV-G pins it with a test). **REV-A merged to `main` via PR #34; REV-B/C/D merged to `main` via PR #39** (`cargo test` 167/167, clippy clean, wasm builds, web 261/261 + build); REV-E not started | **L** |
| **REV-F** | Revenue keeper: hourly `distribute_near` / `distribute_mpoo` caller (`ops/keeper/`, `.github/workflows/keeper.yml`, off until repo var `KEEPER_ENABLED=true`) | merged in PR #33 (`2c30870`); 30/30 keeper unit tests pass. **Unverified on chain**: needs REV-D's `distribute_*` methods deployed and a 24 h testnet run with tx hashes (REV-E) | **S** |
| **F1-REFACTOR** | `mount-wall.ts` split (FE-0 in the queue) | [spec](implementation/2026-11-01-wall-split-spec.md); **done on this branch, merged via PR #37** (characterization tests first, then one commit per controller; `mount-wall.ts` 2,538 → 344 lines); 328/328 web tests pass, build clean. Testnet manual check on board3 still owed | **M** |
| **TOILET-REVIEW** | Full TOILET cycle review | **Specced 2 Nov**: owner decisions T1–T10 in [`economy/2026-11-02-toilet-round-spec.md`](economy/2026-11-02-toilet-round-spec.md), merged via PR #47 (`f1e9e7c`). Nothing implemented; work moves to the TR rows | — |
| **FE-0..5** | Wall split, CI, palette dock, `max_credits`, mPOO checkout, `/money` | Merged 2 Nov: #37, #44, #41, #43, #40, #42. `web/src/app/routes.ts` matches `/money`; `npx vitest run` on `f1e9e7c` with Node 22: **433/433, 55 files** | — |
| **ADM-1** | `/admin` public board settings with owner edits | Merged via PR #46 (`833a131`). Read-only testnet view calls proven in the PR; **live owner-wallet signing unverified**. Follow-up ADM-2 makes it a private owner console | **M** |
| **ADM-2** | Private owner console (out of nav, status first, pause without RPC gates) | **Merged** in `d8a3e5d` via PR #55 (`0223870`). Live owner-wallet signing still unverified (same gate as ADM-1) | **M** |
| **REV-G** | Contract follow-ups: interval bound, `tunables_changed` event, `get_owner`, keeper gas, pause test | **Merged** via PR #58 (`3a1ccf3`). On `main`: paid-board `cargo test` 173/173, keeper 36/36. Ships with the next fresh testnet board. Open: gas defaults unmeasured (REV-E); `web/src/app/admin-catalog.ts` still says the interval has "No limit today" | **S** |
| **TR-B** | TOILET round, board: earning tiles only, no earning cap, guarded rate setter, stored token, minimum claim, **plus `get_buyback_totals`** | **NOT on `main`.** PR #60 merged into the REV-G branch (`88f861d`) after #58 had already landed, so it never reached `main` (`git merge-base --is-ancestor 8f65db8 origin/main` fails; `main` paid-board has 173 tests, not 191). Landing branch `claude/upbeat-cerf-vm5j6q-tr-b-main` (`11d85c8`): TR-B merged cleanly onto `main` plus the staking-sim `new(…, toilet)` fix; paid-board 191/191, staking sim 1/1 in the sandbox. Owner decisions 3 Nov: cooldown applies to switch-on after 0; `MIN_CLAIM` = 10^18; buyback totals approved. Open after it lands: web `claim_toilet({toilet})` arg, admin `max_earning_cells` references, deploy scripts pass `toilet`, launch rate (T1), `quota_*` | **M** |
| **TR-S** | TOILET staking contract: 10%/day pool drip, 10% exit tax burned, no owner | **Merged** via PR #59 (`1256f4b`): `contracts/toilet-staking` 28/28, sandbox sim `contracts/toilet-staking/sim` (CI job `staking-sim`), keeper `sync_inflow` off unless `KEEPER_STAKING_CONTRACT_ID` is set. Built, not deployed. **The sim breaks against the TR-B board until the landing branch above merges.** Open before `set_staking_contract` (once, ever): fresh testnet rehearsal including full-access key deletion, behaviour against real mPOO (sim used a zero-tax stand-in), **external review** | **L** |
| **TR-K** | Buyback keeper: NEAR → mPOO in capped chunks, returned to the board | **Merged** via PR #61 (`3d59007`): `ops/buyback`, 50/50 on `main`, CI job `buyback`. Nothing signed. Candidate mainnet route quoted only (`ops/buyback/evidence/2026-11-03-mainnet-route.json`): Ref pool 6458 wNEAR→RHEA, then DCL RHEA→DIARHEA→mPOO, ≈4.3% all-in. Open: **owner** decides where the full-access key lives (Actions secret or Hermes server, which decides scheduling) and how to prove the route (small approved swap or source review), plus mainnet K2 values; Hermes testnet run | **M** |
| **TR-X** | TOILET exchange-tax configuration and venue evidence (nice-to-have) | [`toilet-exchange-tax`](implementation/toilet-exchange-tax.task.json); Hermes; needs the owner's split and treasury | **S** |
| **FE-HIW** | `/how-it-works` with live board values | **Merged** in `d81450d` via PR #53 (`2f42307`); `routes.ts` matches `/how-it-works` | — |
| **FE-TOILET** | `/toilet` page, live TOILET figures, "Your TOILET" claim card | **Merged** in `16debe8` via PR #57 (`ed327e4`); `routes.ts` matches `/toilet`, `toilet-claim.test.ts`. Uses `VITE_TOILET_ID` until TR-B stores the token id (round spec B4). Staking explorer shows decided rules only: **no staking UI until TR-S is on testnet**. Not exercised against a live claim | **M** |
| **FE-BUYBACK** | `/money` buyback ledger (K4 / F4) | **Merged** via PR #62 (`0b03bef`): `web/src/app/buyback-ledger.ts`. Reads `get_buyback_totals` first, then **FastNEAR's transaction index** (PR #75): the **buyback account's** history via `POST /v0/account` (no `is_event_log` — it means *named in* an event, which a split's data never does), logs batched 20 txs per `POST /v0/transactions`, no key needed; a receipt-closure check keeps mid-flight transactions out of the total. This replaces the NearBlocks fallback, whose **testnet index has been stopped since 2026-09-27** — verified live 2026-11-05: NearBlocks throws `stopped at Sun, 27 Sep 2026`, FastNEAR returns a current head and an explicit `complete` flag. Mainnet cross-check 2026-11-05: index totals 0/0 agree with the board's own `get_buyback_totals` 0/0. Exact figures still need TR-B events on a deployed board. NEAR waiting reads live | **M** |
| **FE-3** | Free paints and happy hour UI | Work order in `implementation/`; **Claude**; not started. Designs: [`visual-concepts/`](visual-concepts/README.md) | **M** |
| **RPC-SEND-FALLBACK** | Re-broadcast the identical signed paint tx to the fallback RPC when the primary drops it | [#73](https://github.com/satojandro/metapoo/issues/73), split out of #70 by the #72 review. Pre-send reads are transport-backed and a failed check no longer pops the wallet; the broadcast itself is still primary-only, so an uncertain paint stays unresolved until the user retries (its marker expires at 90 s). Safe to retry the same bytes: same hash, same nonce | **S** |
| **OPS-RPC** | Keepers' mainnet RPC default | `rpc.mainnet.near.org` (the default in `ops/keeper` and `ops/buyback`) returns 429 "THIS ENDPOINT IS DEPRECATED" after a few dozen calls (seen 3 Nov, TR-K). **Both daemons now take a metered credential** — `KEEPER_RPC_API_KEY` / `BUYBACK_RPC_API_KEY`, sent as an `Authorization` header (PR #74, `docs/ops/fastnear-rpc.md`) — so setting `KEEPER_RPC_URL=https://rpc.mainnet.fastnear.com` / `BUYBACK_RPC_URL=https://archival-rpc.mainnet.fastnear.com` plus the key is the supported mainnet path. Still open: choosing and configuring the **web read fallback** (`VITE_NEAR_READ_FALLBACK_URL`, `5b61530`); it stays on `rpc.mainnet.near.org` until a paid provider or a proxy is in front, and the browser build must not carry a server key (domain-restricted browser keys are a paid FastNEAR feature) | **S** |
| **ADM-HIST** | `/admin` change history probably empty | `web/src/app/admin-history.ts` reads `tx.actions_agg.method`; current NearBlocks responses put it in `actions[].method` (seen 3 Nov, FE-BUYBACK). Unfixed | **S** |
| **ACQ-0…3** | Privy login, Intents funding, RHEA mPOO swap, shared wallet foundation (readiness, gas reserve, recovery, Web Locks) | **Merged** via PR #56 (`987605b`); [specs](implementation/2026-11-03-wallet-funding-integration-spec.md), [handoff](learning/2026-11-03-wallet-acquisition.md). Implemented and fixture-tested only. **All three flags off** (`VITE_PRIVY_ENABLED`, `VITE_INTENTS_FUNDING_ENABLED`, `VITE_RHEA_MPOO_SWAP_ENABLED`). No contract change | **L** |
| **ACQ-4** | Live acceptance and enablement of the three flags | **Open.** Privy: public app/client ids, real testnet Google/email login, key + paint read-back, hosting headers; one high-severity Zod advisory through 4 Privy deps, and `@peerfolio/privy-near-connect@0.0.8` (third-party, pre-1.0, signer code vendored) needs review. Intents: deployed-origin CORS, native NEAR delivery for named / implicit / fresh implicit accounts. RHEA: complete route + code hashes, enforceable post-tax minimum, measured gas, separately approved bounded mainnet trial. Do not mark any of these done from fixtures | **M** |

## Blocked on a human decision

| id | item | what is needed |
|---|---|---|
| **T4b** | Board-dominant presentation | the visual direction decision (deferred by owner to the visual phase) |
| **T10** | Berry Club parity remainder | default-on shipped; single-tap-always is a consent decision |
| **R1** | Sign once, paint forever | four decisions listed in `roadmap.md` R1 |

## Payment stage — on testnet, mainnet pending (updated 2026-10-29)

Evidence (re-checked 2026-10-29 at `09965fe`): the paid board, safety controls and TOILET are on `main`
(PRs #15–#17) and deployed to testnet ([deployment record](payments/testnet-deployment-2026-10.md)).
`cargo test`: paid board 86, TOILET 24. That is local and scripted-testnet evidence, not a settlement
through the page and not a cost result. Mainnet blockers: [code audit](2026-10-29-code-audit.md) §1. `contracts/board` (schema 2) is **retired as a product**
and kept only as the testnet fixture. `web/src/payment-provider.ts` is already absent. The schema-3
Journey C pressure modules are removed, so fixture quotes cannot render on the wall. Schema 4 credit
display stays in `paint-wallet.ts`. Mainnet deployment: none,
confirmed by owner. A testnet token is needed for the first paid rehearsal.

| ID | Pending work | Evidence / completion gate |
|---|---|---|
| PAY-UI | Read-only display + buy-credits sheet + NEAR CTA (mPOO hidden; **mPOO is offered at mainnet launch**, owner 2026-10-29, gated on audit C8); live Brave/Meteor verification still pending | Issues #25–#29 fixes on this branch: `restoreWalletSession`, wallet-details Close/Escape/outside-click, Buy NEAR instead of NEARLY while `TOKEN_PAYMENTS_ENABLED=false`, credits dock refresh after paint, Retry on price fetch failure. Proof: `wallet-restore.test.ts`, `wallet-details-close.test.ts`, `credits-dock-refresh.test.ts`, `buy-credits-sheet.test.ts`. |
| PAY-INTEGRATION | Paid schema-4 frontend and real testnet purchase → paint → refreshed balances | **Loop completed by the owner on `board3.metapoo-player1.testnet` (Brave + Meteor), reported 1 Nov.** It produced issues #25–#29; fixes in `e7c4d83`, `dade276`, `69578bb`, `0cae45c`, `9ea4a76`, `09965fe`. #25–#28 closed; **#29 (credits not updating after spend) still open** though `e7c4d83` and `09965fe` target it, so re-check and close. Transaction hashes were not recorded; the revision rehearsal ([spec](payments/2026-11-01-paid-board-revision-spec.md) C7) records them |
| **PAY-REHEARSAL** | **Delivered 2026-10-29** — board + TOILET deployed and exercised on testnet | `docs/payments/testnet-deployment-2026-10.md`: 50 checks, board `board3.metapoo-player1.testnet` (canonical; `board1.metapoo-player3.testnet` was an earlier, replaced deployment); harness `~/Hermes-crypto-builder/mpoo/harness`. Proves schema-4 views and `resolve_claim` on a refused mint |
| **PAY-RECENCY-UI** | Show the repaint price before the user commits: per-cell cost, stroke total, one-line legend | Page reads `get_cell_cost` and `get_tunables`. A cell painted 2 minutes ago renders chain cost × cells, not cells × 1. The legend sits outside `<details>`. A failed `get_cell_cost` disables submit and shows "price unavailable". Proof: `d1475d9`, `web/src/pages/wall/repaint-price.test.ts`. |
| **PAY-COST** | **Reopen immediately after first mainnet paid-board deployment** | [Required cost matrix](payments/mainnet-cost-validation.md); all mainnet cases pending, keep open through owner acceptance |
| PAY-SAFETY | On main and testnet; **two gaps found by the audit** | `contracts/paid-board/src/safety.rs`: pause, withdrawals, price bounds. Open: `set_tunables` can raise repaint credits without bound (audit C1), and `STORAGE_PER_PIXEL` is still the free-board estimate (C5) |
| **PAY-MPOO-PRICE** | **Decided 3 Nov** — weekly manual rate, **1,000 mPOO per credit** set in `new()`; measured route instead of an oracle or a pool of our own | Audit [`2026-10-29-code-audit.md`](2026-10-29-code-audit.md) C8; evidence [research/2026-11-03-mpoo-near-price-route.md](research/2026-11-03-mpoo-near-price-route.md). Route `mPOO → DIARHEA → RHEA → NEAR` (DCL 10000 twice, then classic ref pool #6458) measured 2026-11-03 at 1 mPOO = `0.0000022591` NEAR → ~442,657 mPOO/NEAR, ~885 mPOO per credit after the 20% discount. **Remaining work:** the weekly update procedure (who runs it, where the number is recorded) and confirming the launch value at deploy — nothing to build in the contract. `mpoo_daily_credit_cap` and the split cooldowns already exist |
| PAY-UPGRADE | Select deployment authority and rehearse state-preserving upgrades before public paid launch | Owner-only `upgrade()` in `34b1a84`; pause now local. New safety fields change the stored layout: migration and testnet rehearsal remain open. |
| TOILET-TOKEN | On main and testnet (`metapoo-toilet.testnet`); venue compatibility unverified | `contracts/toilet`: 24 tests. Capped issuer, emitter-only mint, venue tax. A `resolve_claim` on a refused mint has been seen on testnet; a successful mint through the page has not |
| ECONOMY-LATER | Longevity rewards beyond emission, swaps, inventory shop | Still deferred. **Staking, emission rules and the buyback moved to the TOILET round** (TR-B, TR-S, TR-K, 2 Nov). |

## Open gates and scoped work

### RPC: treat a JSON-RPC `-429` error body like an HTTP 429 — **open, 2026-11-06 incident**
The 2026-11-06 rate-limit incident exposed a gap `read-rpc.ts` does not cover: FastNEAR can
answer a rate-limited read with **HTTP 200 and a JSON-RPC error body** (`{"code":-429,"message":
"Rate limits exceeded…"}`). The transport's 429 handling (cooldown + `near.drpc.org` fallback)
only fires on HTTP 429, so the raw error payload propagated to the paint error card
("Paint not painted. Nothing was stored. {…-429…}") instead of the fallback engaging. Fix:
in the read transport (and/or `describeRpcError`), detect `error.code === -429` in a 200 body
and route it through the same cool-down-and-fallback path as an HTTP 429. Add a unit test with
a 200-wrapped -429 body. Found while diagnosing alejandro.near's "failed txs" (none existed —
the paints never reached the chain).

### T1 manual visual gate — **human, open**
`19e95bd` is tested but not seen. At paint zoom a single painted cell must be a solid square
with no halo or seam, compared side by side against the previous build. Until that is done, T1
is implemented, not accepted.

### T5 — scoped, **not started**
Adopting contract-reported board dimensions instead of validating against `BOARD_WIDTH`/`HEIGHT`
constants is not a small change: those constants are read by the camera (`fitCamera`, `clampPan`,
`zoomAt`, `boardScreenSize`), the renderer, selection and the template. Doing it properly means
board geometry becoming runtime state that the camera is rebuilt against after `get_board`.
File set for a dispatch: `web/src/viewport.ts`, `render-board.ts`, `pages/wall/mount-wall.ts`,
`shared/types.ts`, plus their tests. Risk: camera maths — `learning/traps.md` says do not change
it casually. Recommended: one task, tests first, human visual check after zoom and pan.

### Agent-orchestrator dispatch — 2026-10-27, blocked on credentials
T1 was dispatched (`max-tasks 1`, codex lane, gpt-6.1-sol). The PO planned it correctly — one
reversible task with the acceptance criteria from this document — then the engineer lane failed
four times with **zero file changes**. Cause: the Codex CLI's refresh token was rejected
(`your refresh token was already used`, then `workspace routing discovery unauthorized (401)`).
The work was therefore implemented directly.

Preconditions before the next dispatch:
1. **Re-login the Codex CLI** (`codex login`); verify with `codex exec -m gpt-6.1-sol "PONG"`.
2. The PO also carried forward a process escalation: `scope_violation` fires on reversible web
   files because of ask-first vocabulary matching, not because of a genuine off-scope edit. That
   gate needs narrowing before another web-only batch.

## Superseded inputs

| file | status |
|---|---|
| `remaining.json`, `remaining.harness.json`, `fix_plan.md`, `.ao/`, `signs/` | **Deleted 2026-10-29** (cleanup PR); recoverable from tag `archive/pre-cleanup-2026-10-29`. `fix_plan.md`'s three findings live on as the T1 acceptance criteria above |
| `~/Hermes-crypto-builder/metapoo-backlog-refresh-2026-10-26.md` | **RETRACTED** for T2/T3/T4/T8 status — see the table above |
