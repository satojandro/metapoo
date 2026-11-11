# Social and market links — plan and spec

**Status:** spec + phase 1 built (`web/src/social-links.ts`, `web/src/app/site-footer.ts`).
**Owner decision needed:** the TOILET chart link (see §4) and contributor onboarding (§5).
**Scope:** front-end only. No contract, no deploy config, no new dependency.

## 1. The ask

The site is the only public stall, and it links nowhere else. Add links to:

| what | requested value |
|---|---|
| X | `https://x.com/MetaPoo67` |
| Telegram | `@metapoo67` |
| GitHub | repo, "invite contributors?" |
| mPOO | Dexscreener |
| TOILET | Dexscreener |

Every one of these is a claim about the world, and two of them are claims about money. So the rule for
this change is the same one the repo applies to contract ids: **a link ships only if it resolves to
the thing it names.** A dead chart link on a page that takes real NEAR is worse than no link.

## 2. What was verified, and how

Run these before touching the code again; each is the primary source for one row.

| link | verified value | evidence |
|---|---|---|
| X | `https://x.com/MetaPoo67` | account page loads; handle matches the brand account, 4 posts, "NEAR & RHEA contributor since 2021" |
| Telegram | `https://t.me/metapoo67` | `curl -sS https://t.me/metapoo67` → `og:title = Meta Poo ($mPoo)` |
| GitHub | `https://github.com/satojandro/metapoo` | `gh repo view satojandro/metapoo --json visibility` → `PUBLIC` (same owner the app already links for issues) |
| mPOO chart | `https://dexscreener.com/near/refv2-diarhea.nearlytrade.near:mpoo.nearlytrade.near:10000` | Dexscreener `token-pairs/v1/near/mpoo.nearlytrade.near` → one pair, `dexId: rhea-finance`, that exact `pairAddress`, quote `DIARHEA`, liquidity ≈ $3.2k |
| TOILET chart | **does not exist** | see §4 |

The mPOO pair is a DIARHEA pool on RHEA, not a NEAR pool. That matters for copy: the chart is real but
thin (24 h volume was $0.36 when measured), so the link is labelled a chart, never a "price".

## 3. Placement, and why not a footer bar

`#app` is `display:flex; height:100dvh` and `.page-outlet` is the only scrolling child, so a footer
as a flex *sibling* of the outlet would permanently take ~40 px from every route — including `/wall`,
whose `--wall-size` is a `min()` over a height term, and which already has to keep its group inside
one screen (and already subtracts `--beta-banner-h`). That is the single most common layout
regression on this page (see `docs/learning/traps.md`).

So the footer is appended **inside** the outlet, after the page content: it scrolls with the page, it
cannot shrink the wall, and it needs no change to any page's height math.

```
.app-shell (100dvh, flex column)
├── header.top            (brand, nav, wallet chrome)
├── .page-outlet          (overflow:auto)   ← router replaces its children
│   ├── <page content>
│   └── footer.site-foot  ← re-appended after every route mount
```

- Present on every public route. **Not** on `/admin`: the owner console is an operator surface, and it
  already stays out of the public nav (`shell.test.ts` pins that).
- Appended by `shell.placeFooter(route)` from `main.ts`'s `onRouteChange`, i.e. after the router has
  replaced the outlet and before focus lands on the route heading. The footer carries no `h1`/`h2`, so
  it can never steal that focus target.
- Rows: `X · Telegram · GitHub · $mPOO chart · $TOILET chart`. Community first, markets second; the
  TOILET entry is absent until a pool exists, so the row is honest at every deploy.

## 4. TOILET: there is no pair to link to

Measured 2026-11-11 against the mainnet token `a571dead…7801ee` (`ft_metadata` → `TOILET`, 18 dp,
supply 1,072,847.7):

| check | result |
|---|---|
| `dexscreener.com/token-pairs/v1/near/<id>` | `[]` — nothing indexed |
| `dexscreener.com/latest/dex/search?q=<id>` | 0 pairs |
| RHEA DCL `get_pool` for `TOILET \| wrap.near`, `\| token.rhealab.near`, `\| diarhea.nearlytrade.near` × fees 100/400/2000/10000 | `null` in all 12 |
| `nearlytrade.near.get_launch_by_token` | `null` — no launch record |

So a TOILET Dexscreener link today would land on a 404, which reads as "this token is a rug". Instead:

- **The link is env-gated:** `VITE_DEXSCREENER_TOILET_URL` (empty in `.env.example`). Empty → the
  entry is not rendered at all, and a test pins that no TOILET chart href can appear without it.
- **Trigger to set it:** the first TOILET pool with liquidity, whatever venue creates it. Record the
  pair id in `.env.production` and in this document when it happens.
- **Until then:** `/toilet` and `/money` are the canonical destinations for what TOILET is worth
  (they read supply, tax and split state from chain). The spec for the contextual chart links on those
  two pages is §7 phase 2.

Same non-negotiable applies to whatever is filled in: the URL must be the *pair* URL Dexscreener
actually serves, verified by API on the day it is set — not one built by hand from a pool id.

## 5. GitHub: linking the repo is not inviting contributors

The repo is public and already links its issue tracker from `/agents` ("Built something that paints?
Tell us ↗"). What it does not have is anything a newcomer reads before opening a PR:

- no `CONTRIBUTING.md` (root has `README.md`, `AGENTS.md` conventions inside `AGENT.md`, no licence
  pointer for contributors — `LICENSE` exists);
- labels that exist and would carry an invite: `good first issue`, `help wanted`;
- 0 forks, 0 stars today.

Three options, cheapest first:

| option | cost | what it buys |
|---|---|---|
| **A. Footer links the repo** (built) | one link | a visitor can find the code; no promise made |
| **B. A + a `CONTRIBUTING.md`** (~40 lines: run `web/` with Node 22, tests, the backlog-is-merger-owned rule, `docs/README.md` as the doc map) | one small doc PR | an invite that survives contact with a real contributor |
| **C. B + triaged `good first issue` labels on 3–5 real rows** | curation, ongoing | the only version that actually produces a first PR |

Recommendation: **A now, B as its own docs PR, C when there is capacity to answer issues.** Inviting
people to a repo where every open issue is an internal work order converts goodwill into silence.

## 6. What phase 1 builds

| file | job |
|---|---|
| `web/src/social-links.ts` | the one place the URLs live. Constants with evidence, `socialLinks(env)` returns the visible set, `safeUrl` drops anything that is not http(s) |
| `web/src/app/site-footer.ts` | the DOM: `<footer class="site-foot">` + brand + `<nav>` of links. No heading, no icons, no third-party assets |
| `web/src/app/site-footer.css` | `--mp-*` tokens only; one wrapping row, mono small text, 44 px touch targets |
| `web/src/app/shell.ts` | owns the footer instance, exposes `placeFooter(route)`, skips `/admin` |
| `web/src/main.ts` | one call in `onRouteChange` |
| `web/src/vite-env.d.ts`, `web/.env.example` | `VITE_DEXSCREENER_TOILET_URL` |

Rules the code follows:

- **External links** carry `target="_blank" rel="noopener noreferrer"` and a visible `↗`, with
  `aria-label` naming the destination and that it opens in a new tab. `rel` is not optional on a page
  where the next click may be a wallet.
- **No tracking, no embeds, no icon fonts.** Text labels only, matching `/agents`'s footer, so the page
  keeps zero third-party requests and no extra bytes.
- **The brand name is not a link.** `meta poo.` already navigates home from the header; a second
  self-link is noise.
- **Markets are labelled as charts.** `$mPOO chart`, not `Buy $mPOO` — the page sells credits, not
  tokens, and it must not imply a market maker.

### Acceptance

1. Every public route shows the footer exactly once; `/admin` shows none.
2. The five labels above appear in order, with the mPOO chart linking the verified pair URL.
3. No TOILET chart link exists while `VITE_DEXSCREENER_TOILET_URL` is empty — asserted by test.
4. `web/src/social-links.test.ts` pins every href literally: a typo is a red test, not a 404 in
   production.
5. The footer does not change the wall's one-screen fit: at 1440×900 and 390×844 the wall group's
   box is unchanged and `documentElement.scrollHeight - innerHeight` grows only by the footer.
6. Node 22 suite green; `vite build` clean; footer readable at 390 px with no horizontal scroll.

## 7. Out of scope (phase 2, if wanted)

- Contextual chart links beside the token addresses on `/money` and `/toilet` (the same
  `social-links.ts` values, so there is still one source).
- A `/links` page. Not needed while the row fits one line; add it when the count passes ~6.
- `CONTRIBUTING.md` and issue triage (§5 B/C).
- Any link in `web/public/skill.md` or `/agents` copy — those are agent-facing and already carry the
  issue tracker.

## 8. Rollout

PR → review → merge to `main` → **manual** production publish (`ops/deploy/`, Git deployments are
disabled for this project) → prove the alias serves the bundle that contains the footer hrefs, and
that `/admin` does not.
