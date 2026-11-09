# AGENTS-1 — `/agents`: a page for humans about letting their agent paint

Date: 9 November 2026. **Status: built 10 November 2026** — `web/src/app/agents-page.ts` + `agents.css`, route `/agents`, menu item, and the wall's invite line. The agent-facing file it links to exists: `web/public/skill.md` (served at `/skill.md`), with `web/public/llms.txt` pointing to it. The skill was corrected after two live agent runs: a 64-cell stroke needs 50 Tgas, not 30; a failed draw still costs fees; `get_credits` returns a bare JSON string; and the prompt must tell the agent to do what its human asked.

## Why

The owner wants as much drawing as possible, and agents can draw without the web wall: the board is
an ordinary contract that any NEAR account can call (`draw` / `draw_many`, `contracts/paid-board/src/lib.rs`).
What is missing is a reason for a human to hand their agent the link, and a link worth handing over.

Two readers, two artefacts:

| reader | artefact | job |
|---|---|---|
| the agent | `/skill.md` | exact contract id, methods, prices, errors. Dense, no story |
| the human | `/agents` | why this is fun, what it costs, what is safe, and one obvious thing to copy |

The page never repeats the skill's mechanics. If a fact would need updating in both, it belongs in
the skill and the page links to it.

## Menu

Add **Agents** to `NAV_ITEMS` in `web/src/app/shell.ts`, after "How it works":
Wall · How it works · **Agents** · TOILET · Stake · Where the money goes.
The phone nav is hidden (`shell.ts:133`), so also link it from the wall's invite card (below).

## Page, top to bottom

### 1. Hero: the story in one line, and the handoff

> **Your agent can paint too.**
> Meta Poo is a wall anyone can paint, including the AI you already talk to.
> Give it the link. It reads the wall, picks a spot, and paints with your NEAR.

The handoff block sits right under it, the one thing the page exists for:

```
┌────────────────────────────────────────────────────────────┐
│  Give this to your agent                                   │
│  ┌──────────────────────────────────────────────┐ [Copy]   │
│  │ Read https://metapoo-testnet.vercel.app/skill.md │       │
│  │ and paint something on the Meta Poo wall.    │          │
│  └──────────────────────────────────────────────┘          │
│  Works with any agent that can browse and sign NEAR        │
│  transactions. Open skill.md ↗                             │
└────────────────────────────────────────────────────────────┘
```

- What gets copied is a **prompt**, not a bare URL: pasting a bare link into a chat gets a summary,
  not a painting. The visible text is exactly what is copied.
- "Copy" → "Copied" for 2 s, `aria-live="polite"`. Fallback: the text is selectable.
- Secondary link: open `/skill.md` raw, for people who want to read what their agent reads.

### 2. "Agents on the wall" — proof, from live data

A strip of recent strokes painted by accounts that look like agents is tempting, but the chain cannot
tell an agent from a person. **Do not label anyone an agent** without a signal we control. v1 shows
the live wall thumbnail and "N strokes in the last hour" from the board server or the pixel cache, the
same source as the wall's "Right now" list. A real agent gallery needs an opt-in signal (see open
questions).

### 3. How it goes, in three illustrated steps (story, not instructions)

1. **You hand it the link.** It learns the rules: 64 × 64 wall, 16 colours, open to all.
2. **It looks before it paints.** It reads what is there, finds empty space or something to answer,
   and tells you what it plans and roughly what it costs.
3. **It paints, on chain.** Each stroke is a NEAR transaction from its account. Your art stays on the
   wall, with its name on it, until someone paints over it.

Use the house illustration style (`docs/visual-concepts/`); one small sprite per step.

### 4. What it costs, in the human's units

A three-row table read from the contract at page load, never hard-coded (same rule as
`/how-it-works`): registration once (`get_payment_config().registration_fee`), one tile
(`near_per_credit`), and "a small drawing of ~40 tiles". Plus one line: the first 25 empty-tile paints
are free for a registered account until the wall first fills (`free_first_paints_per_account`,
`get_tunables`). The beta warning from `README.md` sits directly under this table, not in a footer.

### 5. Keep your NEAR safe

Short and plain. This section is what makes a careful person comfortable handing over the link.

- **Give your agent a drawing key, not your wallet.** A function-call key can only paint on this
  board and spend its own small gas allowance. The skill shows the agent how to make one.
- **Fund a separate account.** Put in what you are happy to spend, e.g. 0.1 NEAR.
- **Your agent should ask first.** The skill tells it to say what it will draw and what it costs.
- Revoke any time: removing the key on chain stops it.

### 6. No NEAR yet?

One paragraph: send NEAR to the agent's account from any wallet or exchange, or from another chain via
NEAR Intents. When `VITE_INTENTS_FUNDING_ENABLED` is on (ACQ-4), link the wall's **Add funds** flow
instead. Agent-wallet services (NEAR Intents Agent API) get one neutral line and an outbound link,
never an endorsement: that product is a beta that warns users may lose funds.

### 7. Footer for builders

`/skill.md` · `/llms.txt` · board contract id (copyable) · "Built something that paints? Tell us"
(link to the GitHub repo's issues).

## Other entry points

- Wall invite card (`web/src/pages/wall/wall-invite.ts`): one line, "Or let your agent paint →
  /agents". Phones reach the page through this.
- `/how-it-works`: one sentence and link in the "who can paint" part.

## Build notes

- New page id `"agents"` in `page-registry.ts`, `/agents` in `routes.ts` (+ `routes.test.ts`), mount in
  `web/src/app/agents-page.ts`, styles in `agents.css`. Vanilla TypeScript, like every other page.
- Contract reads through the existing services; no new RPC client.
- Static files in `web/public` are served before the SPA rewrite in `web/vercel.json`; confirm with a
  `curl -I https://…/skill.md` on the preview deploy that it returns the file, not `index.html`.
- Tests: route match, copy button copies exactly the visible prompt, prices come from the view
  calls (fixture), beta warning present.
- Definition of done per `AGENT.md`, plus: an agent actually paints from the copied prompt, with the tx
  hash and a `get_pixel` read-back in the PR. That is the acceptance test for both the page and the skill.

## Open questions for the owner

1. **Agent attribution.** Do we want an "agent" badge on the wall? Options: an opt-in registry view
   method (contract change, out of scope now), a sub-account convention (`*.agents.<something>.near`),
   or a self-declared list in the repo. Until decided, no badge.
2. **Prompt wording.** "Paint something" vs a nudge ("paint something that answers what is already
   there"). The second draws more interesting work, and costs nothing.
3. **Is "Agents" a top-level menu item** or a section of `/how-it-works`? Recommendation: top-level.
   It is a distinct audience with a distinct action, and it signals that agents are welcome.
