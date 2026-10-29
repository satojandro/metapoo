# Buy paint credits — ambitious frontend plan

**Status:** product plan (frontend only) · **Date:** 2026-10-29 · **Owner:** product  
**Companion tasks:** [`pay-checkout.task.json`](../implementation/pay-checkout.task.json), [`pay-recency-ui.task.json`](../implementation/pay-recency-ui.task.json), [`frontend-handoff.md`](frontend-handoff.md)  
**Authority:** does not override [paid model decisions](2026-10-28-paid-model-decisions.md). It *stages how* schema-4 buy/spend becomes a consumer product.

---

## 0. One-line bet

**Buying credits should feel like buying a ticket into the stall — not topping up a prepaid utility meter.**  
If the purchase is a chore buried under “Paint & wallet”, Meta Poo stays a wallet demo. If the purchase is the entrance to the paint high, strangers tell friends.

MVP still means: *connect → understand price → buy → paint → someone else sees it* (testnet first). This plan makes that loop feel inevitable and shareable.

---

## 1. Current gap (what exists vs what users feel)

| Layer | Reality today | User experience |
|---|---|---|
| Contract | `register_credit_account`, `buy_credits_near`, `ft_on_transfer`, `get_credits`, `get_payment_config`, recency costs 1/2/4 | Money path is real on schema 4 |
| Frontend balances | Read-only panel in a `<details>` disclosure | “Paid checkout is not enabled.” |
| Paint path | Session key + stroke UX; recency UI task in flight | Price honesty arriving; purchase still missing |
| Placement | Header chrome, not the wall dock | Desire (empty credits mid-stroke) is disconnected from supply (buy) |

**Product failure mode if we only ship the minimal checkout task:** a correct form that nobody opens, because nobody looks inside a disclosure while their finger is already on the canvas.

---

## 2. Product principles (viral + honest)

These sit on top of [product judgment](../2026-10-14-product-judgment.md): *core paint moment first, ship the vertical slice, proven over clever, mobile first.*

1. **Desire-triggered commerce.** Checkout appears when the user tries to paint without enough credits — never as the first thing they see on an empty wall.
2. **Ammo, not bank balance.** Credits are “paint still owed” / pixels you can place. Never imply withdrawable cash.
3. **Honest magic.** Exact integer totals, registration as its own line, receipt-driven confirmation. No optimistic credit bumps. No fake USD peg.
4. **One job per surface.** Wall = paint. Buy sheet = pay. Share card = brag. Do not turn the first viewport into a dashboard of packs + stats + market links.
5. **Crypto disappears behind verbs.** “Get paint”, “Pay with NEAR”, “Approve in wallet”. Wallet/network errors stay human.
6. **Scarce moments > scarce jargon.** Recency pricing and float caps are *game texture*, explained in one line, never a spreadsheet.
7. **Share the splat, not the receipt.** Virality attaches to the painted moment and the “I was here” feeling — purchase is the enabler.

---

## 3. North-star journeys

### Journey A — Cold stranger (viral acquisition)

1. Lands on `/wall` from a friend link or feed post showing a region of the board.
2. Sees live wall + one-line legend: *Fresh cells cost more to repaint…*
3. Zooms to paint zoom, picks a colour, tries a stroke.
4. Soft block: **“You need 12 paint · you have 0”** with primary CTA **Get paint**.
5. Buy sheet opens over the canvas (canvas dimmed, not navigated away).
6. Picks a pack → NEAR (default) → sees registration line if needed → confirms → wallet → **receipt theater** → credits land.
7. Sheet collapses to a toast: **“12 paint ready — leave a mark.”** Focus returns to the same cell.
8. First successful paint fires **First splat** ceremony (subtle, 1.5s) + optional share.

**Success metric:** median time from first paint attempt → confirmed credits ≤ 90s on a funded testnet wallet.

### Journey B — Returning painter (retention)

1. Opens app; **ammo pill** in chrome shows remaining credits at a glance.
2. Paints until short; sheet opens prefilled to the shortfall (+ a “top up to a pack” nudge).
3. Never re-registers; totals stay exact; wrong network blocks with one clear fix.

### Journey C — mPOO holder (community)

1. Chooses **Pay with mPOO** (mainnet) / **Pay with test token** (testnet).
2. Insufficient balance → NEARLY link labelled as external mainnet market; return/focus refreshes balance.
3. Never implies mainnet mPOO funds testnet credits.

### Journey D — Almost-tricked (trust)

1. Price changes mid-sheet → expected_price reject → sheet explains “price moved” and refreshes config.
2. User rejects wallet → credits unchanged; CTA stays ready.
3. Unknown broadcast → no auto-retry; “check status / refresh” only.

---

## 4. Information architecture

```
┌─────────────────────────────────────────────────────────────┐
│  meta poo.          Wall   …     [ammo: 47]  [wallet]       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                     CANVAS (hero)                           │
│                                                             │
│   paint dock: colour · stroke total · unlock                │
│   legend (always visible on paid board)                     │
└─────────────────────────────────────────────────────────────┘

Desire gap → BUY SHEET (modal / bottom sheet)
  packs · exact total · pay method · registration line · pay CTA

Post-settle → toast + return to dock
First splat → micro ceremony + Share card (optional)
```

**Kill the disclosure as the purchase home.** Keep **Paint & wallet** as an advanced balance/debug surface (refresh, NEARLY, connection details). Primary buy lives on the wall.

---

## 5. Signature UX surfaces

### 5.1 Ammo pill (always-on chrome)

- States: disconnected · loading · unregistered · `N paint` · unavailable/retry · wrong network · board paused.
- Tap opens buy sheet (if schema 4) or connect flow.
- Pending purchase/spend shown as a quiet secondary (“+20 pending…”) — never merged into confirmed credits.
- Copy: **“47 paint”** not “47 credits” in consumer UI; keep `credits` in code/tests.

### 5.2 Desire sheet (primary checkout)

Triggered by:
- Ammo pill tap
- Insufficient credits before stroke submit (pay-recency gate)
- Explicit “Get paint” in dock when balance is 0

**Layout (mobile 390 first):**
1. Title: **Get paint**
2. One line price: `1 paint = 0.0069 NEAR` (+ mPOO rate when configured)
3. Packs row (see §6)
4. Custom quantity (advanced, collapsed by default)
5. Pay method: NEAR | mPOO/test token
6. Line items: paint subtotal · registration (if null `get_credits`) · est. network fees (labelled estimate)
7. Primary CTA: **Pay X NEAR** / **Pay Y mPOO**
8. Status region: submitted → executed → credits re-read

Hard rules from handoff + checkout task still apply: integer decimal-string math, `expected_price` + `min_credits`, no optimistic increment, distinct failure names.

### 5.3 Stroke honesty (pairs with checkout)

Already tasked in `pay-recency-ui`. This plan requires checkout to **consume the same priced total**:
- Insufficient: “Need 31 paint · you have 8 · Get 23+”
- Prefill quantity to shortfall, snapped up to nearest pack when close.

### 5.4 Receipt theater (delight without lying)

A 3-beat animation tied to *real* phases:
1. **Sent** — wallet approved / tx broadcast
2. **Settled** — receipt executed
3. **Loaded** — `get_credits` matches expected increase

If any beat fails, theater stops and the named failure takes the stage. Delight is choreography of truth, not fake progress.

### 5.5 First splat ceremony

On the first confirmed on-chain paint for this account on this board in this browser:
- Brief dock pulse + copy: **“You’re on the wall.”**
- Optional **Share** → static card (region snapshot + “painted on meta poo.” + deep link). No auto-post. No tracking pixel required for v1.

### 5.6 Share card (viral primitive)

- Image: cropped board region around the stroke (client canvas export).
- Text: cheeky, on-brand, no token ticker spam.
- Deep link back to `/wall` with optional camera hint if already supported; else wall root.
- Watermark: `meta poo.` as brand hero on the card, not a tiny footer.

---

## 6. Packs (consumer language for quantity)

Packs are **frontend presets** over `buy_credits_*`. No contract change.

| Pack | Credits | Emotional job | Suggested default |
|---|---|---|---|
| **Drip** | 10 | First taste / tip jar energy | First-time users |
| **Session** | 64 | One full `draw_many` batch | Returning painters |
| **Mural** | 256 | “I’m making something” | Creators |
| **Custom** | 1…cap | Power users | Collapsed |

Show exact NEAR/mPOO totals under each pack using live `get_payment_config`.  
If a float/account cap exists on-chain, clamp packs and say why (“board is nearly full of prepaid paint”).

**Do not** invent discounts, streaks-for-credits, or referral credit in this stage — those need economy decisions.

---

## 7. State machine (implementation contract)

```
idle → need_connect → ready
ready → sheet_open → quoting (fresh get_payment_config + get_credits)
quoting → registering? (null credits) → paying
paying → submitted → executed → reconciling → confirmed
any → named_failure (user_rejected | wrong_network | insufficient_funds |
      price_changed | float_full | token_transfer_failed | paused |
      stale_read | unknown_broadcast)
confirmed → paint_ready → (optional) first_splat → share_prompt
```

Rules:
- Confirmed credits stay separate from pending.
- Unknown broadcast: never auto-resubmit.
- Account/network switch aborts in-flight UI generation (existing panel pattern).
- Paused board: views work; purchase CTAs explain pause; no trapped deposits (contract refunds).

---

## 8. Copy system (cheeky, clear, not clownish)

| Moment | Copy direction |
|---|---|
| Empty ammo | “No paint left.” |
| Desire gate | “This stroke needs 31 paint.” |
| Sheet title | “Get paint” |
| Registration | “First-time setup · 0.01 NEAR (storage)” as its own line |
| Paying | “Approve in your wallet” |
| Confirmed | “Paint loaded.” |
| Price moved | “Price changed on-chain. Totals refreshed.” |
| Float full | “Prepaid paint is sold out for now. Painting frees space.” |
| Testnet mPOO | “test token” — never “mPOO” |
| NEARLY | “Opens NEARLY in a new tab” + network truth |

Tone: stall graffiti energy, short sentences, no emoji decoration, no “gm ser”.

---

## 9. Phased delivery (ambitious but shippable)

### Phase 0 — Money path works (unblocks MVP)

**Scope ≈ `pay-checkout` + placement fix**

- Working NEAR + mPOO/test-token purchase from a **sheet**, not only the disclosure.
- Registration line item; receipt-driven confirmation; named failures.
- Ammo pill with confirmed balance.
- Insufficient-credits path opens the sheet with shortfall prefill.
- Mobile 390px reachable controls; keyboard focus trap in sheet.
- Acceptance tests from `pay-checkout.task.json` plus a mount test that the sheet opens from the dock gate.

**Out of scope:** packs beyond a simple quantity stepper, share cards, ceremony polish.

### Phase 1 — Consumer shape (the “ticket” feel)

- Packs (Drip / Session / Mural) as primary chooser; custom collapsed.
- Receipt theater (3 honest beats).
- Dock copy unification with recency totals (“Need N · Get paint”).
- Advanced balances remain in Paint & wallet details.
- Empty-board seeding awareness copy if free-window ships later (copy-only hook).

### Phase 2 — Viral loop

- First splat ceremony + share card export.
- Deep-link landing that frames “someone painted here” without requiring wallet first.
- Lightweight social proof: “N painters on this wall” only if a cheap on-chain/view signal exists — **ask before adding contract views**.
- Post-paint prompt once per session max (no nag).

### Phase 3 — Economy texture (after safety + caps)

- Float remaining / sold-out state as atmosphere when `outstanding_credits` nears cap.
- Bridge to TOILET claim UI (“you earned — claim”) without mixing claim into checkout.
- Session-key spend cap clarity in chrome (allowance remaining) — consent-visible, no silent renew.

---

## 10. Metrics (so ambition has teeth)

| Funnel | Definition |
|---|---|
| Desire rate | paint attempts with insufficient credits / sessions |
| Convert | sheet_open → confirmed purchase |
| Time-to-paint | first sheet_open → first confirmed draw |
| Trust fails | price_changed + unknown_broadcast + user_rejected rates |
| Share | share card opens / first_splat events |
| Return | sessions with ≥1 paint in D1/D7 |

Instrument with privacy-respecting client events first; no PII. Chain receipts remain source of truth for money.

---

## 11. Explicit non-goals (this stage)

- Embedded swap / inventory shop (NEARLY stays external).
- USD as a hard price (approximate only if sourced + dated).
- Optimistic credit grants.
- Auto-retry of unknown broadcasts.
- Novel paint mechanics, pressure revival, or TOILET spend.
- Turning the wall into a payments dashboard.
- Mainnet deploy (ops gate elsewhere).

---

## 12. Engineering map (where code should grow)

| Concern | Likely home |
|---|---|
| Reads (price, credits, balances) | `web/src/paint-wallet.ts` (extend; keep pure) |
| Purchase tx builders + exact math | new `web/src/buy-credits.ts` (+ tests that fail on float math) |
| Sheet UI | new `web/src/app/buy-paint-sheet.ts` mounted from wall + chrome |
| Ammo pill | `web/src/app/shell.ts` / `wallet-chrome.ts` |
| Desire gate | `web/src/pages/wall/mount-wall.ts` + draw-policy / stroke total |
| Operations reconciliation | `web/src/app/operations.ts` patterns — purchase as an operation kind |
| Styles | `wall-design.css` — sheet as bottom sheet on narrow, dialog on wide |

**Constraint reminder:** frontend-only for Phases 0–2 unless a metric requires a new view (ask first).

---

## 13. Acceptance story (Phase 0 done when…)

A stranger on paid testnet can:

1. Connect wallet on the correct network.
2. Attempt to paint with 0 credits and understand the shortfall.
3. Buy a chosen quantity with NEAR (and separately with the configured test token).
4. See registration charged once, as its own line, when `get_credits` was null.
5. Watch credits update only after receipt + re-read.
6. Complete a stroke whose dock total matched on-chain debit.
7. Survive: reject, wrong network, price change, and RPC blip without corrupted balances.

Evidence: focused unit tests + one recorded browser journey (screenshots/video) on 390px and desktop.

---

## 14. Decision asks (human, before Phase 2+)

| Ask | Why |
|---|---|
| Pack sizes final? (10 / 64 / 256) | Emotional defaults; reversible but brand-facing |
| Consumer word “paint” vs “credits”? | Plan recommends “paint” in UI |
| Share card on-brand art direction | Needs brand yes; reversible assets |
| Any on-chain “painter count” view? | New contract surface = ask-first |
| Launch free-window seeding? | Economy doc; affects empty-wall copy |

---

## 15. Why this can go viral (without betraying the product)

Communal boards already go viral on spectacle and presence. Meta Poo’s wedge is **blockchain-native consequence** (your paint costs something; fresh paint is expensive to overwrite; the wall remembers) wrapped in a **consumer ticket moment**.

The ambitious move is not a cleverer payment form. It is:

> **Make “Get paint” the doorway to the same dopamine as placing the pixel — then give people a beautiful way to show the mark they paid to leave.**

Ship Phase 0 tightly. Dress Phase 1 like a consumer app. Let Phase 2 earn the screenshot.
