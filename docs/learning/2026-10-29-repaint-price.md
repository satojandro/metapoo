# 2026-10-29 — repaint price before submit

## Learned

A flat "1 credit" label is a guess. The paid board already charges 1, 2, or 4
credits from how recently the cell was painted. The page has to show the number
`get_cell_cost` returns, for every cell in the stroke, before anything is sent.
If that read fails, the honest state is "price unavailable" with submit turned
off. Inventing the cheap price is how a drag becomes a trick.

The minute count in "repaint 2 min ago" is only a clock reading. It is not the
pricing rule. The credit count still comes from the contract.

## Evidence

`cd web && npm test` — 261 passed, including `repaint-price.test.ts`: a
2-minute-old cell quoted at 4 credits renders `this stroke: 2 cells · 8 credits`,
a mixed 4 + 1 stroke renders 5 credits, the legend is outside every `<details>`,
and a thrown `get_cell_cost` disables Place paint.

`cd web && npm run build` passed.

Browser: the mock wall (no contract) does not show a credit price. The rendered
paid dock shows the legend, `repaint 2 min ago · 4 credits`, and the stroke
total above Place paint, including at a 390px-wide window, with About / details
still collapsed. The failure dock shows `price unavailable` and a disabled button.

## What this does not prove

No paid board is deployed, so this was not a live `get_cell_cost` round trip.
The chain numbers in the browser preview were the contract's answers fed in as
test readers. Credit shortfall copy is unit-tested, not clicked through a wallet.
