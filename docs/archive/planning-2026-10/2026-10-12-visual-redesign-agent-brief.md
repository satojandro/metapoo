# Meta Poo — fresh visual redesign brief

Date: 12 October 2026
Workspace: `/Users/avb/metapoo`
Purpose: a self-contained handoff to a new agent for the visual redesign.

## Outcome

Design a compelling shared pixel-art experience inside a three-dimensional toilet stall, viewed from its entrance. The shared board occupies the back wall; a substantial, emblematic toilet sits beneath it; the side walls extend toward the viewer and carry original artwork inspired by the user's Sydney photographs.

The scene should feel playful, inhabited, tactile, and visually rich. People should want to enter it and leave a mark. The painting surface must be easy to find and comfortable to use.

## Why this is a redesign

The user explicitly rejected the existing frontend. Their criticism is that it bears little resemblance to the reference photographs and that the toilet looks flat and unconvincing.

The current CSS stall is an arrangement scaffold, not an approved visual design. Brown surfaces, a few colored stripes, and a small flat toilet icon do not meet this brief. A repaired transaction flow or a clipped wall projection does not establish visual quality. Reconsider composition, artwork, materials, lighting, toilet form, and the surrounding interface together.

The earlier review's comment that the composition followed the direction concerned the positions of objects only. It should not be interpreted as aesthetic approval.

## Inspect the actual references first

Read this brief, then inspect all four supplied photographs before proposing the design:

- `/Users/avb/Downloads/IMG_3260.HEIC`
- `/Users/avb/Downloads/IMG_3259.HEIC`
- `/Users/avb/Downloads/IMG_3258.HEIC`
- `/Users/avb/Downloads/IMG_3257.HEIC`

Create readable local previews if the available image viewer cannot open HEIC. Descriptions of the photos are supplementary; they are not a substitute for viewing them.

Supporting documents:

- `/Users/avb/metapoo/docs/2026-10-12-stall-visual-references.md` — reference observations and attribution.
- `/Users/avb/metapoo/docs/2026-10-12-viewport-and-interaction-brief.md` — painting interaction requirements.
- `/Users/avb/metapoo/docs/2026-10-12-palette-proposal.md` — provisional palette exploration, not an approved migration.
- `/Users/avb/metapoo/web/README.md` — current behavior and limitations.

This brief governs the visual redesign where older descriptions conflict with the user's latest direction.

## Spatial composition

- **Viewpoint:** standing at the entrance, looking into the stall toward its back wall. Establish convincing depth with the side walls, floor, object scale, and consistent perspective.
- **Back wall:** the communal pixel board is the main activity surface. Integrate it into the wall rather than presenting it as an unrelated dashboard panel or television. Keep the entire board visible in overview.
- **Toilet:** beneath the board, recognizable and large enough to have presence. Show a coherent cistern, seat, bowl, and pedestal/base, with believable thickness and volume. Ceramic highlights, recesses, occlusion, and contact shadows should make it sit in the room. Its humor comes from putting a communal art experience above an iconic toilet, rather than making the object illegible or cheaply drawn.
- **Side walls:** extend toward the viewer and provide space for artwork. They must frame the back wall without covering the canvas, header, palette, or controls.
- **Materials:** dark weathered brick, worn painted partitions, metal hardware, fasteners, seams, and small signs of use. Choose a coherent combination rather than applying the same brown texture everywhere.
- **Lighting:** one understandable scheme across the room, toilet, and wall art. Use light and shadow to establish form while keeping colors lively and the canvas readable.

Three-dimensional appearance is essential. The user has not prescribed a rendering engine, free camera movement, or photorealism. Choose actual 3D geometry, a carefully rendered fixed-view scene, or another suitable approach based on visual quality and painting usability. Explain the choice briefly after presenting the concept.

## Original artwork and atmosphere

The user explicitly chose **original artwork conveying the vibe**, rather than reproducing the photographed art.

Draw from the references' visual ingredients:

- Nearly black grounds with saturated cyan, blue, yellow, green, red, and pink.
- Pixel fragments, stair-step forms, grids, playful characters and symbols, circles, zigzags, and offset geometric blocks.
- Bold compositions with variation in scale and deliberate areas of breathing room.
- Handwritten marks, stickers, doodles, scuffs, fading, and overlapping layers that suggest many people have used the space.
- Contrast between designed graphics and accumulated human marks.

Create substantial original compositions for the surrounding surfaces. A few diagonal accent stripes are insufficient. Translate the reference language into the stall rather than merely placing a generic poster next to the board. Keep decorative marks outside the editable region so users can tell where painting is possible.

Do not trace the photographs, reproduce their distinctive arrangements, or imply involvement or endorsement by the credited artist. If using generated assets, inspect the output for reference resemblance, compositional quality, and consistency before integration.

## Palette

The references guide the **editable painting palette as well as the environment**. Show proposed swatches with sample original pixel art so the user can judge what they enable.

Aim for clear saturated cyan and blue, yellow, green, red, pink/magenta, and useful dark/light tones. Select exact colors through the visual exploration. The existing muted palette and the earlier proposed hex values are not final design constraints.

For design previews, a proposed palette is acceptable when labeled as proposed. A frontend-only change to existing on-chain color meanings is not authorized. Before shipping a palette change, specify compatibility across contract, shared definitions, and frontend, and obtain a decision about preserving existing artwork. This visual task does not authorize a deployment or reinterpretation of stored colors.

## Painting experience

Use Reddit r/place as the interaction reference: a shared canvas that can be explored, zoomed, and painted precisely. Berry Club informs NEAR drawing patterns; it is not the visual template.

- Preserve the current 128×128 logical board unless a separate product decision changes it.
- In painting view, provide comfortably targetable cells, approximately 16–24 screen pixels each.
- Each painted cell fills its entire square. Scene texture, shadows, borders, and selection indicators must not obscure its interior.
- Keep rendering, hit testing, and selection aligned. Camera movement and touch gestures must not accidentally paint.
- Let the user move from stall overview to a focused painting view. On mobile, prioritize a useful painting area rather than shrinking the whole desktop room into an unusable thumbnail.
- Keep palette and Place controls close to the activity, with named colors and visible focus states.
- Show pending paint distinctly from confirmed artwork. Demo/sample artwork must be clearly identified as such and must never be presented as chain state.
- Keep account, network, fee, and transaction status compact and legible. Put developer details in an expandable area rather than making them the main content.

The board can be embedded in a richly rendered scene while remaining a live interactive canvas. Do not flatten the complete product into a static mockup image with a fake board or fake controls.

## Work sequence and deliverables

### 1. Establish visual direction

Produce one polished, coherent recommended concept before a broad frontend rewrite. Explore alternatives only if they help resolve a meaningful design choice.

Deliver:

1. Desktop stall overview, showing back-wall board, substantial toilet, side-wall art, materials, lighting, and compact controls.
2. Desktop focused painting view, showing sample full-square art, palette, selection, and placement control.
3. Mobile overview and painting views at approximately 390 px wide, with usable controls and a deliberate composition.
4. Proposed palette with a small original pixel-art example.
5. A brief explanation of how the scene will be rendered while preserving board interaction, plus an asset list and source/creation notes.

Save the concepts as reviewable local artifacts and show them to the user. The user should be able to judge actual images or rendered views, not just a written promise about the design. Ask for visual-direction approval after completing these artifacts and before implementing the broad redesign.

### 2. Implement the reviewed design

After the user approves the direction, build against the reviewed reference. Preserve the shared board, wallet, transaction, pending-paint, and synchronization behavior while replacing presentation. Test the actual rendered frontend and compare it to the approved concept.

## Review criteria

The redesign is ready when:

- The entrance viewpoint, receding side walls, back-wall board, and toilet beneath are immediately legible.
- The toilet has convincing form, material, scale, and contact with the room.
- Surrounding art visibly draws from the reference's color energy, graphic richness, and accumulated marks, through original compositions.
- Artwork and architecture form one coherent scene; the interface does not feel pasted beside it.
- The communal canvas remains prominent, unobstructed, and precise to paint.
- Desktop and 390 px mobile have useful overview and painting states.
- Headers, controls, labels, focus indicators, and status remain readable and do not overlap the scene unexpectedly.
- Assets are original or appropriately licensed; sample state is labeled; palette proposals are distinguished from shipped chain configuration.

Passing code tests alone does not satisfy these visual criteria. Verify with screenshots of the finished views and comparison against the reviewed concept.

## Scope and workspace safety

This task concerns visual direction and its eventual frontend implementation. Payments, burns, staking, swaps, rewards, contract deployment, and batch drawing are separate work.

Functional review work is ongoing. At handoff preparation, `df7f8df` was the latest committed review-fix baseline, and follow-up findings concerned queued requests after wallet identity changes and confirmation pixels receiving a separately fetched block height. Inspect current state before relying on that snapshot; do not reopen resolved issues or fold functional changes into the visual task without coordination.

Check Git status before editing. Preserve concurrent changes and unrelated untracked proposals, including paint-economy, toilet-burn/staking, and live-contract research documents. No push, PR, new chat, or deployment is requested by this brief alone.

## Suggested opening instruction for the new agent

Read `/Users/avb/metapoo/docs/2026-10-12-visual-redesign-agent-brief.md` and inspect all four referenced Sydney photographs. Begin with the visual concept deliverables, not code edits. Show a polished original 3D stall direction with a convincing toilet and reference-inspired surrounding artwork, a proposed palette, and desktop/mobile painting views. Preserve ongoing functional work and bring the completed concept back for visual review before implementing the broad frontend redesign.
