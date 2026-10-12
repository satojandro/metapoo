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

## Board viewport (12 October 2026)

The wall sits in a stall frame with a zoomable viewport (`src/viewport.ts`):

- **Fit wall** shows the full 128×128 board.
- **Paint zoom** targets ~20 screen pixels per cell for precise placement.
- Drag to pan; scroll / pinch to zoom. Pan and pinch never submit paint.
- Selection uses an **external** ring so the cell interior stays visible.
- Palette + **Place paint** stay in a dock under the board (sticky on narrow screens).
- Contract / schema / long rules live under **About** in the side panel.

See `docs/2026-10-12-viewport-and-interaction-brief.md`.

## Known limitations

- Full-board load uses paginated `get_pixels` (max 256 cells per page). History
  of past colors is not available — only the current painted set.
- Board refresh is still manual / after own success — bounded polling and
  stale-response guards are not done yet (board-review step 3).
- Without `VITE_CONTRACT_ID`, the board is a local empty mock (not chain state).
- Gas sponsorship is not implemented.
- No MPOO/NEAR checkout, balances, treasury, Intents, or rage quit.
- Success confirmation polls `get_pixel` a few times; slow RPC may show a
  “read did not match yet” failure even when the explorer later shows success.

### Experimental drawing session (function-call key)

A narrow scaffold can optionally call near-connect `connect({ addFunctionCallKey })`
so the wallet is asked to add a **limited** access key for this board’s `draw`
method only, with a small explicit gas allowance (0.05 NEAR lifetime).

**What works in code today**

- Default Connect stays ordinary sign-in (`signInWithoutAddKey`) — no FC key.
- Opt-in checkbox / “Authorize drawing session” builds `addFunctionCallKey` with
  `allowMethods: { anyMethod: false, methodNames: ["draw"] }` and a limited
  `gasAllowance`.
- An ed25519 keypair is generated (Web Crypto) and stored in `localStorage`
  under `metapoo.experimental.drawingSession.v1` (labeled experimental).
- Plain-language status covers inactive / active / forgotten / mismatch, plus
  renewal and “forget in this browser” copy.

**Still unverified on testnet**

- Whether your chosen wallet actually supports `signInWithFunctionCallKey`.
- That the key appears on chain with the expected receiver/methods/allowance.
- Remaining allowance reads, exhaustion handling, and real on-chain revocation.
- **No-popup drawing:** paint still uses `wallet.signAndSendTransaction`. Having
  requested an FC key at sign-in does **not** yet mean local signing without a
  wallet popup. Do not treat multiple paints without popups as proven.

**Important:** clearing browser storage or clicking “Forget session” only removes
local key material. It does **not** delete the access key on the NEAR account.

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
| `src/main.ts` | Wires the page: viewport gestures, selection, wallet, Place paint, status |
| `src/viewport.ts` | Camera math: fit, zoom, pan, hit-testing, selection ring box |
| `src/draw-policy.ts` | Client checks before any wallet prompt |
| `src/submit-draw.ts` | Wallet prompt → pending → confirm with `get_pixel` |
| `src/contract.ts` | Free RPC view calls (`get_board`, `get_pixel`, `get_pixels`) |
| `src/load-board.ts` | Walk every `get_pixels` page into one list |
| `src/wallet.ts` | Connect / disconnect / `signAndSendDraw` (optional FC key on connect) |
| `src/drawing-session.ts` | Experimental FC-key session helpers + localStorage |
| `src/board-cache.ts` | Sparse painted cells from confirmed reads only |
| `src/sponsorship.ts` | Feature flag + ordinary-wallet fallback |
| `src/payment-provider.ts` | Unused future checkout interface |
| `../shared/` | Shared board size, palette, and rule checks |

Contract method names and JSON shapes: `contracts/board/FRONTEND_HANDOFF.md`.
