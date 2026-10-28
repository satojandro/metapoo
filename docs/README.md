# Documentation map

One question this file answers: **for a given topic, which document is authoritative?**

The repository accumulated overlapping docs across several planning waves. Most are still
current; some described work that has since shipped or been superseded. Rather than rely on
dates, use this map.

Rule: if two documents disagree, the one listed as authoritative here wins. If neither is
listed, the newest dated file wins and this map is missing an entry.

---

## Read first

| topic | authoritative document |
|---|---|
| what to do before changing code | `../AGENT.md` |
| **what is left to build** | **`backlog.md`** — verified state; agents keep it current, every row carries its proof |
| traps that have already cost time | `learning/traps.md` |
| open product decisions (R1–R5) | `roadmap.md` |
| decisions already taken | `00-shared-decisions.md` |
| how agents should decide (judgement) | `2026-10-14-product-judgment.md` |
| session history of what was tried | `learning/` |

## Product and scope

| topic | authoritative document | notes |
|---|---|---|
| product intent, wall + market + moments | `2026-10-12-product-prd.md` | planning baseline; economy sections are **not** live behaviour |
| MVP scope and staged plan | `../02-mvp-scope-and-roadmap.md` | |
| payment-stage UI and wallet balances | `payments/frontend-handoff.md` — read-only display local; checkout pending | supersedes older MPOO-only/TOILET purchase assumptions for this stage |
| paint economy / swap / tokenomics | `2026-10-12-paint-economy-and-swap-plan.md` | future phase; nothing implemented or deployed |
| pressure pricing and paid mode | `implementation/pressure-and-paint.md` | |
| bounties | `implementation/art-bounties.md` | |
| history and prints | `implementation/history-and-prints.md` | |

## Interaction, visuals, and viewport

| topic | authoritative document | notes |
|---|---|---|
| viewport, zoom, selection behaviour | `2026-10-12-viewport-and-interaction-brief.md` | partially superseded by practice: paint zoom is no longer a precondition for painting (`learning/traps.md`) |
| stall scene geometry | `2026-10-12-visual-concept.md` | "geometry spec kept" |
| visual direction and rejected work | `2026-10-12-visual-redesign-agent-brief.md` | the newest of the three visual docs; start here |
| reference imagery | `2026-10-12-stall-visual-references.md` | references only; the flat-toilet implementation was rejected |
| palette | `2026-10-12-palette-proposal.md` | **not implemented**; changing hex values for existing indices would recolour stored art and needs a schema bump |

## Contracts

| topic | authoritative document |
|---|---|
| paid board: local contract and API | `../contracts/paid-board/README.md` — schema 4, not deployed |
| paid board safety implementation | `implementation/paid-board-safety.task.json`; actual behavior and state-layout correction in `../contracts/paid-board/README.md` |
| TOILET token implementation and tax/refund semantics | `../contracts/toilet/README.md` — local code/tests, not deployed; task in `implementation/toilet-token.task.json` |
| **mainnet cost tests: revisit on deployment** | **`payments/mainnet-cost-validation.md` — all pending; PAY-COST remains open** |
| contract changes and upgrades | `payments/upgrade-policy.md` — proposal and current gaps |
| board contract: deploy, storage, gas, frontend handoff | `../contracts/board/DEPLOY.md`, `STORAGE_AND_GAS.md`, `FRONTEND_HANDOFF.md` |
| contract design seams | `../03-architecture-and-contract-seams.md`, `../contract/DESIGN.md` |
| acceptance, security, QA | `../08-acceptance-security-and-qa.md` |
| threat sketch | `threat-sketch.md` — a design sketch, not an audit |

## Loose but still live

| file | what it is | why it is not archived |
|---|---|---|
| `../fix_plan.md` | three unresolved P5 review findings against the renderer-crispness goal | still actionable; they are acceptance criteria for the crisp-paint work, not history |
| `research/2026-10-11-near-intents-memo.md` | research memo | unbuilt feature, still a valid input |
| `implementation/core-board.md`, `delivery-plan.md`, `frontend-journeys.md` | implementation specs | current references |

## Archived

`archive/` holds documents that describe work which has since shipped, or planning waves whose
output is now in the code and in `learning/traps.md`. See `archive/README.md`.
