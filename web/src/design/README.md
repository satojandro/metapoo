# Design tokens

`tokens.css` is the one source for the site's colours, type, spacing and small shared components. It is
imported once in `src/main.ts`, before `style.css` and `wall-design.css`. Values come from `/money` and the
approved drafts in [`docs/visual-concepts/`](../../../docs/visual-concepts/README.md): the dark wall scene,
Arial at heavy weights, the yellow tag colour and monospace figures.

Everything is prefixed (`--mp-*`, `.mp-*`) so it can't collide with the older `style.css` layer, which
already defines `--focus`, `--muted`, `.chip` and `.eyebrow`.

## The rule

New and migrated pages use these tokens and never literal colours. If a page needs a value that isn't
here, add a token here first. `/money` (`app/revenue-panel.css`) is on the tokens. The wall page migrates
in Phase 1 of the [wall audit plan](../../../docs/2026-11-02-wall-frontend-audit.md); until then
`style.css` and `wall-design.css` keep their own values.

## Tokens

| token | for |
|---|---|
| `--mp-bg`, `--mp-card`, `--mp-card-2`, `--mp-line` | page background, panels, raised controls inside panels, borders and rules |
| `--mp-fg`, `--mp-soft`, `--mp-soft-2`, `--mp-muted` | headings and figures, body text, secondary body text, labels and captions |
| `--mp-on-tag` | text on a `--mp-tag` background |
| `--mp-tag` | the brand yellow: page headlines, primary buttons, pressed chips |
| `--mp-near`, `--mp-stake`, `--mp-burn`, `--mp-team` | the money flows: NEAR, TOILET stakers, burn, team. Keep each one meaning one thing |
| `--mp-good`, `--mp-warn`, `--mp-bad` | status (ready, attention, failure), separate from the flow colours' meaning |
| `--mp-focus` | keyboard focus ring |
| `--mp-font`, `--mp-mono` | interface text; figures, addresses, timestamps and eyebrows |
| `--mp-text-*`, `--mp-leading` | type scale from 11 px labels to the clamped `h1` and big figures |
| `--mp-space-1` … `--mp-space-8` | spacing: 4, 8, 12, 16, 20, 24, 32, 56 px |
| `--mp-radius-sm/md/lg/pill` | 3, 6, 8 px and fully rounded |
| `--mp-hit` | 44 px minimum touch target |

## Components

`.mp-eyebrow` (uppercase monospace label), `.mp-card` (panel), `.mp-btn` and `.mp-btn-primary`,
`.mp-chip` (toggle; pressed state from `aria-pressed="true"`), `.mp-figure` (big tabular number), and
`.mp-focus-ring` for custom focusable elements. Buttons and chips already have the focus ring.
