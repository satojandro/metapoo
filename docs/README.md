# Documentation map

One job: **for a given topic, which single document is authoritative.** If two documents disagree, the
one listed here wins. If a topic is not listed, this map is out of date — fix the map, not the reader.

Everything not listed here lives in [`archive/`](archive/README.md) and is history, not instruction.

## Read first

| question | document |
|---|---|
| what do I do before changing code? | [`../AGENT.md`](../AGENT.md) |
| what is left to build? | [`backlog.md`](backlog.md) — every row carries its proof |
| what has already gone wrong here? | [`learning/traps.md`](learning/traps.md) |
| what is decided vs still open? | [`00-shared-decisions.md`](00-shared-decisions.md), [`roadmap.md`](roadmap.md) |
| what blocks mainnet, in what order? | [`2026-10-29-code-audit.md`](2026-10-29-code-audit.md) |
| how should the site look and feel? | [`2026-10-29-whole-site-design-review.md`](2026-10-29-whole-site-design-review.md) |
| how should a judgement call be made? | [`2026-10-14-product-judgment.md`](2026-10-14-product-judgment.md) |

## Payments (the money path)

| topic | document | status |
|---|---|---|
| the paid model: credits, schema 4, the 15 contradictions it resolved | [`payments/2026-10-28-paid-model-decisions.md`](payments/2026-10-28-paid-model-decisions.md) | **authoritative** |
| what the purchase UI must do and show | [`payments/frontend-handoff.md`](payments/frontend-handoff.md) | current; NEAR checkout built (`55526b9`), mPOO hidden |
| mainnet cost measurement | [`payments/mainnet-cost-validation.md`](payments/mainnet-cost-validation.md) | **all pending** — reopens on first deploy |
| first live testnet deployment of board + TOILET, with evidence | [`payments/testnet-deployment-2026-10.md`](payments/testnet-deployment-2026-10.md) | **deployed 2026-10-29** at `board3.metapoo-player1.testnet` (canonical), 50 checks green |
| upgrade authority and migration | [`payments/upgrade-policy.md`](payments/upgrade-policy.md) | `upgrade()` exists; migration + pause missing |
| the contract itself | [`../contracts/paid-board/README.md`](../contracts/paid-board/README.md) | schema 4, testnet only |
| pause, treasury withdrawal, bounded price change | [`../contracts/paid-board/README.md`](../contracts/paid-board/README.md) | on main (PR #15) and on testnet |

## Economy

| topic | document | status |
|---|---|---|
| TOILET: issuance, staking, burns, burn page | [`economy/2026-10-28-toilet-economy-v1.md`](economy/2026-10-28-toilet-economy-v1.md) | **proposed** — four decisions open |
| TOILET token: supply, tax, refund semantics | [`../contracts/toilet/README.md`](../contracts/toilet/README.md) | on main (PRs #15–#17), testnet at `metapoo-toilet.testnet` |

## Work in flight

| topic | document |
|---|---|
| what is next, in what order | [`2026-10-29-code-audit.md`](2026-10-29-code-audit.md) §5 |
| what is left, with proof | [`backlog.md`](backlog.md) |

The task orders in [`implementation/`](implementation/) (repaint price, checkout, safety, TOILET token,
D4, accrual claim) are **all delivered** (PRs #15–#23). The 2026-10-28 work queue is superseded by the
audit's order of work. Keep them for the reasoning; do not dispatch from them.

## Code and security

| topic | document |
|---|---|
| running the page, known limits | [`../web/README.md`](../web/README.md) |
| free board contract: deploy, storage, gas, frontend handoff | [`../contracts/board/`](../contracts/board/) |
| what the scaffold protects against | [`threat-sketch.md`](threat-sketch.md) |
| session lessons, one file per session | [`learning/`](learning/README.md) |

## Archived (2026-10-28)

The 12 October planning wave, the September agent pack, the expansion specs (bounties, prints,
history), the pressure-pricing protocol, the original PRD and economy plan, the visual direction, and
completed task orders all moved to [`archive/`](archive/README.md). They are kept for the reasoning they
record, not for instruction. If one becomes relevant again, move it back and add it here.
