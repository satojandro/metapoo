# Delivery plan and agent handoffs

Date: 12 October 2026. Scope: implement the [product PRD](../2026-10-12-product-prd.md). This pass delivers documentation, not running economic contracts or funded services.

Read [core-board.md](core-board.md) first. It preserves the familiar pixel-board rules, separates prototype dimensions from the proposed larger capacity target, identifies existing modules to reuse and lists remaining deployment/device/wallet checks. Do not interpret the new scope as permission to reinvent the board. B and F own baseline completion as well as their extensions; other agents consume the shared board interfaces.

## 1. Smallest complete proof

On testnet, a sponsor funds one bounty with a clearly labelled test token; two artists buy paint, paint under bounded pressure quotes, agree a split, and submit a finalized historical snapshot. Sponsor accepts after submission close; artists claim; sponsor mints the reserved print independently. Another sponsor lets a bounty expire and recovers funds. Reopen each account and verify the final state. Replay the captured region after the live artwork is overwritten.

Use time-compressed deadlines only in an explicit test configuration. Public defaults remain in the bounty spec. A fixture-only tour is useful, but it is not this proof.

## 2. Repository layout and single-writer ownership

Existing files are retained until their owner performs the agreed integration. Do not reset concurrent dirty work or overwrite the existing visual redesign. Proposed new paths below do not exist merely because they appear in this table.

| Package | Owner | Exact write boundary | Deliverable |
|---|---|---|---|
| A — Protocol/integration | Coordinator | `shared/**`, root navigation docs, integration fixtures, dependency/lockfile review | Versioned types, error vocabulary, golden vectors, API freeze; final integration |
| B — Board/economy | Board agent | `contracts/board/**`, `simulations/pressure/**` | Pressure, MPOO paint receiver, TOILET ledger, authenticated spending budgets, migration/events |
| C — History service | History agent | `services/history/**` | Finalized ingest, database, snapshots/replay, replicated archives, HTTP/query API |
| D — Registry/prints | Print contract agent | `contracts/prints/**` | Immutable snapshot registration and numbered NFT issuance; bounty entitlement callback |
| E — Bounty escrow | Escrow agent | `contracts/bounties/**` | Funding, immutable terms, consent, award/refund state machine and recoverable claims |
| F — App shell/wall | Frontend integrator | Existing `web/src/main.ts`, wallet/draw adapters, route shell, shared style, `web/index.html` | Route lifecycle, wallet/operation recovery, paid wall integration and pressure UI |
| G — Bounty pages | Bounty UI agent | `web/src/pages/bounties/**` and co-located scoped styles/tests | Browse/create/detail, template context, submissions/consents/review; claim widgets |
| H — History/print/account pages | Collection UI agent | `web/src/pages/history/**`, `prints/**`, `account/**` | Timeline/crop, provenance, mint recovery, my activity using frozen adapters |
| I — Independent validation | QA agent | `tests/e2e/**`, `tests/scenarios/**`, evidence docs | Multi-user scenarios, abuse tests, balance invariants, mobile and actual testnet evidence |

Only A changes shared models. Other agents propose schema patches to A. Only F changes existing wall/wallet wiring and common CSS. Only B changes board events and migration. D owns the registry contract; C owns the service that attests to it. Account page widgets consume other domains' adapters rather than editing their financial logic. Any ownership transfer is explicit in the handoff log.

## 3. Interface freeze before parallel implementation

Coordinator creates `shared/protocol/{board,bounties,history,prints,operations}.ts` and matching serialized examples plus `shared/fixtures/**`. Existing `shared/types.ts` remains a compatibility layer until migration. No implementation agent invents an alternative monetary type or lifecycle enum.

Freeze:

1. Chain/board identity: network genesis, contract account, board epoch; event `revision` monotonic per epoch, decimal strings for large values. Wire field is `revision` across board/history; no competing `board_seq` field.
2. Paid draw: exact session/wallet method names, pricing version, maximum cost, expiry, account-scoped sequential nonce, actual charged result. Client adapters map existing colorIndex to wire color.
3. Token fixture, pack config, integer amount precision, receiver/refund semantics, storage policy. Prototype test amounts are not live token economic decisions.
4. Snapshot canonical bytes, ID and manifest envelope; distinguish finalized origin data from attester certification. Golden full-board, crop and empty-vs-Ink examples.
5. Registry → escrow immutable snapshot registration; escrow → prints immutable bounty entitlement; authenticated callback and idempotency behavior in both.
6. Bounty terms/proposals, exact crop match, consent digest serialization, funding/submission/review boundaries, payout dust allocation, claim attempt state.
7. HTTP schemas, cursor/coverage/error formats, persisted operation IDs and outcome lookup for reload recovery.
8. Print public series and separate collector entitlement: public mint must not squat or consume reserved bounty edition.

Schemas must include both successful and rejected/uncertain operations. Error codes are stable uppercase identifiers with user-facing translations; domain specs' prose is not a substitute for typed payload fixtures. Freeze review is a small first implementation task, not an excuse to let every agent guess.

## 4. Work waves and dependencies

### Wave 0 — freeze and scaffold

A freezes fixtures and contracts; F extracts route lifecycle preserving current wall tests; B builds pure pressure simulation/price vectors. These can overlap after the initial types are agreed. Fixture UI uses a persistent demo label. Existing free schema continues to work until the paid adapter is explicitly enabled.

Exit: one source of truth for interfaces, route disposal tested, pressure scenarios reported, migration plan selected from actual deployment evidence. If actual deployment is absent, use a fresh testnet board and preserve old-schema migration fixtures rather than claiming a migration happened.

### Wave 1 — domain implementations

B implements paid board and v2 events. C implements ingest against saved execution fixtures, then integrates actual board events. D implements registry/prints against fixed manifests. E implements escrow against the test FT and registry fixtures. F/G/H build route modules using frozen adapters. No need for everyone to inherit the entire conversation.

Exit per package: meaningful unit/contract tests, negative cases, fixture version, changed files, commands/results and known limitations. A reviews interface diffs before merging.

### Wave 2 — wire one vertical slice

B→C: real finalized board history. C→D: verified encoded snapshot and attested registration. D→E: snapshot reference eligible for bounty. G/E: actual funding and consent. E→D/H: award entitlement then independent print mint. F integrates shared wallet and operation recovery. I reproduces happy and failure paths through independent clients.

Critical path: shared types → board events/baseline → finalized snapshot registry → eligible submission → accepted award → print redemption. Escrow and most UI can be developed before the history service is live using truthful fixtures.

### Wave 3 — rehearsal and launch decision

Run the PRD's independent sponsor/artists/spectator exercise with test assets. Record contract/code hashes, configuration, transaction/receipt references, expected and observed balances, archive retrieval evidence and mobile results. Rehearse paused writes, failed claims, expired bounties and interrupted indexer. Fix discovered problems before expanding features.

Mainnet, actual token transfers, operating budgets, authority assignments and production economic parameters are separate decisions. No agent infers these from a passed test suite.

## 5. Efficient use of limited context/tokens

Delegation increases parallel throughput and isolates context; it does not make total token use free. Prefer bounded packages with fixed interfaces over many agents exploring the whole repository.

Practical plan for this environment's four concurrent slots: coordinator plus three workers. First implementation group B/E/F; next C/D/G; then H/I and integration fixes. C may begin earlier if a slot opens and fixtures are frozen. Do not create nine simultaneous agents or duplicate domain audits.

Budget envelope, offered as allocation guidance rather than measured token estimates: 10% interface freeze, 25% contracts/economy, 20% history/prints, 25% frontend, 20% integration/validation. Preserve the integration reserve; do not consume the whole budget generating more proposals. Actual cost depends on failures and environment setup; ask for a numeric budget only if a hard ceiling is needed.

Coordinator can directly handle this PRD/spec pack, shared types/fixtures, integration choices, and one compact frontend foundation slice. Delegate specialist domain implementation and independent validation. Doing every contract, backend and page in this one chat would consume the budget on repeated context and leave little verification capacity.

Recommended next bounded implementation: A + F deliver routes and fixture-backed Art Bounties list/detail/create while B/E build pure pricing vectors and escrow tests. This produces a reviewable user journey without implying live money. Do not start a cosmetic-only full redesign before that flow is clear.

## 6. Ready-to-dispatch briefs

Common preamble for every package: Read PRD sections 1–6, this ownership table and only your domain spec. Inspect applicable repository instructions and current dirty state. Work inside assigned paths; preserve other work. Treat defaults as prototype configuration. Do not deploy mainnet, move funds, create new chats or rewrite shared interfaces. Report necessary interface changes to coordinator. Deliver tests/evidence, not success claims from mock data. Stop at a genuine dependency and identify exact required data; continue independent fixture work where possible.

### B — board and pressure

Implement [pressure-and-paint](pressure-and-paint.md) in your paths after A freezes types. Start with simulator/golden vectors, then migration and paid entrypoints. Preserve legacy tests as legacy behavior; no free bypass in paid schema. Demonstrate atomic debit/write, quote limits, restricted-key budget enforcement and receiver refunds. Include storage/gas estimates backed by test measurements. Hand over event fixtures to C and draw adapter examples to F.

### C — history and archive

Implement service portions of [history-and-prints](history-and-prints.md). Pin provider dependencies after checking their actual interfaces. Produce baseline/ordered replay, gap detection, snapshot encoding, two archival copies, APIs and restart recovery. Do not hold spending credentials. Hand over manifest fixtures and published registry record to D/E; show independent replay and coverage evidence.

### D — registry and prints

Implement contract portions of [history-and-prints](history-and-prints.md) with fixed attester authorization, immutable metadata, versioned edition rules and independently retryable bounty redemption. Test concurrent last edition, duplicate request, wrong attester/escrow and callback failure. Never make contributor payment depend on your contract's availability.

### E — escrow

Implement [art-bounties](art-bounties.md) against the shared test token and registered snapshot fixtures. Prove exact funding and refunds, consent digest binding, all deadline edges, award/expiry races, allocation sums and failed transfer recovery. Bounty funds never enter paint/staking revenue. Hand over state/readback examples to G/H.

### F — shell and wall

Implement lifecycle-safe routes in existing vanilla TypeScript; preserve wall behavior and wallet recovery. Integrate typed paid quote/paint adapters, pressure overlay, bounds and session budget after B is ready. Expose reusable operations/wallet services to G/H. Do not mask backend failure with fixtures. Keep current 3D/art redesign work intact unless an explicit integration change is necessary.

### G — bounty experience

Build [frontend journeys](frontend-journeys.md) bounty pages with fixture adapter first. Include funded-vs-draft distinction, reference template/deep link, immutable preview, consent, sponsor review, refund and recoverable claims. Clearly explain voluntary painters versus paid split recipients. Add 390px and keyboard checks; then replace fixtures with E/C services through shared adapters.

### H — collecting and account

Build history/crop/static print and personal activity pages using shared adapters. Show coverage, finalized evidence, edition rules and distinct mint recipient/current owner/contributors. Track claims and pending financial actions without retrying uncertain broadcasts. Keep animated NFT export, mystery cards and staking pages out of this package.

### I — independent release evidence

Read specs and exercise implementation through public methods, not internal helpers alone. Test expensive-region obstruction and multi-wallet behavior, financial invariants, archive gaps, forged registration, immutable accepted snapshot, public/bounty edition separation and failed asynchronous transfers. Run independent-wallet testnet rehearsal and mobile/desktop checks. Report defects with reproduction and source references; do not equate a green build with launch readiness.

## 7. Handoff and completion checklist

Each handoff contains: package/version, files changed, dependencies required, example input/output, checks run and result, current limitations, and next integration step. Keep it to a short document plus fixtures rather than copying long tool logs.

Definition of integrated done: all domain contracts agree; no live route uses fixtures; balances reconcile; histories reproduce; queued operations survive navigation/reload; successful receipt plus authoritative read-back supports every completion state; expiry/refund/claim failure cases pass; archive bytes retrieve and match; actual independent testnet participants complete the journey. Record what is still trusted and who can upgrade it.
