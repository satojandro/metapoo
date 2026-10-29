# Meta Poo — whole-site product and design review

> Correction (29 Oct, code audit): the canonical testnet paid board is `board3.metapoo-player1.testnet`.
> `board1.metapoo-player3.testnet`, previewed below at the legacy 0.0069 price, was an earlier deployment that has since been replaced.
> The checkout found missing below has since shipped (`55526b9`).

Date: 29 October 2026. Status: design recommendations for owner review, not approval of new economy rules, authorisation changes, palette changes, contracts, or deployment.

## Verdict

Meta Poo is a branded functional prototype with a distinctive setting and increasingly capable painting infrastructure. It is not yet a coherent consumer experience. The next milestone should be one beautiful, understandable mobile journey from discovering the wall to making a confirmed mark. Checkout belongs inside that journey; it should not become a separate design language.

The design promise: **a public wall you want to touch, in a place you remember.**

Apply an Apple-level standard of clarity, restraint, craft, and feedback while preserving Meta Poo's irreverent street-art identity. White cards and generic glass effects would not, by themselves, improve this product.

## Evidence and limits

- Reviewed GitHub main at `c6979be0f7fd7641a43ab56b694b28624189bc6d`, fetched during this review. The working checkout is a different branch at `3d214b8`; the browser preview used an isolated export of main.
- Inspected the running frontend at desktop 1280 × 720 and mobile 390 × 844. Exercised focus mode, palette selection, paint zoom, hint dismissal, and the wallet disclosure. Mobile was a browser viewport simulation, not a physical-device touch test.
- Also configured a separate local preview for `board1.metapoo-player3.testnet`, the account reported in PR #22. Its paid price, repaint legend and board freshness loaded through the frontend. Observed block 275247404 and subsequent refreshes; displayed price was 0.0069 NEAR per credit and 1 configured test token per credit. This confirms those browser reads at review time, not the 49 acceptance checks reported by #22.
- No wallet connection, key approval, purchase, painting transaction, claim, or mainnet interaction was performed.
- Read the documentation map, product judgment, roadmap, shared decisions, payment handoff, work backlog, PR #21's plan and reconciliation review, and PR #22's deployment report.
- Consulted the archived visual brief and concept to recover historical intent, not to promote archived proposals to current authority. The original HEIC photographs were not re-inspected; this is not an original-art or reference-fidelity approval.
- No application code was changed. This is an expert inspection, not a usability study with new users or a complete accessibility audit.

## What to preserve

1. **The setting.** A communal wall above a toilet is memorable. The original street-art environment gives it a reason to exist beyond another pixel canvas.
2. **The invitation.** “Leave your mark.” is concise, relevant and expressive. The unusual gallery framing suits the product.
3. **The core surface.** Keep the real editable canvas flat, square and precise even when the surrounding room has depth.
4. **Honest state.** Selection, submitted paint and confirmed paint are different things. Preserve that distinction through every redesign.
5. **Existing capabilities.** Keyboard selection, named swatches, visible selection, zoom controls, pending markers, session recovery and reduced-motion styling are foundations to refine, not features to rebuild from scratch.
6. **A narrow release.** The wall is the product for this stage. Bounties, historical prints and a larger token dashboard do not need to occupy the first screen.

## Where the experience breaks

| Priority | Observation | Impact | Recommended treatment |
|---|---|---|---|
| P1 | The paid flow has no checkout in reviewed main. | A visitor cannot complete the intended paid journey. | Deliver PR #21 review's Phase 0, with a dock purchase entry and shortfall entry. |
| P1 | Session copy says the drawing key “cannot move your funds,” without explaining paid-credit spending. | A user can misunderstand the authority they grant on a paid board. | Explain that it cannot transfer wallet tokens but can spend this board's paint credits. Keep approval scope and actual limits truthful; do not invent a credit cap. |
| P1 | “No app fee,” “Testnet” and “LIVE BOARD” are static labels; the mock preview simultaneously says it is not on a blockchain. | People receive conflicting information about money and environment. | Drive environment labels from actual configuration; distinguish credit price, registration and network fees. |
| P1 | At 390 × 844, the board and dock dominate while most stall identity disappears. The first-use hint occupies much of the canvas. | Mobile loses both the brand setting and usable drawing space. | Design explicit mobile overview and painting compositions. Use a small, dismissible hint beside controls. |
| P1 | The board legend and contract line fall below the visible scene boundary in the inspected mobile layout. | Information present in markup is not necessarily information a visitor can see. | Give essential guidance a real layout slot outside the clipped scenery; move technical detail into details. |
| P2 | Guidance is scattered across header state, dock state, preview text, selection text, freshness and details. | The visitor must assemble the next action. | One primary action and one nearby status per interaction state; keep technical diagnostics in details. |
| P2 | Focus canvas, Paint zoom, zoom controls, Direct paint and Place paint expose overlapping concepts. | People must understand implementation modes before making a mark. | Separate viewing controls from painting tools. Design the select/place and direct-paint states together, without silently changing paid submission behavior. |
| P2 | The desktop palette wraps into two rows while other dock content stretches across a large cream panel. | The tool feels assembled rather than composed. | Design intentional responsive dock arrangements; selected colour, cost, balance and next action must read as one group. |
| P2 | Essential mobile status text is around 9–10 px; swatches measured about 42 × 40 px. | Harder reading and touch targeting than the desired quality level. | Use roughly 14–16 px for actionable messages, and aim for 44 px minimum primary touch targets. Verify contrast, zoom and text enlargement. |
| P2 | The public desktop navigation advertises three unavailable destinations. Direct routes expose some internal worker language. | The site promises a larger product than visitors can use. | Remove inactive destinations from primary navigation; give direct links a deliberate public-facing unavailable page. |
| P2 | Colour language differs: vivid surrounding art, muted editable palette, pink headline and cream tools. | The connection between the scene and what users can create is weak. | Unify interface colours and materials first. Explore palette changes separately with artwork-compatibility review. |
| P2 | The empty board reads as a large dark technical surface. | The collective creative premise is difficult to grasp before activity arrives. | Add a truthful empty state and deliberate initial-art strategy. Never substitute decorative sample pixels for live work. |
| P3 | Current-artist information exists, but a clear social and return journey is not yet established. | Painting risks feeling like a transaction with no continuing story. | After the core loop works, design cell inspection, returning-to-your-mark, and sharing in that order, using available data. |

P1 means resolve before calling the paid journey ready for a wider rehearsal. P2 means part of the first coherent design release. P3 means after that release proves useful.

## Design direction

### Artful room, calm tools

Keep depth, worn surfaces, original murals and a recognizable toilet in the room. Keep controls quiet, legible and consistently placed. The environment supplies the mischief; the controls supply confidence.

The canvas must be visibly the communal artwork, rather than an unexplained dark panel competing with richer decoration. Establish the difference through framing, space and a restrained label, not a paragraph on top of the art. In painting mode, move attention toward the canvas and reduce decorative competition.

Use one interface type family with a deliberate scale; the existing italic headline can remain a small expressive exception. Define shared spacing, colour, border, button, panel and status tokens. A token is a named reusable value, such as the same background colour for every tool panel. Do not add a third set of checkout styles on top of the existing two CSS layers.

### Two compositions, one wall

**Overview:** understand the stall, see the whole communal board, inspect an area, and enter painting. This should be immediately interesting without connecting a wallet.

**Painting:** a precise canvas, compact tools within thumb reach, current selection, honest cost, credits and the next action. Preserve camera and selection when connecting or buying; return to the same place afterward. The mobile experience may prioritize painting space while retaining a recognizable piece of the stall and a reachable way back to overview.

These are presentation states of the same board, not separate canvases or a new game mechanic. The design must map existing focus, zoom and direct-paint behavior before changing any behavior. Camera mathematics and submission modes remain separate implementation decisions.

### A state-aware dock

| State | Primary communication | Primary action |
|---|---|---|
| Browsing, no intent | Explore freely; no wallet needed to look. | Enter painting / select an area. |
| Paint intent, disconnected | Connect to place your mark. | Connect wallet. |
| Connected, session approval required by current flow | Enable painting in this browser; explain credit spending. | Existing explicit approval flow. |
| No colour or cell chosen | Name the missing selection. | Select the missing item. |
| Price loading or unavailable | Checking price / price unavailable. | Wait / Retry; no guessed quote. |
| Insufficient credits | Stroke needs N; balance is M. | Buy credits, prefilled to the shortfall. |
| Ready, select-and-place | Selected colour and total cost. | Place paint. |
| Ready, direct-paint mode | Clearly say touching/dragging paints and spends credits. | Canvas interaction; do not show a redundant Place action. |
| Submitted | Mark the pending cells and show nearby progress. | Inspect status; avoid repeat submission. |
| Confirmed | Confirm the result briefly at the affected area. | Continue painting. |
| Outcome uncertain | Checking the submitted operation; don't submit again. | Check status / refresh. |

This table is a proposed presentation model. It is not permission to reorder wallet authorisations or introduce automatic spending.

### Trust belongs in the interface

Use “credits” consistently for this stage. State that fresh cells can cost more, show the exact stroke total, and distinguish credits from both wallet tokens and key gas allowance.

Registration is a separate purchase line. Purchasing credits does not automatically place a stroke. Closing checkout returns to the selected area. Rejection is a normal recoverable outcome. A refresh failure is unavailable information, not a zero balance.

Suggested session explanation, subject to matching actual implementation: “Approve painting in this browser. This key can spend your paint credits on this wall. It cannot transfer NEAR or tokens from your wallet. You can revoke it in Wallet.” Make the revocation entry reachable wherever this promise is made. Do not claim an expiry, credit limit or allowance that the system does not enforce.

### Fun comes from making a mark

Prioritize precise targeting, responsive colour selection, a visible pending mark and a satisfying confirmed result. A small local pulse or concise “You're on the wall” message can be enough. Respect reduced motion. Do not add elaborate purchase celebration before paint itself feels satisfying.

Use wit in invitations and optional delight. Use plain literal language for costs, permissions, errors and refunds. No forced jokes while someone is trying to understand a payment.

## The whole website, beyond checkout

- **Entry and navigation:** `/` and `/wall` already mount the wall on main. Keep that directness. Avoid a marketing gate before the communal art. Keep Help, Wallet and rules reachable; remove unavailable primary sections.
- **Orientation:** explain a shared, overwriteable wall in one line. Show guidance when it becomes useful, without obscuring the selected region. Allow replaying help.
- **Wallet:** combine connection, network, credits, session status and revocation in an understandable account surface. Put raw contract, schema and operation diagnostics deeper. Token acquisition remains an external NEARLY path with correct network language.
- **Checkout:** implement the reconciled Phase 0 from #21. Preserve exact arithmetic, price protection, registration, receipt checking, and fresh balances. Use a desktop dialog/mobile sheet with keyboard focus, Escape/close behavior and preserved canvas context.
- **Painting:** compose palette, selection, stroke price, credits and action together. Preview promptly, but visually distinguish preview from submitted and confirmed state. Explain the active gesture before a paid touch can submit.
- **Progress and failure:** consolidate ordinary status beside the canvas. Escalate interruptions only for decisions requiring attention. Recover to the previous selection. Never silently retry an uncertain purchase or paint.
- **Social understanding:** make inspecting the current painter and overwrite rules easy. Do not label the current artist as permanent owner. Future history or reward UI must describe only the capabilities actually available.
- **Empty, loading and offline:** intentionally design all three. Keep last-known art with a stale label where valid. A failed board read must not impersonate an empty wall. Keep mock and live views visibly distinct.
- **Unavailable pages:** public copy should not mention Worker G/H, fixture adapters, or implementation ownership. Do not expose an empty platform around the one working product.
- **Launch preparation:** decide initial wall seeding and how public artwork reports are handled before inviting a wider audience. These are product decisions, not reasons to build a moderation platform during the design pass.

## Delivery sequence

### 1. Design the complete slice before styling checkout independently

Deliver reviewed desktop and 390 px mobile designs for overview, painting, connection/approval explanation, shortfall, checkout, confirmation, unavailable price, and uncertain outcome. Include an empty board and realistically populated board. Use the same components and vocabulary across all states. Sample artwork must be labeled.

Acceptance: the owner can follow the journey visually; the canvas, cost and next action are obvious; room identity survives on mobile; no screen requires a developer explanation. This is the next visible design deliverable, not a long redesign specification exercise.

### 2. Implement one coherent testnet journey

Deliver Phase 0 checkout together with the immediately adjacent dock, truthful status/permission copy, navigation cleanup, and mobile layout fixes. Limit refactoring to the components changed. Design approval and the existing checkout authorisation/task boundaries govern actual implementation.

Acceptance: connect → understand approval → buy with NEAR → return to selection → paint → observe matching credit debit → observe in a second browser. Repeat with the configured test payment token. Exercise cancellation, unavailable price, insufficient funds, wrong network, identity switch and uncertain outcome. Preserve a reviewable PR, screenshots, browser recording and transaction references.

Do not combine this with new contracts, wallet scope changes, palette migration, token-economy work, broad CSS replacement, or mainnet release.

### 3. Refine the paint experience with people

Invite about five first-time participants, including phone users. Ask them to explain the wall, select a cell, predict its cost, buy test credits and place a mark without coaching. Observe uncertainty, wrong taps and recovery. This is formative research: five people can uncover friction, not establish a statistically reliable conversion rate.

Proposed success gate: at least four complete the journey without assistance; all understand that credits cost something and others can repaint; no accidental paid submission occurs; no one mistakes pending paint for confirmed paint. Revise the largest observed failures before expanding scope.

### 4. Add reasons to return

Only after the journey works: clearer current-artist inspection, return-to-your-mark behavior, a useful sharing view, and optional pack presets. Review larger History, Bounties, prints and TOILET experiences independently. Contract readiness does not make these good next homepage sections.

## Immediate agent brief

First produce the complete desktop/mobile journey design described in step 1. Use the existing judgment document and PR #21's reconciliation review as inputs. Keep the stall identity and present one consistent tool system. Show the paid approval, checkout and recovery states as carefully as the hero view. Bring the concrete design back for review before a broad visual implementation. Existing bounded checkout work can proceed against the same requirements; do not expand its scope into packs or sharing.

## Reference pointers

- Current authority: `docs/README.md`, `docs/2026-10-14-product-judgment.md`, `docs/00-shared-decisions.md`, `docs/payments/frontend-handoff.md`.
- Historical visual intent: `docs/archive/planning-2026-10/2026-10-12-visual-redesign-agent-brief.md` and `2026-10-12-visual-concept.md`; the reference material is historical context, not new approval.
- Presentation code: `web/src/app/shell.ts`, `web/src/pages/register-default-pages.ts`, `web/src/pages/wall/wall-template.ts`, `web/src/style.css`, `web/src/wall-design.css`.
- Paid price behavior: `web/src/pages/wall/repaint-price.ts` on reviewed main.
- Plans under review: [PR #21](https://github.com/satojandro/metapoo/pull/21), [PR #22](https://github.com/satojandro/metapoo/pull/22).
- External principles: [Apple feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback) supports integrated feedback and proportionate interruption; [W3C accessible design tips](https://www.w3.org/WAI/tips/designing/) support sufficient contrast, keyboard access and visible focus.
