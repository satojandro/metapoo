# 05 Agent Brief Contract

## Mission

Design and implement the smallest safe NEAR game contract that supports one shared pixel board. Inspect the repository and teach the coordinator what each important contract choice means in plain language.

## Scope

- Confirm the existing toolchain and contract framework before adding dependencies.
- Propose and implement the board configuration and pixel state for a provisional 128 × 128 canvas.
- Enforce coordinate bounds, palette bounds, and the chosen ownership/update rule.
- Decide how empty pixels are represented and avoid unnecessary per-pixel setup.
- Emit documented change events or provide a read strategy suitable for the frontend.
- Include authorization for administrative configuration only if the MVP needs it; document who can change it.
- Add focused tests and local/test deployment instructions.
- Explain NEAR storage costs and how the chosen state shape affects them.

## Not in scope

No MPOO transfers, NEAR application fees, creator commissions, treasury, token swap, sponsorship signing service, Intents, bridging, or rage quit. Do not deploy to mainnet.

## Required questions before implementation

- Does first draw claim a pixel permanently, or can the current owner recolor it?
- Can another account overwrite a pixel? If so, what rule prevents abuse?
- Is ownership a current controller, a public attribution, or a transferable right?
- Are colors numeric indices, RGB values, or another bounded representation?
- What history and board read methods are necessary for the first demo?
- What admin or pause control is truly needed?
- Who may overwrite a claimed pixel, and what timestamp/event ends the previous artist's tenure?
- Should successful write time be stored for a later tenure statistic? Do not add reward payout logic in the MVP.

If the coordinator has not answered, write a recommendation and stop before encoding a conflicting rule.

## Deliverables

- Contract design note with state shape and methods.
- Contract implementation and focused tests.
- Example calls that the frontend agent can use.
- Storage and gas considerations in beginner-friendly language.
- Known limitations, security concerns, and exact environment for verification.

## Acceptance

The contract rejects out-of-range coordinates and invalid colors; follows the agreed ownership rule; emits or exposes enough state for the UI to render; avoids unbounded work; and passes focused local tests. State clearly whether any result is local, testnet, or mainnet. No claim of production readiness without an independent review.

