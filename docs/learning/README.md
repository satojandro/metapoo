# Learning records

One file per focused session, using the headings below. The original template is archived at `../archive/foundation/09-learning-journal.md`.

## Why this exists

`README.md` item 9 promises a learning record. For sixteen days it did not happen:
`docs/learning/` held only the two scaffold files dated 2026-10-11, while the durable
knowledge from that period lived in a handoff document **outside the repository** — invisible
to Cursor, to Codex, and to the orchestrator. That is the failure this directory corrects.

## The rule

**A change is not finished until the lesson is recorded.** In practice:

- Any PR touching `web/src/pages/wall/**` or a contract includes a `## Learned` line in its
  description. "Nothing new" is a valid answer; silence is not.
- If the lesson changes how someone should work, it belongs in `traps.md`, not only in the
  session file. Session files are history; `traps.md` is instruction.
- Evidence beats narrative. Name the command output, transaction, test, or source line. The
  `09-learning-journal.md` template already asks for "what this evidence proves" and "what it
  does not prove" — those two lines are the whole value.

## Files

| file | purpose |
|---|---|
| `traps.md` | durable, forward-looking: what will bite you. Read before coding. |
| `YYYY-MM-DD-<topic>.md` | one session: what was tried, what was observed, what it proved. |

## For agents working from this repo

Read `traps.md` first, then `docs/roadmap.md` for open product decisions, then
`docs/00-shared-decisions.md` for what has already been decided. Do not infer project state
from the code alone — several documented traps are cases where the code looked fine and the
behaviour was broken.
