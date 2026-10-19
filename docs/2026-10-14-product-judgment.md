# Product Judgment — Meta Poo

Extracted from Alejandro via structured interview on 2026-10-14 (interview-me skill;
explicit yes on the restated intent). Governs *how agents decide*; topic-specific
accepted decisions still win on their own subjects (tier rules below).

## 1. Copied vs original

- **Copied wholesale, no guilt:** r/place interaction patterns (zoom, pan, precise
  placement, communal board feel); Berry Club engineering patterns (pixel batching,
  guarded refresh, row versioning, pending-paint rendering). The game idea is the
  proven one; we are not inventing mechanics nobody asked for.
- **Technology freshness (the real "distance" from 2020):** the five-year gap means
  we copy *patterns*, never *code or stale standards*. Implement on current NEAR:
  current contract SDKs, current wallet APIs, current function-call key behavior.
  If a pattern requires outdated tech to reproduce, re-derive it on today's stack.
- **Originality lives in:** brand (Meta Poo), setting (the 3D stall), UX feel (the
  paint moment, the zoom snap), and blockchain-native features (pressure pricing,
  Art Bounties) that r/place never had.
- **Originality does NOT live in:** novel interaction mechanics, alternative
  economics schemes, "improvements" to the proven core loop.

## 2. Tie-breaker stack

1. **The core moment must feel great** — a paint click that lands instantly and
   precisely beats every other consideration.
2. **Ship the vertical slice** — one polished end-to-end journey beats five
   half-features.
3. **Proven over clever** — when in doubt, do what r/place does, not what is novel.
4. **Reversible advances, irreversible asks** — agents spend autonomy on reversible
   choices; irreversible ones go to the human with options.
- **Mobile is first-class** — painting must work on a phone; most communal-board
  users live there. Not a deferred afterthought.

## 3. Doc authority tiers

1. This judgment doc (how to decide).
2. Currently-accepted decision records: `docs/00-shared-decisions.md`, the paint
   economy plan (`docs/2026-10-12-paint-economy-and-swap-plan.md` — update in place,
   never fork a new proposal), the PRD for next-product scope.
3. Background: original agent pack (01–09), unshipped proposals (e.g. saturated
   palette), older briefs — mineable, never current direction without a tier-2 record.

Unresolvable conflicts: surface via orchestrator `blocked` + decision log. Never
improvise.

## 4. Gap-filling boundaries

- **Autonomous (reversible, vision-consistent):** filling missing navigation,
  unclear buttons, weak onboarding copy, inconsistent journeys, micro-UX choices
  (selection indicator placement, zoom snapping behavior), code organization.
- **Ask first:** anything touching contracts/payments/token addresses/deployments,
  new features beyond the proven pattern, economy changes, brand voice shifts.
  "Touching" means changing behavior, values, or flows — not mentioning them:
  web-only files may render, describe, or test wallet/payment wording without
  asking, provided the addresses, amounts, and connect/sign flows are unchanged.
  Scope the `touches` declaration to every directory the feature genuinely
  needs (e.g. a wall polling feature may include `web/src/board-sync.ts`);
  do not shrink `touches` to look conservative — an undeclared real edit is
  what the scope gate punishes, not a wide honest one.
- **Never:** mainnet anything, secret handling, silent scope expansion (per
  agent-orchestrator docs/05).

## 5. Success signature

"This is right when painting a pixel on a phone feels instant, precise, and
obviously ours."
