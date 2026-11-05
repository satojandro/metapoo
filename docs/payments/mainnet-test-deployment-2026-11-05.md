# Mainnet testing deployment — 2026-11-05

First mainnet deployment of `contracts/paid-board` (schema 4) and `contracts/toilet`. A **testing**
round on mainnet: real chain and real NEAR, small money, for tester feedback before a launch.
Owner decisions that shaped it: launch at 64 × 64, grow only (PR #67); TOILET buy/sell tax 2% / 3%
with a 30% treasury and 70% burn split; paperhand tax stays out of this contract (it lives in the
staking contract, 10%).

Follows [`mainnet-deploy-runbook.md`](mainnet-deploy-runbook.md).

## Accounts

Implicit accounts, created for this round. Burnable on purpose — a testing round costs balances,
not names, and `nearlytrade.near` has no full-access key retained, so sub-accounts were not
available.

| Role | Account | Created by |
|---|---|---|
| Board (paid, schema 4) | `fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e` | `tY8CDyf3XN1A9RWz1iDzzkV1szva8SJLSB4hiyTne9a` |
| TOILET token | `a571dead0abc8d307f6da72e38ae9c9006c87db9007b1e186eae14b2ee7801ee` | `J49x6MdmsEXd7ZRe5wSB74R2gp3ZYhfvDfTGHZ5tmT2U` |
| Treasury (TOILET tax sink, board `team_account`) | `816562893deda87a6a847023b2f17cd1220dd7cbcbd2aa5c27dd1b487186ab51` | `EpdvCyLcwK7WUamBeAy6JwoxH8BH3ALNiC1SDWYb4gkE` |
| Buyback (board `buyback_account`) | `e297202da796949aeeeffa2e43999847d68de7bf97f7857cbfdc517c0d8487a9` | `G9uwa9XofE3yMkPx4YvbmAAyzhvHPeGbhGABqs9MQsoh` |

Owner of the board: **the board account itself** (`get_owner` returns it). Keys are files on the
Mac Mini and in `~/.near-credentials/mainnet/`; custody is a testing-round arrangement only.

## Artifacts

| Contract | Size | sha256 |
|---|---|---|
| `metapoo_toilet.wasm` | 231,550 B | `4ae3739a4286fb4b07c8331fa5e58ef2553ecbe3c78d7e7c86e5975ef1dbe525` |
| `metapoo_paid_board.wasm` | 441,213 B | `145671e9a37443c371aee5f5aed9a70d655095b3363d68e387bb87739c06e39b` |

Both built from `main` at `10632a2` (`cargo near build non-reproducible-wasm`). The board hash is
byte-identical to the one rehearsed on testnet in the growth runbook.

## Transactions

| Step | Transaction |
|---|---|
| Deploy TOILET + `new(emitter, tax)` | `A9xr1hWUqmVNhUnqmjUzmtV7CWPaXXWnviHej866W3Vx` |
| Deploy board + `new(mpoo, 1e18, team, buyback, toilet)` | `ACQgeL1Y4Mt5vC4uyPEoQY4e1i68H7d8Z6HNVejVy35a` |
| `set_toilet_rate(1000000000000000)` | `6RABe1h6z41cKekUfewQjvS47d8uYuELFcQRHEEQJLQX` |
| `register_credit_account` (0.01 NEAR) | `BZvi2iV1AAg4PhyAipHuXhB5kxxbpmytZ6ns3XLf1pXE` |
| `buy_credits_near` (0.01 NEAR → 4 credits) | `B8AShRGKyYn6J29hN6q5gvrjwxnxgXJ5aESq2AG7tbQo` |
| `draw(10,10,3)` | `r6ug3VMNxUgaF6EgDxsuyXhkXN46drKoRcR7kAEojDM` |
| WEB: production deploy `dpl_6rCAePt6PzWVYJP3gPdM8uqJpWY5` of build `10632a2` | https://metapoo-testnet.vercel.app |

## Configuration actually on chain

- `get_board`: 64 × 64, schema 4, `open_wall`, sponsorship false.
- TOILET `get_tax`: `buy_bps` 200, `sell_bps` 300, `burn_bps` 7000, `treasury_bps` 3000, treasury and
  exchange `81656289…`. `ft_total_supply` 0, 18 decimals, name/symbol `TOILET`.
- `toilet_per_cell_second` `1000000000000000` (0.001 TOILET per cell per second). **Estimate, not a
  modelled number:** ~86.4 TOILET per cell per day, so the 1e9 cap lasts ~7.7 years even with all
  4,096 launch cells permanently held, and ~15 years at half. Chosen conservative so a test round
  cannot exhaust the cap; revisit before a launch.
- Prices: `expected_price` 0.0025 NEAR per credit; registration 0.01 NEAR; `mpoo_per_credit` 1e18 is
  a plumbing fixture.

## Verification performed

| Check | Result |
|---|---|
| `get_board` | 64 × 64, schema 4 |
| `get_owner` | the board account |
| `draw(10,10,3)` | succeeded, `get_pixel(10,10)` returns colour 3 and the signer as artist |
| credits before / after that draw | 4 / 4 — a free first paint does not decrement |
| `get_pixels` | one pixel, `(10, 10)`, truthful coordinates |
| deployed bundle | contains the mainnet contract id and `rpc.mainnet.fastnear.com`, no `board5` reference |

Not yet proven: a **wallet-signed paint through the page** (the E2E below), a credit decrement on a
paid repaint, the mPOO purchase path, and every cost figure.

## Money

| Item | NEAR |
|---|---|
| Funded by owner | 14.0 |
| Code + state storage, board | 4.43 |
| Code storage, TOILET | 2.32 |
| Credit purchase + registration | 0.02 |
| Transaction fees (13 txs) | ~0.01 |
| Left on the board | 11.10 |
| Left unused on the signer | ~0.05 |

The board reserves `storage used + empty cells × 664e15 + 5 NEAR reserve floor` ≈ 12.15 NEAR and
holds 11.10, so `get_withdrawable_near` is **0** and nothing distributes until it is topped up by
~1.1 NEAR. Harmless while there is no revenue; needs funding before the keeper is pointed at it.

## Next

E2E in a real wallet against https://metapoo-testnet.vercel.app — buy a credit, repaint a cell
(credits must decrement), paint a stroke, confirm the pixels and the credit delta. Then the C01+
rows in [`mainnet-cost-validation.md`](mainnet-cost-validation.md) with these transaction ids.

## Traps hit during this deploy

- `near tokens send-near` and `cargo near build` both need a TTY; plain piping returns
  `The input device is not a TTY` or a cancelled menu. `expect` (or `script -q /dev/null` for the
  build) is required for unattended runs.
- The Vercel project's gitless deploy **fails on `@shared/*`**: with no repo checkout context the
  path alias does not resolve and `tsc` emits a wall of TS2307. `vercel build --prod` +
  `vercel deploy --prebuilt --prod` from a real checkout is the working path.
