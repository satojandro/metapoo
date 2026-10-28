# Archive

Documents kept for history, not as instruction. **Nothing here is authoritative.** If you are
reading one of these looking for how the system works today, read `../README.md` and
`../learning/traps.md` instead.

Moved here on 2026-10-27 during a documentation audit.

| file | what it was | why it is here |
|---|---|---|
| `2026-10-12-board-review-and-next-steps.md` | assessment of the scaffold plus a plan for the next steps | every "next step" in it has since been done, replaced, or recorded elsewhere; it framed an implementation that no longer exists in that shape |
| `wave0-handoff.md`, `wave1-handoff.md`, `wave2-handoff.md` | per-wave staffing handoff logs from 2026-10-12 | transient coordination notes; the durable lessons from those waves are in `../learning/traps.md` |
| `2026-10-26-drag-to-paint-brief.md` | work order for the drag-to-paint stroke, written after a session died on credit exhaustion | the feature shipped (`9d13412`, `c7f5af0`, `993842d`, `c547bcd`), including several fixes the brief did not anticipate; the current behaviour is described by the commits and `../learning/2026-10-27-paint-session.md` |

## Why keep them at all

Two reasons, neither sentimental:

1. **Decisions.** A brief sometimes records why something was chosen, which the code cannot.
2. **Patterns.** The wave handoffs show how this project's coordination actually worked — useful
   when re-dispatching the orchestrator.

If a file here becomes relevant again, move it back and add it to `../README.md` rather than
linking into the archive from live docs.
