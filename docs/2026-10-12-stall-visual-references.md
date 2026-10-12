# Stall visual references — 12 October 2026

## User direction

The user supplied four photographs taken around Sydney as references for art they like and want on the toilet stall. The surrounding brickwork also informs the atmosphere. These references supplement the r/place interaction direction; they do not replace the need for a precise shared pixel canvas.

**Latest clarification: compose a three-dimensional stall viewed from its entrance.** The shared pixel board sits on the back wall, an emblematic toilet sits beneath it, and the side walls extend toward the viewer. Surfaces outside the explicitly editable board carry original art inspired by the photographs. The photographs also guide the painting palette. The goal is their vibe, not reproduction of the original artwork.

Original reference files:

- `/Users/avb/Downloads/IMG_3260.HEIC`
- `/Users/avb/Downloads/IMG_3259.HEIC`
- `/Users/avb/Downloads/IMG_3258.HEIC`
- `/Users/avb/Downloads/IMG_3257.HEIC`

The photos remain in Downloads; no artwork has been copied into application assets.

## Artist identification

The credit visible in IMG_3259 names **Tegan Wotton** and displays the title over two lines as “BADABABA / BABBAT-DA”. City of Sydney documentation independently credits **BADABABABABBAT-DA** to Tegan Wotton as a Site Works artwork.

Source: [City of Sydney, 2022 Site Works expression of interest](https://www.cityofsydney.nsw.gov.au/-/media/corporate/files/programs/cultural-support-funding/creative-hoardings-program/final-2022-site-works---expression-of-interest.pdf?download=true).

This attribution identifies the underlying credited artwork. It does not identify the authors of the later tags, stickers, and doodles visible on top.

## Observations from the photographs

- Dark, nearly black grounds make saturated cyan, blue, yellow, green, red, and pink highly visible.
- Pixel stairs, scattered square fragments, grid patches, hearts, faces, and computer-like symbols coexist with circles, zigzags, and blocks with simple dimensional shading.
- Strong geometric composition is interrupted by loose handwritten marks, stickers, drips, scuffs, and fading.
- Dark brown/charcoal brick, pale mortar, recessed panels, visible fasteners, shadows, and weathered metal give the setting physical weight.
- The contrast between designed art and accumulated public marks makes the surface feel used and socially shared.

Interpretation: a playful mix of retro computer graphics, geometric poster design, and street graffiti. “Memphis-like” is a useful descriptive comparison for some shapes and colors, not a verified statement about the artist's influences.

## Application to Meta Poo

1. **Spatial composition:** look into a 3D stall from the entrance, facing the back wall. Side walls extend toward the viewer; perspective, shading, and material detail establish depth. This visual requirement does not yet prescribe a rendering engine or a freely movable camera.
2. **Back wall and toilet:** the shared pixel board occupies the back wall. A recognizable, emblematic toilet beneath it supplies the humorous focal point. Keep it below the painting region so it does not hide artwork or obstruct cell selection.
3. **Surrounding surfaces:** everything outside the board is available for original geometric art, pixel motifs, handwriting, stickers, scuffs, and weathering. Dark brick, worn partitions, fasteners, and metal details carry the Sydney material reference. Make the editable boundary clear.
4. **Shared canvas:** the board is a precise rectangular painting surface within the 3D scene. Individual pixels remain fully colored squares. Perspective, texture, scene objects, and selection indicators must preserve accurate targeting and visible cell interiors, especially at painting zoom.
5. **Controls:** keep palette and placement controls readable and within reach. Coordinate, connection, pending, and error states remain easy to understand within the spatial composition.

Visual arrangement: entrance viewpoint → side walls extending toward the viewer → pixel board on the back wall → emblematic toilet beneath it. Reference-inspired art occupies the surrounding surfaces. A compact palette and placement toolbar support painting. Exact toilet design and scene proportions remain to be explored in the next visual draft.

## Palette direction

The photographs inform both the environment and the editable painting palette. Favor saturated cyan, blue, yellow, green, red, and pink, with dark ink and light tones for contrast and highlights. These are reference-derived color families, not finalized swatches or an approved palette size.

The existing muted eight-color palette is an implementation baseline, not the final visual target. Propose swatches alongside the next stall draft and preview a small piece of pixel art using them. Implement changes consistently across contract, shared definitions, and frontend, with an explicit compatibility plan so changing a color index does not silently recolor stored art.

## Next design check

Produce desktop and 390 px mobile views showing the 3D stall overview and a zoomed painting state. The overview must show the back-wall board, toilet beneath, and side walls extending toward the viewer. Check that surroundings and proposed palette share the reference's color energy while the editable board, selected cell, and placement action remain immediately recognizable. At painting zoom, preserve precise targeting and full-square color.

Use the supplied photos as references for composition, materials, and atmosphere. Direct use of the exact artwork would be a separate asset decision; an original composition can convey this direction.
