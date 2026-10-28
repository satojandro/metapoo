# Meta Poo — visual concept

Date: 12 October 2026
Status: geometry spec kept. A deeper overview now combines that spec with the earlier room. No frontend rewrite yet.

Open `docs/visual-concepts/concept-preview.html` to look at the same scene. The saved views are:

- `stall-overview-desktop.png` — full square board, desktop
- `stall-paint-desktop.png` — 18×18 crop, 22 px cells
- `stall-overview-mobile.png` — 390 px wide
- `stall-paint-mobile.png` — 18×18 crop, 18 px cells
- `palette-proposal.png` — indices 0–7 and a sample drawn only from those swatches

## Geometry

The board is 128×128. Both overviews show that whole board as a square, scaled evenly. Measured boxes:

- Desktop: 331×331 px, with 16 px of brick between the frame and the cistern.
- Mobile: 226×226 px, with the same 16 px brick gap.

The toilet sits under that gap. It does not cover a cell. Paint view shows an 18×18 window of the same board. Cells stay square: 22 px on desktop, 18 px on a 390 px screen. The window is a crop, so it is smaller than the full board, and it is not stretched.

## Side art

Desktop and mobile use the same two mural bitmaps. The phone is a narrower doorway, so each wall shows the inner slice of that mural: stairs, grids, blocks, and the yellow mark, at a large pixel size. The desktop view shows the rest of the same compositions beside that slice.

## Proposed palette

Eight colors. The numbers are the contract indices, 0 through 7.

| Index | Name | Hex |
|---|---|---|
| 0 | Ink | `#111114` |
| 1 | Paper | `#F6F3EC` |
| 2 | Red | `#FF3B30` |
| 3 | Yellow | `#FFE500` |
| 4 | Green | `#3DDC6A` |
| 5 | Blue | `#2D5BFF` |
| 6 | Pink | `#FF4D9A` |
| 7 | Cyan | `#3EE0FF` |

The sample mark is Yellow, with Ink for the eyes and ground and one Paper highlight. Green and Cyan squares sit beside it. Every pixel on the sample sheet and on the shared board is one of these eight hex values. This proposal does not add a ninth color. Brown would need a new index, and that is a contract change.

These hex values are a design preview. Shipping them would recolor stored cells that keep their old indexes.

## Deeper overview

`stall-depth-desktop.png` and `stall-depth-mobile.png` keep the square board and the cistern clearance, and put that board back into a photographed stall: receding walls, textured brick, one ceiling light, and a ceramic toilet with a cistern, thick seat, bowl, and pedestal.

The board pixels are the same eight-color sample as the palette sheet, scaled evenly. Measured after compositing:

- Desktop board: 236×236 px, then 29 px of brick before the cistern.
- Mobile board: 258×258 px, then 78 px of brick before the cistern.

The flat PNGs above stay the geometry and painting-control spec. Paint view is still the 18×18 crop at 22 px and 18 px cells.

Some figures on the side walls still read as old arcade sprites. Those marks should become abstract geometry before the walls are final. The room, toilet, and square board are the parts to keep.

## How it would be built

The live canvas stays the painting surface. Overview keeps it square on the back wall, above the toilet. Paint mode shows a square crop of that same canvas at about 16–24 screen pixels per cell. Place writes. Dragging only moves the view.

Sample pixels in these pictures are labeled and are not chain state.
