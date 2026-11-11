# Return and growth features — specs

Date: 11 Nov 2026. Status: **specs for owner review, nothing built.** Five features that give
players a reason to come back, agreed in conversation with the owner on 11 Nov. The AI art
curator was discussed and is deliberately **not** in this document (owner, 11 Nov: skip).

The UI cleanup is a separate plan: [`../2026-11-11-ui-launch-review.md`](../2026-11-11-ui-launch-review.md).
Do that first; several items here reuse its rules (short account ids, "tile" and "credit" only).

| id | feature | size | needs an owner decision before work starts |
|---|---|---|---|
| **AWAY** | "While you were away" summary, then Telegram alerts | M + M | no for the summary; yes for the bot (who hosts it) |
| **SPONSOR** | First paint without owning NEAR | M | **yes** — budget, and which of two designs |
| **NAMES** | "Get a name" guide, linked from hex ids | S | no |
| **HALL** | Hall of Fame page; timelapse later | S, then L | yes — the menu (see §4.4) |
| **AGENTS** | Starter prompts, agent gallery, "give your agent a marker" | S + M + M | **yes** for the marker button (wallet key scope) |

Suggested order: NAMES and HALL v0 (small, no chain work) → AWAY summary → AGENTS prompts →
SPONSOR → the rest.

---

## 1. AWAY — tell players their tiles were covered

### 1.1 What exists

`web/src/pages/wall/wall-yours.ts` already shows "what happened to your tiles since you last
looked" under the wall. It is **this browser's memory**: the held tiles are saved in
localStorage and compared on the next visit. It misses a tile covered and won back in between,
knows nothing on a second device, and cannot say what was earned.

There is no way to reach a player who is not on the page. Most players connect with a NEAR
wallet, so there is no email address to write to.

### 1.2 Phase A — a server-backed summary (in-app)

When a wallet connects on `/wall`, show one card above "Your tiles":

> **While you were away** · 14 of your tiles were covered, 9 by `misfits-validator.near`.
> You earned 240 TOILET. **[Show me]** **[Claim]**

- **Show me** moves the camera to the largest covered cluster (the existing "show on the wall" jump).
- The card appears only when something changed, and is dismissed for that visit once closed.
- "Since" is the later of the account's last visit (stored per account in localStorage, as today)
  and 30 days ago.

**Board server.** It needs a per-account history it does not keep today. `draw_events` is a
catch-up buffer for the WebSocket, not a history (check its retention before relying on it).
Add:

- a sorted set per account of *cover events*: `{x, y, by, at_ms}`, written by the consumer when
  a draw replaces a tile held by another account; trimmed to 30 days;
- `GET /api/account-covers?account=<id>&since_ms=<n>` → `{count, by: [{account, tiles}], first: {x, y}}`.

The earned figure comes from the chain read the page already makes for the claim panel; the
server does not compute money.

**Fallback.** With no board server (`VITE_BOARD_SERVER_URL` unset or down), keep today's
localStorage comparison. The card must never show a number the page cannot back.

**Done when:** a second account covers three tiles of a first; the first, opening the wall in a
browser that has never seen it, gets the card with 3 and the right name. Test named in the PR;
a replay of the indexer over a known block range produces the same cover events twice.

### 1.3 Phase B — Telegram alerts

A bot the player links to their account, so the game can reach them off the page.

1. Account panel → "Get alerts on Telegram" → the page shows a one-time code and a link to the bot.
2. The player sends the code to the bot. The page asks the wallet to **sign a message** (NEP-413,
   no transaction, no fee) binding that code to the account; the bot's server verifies the
   signature against the account's keys and stores `account ↔ chat id`.
3. The bot sends at most one message per account per hour: "9 of your tiles were covered by X.
   [Open the wall]". `/stop` unlinks.

Requirements: the link is opt-in and removable from the account panel; the stored mapping is
the only personal data and is not published; messages never include balances.

**Open decisions:** who hosts the bot (the Mini that runs the board server is the obvious
place, with the same ephemeral-tunnel caveat the backlog records); whether Privy sign-ins get
email alerts instead, since Privy does hold an email for them.

### 1.4 Not planned

Browser push. It needs no email, but on iPhone it only works for a site added to the home
screen, which few players will do. Revisit if Telegram take-up is poor.

---

## 2. SPONSOR — a first paint without owning NEAR

### 2.1 The problem, exactly

"Your first 25 tiles are free" is the hook, but free paints need a registered account
(`free_paint.rs`: remaining is 0 when unregistered), registering costs exactly 0.01 NEAR
(`payments.rs`, `register_credit_account`), and every paint pays network fees. A player who
signs in with Google has an empty account and cannot use the offer.

`web/src/sponsorship.ts` is a stub: no sponsor service exists behind the flag.

One correction to what was said in conversation: **nobody can pay the registration for someone
else today.** `register_credit_account` registers `predecessor_account_id()` and takes no
account argument.

### 2.2 Two designs

| | A. Starter drip | B. Sponsored registration |
|---|---|---|
| What happens | A small service sends a new player 0.015 NEAR once: 0.01 to register, the rest for fees | The team account registers the player directly; the player receives only fee dust |
| Contract change | **None** | **Yes** — a `register_credit_account_for(account_id)` method. Ask-first under AGENT.md |
| Cost per player | 0.015 NEAR | about 0.011 NEAR |
| What a farmer can take | About 0.005 NEAR per fake sign-in (Send keeps 0.01 back) | Nothing withdrawable |
| When | Now | Next contract revision |

**Recommendation: A now, B when the contract is next revised.** A's leak is small and the
budget cap bounds it.

### 2.3 Design A in detail

- **Who qualifies:** Privy sign-ins only (Google or email), once per Privy user id, and only if
  the account has never held NEAR and is not registered. Wallet users already have NEAR.
- **The service:** one endpoint, `POST /starter`, that receives the player's Privy access token,
  verifies it server-side with the Privy app secret (which never ships in the bundle), checks the
  rules above on chain, and sends the transfer from a dedicated **starter account**.
- **Limits, all enforced by the service:** a total budget (the starter account's balance is the
  hard cap — it is funded with only what the owner is willing to lose), a per-day cap, one grant
  per Privy user id and per NEAR account, and a kill switch (`STARTER_ENABLED=false`).
- **The page:** after a Privy sign-in with an empty account, the wall offers "Get your 25 free
  tiles" → calls the service → shows "Setting up your account…" → registers → paint mode. If the
  budget is spent or the service is down, fall back to today's flow with honest copy: "Free
  tiles need a little NEAR to open your account. [Add funds]".
- **Money:** 5 NEAR funds about 330 players. The team's 10% share is the natural source.

**Done when:** a fresh Google sign-in with zero NEAR places a free tile without visiting Add
funds; chain evidence is the starter transfer, the registration and the `draw` for one account.
A second request for the same Privy user is refused. With the starter account empty, the
fallback copy shows.

**Open decisions:** the budget and daily cap; where the service runs (a Vercel function keeps
it off the Mini but puts a funded key in Vercel's secrets); whether the key custody is
acceptable for a small hot balance.

---

## 3. NAMES — help players get a readable name

### 3.1 The problem

Five of the wall's top holders have names (`misfits-validator.near`); the top one is a
64-character hex id. Hex ids make "Right now" and "Who holds the wall" unreadable and give
nobody an identity to defend. Privy accounts are always hex: Privy does not support named
accounts on NEAR.

### 3.2 Scope

1. **A "Get a name" section** on How it works: what a named account is, that it is created in a
   NEAR wallet and not by Meta Poo, and the steps for the wallets in the connect list. **The
   steps and any cost must be checked against each wallet before the copy is written** — this
   spec does not assert them.
2. **A link where the problem is felt:** in the tile inspector and the two wall lists, a hex id
   that belongs to *the signed-in player* gets a small "Get a name →" link. Other players' ids
   do not.
3. **Hex ids are shortened everywhere** to first 8 … last 8 (already in the UI review, A1/B4).

**Open question:** what a Privy player is told. They cannot rename the account they have. The
honest options are "connect a named wallet instead" or nothing; a display-name feature stored
off chain is a separate, larger idea and is not in this spec.

**Done when:** the section exists with verified steps for each listed wallet, and the link shows
only for the viewer's own hex id.

---

## 4. HALL — Hall of Fame, and the timelapse

### 4.1 Hall of Fame v0 (small, ship at launch)

A real page with real content, curated by hand.

- **Route** `/hall`, title "Hall of Fame".
- **Content:** a grid of stills, newest first. Each has a pixel-crisp image, a title, the date,
  the painters' names, and "See it on the wall →" (the existing `/wall?x=&y=&zoom=` link).
- **Data:** `web/src/app/hall.json` (`{id, title, date, block, painters[], x, y, zoom, image}`)
  and PNGs in `web/public/hall/`. Adding an entry is a commit; no admin UI.
- **Snapshot tool:** `ops/hall/snapshot.mjs` reads the board server's region blob
  (`GET /api/region/0/0`, 6 bytes a tile, RGB first) and writes a PNG at a whole-number scale,
  optionally cropped to a rectangle, stamped with the block from `x-last-block`. Without a board
  server it pages `get_pixels`.
- **Empty state:** with no entries, the page is not linked from the menu.

**Done when:** three real snapshots are published and each "See it on the wall" link lands on
the right spot.

### 4.2 Start keeping history now

The timelapse needs every paint, in order. The board server keeps the current wall and a short
catch-up buffer, not a history. Past paints can be recovered by replaying the chain (the
indexer's tx-index mode and `scripts/replay-check.py` already do this), so nothing is lost, but
the cheap moment to start an append-only log of draw events is before launch traffic, not after.

- The consumer appends every applied draw to a durable log: `{block, at_ms, x, y, color, by, free}`.
- One-off backfill from the deploy block by replay; the log's tile state at the tip must equal
  the live blob (same check as `/api/health`'s replay comparison).

### 4.3 Timelapse (large, after launch)

- **Route** `/timelapse`: the wall, a scrubber, play/pause, speed, and "Share this moment".
- **Data:** `GET /api/history?from_block=&limit=` paged from the log, or a pre-built compact
  file per day so the page does not make hundreds of requests.
- **Later:** export a short video or GIF of a region for sharing.

### 4.4 The menu — decision needed

The owner proposed adding both pages to the menu now with a "SOON" label. The recommendation
here is different, and the choice is the owner's:

- **Recommended:** add **Hall of Fame** as one real menu item once it has three entries, and
  tease the timelapse at the foot of that page ("Watch the wall fill — coming soon"). The
  29 Oct design review flagged menu items that lead nowhere, and six items already wrap onto a
  second line on a phone (UI review C10).
- **Alternative (owner's proposal):** two placeholder pages with SOON labels. If chosen, do the
  phone menu fix first, and each placeholder says what the page will be, not just "soon".

---

## 5. AGENTS — make "your AI can paint here" a feature, not a setup page

### 5.1 Starter prompts (small, no decision needed)

Replace the single generic line in the "Give this to your agent" box with three copyable
prompts, each with a budget in it:

1. "Read `<origin>/skill.md`. Find an empty spot on the Meta Poo wall and draw a small space
   invader. Spend at most 0.1 NEAR. Show me the plan and the cost first."
2. "… write my name, `<name>`, in 5-tile-high letters …"
3. "… look at the wall and tell me what is there. Do not paint."

The third costs nothing and is the easiest first step. Keep the `skill.md` link.

### 5.2 Agent gallery (medium)

A section on `/agents`: things agents painted, with the prompt that produced them.

**There is no signal on chain that a tile was painted by an agent**, so nothing can be marked
automatically. v0 is a curated list in the same shape as the Hall of Fame (§4.1) with one extra
field, `prompt`, fed by the existing "Built something that paints? Tell us" link. Marking agent
tiles on the wall itself, and an agents leaderboard, need a registry of agent accounts — a
separate decision, not specified here.

### 5.3 "Give your agent a marker" (medium, **owner decision required**)

Today `skill.md` tells the human to run `near account add-key … grant-function-call-access
--allowance '0.25 NEAR'` by hand. A button would do it in the page: generate a key pair, ask the
wallet to add it as a painting key (the same `draw` / `draw_many` scope as the player's own
painting key), and show the private half **once** for the player to hand to the agent.

This changes who holds a key on the player's account, which AGENT.md reserves for the owner.
Before any work, decide:

- **The key can spend every credit the account holds.** The 0.25 NEAR allowance limits network
  fees, not credits; the contract has no per-key credit cap. The page must say so plainly, and
  the honest advice may be "give the agent its own account" (already on the page) with the
  button offered only as the second option.
- **Showing a private key in a web page** is a phishing lesson in the wrong direction. The
  alternative is that the agent generates the key and gives the human the *public* half to paste
  — the same shape as the self-custody panel, and no secret ever crosses the page.
- **Revocation** must be one click from the account panel, listing each agent key with its
  remaining allowance.

Recommendation: build the public-key-paste version, not the generate-and-reveal version.

---

## Proposed backlog rows

For whoever merges this (AGENT.md: pull requests do not edit `docs/backlog.md`):

| id | work | status | size |
|---|---|---|---|
| **AWAY-A** | Server-backed "while you were away" card | spec §1.2, not started | M |
| **AWAY-B** | Telegram alerts | spec §1.3, hosting undecided | M |
| **SPONSOR** | Starter drip for Privy sign-ins | spec §2.3, budget and hosting undecided | M |
| **NAMES** | "Get a name" guide and own-id link | spec §3, wallet steps unverified | S |
| **HALL-0** | Hall of Fame page and snapshot tool | spec §4.1, menu undecided | S |
| **HISTORY** | Durable draw log and backfill | spec §4.2, not started | M |
| **TIMELAPSE** | Timelapse page | spec §4.3, after HISTORY | L |
| **AGENTS-PROMPTS** | Three starter prompts | spec §5.1, not started | S |
| **AGENTS-GALLERY** | Curated agent gallery | spec §5.2, not started | M |
| **AGENTS-MARKER** | In-page agent key | spec §5.3, **owner decision required** | M |
