# 2026-10-28 — payment displays before paid deployment

## Learned

The free testnet board and new paid contract coexist. A display must identify the
board schema before asking for paid config/credits; otherwise missing methods can
look like empty wallets. Keep planned prices explicitly labelled, errors separate
from zero, and discard late responses after account/network changes. A mainnet
market link must not imply that its tokens can pay for testnet credits.

## Evidence

9 payment-display tests, 284 full frontend tests / 41 files and production build
passed. Browser inspection showed the disconnected/free-board state from the
configured testnet board. Connected balances and schema-4 state are fixture-tested
only. No signing, purchases or mainnet deployment occurred. Regression tests include
late previous-account responses and failed-credit reads preserving NEAR data.
