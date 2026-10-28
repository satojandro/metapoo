# Archive

Documents kept for the reasoning they record, not for instruction. **Nothing here is authoritative.**
If you are reading one looking for how the system works today, start at [`../README.md`](../README.md)
and [`../learning/traps.md`](../learning/traps.md).

Moved here on 2026-10-28 in a documentation cut: the live set is now the map in `../README.md`, and
everything below was either shipped, superseded, or written for a phase that has not started. Original
paths are given so commit messages and older discussions still resolve.

Cross-links *between* archived documents may be stale — they were correct when written, and nothing here
is maintained.

## The September agent pack → `foundation/`

The scaffold's original nine documents. Superseded by `../00-shared-decisions.md`, `../roadmap.md`,
`../backlog.md` and `AGENT.md`.

| was | now |
|---|---|
| `01-product-requirements.md` | `foundation/01-product-requirements.md` |
| `02-mvp-scope-and-roadmap.md` | `foundation/02-mvp-scope-and-roadmap.md` |
| `03-architecture-and-contract-seams.md` | `foundation/03-architecture-and-contract-seams.md` |
| `04-cursor-parallel-agent-orchestration.md` | `foundation/04-cursor-parallel-agent-orchestration.md` |
| `05-agent-brief-contract.md` … `08-acceptance-security-and-qa.md` | `foundation/` |
| `09-learning-journal.md` | `foundation/09-learning-journal.md` — its prompts now live in `../learning/README.md` |

## The 12 October planning wave → `planning-2026-10/`

| was | why it is here |
|---|---|
| `docs/2026-10-12-product-prd.md` | the expansion PRD (pressure pricing, prints, bounties). Its payment sections are superseded by `../payments/2026-10-28-paid-model-decisions.md`. The pillars survive in `../00-shared-decisions.md` |
| `docs/2026-10-12-paint-economy-and-swap-plan.md` | MPOO-only purchases, TOILET-as-paint, staking — replaced by prepaid credits and `../economy/` |
| `docs/2026-10-12-palette-proposal.md` | not implemented; changing hexes for live indices is now a **schema 5** decision |
| `docs/2026-10-12-viewport-and-interaction-brief.md` | paint zoom is no longer a precondition for painting; see `../learning/traps.md` |
| `docs/2026-10-12-visual-concept.md`, `2026-10-12-visual-redesign-agent-brief.md`, `2026-10-12-stall-visual-references.md` | the visual pass has not started. **Unarchive before that work** — reference images stay in `../visual-concepts/` |

## Expansion and implementation specs → `specs/`

Written for a phase after the MVP. Kept because they hold interface work worth not redoing.

| was | what it is |
|---|---|
| `docs/implementation/art-bounties.md` | funded art bounties: escrow, judging, payout splits |
| `docs/implementation/history-and-prints.md` | historical snapshots and print editions |
| `docs/implementation/core-board.md` | board preservation handoff — superseded by `contracts/board/README.md` |
| `docs/implementation/delivery-plan.md` | 12 October staffing and integration gates |
| `docs/implementation/frontend-journeys.md` | proposed journeys, predating the working wall |
| `docs/implementation/pressure-and-paint.md` | the schema-3 pressure/TOILET protocol, superseded by fixed-price credits; the per-cell recency idea survives as the repaint multiplier |
| `contract/DESIGN.md` | older contract design note (still says schema 1) |
| `simulations/pressure/README.md` | the pressure-pricing simulation that went with the protocol |

## Completed task orders → `tasks/`

| was | shipped as |
|---|---|
| `docs/implementation/drag-to-paint-stroke.task.json` | drag-to-paint stroke + session key |
| `docs/implementation/pilot-zoom-pan-paint.task.json` | zoom/pan/place pilot |
| `docs/implementation/t1-crisp-device-pixels.md` | device-pixel rendering (`19e95bd`) |

## Research → `research/`

| was | why |
|---|---|
| `docs/research/2026-10-11-near-intents-memo.md` | chain-abstraction memo for an unbuilt feature |
| `docs/research/2026-10-12-mpoo-live-contract-readout.json` | snapshot of the token at that block; superseded by the live `get_tax` read recorded in `../economy/2026-10-28-toilet-economy-v1.md` §14 |

## Earlier archive (2026-10-27)

| was | why it is here |
|---|---|
| `2026-10-12-board-review-and-next-steps.md` | every next step in it was done, replaced, or recorded elsewhere |
| `wave0-handoff.md`, `wave1-handoff.md`, `wave2-handoff.md` | transient coordination logs; durable lessons are in `../learning/traps.md` |
| `2026-10-26-drag-to-paint-brief.md` | the feature shipped, including fixes the brief did not anticipate |

## Why keep any of it

Two reasons, neither sentimental:

1. **Decisions.** A brief sometimes records why something was chosen, which the code cannot.
2. **Patterns.** The wave handoffs show how this project's coordination actually worked — useful when
   re-dispatching the orchestrator.

Rule: if a file here becomes relevant again, **move it back and add it to `../README.md`** rather than
linking into the archive from live docs.
