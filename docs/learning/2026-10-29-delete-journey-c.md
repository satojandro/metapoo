# 2026-10-29 — Journey C pressure path removed

## Learned

Schema 3 pressure quotes were a prototype, and the numbers they showed were fixtures.
A fixture price on a paint screen is a fabricated price. Those modules are deleted.
The free `draw` path, drag strokes, direct paint, the drawing session, and the Paint &
wallet panel stay. Schema 4 repaint prices are a later task and must be read from the
contract, not rebuilt from the deleted quote helpers.

## Evidence

`grep -rn "paid-mode\|paid-paint\|pressure-quote\|features/pressure" web/src` returns
nothing. `cd web && npm test` and `npm run build` were run after the deletion. No
contract files changed. No chain transaction was sent: this change removes a browser
path, it does not paint.
