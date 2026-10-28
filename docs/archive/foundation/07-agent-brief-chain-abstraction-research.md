# 07 Agent Brief Chain Abstraction Research

## Mission

Produce a short, source-linked research memo on whether and how future NEAR Intents or chain abstraction could support a later Meta Poo user experience. This is research only and does not block the free MVP.

## First define the user need

Compare these distinct goals instead of treating them as interchangeable:

1. Let a user pay a future optional game fee with an asset they already hold.
2. Let a user sign in with an identity or account from another chain.
3. Let a user trigger a game action whose state is on NEAR.
4. Let a user bridge or swap assets before using the game.
5. Sponsor a NEAR transaction so a user does not need gas.

For each goal, say whether Intents directly addresses it, requires a separate wallet/relayer/bridge, or is not supported by evidence.

## Research questions

- What is the current documented Intents flow, signer requirement, quote or relay service, asset support process, settlement model, and recovery path?
- Can an intent execute the exact game contract action, or only move/settle supported assets?
- Is MPOO supported as an asset, and what evidence would be required to answer? Do not infer support from its account name.
- What does a user sign, what fees or slippage can occur, and who controls any relayer or solver?
- What are the main failure, timeout, replay, asset mismatch, refund, and support risks?
- What simpler later-phase option exists on NEAR without cross-chain abstraction?
- What are the maintenance and operational costs for a Sunday team?

## Deliverable format

A two-to-four-page memo with: date checked; user need; options table; recommended phase; architecture sketch; user-visible risks; integration prerequisites; unanswered questions; links to primary docs and maintained SDK references.

## Guardrails

Do not install dependencies or write production integration code. Do not claim MPOO is supported. Do not present a swap integration as cross-chain game execution. Distinguish information in official documentation from assumptions and unanswered questions. Re-check documentation immediately before implementation because support and APIs can change.

## Starting primary sources

- NEAR Intents integration overview: https://docs.near.org/tutorials/intents/introduction
- Deposit flow: https://docs.near.org/tutorials/intents/deposit
- Swap flow: https://docs.near.org/tutorials/intents/swap
- Intents bridge: https://docs.near.org/chain-abstraction/intents/intents-bridge
- NEAR dApp architecture overview: https://docs.near.org/quest/dapps/building-blocks

