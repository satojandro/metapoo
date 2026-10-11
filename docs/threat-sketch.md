# Threat sketch

Date: 11 October 2026. This is a design sketch for the mock scaffold, not a security audit and not a review of any deployed contract.

## What we are protecting

- A visitor should not be told a pixel changed unless a successful transaction was observed and the board was read again.
- The overwrite rule, once chosen, has to be enforced by the contract. The page can be skipped.
- Network gas sponsorship, if it ever exists, must not become an open signer.
- Token accounts and treasury flows stay out of the MVP so a game bug cannot move those assets.

## Sketch

| Risk | What could go wrong | What this scaffold does |
|---|---|---|
| Click treated as success | The wall updates because someone pressed a button, even if the transaction failed or never existed | The draw path returns a rejection and tells the visitor that no transaction was sent. There is no success state in the page. |
| Hidden overwrite rule | Contract and page disagree about who may paint | The policy type has one value, `unresolved`. Draws stop. |
| Out-of-range writes | A caller stores a color or cell the page cannot show | Shared checks reject bad coordinates and palette indexes. The contract must repeat this later. |
| Unbounded storage | Initializing every cell, or writing unlimited history, locks a growing NEAR deposit | Empty cells are absent. One cell per future call. History is deferred. Cost is not measured yet. |
| Wallet on the wrong network | A mainnet wallet signs toward a test contract, or the reverse | The mock compares session network to board network. Mismatch is a distinct error. No signature is requested. |
| Practice data mistaken for mainnet | Sample pixels look like a live wall | The page says the board is mock data. Sample names are not the supplied token or deployer accounts. |
| Sponsorship key in the browser | Anyone could sign gas-paid transactions | Sponsorship is hardcoded off. No sponsor key exists in the repo. |
| Supplied token facts treated as verified | Fees, taxes, or transfers get built on an unread contract | The token account is documented as supplied context and is not referenced by code. |
| No pause | A bad rule on a public contract cannot be stopped | No admin key is a choice: nobody can pause, and nobody has a hidden admin either. Decide before a public deploy. |
| Replay of a sponsored action | A signed payload is submitted twice | Not applicable while sponsorship is off. Required before any sponsor work. |

## Out of scope on purpose

MPOO transfers, application fees, treasury custody, NEAR Intents, bridging, and rage quit are not in the threat surface of this scaffold because there is no code for them. Adding that code later needs its own review.
