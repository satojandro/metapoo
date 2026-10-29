# Buy-credits plan vs shipped UI — comprehensive review

**Date:** 2026-10-29 · **Status:** review of [`buy-credits-ux-plan.md`](buy-credits-ux-plan.md)  
**Verdict:** The plan’s *placement* and *honesty* instincts are right. Its *consumer theater* (packs, ammo pill productization, receipt choreography, first-splat share) is one fidelity band above the wall that exists today. Ship money on the current bones first; lift the whole paint journey one notch together; defer viral garnish until the chrome stops looking like a test harness.

---

## 1. What the shipped product actually is

Meta Poo today is **not** a blank wireframe — and it is **not** a finished consumer app. It is a **branded prototype with engineering chrome**.

### What already has product intent

| Surface | Evidence |
|---|---|
| Brand | `meta poo.` + “PUBLIC WALL. PRIVATE MOMENT.” |
| Atmosphere | Stall photo backdrop, focus-canvas zoom, “Leave your *mark.*” |
| Paint core | Palette, selection ring, pending magenta dots, paint zoom, drag strokes |
| Honest states | draw-state phases, price unavailable, credit shortfall text (no buy CTA yet) |
| Paid honesty (new) | Repaint legend + per-cell / stroke credit totals on schema 4 |

### What is still bare bones / harness

| Surface | How it reads |
|---|---|
| Shell chrome | “Connect NEAR wallet” + `<details>Paint & wallet</details>` |
| Paint & wallet panel | `dt`/`dd` balances, “Paid checkout is not enabled”, Refresh, NEARLY link |
| Paint dock | Long unlock essay about function-call keys; “Direct paint” checkbox; “Place paint” |
| Status strip | Monospace `flow-state` / compact status — operator telemetry aesthetic |
| Advanced | “Raw board state”, “Contract & schema”, drawing-session revoke controls |
| Nav | Wall live; Bounties / History / My activity = “soon” |
| Design system | **Two stacked CSS eras**: `style.css` (serif / brick stall) then `wall-design.css` (Arial / dark street). Override salad, not one language |
| Copy register | Mix of poetic (“Leave your mark”) and protocol (“Authorize drawing session on connect”) |

**One-line diagnosis:** the *scene* aspires to r/place-in-a-stall; the *controls* still explain NEAR to maintainers.

That mismatch already exists *without* checkout. The buy plan risks making it worse by adding a third register: **consumer IAP**.

---

## 2. Where the ambitious plan clashes

Mapped against product judgment ([`2026-10-14-product-judgment.md`](../2026-10-14-product-judgment.md)): *core paint moment first, ship the vertical slice, proven over clever, originality in brand/setting/feel — not novel commerce mechanics.*

| Plan idea | Clash with today | Severity |
|---|---|---|
| **Packs** (Drip / Session / Mural) | App still says “credits” and teaches access keys; pack names feel like App Store SKUs on a lab bench | High — brand voice jump |
| **Ammo pill** as always-on product chrome | Header is still Connect + disclosure; a polished pill next to harness controls looks bolted on | High — visual fidelity jump |
| **Receipt theater** (3-beat animation) | draw-state is already a quiet monospace phase line; choreography would outshine the paint confirmation itself | Medium — delight hierarchy wrong |
| **“Get paint” / ticket metaphor** | Current shortfall is “Not enough credits” + educational blocks; metaphor is fine later, premature as system copy now | Medium — vocabulary fork |
| **First splat + share card** | No share primitive, no capture pipeline, nav stubs; viral loop before the buy→paint path is even clickable | High — sequencing |
| **Desire-triggered sheet on the wall** | **Fits.** Unlock already moved into the dock for the same reason; buy belongs next to desire | Low — keep |
| **Exact math / receipt-driven credits / named failures** | **Fits.** Matches existing anti-optimism (pending dots ≠ confirmed; no fake balances) | None — keep |
| **Don’t bury buy in Paint & wallet** | **Fits.** That disclosure is already the advanced drawer | None — keep |
| **Metrics / funnel language** | Fine for us; not a user-facing problem | n/a |

**Core tension:** the plan optimizes for a *viral consumer app*. The repo’s accepted MVP optimizes for *one stranger: connect → understand price → buy → paint → someone else sees it* on testnet. Those are compatible destinations; they are not the same next commit.

---

## 3. Fidelity bands (why it feels “at odds”)

Think in bands, not features:

| Band | Character | Examples today | Plan items that live here |
|---|---|---|---|
| **A — Atmosphere** | Brand, stall, headline | meta poo., Leave your mark, stall photo | Share card art (later) |
| **B — Working tools** | Correct, plain, slightly nerdy | Connect, unlock essay, Place paint, credit shortfall text | Quantity buy, NEAR/mPOO pay, registration line, failures |
| **C — Consumer product** | Packs, pills, rituals, share | *Almost nothing shipped* | Packs, ammo pill, receipt theater, first splat |
| **D — Platform** | Bounties, history, claims | “soon” | TOILET claim bridge, social proof counts |

The buy plan’s Phase 1–2 jumps to **band C** while the money path and dock are still **band B**, sitting under **band A** scenery. Users feel that as “two products.”

**Rule for Meta Poo right now:** never ship a band-C control on a band-B journey. Either raise the journey or lower the control.

---

## 4. What to keep from the original plan

These ideas survive the review unchanged:

1. **Checkout lives on the wall at the moment of shortfall** — not only inside Paint & wallet.
2. **Confirmed credits ≠ pending**; never optimistic increment.
3. **Registration is a separate line item.**
4. **Named failures** (reject, wrong network, price changed, float full, unknown broadcast — no auto-retry).
5. **Paint purchase is not painting** — return focus to the same cell.
6. **NEARLY stays external**; testnet must not imply mainnet mPOO funds testnet credits.
7. **Frontend-only** until an ask for new views.

---

## 5. What to change (reconciled plan)

### 5.1 Reframe the ambition

Original bet:

> Buying credits should feel like buying a ticket into the stall.

Reconciled bet (matches bare-bones + judgment):

> **Buying credits should feel like the missing next step after “not enough paint” — as plain and trustworthy as Place paint — and only then earn ticket theater.**

Viral consumer ambition stays as a *north star*, not as Phase 0 styling.

### 5.2 Revised phases

#### Phase 0 — Money on current bones (MVP exit)

Match the **existing dock / draw-state language**. No packs. No ceremonies.

- Quantity stepper + exact total (NEAR default; mPOO/test token when configured).
- Trigger: shortfall on stroke/place **and** a single dock button **Buy credits** when schema 4 + connected (or “Get credits” if we accept one soft synonym — pick one word and use it everywhere).
- Sheet/panel visual: reuse **paint-dock** cream panel language (same radius, type size, button classes) — not a new “mobile IAP sheet” aesthetic.
- Ammo: a **quiet balance line** in the dock (`Credits: 47` or `47 credits`) — not a header pill product.
- Keep Paint & wallet disclosure as the advanced balance/NEARLY surface.
- Acceptance = `pay-checkout.task.json` + shortfall opens buy + 390px reachable.

#### Phase 0.5 — One vertical polish pass (required before packs/share)

Raise **connect → unlock → buy → paint** to one fidelity band. Same PR train as checkout polish, not a separate “rebrand.”

| Harness today | Polish target (still simple) |
|---|---|
| Unlock essay in dock | 1 title + 1 short line + Unlock |
| “Direct paint” | Keep if useful; rename only if user testing says so — don’t invent modes |
| “Not enough credits” dead end | Same sentence + **Buy credits** CTA |
| Dual CSS era | Prefer `wall-design.css` tokens for new chrome; stop adding `style.css` patterns for paid UI |
| Monospace flow-state as primary feedback | Keep for debug; user-facing status uses dock `draw-state` weight |
| “Authorize drawing session on connect” in header details | Stay advanced; don’t surface in buy |

**Success check:** a screenshot of buy + unlock + place should look like one designer touched them — even if the About drawer still looks like a lab.

#### Phase 1 — Consumer language (only after 0.5)

- Packs as presets (optional names: start with **10 / 64 / 256** numeric chips; add Drip/Session/Mural only if brand signs off).
- Soft receipt beats that mirror draw-state phases (submitted → confirmed), not a separate “theater” brand.
- Header ammo pill *if* Connect chrome is cleaned to match.

#### Phase 2 — Viral (only after strangers complete buy→paint without confusion)

- First confirmed paint emphasis (subtle dock pulse is enough).
- Share card export.
- Deep link framing.

#### Phase 3 — Economy texture

Unchanged: float/sold-out, TOILET claim bridge, allowance visibility — after safety/caps.

---

## 6. Copy: one dictionary

Stop forking vocabulary across docs and UI.

| Concept | Use in UI now | Avoid until Phase 1+ |
|---|---|---|
| Prepaid unit | **credits** (matches contract + current repaint UI) | “paint” as noun (“47 paint”) |
| Purchase verb | **Buy credits** | “Get paint”, “ticket” |
| Balance | **N credits** | “ammo” in user copy |
| Shortfall | existing `creditShortfall` phrasing + Buy credits | New metaphor sentences |
| Internal/eng | credits, ammo, sheet | — |

When (if) brand wants “paint” as the consumer noun, change **legend, cell price, stroke total, buy, and balance together** — never buy alone.

---

## 7. Interaction inventory (buy must plug in, not reinvent)

Ordered as a stranger hits them on a paid board:

1. Land on wall (atmosphere) — OK  
2. Focus / paint zoom — OK  
3. Connect wallet — bare but clear  
4. Unlock painting (session key) — correct placement, too much copy  
5. See price (legend / cell / stroke) — OK, new  
6. **Buy credits** — **missing** ← Phase 0  
7. Place / drag paint — OK  
8. See confirmation — quiet, OK  
9. Share — missing, correctly later  

**Do not** insert a new mental model between 5 and 6 (packs, tickets, ammo). Extend 5→6 with the same words as 5.

Insufficient-credits today ends in `fillBlock(…, "Not enough credits", shortfall)` with **no path to purchase**. That single missing link is the highest-ROI UX change in the entire ambitious plan — and it needs almost none of the ambition.

---

## 8. Risks if we ship the plan as written

1. **Uncanny product:** stall poetry + IAP packs + access-key essay = confused trust.  
2. **Delight in the wrong place:** receipt theater upstages the paint click (violates judgment §2.1).  
3. **Scope inflation:** share/deep-link/capture pulls away from MVP exit criterion in the work queue.  
4. **Copy debt:** “paint” vs “credits” vs “pixels available” already triple; packs add a fourth.  
5. **Design-system debt:** a new sheet component on dual CSS makes a third era.

---

## 9. Recommended decision for the owner

**Approve the reconciled sequencing:**

1. Implement **Phase 0** as checkout on current bones (credits language, dock CTA, dock-matched sheet).  
2. Budget a short **Phase 0.5** polish on unlock + buy + place as one strip.  
3. Hold packs / ammo pill / splat share for **Phase 1–2** after a human looks at Phase 0 on a phone and still wants more consumer energy.  
4. Keep the original plan doc as north-star ambition; this review constrains near-term delivery.

Optional ask (brand): when we *do* rename credits→paint, do it as one glossary PR across wall + buy.

---

## 10. Relationship to existing tasks

| Task | Relationship |
|---|---|
| `pay-checkout.task.json` | Still the implementation spine for Phase 0; interpret “panel” as dock-triggered sheet, not only Paint & wallet |
| `pay-recency-ui.task.json` | Done/landing; buy must reuse its shortfall + totals |
| `buy-credits-ux-plan.md` | North star; **Phases 1–2 deferred in spirit** until 0.5 |
| This review | Near-term sequencing + fidelity rule |

---

## 11. Bottom line

The ambitious plan is good product thinking aimed at the *right end state*. It feels at odds because it dresses **band-C commerce** onto **band-B controls** under **band-A scenery**.

**Be ambitious about the loop (desire → buy → paint → visible to others). Be humble about the chrome until that loop is real.** Then spend ambition on packs and share — when they won’t look like stickers on a prototype.
