# Intents source allowlist — 2026-11-10

Expands `INTENTS_REVIEWED_SOURCES` (`web/src/integrations/release-evidence.ts`) from USDC on Base
to 18 routes. Destination is unchanged (`nep141:wrap.near`, native-NEAR delivery still unproven:
test mode stays on).

## How each route was checked

1. **Registry.** Each asset id resolves in `GET https://1click.chaindefuser.com/v0/tokens` to the
   expected symbol, chain, decimals and contract address.
2. **Contract on its own chain.**
   - EVM: `eth_call` `symbol()` and `decimals()` via publicnode RPCs.
   - Solana: `getAccountInfo` (jsonParsed). The account is an SPL mint owned by
     `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
   - Tron: `wallet/getcontract` (name `TetherToken`) and `decimals()`.
3. **Live dry quote.** `POST /v0/quote` with `dry: true` (no deposit address, no funds), about $5
   in (0.002 ETH, 0.03 SOL), to `wrap.near`.

| Asset | Chain | Contract | Decimals | Dry quote |
|---|---|---|---|---|
| USDC | Ethereum | 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 | 6 | OK ~47s |
| USDC | Base | 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 | 6 | OK ~37s |
| USDC | Arbitrum | 0xaf88d065e77c8cc2239327c5edb3a432268e5831 | 6 | OK ~27s |
| USDC | Optimism | 0x0b2c639c533813f4aa9d7837caf62653d097ff85 | 6 | OK ~37s |
| USDC | Polygon | 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359 | 6 | OK ~37s |
| USDC | Avalanche | 0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e | 6 | OK ~37s |
| USDC | Solana | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | 6 | OK ~22s |
| USDT | Ethereum | 0xdac17f958d2ee523a2206206994597c13d831ec7 | 6 | OK ~45s |
| USDT0 | Arbitrum | 0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9 (on-chain symbol `USD₮0`) | 6 | OK ~27s |
| USDT | Optimism | 0x94b008aa00579c1307b0ef2c499ad98a8ce58e58 | 6 | OK ~37s |
| USDT | Polygon | 0xc2132d05d31c914a87c6611c10748aeb04b58e8f (on-chain symbol `USDT0`) | 6 | OK ~37s |
| USDT | Avalanche | 0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7 (on-chain symbol `USDt`) | 6 | OK ~37s |
| USDT | Solana | Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB | 6 | OK ~22s |
| ETH | Ethereum | native | 18 | OK ~47s |
| ETH | Base | native | 18 | OK ~37s |
| ETH | Arbitrum | native | 18 | OK ~27s |
| ETH | Optimism | native | 18 | OK ~37s |
| SOL | Solana | native | 9 | OK ~22s |

## Verified but not listed

| Asset | Chain | Why held back |
|---|---|---|
| USDC, USDT | BSC (18 dp) | Provider: "Temporary swap limits: minimum swap amount is $1,000" |
| USDT | Tron | Provider: "Temporary swap limits: minimum swap amount is $100" |

Tron now has a refund-address validator in `quote.ts`, so listing it later is one line once the
minimum comes down. Re-run the dry quote first.

## Not checked

- Delivery. No real deposit has been made on any new route. A dry quote proves the provider
  will price the route; it does not prove native NEAR arrives. That is the open question test mode
  already states.
- Refund to origin on each chain.
