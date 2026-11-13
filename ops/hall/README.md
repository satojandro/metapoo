# Hall of Fame snapshots

Return/growth spec §4.1 (`docs/implementation/2026-11-11-return-and-growth-spec.md`).

`snapshot.mjs` takes a pixel-crisp still of the wall and prints the `hall.json` entry for it.
It only reads. No dependencies; Node 22+.

```bash
# From the board server (one request, block from x-last-block):
node ops/hall/snapshot.mjs --id first-fill --server https://<board-server> --board <contract>

# Without a board server: pages get_pixels, every page pinned to one final block.
node ops/hall/snapshot.mjs --id first-fill --rpc https://rpc.mainnet.fastnear.com --board <contract>

# A region, larger:
node ops/hall/snapshot.mjs --id invaders --rpc … --board … --crop 0,0,32,16 --scale 12
```

It writes `web/public/hall/<id>.png` with the board, block and crop in PNG `tEXt` chunks, and
prints a JSON entry with `title` and `painters` set to `TODO`. Fill those in, add the entry to
`web/src/app/hall.json`, and commit both. Adding an entry is a commit; there is no admin UI.

`/hall` is linked from the menu only once `hall.json` holds three entries (owner, 11 Nov).

Empty tiles use the wall's own checker (`web/src/render-board.ts`), so a still looks like the
wall it came from.

```bash
cd ops/hall && npm test
```
