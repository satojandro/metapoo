# Meta Poo web (frontend agent 06)

Small Vite + TypeScript page for reading the shared pixel board and submitting
one `draw` action through a NEAR wallet (`@hot-labs/near-connect`).

## Run locally

```bash
cd web
npm install
cp .env.example .env   # then edit VITE_CONTRACT_ID if you have a deploy
npm run dev
```

Checks used while building this milestone:

```bash
npm test
npm run build
```

## Point at a local or test contract

1. Deploy and initialize the board contract (see `contracts/board/DEPLOY.md`).
2. Copy `web/.env.example` → `web/.env`.
3. Set:

```env
VITE_CONTRACT_ID=board.YOUR_ACCOUNT.testnet
VITE_NEAR_NETWORK=testnet
# optional:
# VITE_NEAR_RPC_URL=https://rpc.testnet.near.org
VITE_SPONSORSHIP_ENABLED=false
```

4. Restart `npm run dev`.
5. Connect a **testnet** wallet. The page shows account + network before draw.

For **view reads** against a NEAR node on your machine, set
`VITE_NEAR_NETWORK=localnet` and `VITE_NEAR_RPC_URL=http://127.0.0.1:3030`.
Note: `@hot-labs/near-connect` only speaks `testnet` | `mainnet`, so wallet
signing on true localnet is out of scope for this connector; use testnet for
the full draw loop.

Leave `VITE_CONTRACT_ID` empty to stay on the local empty mock board. Looking
still works; draw stays blocked with a clear message.

Do **not** put the MPOO token account (`mpoo.nearlytrade.near`) in
`VITE_CONTRACT_ID`.

## State flow walkthrough

| State | What you see | What is true |
|---|---|---|
| **Disconnected** | “Not connected”, board visible | Reads do not need a wallet. Draw is blocked. |
| **Connected** | Account id + matching network | Identity only. No pixel has changed. |
| **Editing** | Square ring + coordinates + named color preview | Client-side selection. Picture still unchanged until a confirmed read. |
| **Wallet prompt** | Status strip + plain-language approval text | Wallet asks to sign `draw(x, y, color)` on the game contract. |
| **Pending** | Transaction id + explorer link (when available) | Hash exists; page re-reads `get_pixel` before success. |
| **Success** | Painted cell + credit | Wallet outcome observed **and** `get_pixel` matches color + artist. |
| **Error** | Recoverable message | User rejection, wallet error, on-chain failure, or confirm mismatch. Try again. |

Sponsorship stays behind `VITE_SPONSORSHIP_ENABLED`. When off (default), the UI
does not claim a sponsored or cross-chain flow. When on but unavailable, the
ordinary wallet path is used. `payment-provider.ts` is an unused stub.

## Known limitations

- No `get_pixels` / full-board download yet. The picture is a sparse cache of
  cells read after selection or after a confirmed draw.
- Without `VITE_CONTRACT_ID`, the board is a local empty mock (not chain state).
- Gas sponsorship is not implemented.
- No MPOO/NEAR checkout, balances, treasury, Intents, or rage quit.
- Success confirmation polls `get_pixel` a few times; slow RPC may show a
  “read did not match yet” failure even when the explorer later shows success.

## Manual checks (and environment used)

| Flow | Result | Environment |
|---|---|---|
| Load page, read board + rules without wallet | Board + Open wall rules visible; draw blocked until selection/wallet/contract | **mock** (empty `CONTRACT_ID`) |
| Keyboard arrows + visible focus + selection ring | Moves selection; coordinates announced in text | **mock** |
| Palette names + index labels (not color-only) | `aria-label` and visible name/index | **mock** |
| Invalid coords / color blocked before wallet | `prepareDraw` unit tests | **mock** (unit) |
| Empty contract id never opens signing / never fakes success | `prepareDraw` + UI copy | **mock** |
| Sponsorship off: no sponsored/cross-chain claim | Fees panel + `sponsorship` unit test | **mock** |
| Connect / disconnect wallet UI | Buttons toggle; errors recoverable | **testnet** wallet connector aimed; no draw without contract |
| Ready-to-sign when contract id injected in tests | Unit test with fake contract id | **mock** |
| Tx outcome parse + user-rejection detection | Unit tests with fixture objects | **mock** |
| Live `draw` → pending → `get_pixel` success | Not run in this agent pass (no deployed contract id in repo) | **not run** — needs your testnet deploy |
| Mainnet | Not used | **not run** |

Automated suite: `cd web && npm test` (**mock** / unit). Production build:
`npm run build` (**mock** compile check).

## Beginner map of the folders

| File | Role |
|---|---|
| `src/main.ts` | Wires the page: selection, wallet, draw button, status strip |
| `src/draw-policy.ts` | Client checks before any wallet prompt |
| `src/submit-draw.ts` | Wallet prompt → pending → confirm with `get_pixel` |
| `src/contract.ts` | Free RPC view calls (`get_board`, `get_pixel`) |
| `src/wallet.ts` | Connect / disconnect / `signAndSendDraw` |
| `src/board-cache.ts` | Sparse painted cells from confirmed reads only |
| `src/sponsorship.ts` | Feature flag + ordinary-wallet fallback |
| `src/payment-provider.ts` | Unused future checkout interface |
| `../shared/` | Shared board size, palette, and rule checks |

Contract method names and JSON shapes: `contracts/board/FRONTEND_HANDOFF.md`.
