# Viewport and interaction brief — 12 October 2026

## One-sentence product

A live communal pixel-art wall inside a toilet stall. Explore the wall, zoom to a cell, choose a color, and place it precisely.

## Setting vs canvas

Compose a three-dimensional stall viewed from the entrance: the shared pixel board sits on the back wall, an emblematic toilet sits beneath it, and side walls extend toward the viewer. Surrounding surfaces outside the board carry original geometric art, graffiti, brick/metal texture, and vivid colors inspired by the user's Sydney photographs. See [latest stall visual references](2026-10-12-stall-visual-references.md).

The board is a precise rectangular painting surface within the spatial scene. One logical pixel remains one filled square. Perspective and decoration must preserve accurate cell targeting and visible paint interiors. The visual requirement does not yet select a 3D engine or camera implementation.

## Interaction model (r/place + Berry Club lessons)

- **Overview:** Fit the full 128×128 board in the viewport so everyone can see the communal picture.
- **Painting zoom:** Aim for roughly 16–24 screen pixels per logical cell when placing paint. The logical board size stays 128×128 for this repair.
- **Explore without painting:** Pan and pinch never submit paint. Only an explicit Place action writes by default; Direct paint (serialized queue) is available after a drawing session is authorized.
- **Selection:** External indicator that does not cover the cell interior. Coordinates and a named color preview remain primary, not color alone.
- **Shared updates:** Confirmed art comes from chain reads. Pending / preview paint is a separate client layer when introduced.
- **Palette:** The photographs guide the painting colors as well as the environment: saturated cyan, blue, yellow, green, red, and pink, supported by dark and light tones. The current eight-color palette is an implementation baseline, not the final target. Propose swatches with the visual draft; apply changes consistently across frontend / shared / contract with an explicit compatibility plan for stored art.

## Technical references (not forks)

- **Berry Club / NEAR Place:** Engineering patterns — batched draws, pending preview, guarded refresh, row-oriented updates, function-call drawing sessions. Study public history; do not copy old wallet URLs, economics, or undifferentiated pending paint. Primary sources are linked from `docs/2026-10-12-board-review-and-next-steps.md`.
- **Reddit r/place:** Synchronized board state, substantial zoom, easy pan, desktop and mobile; distinguish small logical pixels from larger screen targets.

Original product requirement stands: Meta Poo is not a Berry Club fork. Studying its public implementation for patterns is encouraged.

## Desktop and ~390 px mobile views to support

1. Overview of the 3D stall: back-wall board, toilet beneath, side walls extending toward the viewer, and compact connection status
2. Zoomed painting with external selection and palette + Place within reach
3. Pending paint distinct from confirmed art (when pending layer lands)
4. Compact testnet / fee indication; contract and schema detail in an expandable About panel

## Out of scope for this brief

Does not change the accepted Open wall rule, enable payments, replace the wallet library, or deploy a contract. Continuous brush strokes and a batch `draw` method wait until single-cell placement works well.
