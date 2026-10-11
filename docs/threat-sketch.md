# Threat sketch

Date: 11 October 2026. This is a design sketch for the Open wall scaffold, not a security audit and not a review of any deployed contract.

## What we are protecting

- A visitor should not be told a pixel changed unless a successful transaction was observed and the board was read again.
- The overwrite rule is enforced by the contract. The page can be skipped.
- Network gas sponsorship, if it ever exists, must not become an open signer.
- Token accounts and treasury flows stay out of the MVP so a game bug cannot move those assets.

## Sketch

| Risk | What could go wrong | What this scaffold does |
|---|---|---|
| Click treated as success | The wall updates because someone pressed a button | Page draw path stays blocked while `CONTRACT_ID` is empty. No success without an observed transaction. |
| Open wall vandalism | Anyone can overwrite any pixel | Accepted product tradeoff. Rules panel must say so. |
| Hidden overwrite rule | Contract and page disagree | Marker is `open_wall` in `board.json`, TypeScript, and the contract. Tests compare them. |
| Out-of-range writes | A caller stores a color or cell the page cannot show | Shared checks and contract reject bad coordinates and palette indexes. |
| Unbounded storage | Initializing every cell locks a growing NEAR deposit | Empty cells are absent. One cell per successful `draw`. Cost is not measured yet. |
| Wallet on the wrong network | A mainnet wallet signs toward a test contract | Page compares wallet network to `PAGE_NETWORK` (testnet). |
| Practice board mistaken for mainnet | Empty local picture looks like a live wall | Evidence line says local mock. Nothing is deployed. |
| Sponsorship key in the browser | Anyone could sign gas-paid transactions | Sponsorship is hardcoded off. |
| Supplied token facts treated as verified | Fees or transfers get built on an unread contract | Token account is supplied context and unused by code. |
| No pause | A public contract cannot be stopped | No admin key yet. Decide before a public deploy. |

## Out of scope on purpose

MPOO transfers, application fees, treasury custody, NEAR Intents, bridging, and rage quit are not in the threat surface of this scaffold because there is no code for them.
