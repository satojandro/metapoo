# Meta Poo: the wall, the market, and the moments

Date: 12 October 2026. Status: implementation-planning baseline; not a deployment or claim of implemented features.

## 1. Purpose and source of truth

Build a shared NEAR pixel wall where communities create and defend art, collectors fund Art Bounties, and people collect verifiable historical prints. Local demand changes the cost of painting, giving location and timing strategic meaning.

The user approved focusing on these three pillars and excluding mystery cards. Audience order: existing mPOO/NEAR communities, other crypto communities, then broader pixel-art audiences. Creation develops attachment; defence supplies a longer-term reason to return. Lore: cheeky longtime NEAR contributors positioned as Meta Pool's nemesis, with freedom to develop the story. This describes the user's creative direction, not affiliation or endorsement.

This PRD owns product scope, journeys, and priorities. [Delivery plan](implementation/delivery-plan.md) owns allocation and integration gates. Domain specs own their named interfaces. [Economy plan](2026-10-12-paint-economy-and-swap-plan.md) remains authoritative for MPOO purchases, TOILET issuance/rewards, staking and reserves. [Shared decisions](00-shared-decisions.md) separates current code from proposed behavior. Old numbered briefs describe the original free MVP, not this release's complete scope.

Mechanics labelled **proposed default** are sufficiently specific for simulation and testnet implementation. They are not approved mainnet parameters. Agents must record departures through the coordinator instead of silently choosing incompatible rules.

## 2. Current evidence and gap inventory

The [core board handoff](implementation/core-board.md) is authoritative for preserving the established game and completing its live verification. Agents must reuse that baseline rather than redesigning it; the three new pillars are extensions.

Inspected checkout: base commit `e5d0c13`, plus existing uncommitted documents and visual assets. Preserve those changes. Runtime deployment was not verified. Earlier in this review, 78 frontend, 15 Rust, and 12 shared tests passed; production build passed with dependency warnings. These checks predate this documentation-only change and are not live wallet evidence.

| Capability | Current repo | Required addition / release |
|---|---|---|
| Shared painting | Rust schema 2, 128×128, eight colors, free Open wall, one-cell draw | Paid schema, versioned quote and pressure rules / R1 |
| Frontend | Vite/vanilla TypeScript, one HTML page, canvas zoom/pan/palette | Route lifecycle, new screens, context links / R1 |
| Drawing sessions | Restricted key, local signing path, queue and fallback | Contract-enforced paint budget and expiry; live wallet rehearsal / R1 |
| Updates | Full paginated block-pinned reads and polling | Finalized event history, incremental updates, reconnect cursor / R1 |
| Art Bounties page | Missing | Browse/filter funded briefs; detail/create/submission/review / R1 |
| Bounty escrow and payout | Missing | Separate MPOO escrow, deadlines, locked splits, claims/refunds / R1 |
| Crew coordination | Missing | Shareable region/template and explicit submission participants / R1; persistent crews later |
| Pressure pricing | Missing | Contract-authoritative regional cost and readable overlay / R1 |
| MPOO purchase / TOILET balance | Payment provider is an unused placeholder | Verified purchase receiver, balance, atomic spend / R1 dependency |
| History and snapshot service | Missing; contract emits draw logs | Indexer, baseline, finalized snapshots, deterministic encoding / R1 |
| Historical print / NFT | Missing | Registry, numbered static editions, collectible page / R1 |
| Personal account dashboard | Missing | Paint, submissions, awards/refunds, prints and pending operations / R1 |
| Bounty activity / changed since visit | Missing | Derived factual activity and bounded replay / R1 basic; richer defence later |
| Longevity / staking / swaps / shop | Planned, not implemented | Separate economy phases; not prerequisites for the first bounty rehearsal |
| Animated prints, notifications, season resets | Proposed in conversation, absent | Later; not implied by R1 |
| Mystery cards | Absent | Explicitly excluded |

Sources: `contracts/board/src/lib.rs`, `shared/types.ts`, `web/src/main.ts`, `web/src/contract.ts`, `web/src/submit-draw.ts`, `web/src/paint-queue.ts`, `web/src/payment-provider.ts`, `web/index.html`. Existing visual concepts are sample artwork, not chain state.

## 3. Product principles

1. The bounty is the rallying point; the wall is the common place where the work happens.
2. An overwrite changes the live wall, not an already captured moment or historical credit.
3. A funded brief is a real escrow liability, not an unfunded pledge or game revenue.
4. Players see an understandable price and maximum spend before signing; no silent price chase.
5. Art judgement is human and named. The contract enforces the agreed procedure, not beauty.
6. No wallet required to explore the wall, bounties, history or prints. Writing requires authorization.
7. Display observed facts, pending operations and service limitations honestly. A hash is not proof of preserved image availability or a successful payment.

## 4. Release scope

### R0: integration foundation and simulation

Freeze shared interfaces, simulate regional pressure, build route shells with conspicuously labelled fixtures, and define the snapshot trust model. Preserve the existing free board until the paid schema is ready. Capture a baseline and begin history indexing during testnet rehearsal.

### R1: one complete funded art journey on testnet

One wall with metadata-driven dimensions; 128×128 remains the current fixture, with proposed 1,024×1,024 capacity subject to scale validation (see core handoff); public Open wall; fixed eight-color versioned palette; fixed-price MPOO paint packs; variable TOILET placement costs; single-sponsor MPOO bounties; a named sponsor judging bounded submissions; explicit participant payout splits; finalized static snapshots; numbered print editions; independent award claims and print mint; account recovery screens. A mock fungible token is used for testnet money flows and must be visibly distinguished from actual mainnet MPOO.

Proposed default: TOILET is an internal paint ledger in R1, not a separately transferable fungible token. Purchased and later earned units have the same spending rights. Product language says "paint spent"; do not claim an externally verifiable token burn unless that token implementation exists. No longevity issuance or staking payouts are enabled in this slice. Existing plans remain later phases, not abandoned commitments.

Mainnet activation is a separate gate after mechanism review, exact token/transfer validation, authority and budget selection, and independent multi-user rehearsal. No deployment, treasury transfers or trading automation is authorized by this document.

### Explicit exclusions from R1

Mystery cards; random paid rewards; price speculation promises; automatic art judging; unlimited AI painting bots; per-person pricing claims; crowdfunding; resale marketplace; guaranteed royalties; permanent control of live pixels; animated NFTs; mobile apps; generalized DAO governance; notification infrastructure; automatic season flushes; MPOO staking/replenishment shop implementation. No framework rewrite solely to add routes.

## 5. User journeys and magic moments

### J1 — Visitor becomes a contributor

Enter `/` (stall overview) → `/bounties` → choose a funded brief → see reward, exact region, deadline, criteria and approver → Open on wall → inspect crew template → connect → acquire test paint → quote placement → paint → see confirmed contribution and activity.

**Magic moment M1:** “This is the exact pixel our picture needs—and my mark just joined everyone else's.” A faint template is optional and visibly separate from real pixels. No fabricated online counts or sample art presented as live.

Public contributors do not automatically earn a bounty share. Before painting, show that only an approved submission's consented payout recipients can claim the award. People can still contribute voluntarily.

### J2 — Collector rallies a community

Create brief → select region → specify objective, reference and licence terms → set submission/review deadlines → preview immutable terms and storage/network costs → fund escrow with MPOO → wait for verified receipt → share public bounty link.

**M2:** “My funded brief is now a place people can gather around.” Bounty card shows funded amount, not requested amount. Until funding is verified it remains draft/funding pending.

### J3 — Crew creates and defends

Open shared bounty wall link → coordinate using template/region → place quoted paint → inspect pressure overlay → move toward cheap space or accept contested-region cost → return to a factual changed-since view → restore or redesign → agree payout split → capture a finalized snapshot → submit before deadline.

**M3:** “We can see the battle happening, and our completed version is safely recorded even if it gets painted over.” A snapshot protects history, not territory. A bounty never locks a rectangle or privileges a crew's placement price.

### J4 — Sponsor accepts, artists claim, collector prints

Sponsor reviews eligible immutable submissions side by side → checks criteria and split → explicitly accepts one before review deadline → escrow allocates payout claims → artists claim independently → sponsor's reserved print entitlement is minted/retried separately → share collectible with historical wall link.

**M4:** “This print is the exact work we rallied around; the artists have a recorded award.” Award allocation, token transfer and NFT mint have distinct progress states. Later wall changes cannot alter the accepted artifact.

### J5 — Anyone discovers a historical moment

`/history` → scrub available finalized history → choose whole wall or crop → inspect coordinates/time/palette/contributors → freeze snapshot → review edition and cost → mint → `/prints/:id` links back to that history.

**M5:** “I can revisit that moment and collect a reproducible record of it.” History gaps are marked; unavailable periods cannot be minted. A spectator mint cannot consume a bounty sponsor's reserved entitlement.

### J6 — Nothing was accepted / something failed

If no submission is accepted by the review deadline, anyone may trigger expiry; only the sponsor receives the refund claim. Sponsor silence never locks escrow indefinitely. Failed claims restore entitlement; uncertain transactions are reconciled before retry. Rejected artists keep their historical contributions but receive no automatic award. Rules say this before participation.

Detailed UI states, routes and accessibility: [Frontend journeys](implementation/frontend-journeys.md).

## 6. Functional requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| WALL-01 | Use metadata-driven dimensions and preserve correct zoom, pan, keyboard and mobile hit testing | Existing tests plus 390px touch/desktop manual checks |
| PRICE-01 | Contract calculates regional price from chain time and recorded state | Shared Rust/TS golden vectors; quotes bounded by version, expiry and max cost |
| PRICE-02 | Failed/stale/no-op placements consume no paint and add no pressure | Contract failure tests and balance reads |
| PAY-01 | Exact authorized MPOO receiver credits payer once; draw spend is atomic | Forged/duplicate/underpayment/refund/concurrent-spend tests |
| BOUNTY-01 | Dedicated browse/detail/create pages show actual funded status | Independent browser and contract read-back |
| BOUNTY-02 | Immutable brief/deadlines/crop after funding; one accepted winner | Escrow state-machine and deadline race tests |
| BOUNTY-03 | Locked consented splits allocate entire award deterministically | Split validation, rounding and failed callback tests |
| HIST-01 | Replay from baseline reproduces selected finalized checkpoint | Replay/restart/duplicate/gap fixtures and chain sample comparison |
| PRINT-01 | Print refers to immutable reproducible snapshot and explicit edition | Encoding golden vectors, hash match, uniqueness and retrieval checks |
| PRINT-02 | Award funds remain claimable despite mint failure | Cross-service failure rehearsal |
| SESSION-01 | Limited drawing key cannot spend beyond on-chain paint cap or expiry | Direct contract calls outside browser checked; revoke verified |
| RECOVERY-01 | Reload/account/network changes do not duplicate a financial action | Interrupted-operation end-to-end scenarios |
| TRUST-01 | Snapshot attester, upgrade authority and data availability visible | About/details page and deployment manifest review |

## 7. Success measures and rollout gates

Instrument opt-in/aggregate product events without private keys or wallet secrets. Record timestamps for first board view, first confirmed placement, bounty opened, submission accepted, award claim and print mint. Distinguish accounts from people.

Prototype goals, not current measured performance: cached browse response under 2 seconds; healthy finalized updates visible within 10 seconds after finality; 95% of novice rehearsal participants finish a first placement without facilitator intervention. Collect actual results and adjust targets before launch.

Track bounty funding→submission→acceptance→claim→print completion; return-to-region after contribution; cost to restore a standard mural; share of expenditure/territory by largest accounts; newcomer successful placements; quote rejection rate; indexer lag; failed operations recovered. Transaction count and MPOO volume alone are not success.

Required rehearsal: sponsor, two competing crews and spectator in independent sessions. At least one completed award/print; one unaccepted expiry/refund; one failed token transfer; one indexer interruption; one immediate overwrite; one expired price quote. No production readiness claim based only on fixtures or local tests.

## 8. Decisions and remaining configuration

Approved direction: three pillars, audience sequence, creation→defence progression, creative freedom compatible with mPOO, no mystery cards, multi-agent implementation planning.

Proposed implementable defaults: regional pressure, static numbered prints, single-sponsor subjective bounties, immutable briefs and splits, explicit snapshot attester, independent payouts/mint, testnet-only prototype. Domain specs define their mechanics.

Before mainnet choose: actual price/rate/caps and paint supply; storage funding; print price/edition limits; production judge/deadline bounds; attester/operator keys and upgrade control; content display policy and takedown process (display filtering is not erasing chain history); archival providers/retention budget; token eligibility/refund behavior. Interface design and test fixtures need not wait for these choices.

Persistent crews, timed battle windows, reward rates, staking, optional notifications, animated prints and The Flush remain proposed/deferred. The user has not approved a seasonal reset or guaranteed reward for every contributor.

## 9. Reading path for a builder

1. [Core board handoff](implementation/core-board.md), this PRD and [delivery plan](implementation/delivery-plan.md).
2. Your assigned domain: [pressure](implementation/pressure-and-paint.md), [bounties](implementation/art-bounties.md), [history/prints](implementation/history-and-prints.md), [frontend](implementation/frontend-journeys.md).
3. Existing code paths named in your brief; economy plan only for relevant dependencies.
4. Shared interface freeze and integration fixtures before parallel edits to contracts or clients.

Glossary: escrow = funds held until agreed conditions; snapshot = frozen board state; attester = named service trusted to certify that state; finality = chain state considered settled; idempotent = repeating an operation does not apply its effects twice; claim = recipient explicitly withdraws an allocated payment.
