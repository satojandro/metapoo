# 06 Agent Brief Frontend

## Mission

Build the smallest polished experience for reading the shared pixel board and submitting a drawing action through a NEAR wallet. Keep the code approachable and explain unfamiliar pieces for a beginner maintainer.

## Scope

- Inspect the repository's framework and existing wallet setup before choosing libraries.
- Render a responsive, keyboard-friendly board with an accessible selected-pixel indicator.
- Provide read-only use without a wallet.
- Connect and disconnect a NEAR wallet; show account and network clearly.
- Provide a limited palette and selection preview.
- Call the agreed game contract interface, show pending/success/rejected/failed states, and link to the transaction when available.
- Refresh from the contract or authoritative read service after success; do not mark a pixel changed just because the user clicked.
- Display the pixel rule and any sponsor status before submission.
- Keep sponsorship behind a feature flag and use the ordinary wallet path if sponsorship is unavailable.
- Keep any future payment provider interface unused in the MVP.

## Not in scope

Do not add MPOO or NEAR payment checkout, exchange quotes, token balances, treasury displays, creator fees, cross-chain actions, or rage quit.

## Accessibility and usability

Support keyboard movement and selection, visible focus, text alternatives for color selection, sensible contrast, and a mobile layout. Do not rely on color alone to communicate selection or ownership. Explain what the wallet asks the user to approve in ordinary language.

## Deliverables

- UI implementation and focused checks consistent with the repository.
- Short walkthrough of state flow: disconnected, connected, editing, wallet prompt, pending, success, and error.
- Example configuration and clear instructions for pointing at a local/test contract.
- Known limitations and a list of screens or flows that were manually checked.

## Acceptance

The board is understandable without a wallet; a drawing action cannot be submitted with invalid coordinates or palette values; wallet errors are recoverable; confirmation comes from an observed transaction result; and the UI does not claim that a sponsored or cross-chain flow exists when disabled. Report whether each check used mock state, local contract, testnet, or live mainnet.

