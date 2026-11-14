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

## Agent gallery (`/agents`)

Spec §5.2. The gallery on `/agents` is the same kind of list with one more field, `prompt`:
the words the owner gave the agent. **Nothing on chain says a tile was painted by an agent**, so
a piece goes up only when someone tells us (the "Built something that paints? Tell us" link on
`/agents`) and gives us the prompt. Never add an entry on a guess, and never write a prompt for
someone. An empty gallery is correct; the page then shows a one-line invitation and no grid.

1. Take the still with `--gallery`, cropped to the piece (`x,y,w,h` in tiles):

   ```bash
   node ops/hall/snapshot.mjs --gallery --id red-invader --rpc https://rpc.mainnet.fastnear.com --board <contract> --crop 3,4,16,16 --scale 12
   ```

   It writes `web/public/agents-gallery/red-invader.png` and prints the entry with `title`,
   `painters` and `prompt` set to `TODO`. A square crop fills the card; any other shape is
   letterboxed.

2. Add the entry to the array in `web/src/app/agents-gallery.json` and fill in the three fields:

   ```json
   {
     "id": "red-invader",
     "title": "<what the owner calls it>",
     "date": "2026-11-13",
     "block": 224100000,
     "painters": ["<the account that painted it: the agent's, or the owner's>"],
     "x": 11,
     "y": 12,
     "zoom": 12,
     "image": "/agents-gallery/red-invader.png",
     "prompt": "<the prompt exactly as the owner sent it; use \\n for line breaks>"
   }
   ```

   `painters` takes full account ids; the page shortens 64-character ones itself. The prompt is
   shown as plain text (markup in it is not rendered) with a Copy button, and a long one scrolls
   inside its box. It may be at most 4,000 characters. Check the painter against the wall first:
   the tiles in the crop should belong to that account at that block.

3. From `web/`, run `npm test -- agents-gallery`. It fails if an entry still has a `TODO`, lacks
   its prompt, points at an image outside `/agents-gallery/`, or its PNG is not in
   `web/public/agents-gallery/`. An entry that fails validation is also dropped by the page
   rather than shown half-filled.

4. Commit the PNG and the JSON together. That is the whole process; there is no admin UI.

The shared checks for both lists are in `web/src/app/wall-still.ts`.

Empty tiles use the wall's own checker (`web/src/render-board.ts`), so a still looks like the
wall it came from.

```bash
cd ops/hall && npm test
```
