# Frontend journeys and implementation contract

Date: 12 October 2026. Status: proposed implementation specification, not shipped behavior. Companion to the new PRD and contract/history specifications; their finalized domain schemas take precedence over illustrative interface names here.

## 1. Evidence and boundary

Read against `web/package.json`, `web/index.html`, `web/src/main.ts`, `contract.ts`, `submit-draw.ts`, `paint-queue.ts`, `drawing-session.ts`, `shared/types.ts`, and `docs/00-shared-decisions.md`.

The application uses Vite and vanilla TypeScript, with a single page wired to fixed DOM IDs. It has a 128 × 128 canvas, pan/zoom, keyboard selection, named palette, wallet connection, experimental draw-only sessions, serialized direct-paint queue, pending overlays, and stale-read guards. Current-board pagination pins reads to one block; defaults are optimistic, not final historical evidence. The current interface supports only board metadata, current pixels, and drawing. Network gas is distinct from future game charges.

There are no implemented pressure quotes, TOILET balances, funded bounty lifecycle, replay archive, collectible prints, crew templates, or multi-page navigation in these inspected interfaces. The payment-provider file is a future stub. Local code and tests do not prove deployed contracts or a completed live wallet journey. Existing documentation explicitly leaves live session authorization/revocation unverified.

Preserve: open-wall overwrite rights, named colors and keyboard controls, no invented chain success, no automatic resubmission of uncertain transactions, and no gas-sponsorship claim. A bounty region is a coordination target, never exclusive ownership. Buying a print does not freeze pixels or establish copyright.

## 2. Routes and navigation

Top-level navigation: **Wall · Art Bounties · History · My activity**. Wallet/network status remains global. Separate pages are necessary; bounty terms and historical provenance must not crowd the painting dock.

| Route | Main content and action | Required empty/error states |
|---|---|---|
| `/wall` | Live board; named palette; selected placement quote; pressure overlay; optional bounty/template context; paint | Missing contract; unavailable/stale board; incompatible schema; insufficient balance; expired quote |
| `/bounties` | Funded opportunities with preview, amount/token, named approver, region, deadline, lifecycle status; Create bounty | No funded bounties; disconnected browsing allowed; service unavailable; filters with no matches |
| `/bounties/new` | Terms → funding review → wallet → confirmed bounty | Invalid terms; insufficient tokens/storage/gas; rejected or uncertain transfer; refundable transfer |
| `/bounties/:id` | Immutable terms, escrow evidence, target region, optional template, submissions, review/refund status | Unknown ID; index lag; expired; unawarded; rejected submission; payout pending |
| `/history` | Finalized time navigation, wall/crop replay, selected snapshot evidence; Frame this moment | Index catching up; unavailable interval; archive gap; no finalized snapshot; playback load failure |
| `/prints/:id` | Canonical artwork, block/snapshot, crop and series/edition list; optional `?token=` selects one edition's owner/minter, separate from recorded contributors | Unknown artwork/edition; metadata or source unavailable; verification failed; loading owner |
| `/account` | Paint balance, pending operations, my submissions, payouts/refunds to claim, collected prints, drawing session controls | Disconnected; partial service outage; empty holdings; unresolved transaction |

Route query parameters carry explicit `board`, `x`, `y`, `zoom`, `bounty`, `template`, or `snapshot` identifiers. Validate and clamp coordinates/zoom; reject unsupported network/board references. A URL never supplies a trusted price, recipient list, or signable contract ID. History selection never silently becomes live paint mode.

Use History API routing in the existing stack. Extract `main.ts` into `mountWall(root, services)` returning `dispose()`, then build small page modules. Disposal cancels timers, aborts reads, and removes event listeners. Keep transaction recovery and wallet state in a shared service; leaving a page must not drop a broadcast operation. Configure the deployed host to serve the app on deep links; test refresh and browser back/forward. `/` is the stall entrance/overview and links to focused `/wall`; it is not a second independent board implementation. No framework migration is required.

## 3. Journey A: rally around a funded artwork

1. Visitor opens a bounty link without connecting a wallet. They see the actual escrow amount, artist brief, named sponsor/approver, submission deadline, review deadline, payout rules, and region. “Funded” requires confirmed escrow, not a draft record.
2. **Magic moment: “This is something we can make together.”** Preview the proposed artwork beside the current target area; show exact time remaining and a clear **Help paint** action.
3. Help paint opens `/wall` at the target region with an optional template overlay. Explain that matching the template is coordination, not automatic acceptance or a guaranteed payout.
4. Choose a cell/color, inspect current TOILET placement cost, connect if needed, acquire paint through the separately specified MPOO flow, and paint. Preserve region/selection through wallet return.
5. **Magic moment: “My mark is part of our picture.”** Confirm the recorded placement; update template match count from observed board state. Show pending pixels separately. Do not infer authorship or reward eligibility from matching colors.
6. Share copies a deep link and preview; no automatic social posting. Returning players can compare current art against the template or a saved finalized snapshot.
7. A team representative submits a finalized snapshot within the allowed deadline and locks a named payout distribution according to the bounty contract spec. Recipients and exact amounts are visible before submission. Distribution cannot change after submission; a replacement must be a separate eligible submission. The UI never derives payouts automatically from pixel counts.
8. Named sponsor reviews that immutable submission and its terms. Approval finalizes the award according to the contract; release/claim statuses track actual funds separately from artistic acceptance.
9. **Magic moment: “We made this, and it became part of the wall’s history.”** The accepted artwork links its snapshot, bounty, and settlement evidence. Minting the sponsor's reserved print is a separate explicit retriable action and never blocks artist claims.

First release needs shared templates and links, not a full crew social network. A template contains board ID, origin, bounded dimensions, palette version, palette-index cells (with transparent/no-target cells), title, creator, and content hash. Validate file sizes/dimensions; render only raster data and escaped text. Never execute uploaded SVG/HTML. Template opacity/toggle are local preferences. Display mismatch counts; do not paint or restore automatically. Personal watch regions may initially be browser-local with that limitation stated.

## 4. Journey B: sponsor an Art Bounty

1. Connect → create brief/title → choose region → review the fixed capture window (funding through submission close) → set submission/review deadlines and reward. The connected sponsor is the approver and MPOO is the fixed funding token (labelled test token in rehearsal); no unsupported token/approver selector. Distribution rules follow the bounty spec. Dates show local time and an exact timezone/UTC equivalent on review. Contract time governs eligibility.
2. Review all immutable terms and the maximum debit. Explain that subjective acceptance is the named approver’s decision, that painting does not guarantee payment, and when escrow becomes refundable.
3. Sign the supported funding transaction. Persist its ID/recovery record before displaying success. A token-transfer success alone does not prove escrow creation; confirm receipt/callback result and bounty state. Never silently send funds again.
4. Publish a shareable funded bounty after confirmed escrow readback. A locally saved draft remains explicitly **Unfunded draft**.
5. Review submissions with a fixed historical image, recipients, amount split, and evidence. Approve only an eligible submission before the contract deadline. Rejecting one submission does not erase others or shorten participants’ stated window.
6. On expiry, display **Refund available** only when the contract permits it; show transaction-pending and confirmed-refund states separately. A failed payout/refund remains a recoverable claim and never appears as paid.

Client-side countdowns are advisory. Re-fetch authoritative state before approval/refund. Concurrent approval, refund, or submission must fail cleanly with the actual updated state; a stale button is not permission.

## 5. Journey C: choose an affordable placement

1. Toggle **Paint cost** to see region-level pressure, with a numerical legend and non-color indicators. Explain: activity raises local cost; quiet time cools it; no account fairness or profit guarantee.
2. Select a cell. Display cost in TOILET, available balance, distinct network gas notice, quote age/expiry, and the maximum authorized cost.
3. Sign a bounded placement request. The contract computes the effective cost at execution and rejects a cost above the user's limit; the browser does not enforce economics by itself.
4. If the price rises beyond the limit, show **Price changed—review new cost**, keep the selection, and require another explicit action. If the quote expires or configuration changes, refresh before signing. Never silently increase spending tolerance.
5. For direct-paint mode, show a session spending budget independent of the existing access-key gas allowance. Every queued item carries a max cost and expiry; revalidate before dispatch. Stop on depleted balance, exhausted budget, expired authorization, or changed account/network. Cancel removes only unsent work; explain that an in-flight transaction may still settle.

Initial implementation can keep one transaction at a time. Do not promise brush-speed settlement until measured. Heat colors and prices must use the same contract configuration/version and quote reference. “Cheaper nearby” may compare fresh quotes but must not promise a fixed future cost.

## 6. Journey D: preserve a moment

1. Open History, choose a finalized moment and crop. Scrubbing is read-only. Display archive coverage and an explicit gap rather than interpolating invented historical pixels.
2. **Magic moment: “I can rewind our comeback.”** Replay real recorded changes using deterministic palette and crop data. First print release is a static captured moment; animated prints can follow once replay and media preservation are proven.
3. Select **Frame this moment**. Lock snapshot/block reference, crop, palette version, content hash, declared edition policy, mint cost, recipient, and rights statement. The print cannot switch to a later live image during wallet approval.
4. Mint → track final receipt → confirm token record → open print page. NFT ownership, minter identity, and recorded pixel contributors are separately labeled. Snapshot contributor credit is not a claim that all creative authors are known.
5. Verification checks the reproduced image against the committed manifest/hash and shows the trust model (for example an authorized snapshot publisher). A hash alone is not a proof that an image matches chain history. If verification or storage fails, disable mint and explain recovery.

There are no mystery cards, random selection, reserved painting rights, or automatic royalties in this release. Scarcity is exactly the declared collection/edition rule; identical art may still be captured elsewhere unless an explicit uniqueness rule exists.

## 7. Shared state and service dependencies

The following are conceptual frontend adapter interfaces, not claims that these methods exist. Freeze exact schemas with the contract/history agents before parallel integration. Use decimal strings for token quantities, timestamps, and identifiers that exceed JavaScript safe integers; never floating-point currency arithmetic.

| Adapter | Required capabilities and evidence |
|---|---|
| Board/pricing | Existing metadata/read/draw; versioned pressure config; bounded quotes; balance; max-cost/expiry enforcement; actual charged amount from receipt |
| Bounties | Paginated summaries/details; authoritative escrow state; immutable terms and submissions; approved payout distribution; funding/submit/approve/refund/claim operations and final receipts |
| History | Coverage and latest finalized height; deterministic snapshot manifest; cursor-ordered events; crop reconstruction; gap and index-lag metadata; finalized snapshot registration status |
| Prints | Mint constraints/fees and edition availability; snapshot reference; token metadata/ownership; duplicate/recovery lookup; receipt and provenance validation |
| Operations | Persist operation intent + network/account + hash when available; recover outcome after wallet return/reload; reconcile from contract state; never store wallet secrets in activity records |

Use a common operation state vocabulary: `draft`, `awaiting_signature`, `submitted`, `confirmation_delayed`, `confirmed`, `failed`, `cancelled_before_submission`. Domain lifecycle is separate: a confirmed submission is not an approved bounty, an approved award is not necessarily a completed payout, and a confirmed paint can already have been overwritten. Refresh/reconcile unknown outcomes before offering any retry.

Keep mock adapters available for parallel UI development, with persistent **Demo data — no funds or NFTs** labeling. Live mode must never silently substitute fixtures on service failure. Contract state is authoritative for money and minting; an index/API supplies discovery and history with visible coverage/lag. Bounty text and remote metadata are untrusted content: escape strings, limit lengths and uploads, allow only safe links, and reject executable media.

## 8. Mobile, accessibility, and verification

- Test at 390px mobile width and desktop; no horizontal page overflow. Use a compact painting dock and full-screen board option. Terms, approval recipients, and maximum debits must remain readable before signing.
- Preserve keyboard arrows/Enter and visible focus. Use semantic controls, named colors, textual heat/cost values, reduced motion, pauseable replays, and adequately sized touch targets. Do not announce every hover/pixel update to assistive technology; announce intentional selection and transaction state changes.
- Pan/pinch must never paint. Template visibility must not obscure pending/confirmed distinctions. Focus moves to route heading on navigation and returns correctly after dialogs.
- Deep-link wallet return preserves a draft/selection but revalidates network, quote, deadlines, recipient distribution, and authoritative state before enabling writes.
- Acceptance: a fresh visitor can open a real funded bounty, find its region, confirm one bounded-cost paint, submit a finalized moment, observe sponsor approval and recoverable payouts, and mint/view a reproducible print on testnet. Each action has a receipt/readback; service lag never manufactures success.
- Negative acceptance: stale quote rejected without excess debit; interrupted wallet funding recovered without double funding; expired bounty not approved; failed transfer shown as claimable/failed rather than paid; archive gap prevents mint; same snapshot reproduces identical bytes; account switch stops queued paint; direct-route refresh and browser back work.
- Unit checks focus on route decoding, money formatting, quote expiration/budgets, lifecycle permissions, and manifest validation. Integration checks cover adapter responses and delayed/failed operation recovery. A real testnet walkthrough is a separate release gate from fixtures and builds.

## 9. Frontend work partition

Coordinator owns `shared/**` and schema freeze. One frontend integrator owns routing, shared wallet/operations services, `web/index.html`, and changes to existing wall wiring. This prevents simultaneous rewrites of `main.ts`.

After adapter freeze, independent agents can own `web/src/pages/bounties/**`, `web/src/pages/history/**` plus prints, while frontend integrator F exclusively owns pressure UI (including `web/src/features/pressure/**`). Each page agent delivers fixture-backed screens and negative-state checks first, then plugs into real adapters. Fixtures are evidence of UI behavior only. Integration must remove every live-path fixture, verify token quantities and provenance, and record testnet receipts before describing the experience as end-to-end working.
