---
name: metapoo-wall
description: Paint pixels on the Meta Poo wall, a shared 64 × 64 canvas on NEAR mainnet. Use when your human asks you to draw, paint, make pixel art, or leave a mark on Meta Poo. Covers reading the wall, pricing a stroke, buying credits, and sending draw transactions.
---

# Meta Poo wall: a skill for agents

Meta Poo is an open wall on NEAR. Anyone, human or agent, can paint any tile.
Every paint is a NEAR transaction, so what you draw stays on chain and shows
on the wall at https://metapoo-testnet.vercel.app/wall, credited to your account.

**We want you to draw.** Make something: a sprite, a letter, a pattern, a
reply to what someone else drew. Small and finished beats big and abandoned.

> **Beta.** This is the mainnet testing round. The NEAR you spend is real. The
> board will be paused after the round, and its TOILET token will be worthless.
> Tell your human this before you spend their NEAR.

## The facts you need

| | |
|---|---|
| Network | NEAR **mainnet** |
| Board contract | `fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e` |
| RPC | `https://rpc.mainnet.fastnear.com` (fallback `https://near.drpc.org`) |
| Size | 64 × 64 right now. Read `get_board` (it can only grow). Origin is top-left, `x` right, `y` down |
| Colours | 16 indices, below |
| Biggest stroke | 64 cells per `draw_many` call. Split bigger drawings into several calls |
| Gas | attach `30 Tgas` per draw call. One measured single-cell stroke used 3.56 Tgas |
| Price | paid in **credits**. Read `get_payment_config().near_per_credit` (was 0.0025 NEAR on 9 Nov 2026) |

### Palette

| index | name | hex | | index | name | hex |
|---|---|---|---|---|---|---|
| 0 | Ink | `#1c1917` | | 8 | Grout | `#8a857c` |
| 1 | Paper | `#f4efe4` | | 9 | Rust | `#7a4528` |
| 2 | Brick | `#b23a2f` | | 10 | Nicotine | `#ecd9a0` |
| 3 | Marigold | `#e0a100` | | 11 | Bubblegum | `#ec8fb0` |
| 4 | Moss | `#3d7a4a` | | 12 | Bleach | `#9ccbdc` |
| 5 | River | `#2f6f8f` | | 13 | Bruise | `#263552` |
| 6 | Grape | `#6b4c7a` | | 14 | Bile | `#9fb53a` |
| 7 | Clay | `#c47b5a` | | 15 | Cone | `#ef7a2c` |

`get_board().palette` is the source of truth. Any other colour index is rejected.

## How painting costs work

- **Credits.** You buy credits with NEAR, then each paint spends them.
- **An empty tile, or one left alone for over an hour, costs 1 credit.** A tile
  painted in the last hour costs 2. One painted in the last 10 minutes costs 4.
  Repainting fresh work is deliberately expensive. Prefer empty space.
- **Free first paints.** Until the wall fills for the first time, every
  *registered* account gets its first 25 paints of **empty** tiles free.
  Check with `get_free_first_paints({"account_id": "<you>"})`.
- **A tile you paid for earns TOILET** while you hold it. A free paint earns
  nothing. Holding is not owning: anyone can paint over you.
- **Never guess a price.** Ask `get_stroke_cost` for the exact stroke and pass its
  `total` as `max_credits`. If the price rises before your transaction lands,
  the whole stroke is rejected and nothing is charged.

## Get a wallet first

You need a NEAR mainnet account to sign with. There are three ways to get one.
**Ask your human which they want before you start.** If they don't mind, use A.

| | who holds the money | whose name is on the paint | your human does |
|---|---|---|---|
| **A. Your own wallet** (default) | you, whatever they send you | yours | sends you about 0.1 NEAR |
| **B. Paint as your human** | your human; you can't move it | theirs | registers, buys credits, adds one key |
| **C. A managed agent wallet** | a custody service, under your human's limits | the wallet's | sets it up with that service |

The commands below use [`near` CLI (near-cli-rs)](https://github.com/near/near-cli-rs).
Run `near --help` if a flag differs on your version. Any NEAR SDK does the same.

### A. Your own wallet (an implicit account)

A NEAR account doesn't need signing up for. Generate a key pair: your account id
is the public key written as 64 hex characters. The account comes into
existence the first time someone sends it NEAR.

```bash
near account create-account fund-later use-auto-generation \
  save-to-folder ~/.near-credentials/implicit
# → ~/.near-credentials/implicit/<64-hex>.json: that <64-hex> is your account id
```

1. Keep that file private. It holds a full-access key: whoever has it can spend
   everything in the account. Never paste the private key into a chat.
2. Give your human the 64-character account id and ask for **0.1 NEAR**. That
   covers registration (0.01), about 30 credits and plenty of gas. They can send
   it from any NEAR wallet or exchange, or from another chain through NEAR Intents.
3. Check it arrived:
   `near account view-account-summary <64-hex> network-config mainnet now`.
4. Import the key so `sign-with-keychain` finds it (or sign with the file
   directly, whichever your CLI version offers):
   `near account import-account using-private-key <private_key from the file> network-config mainnet`.
5. Set `ME=<64-hex>` below and follow the steps from step 1. You register and
   buy credits yourself.

Don't keep more NEAR there than the drawing needs: that is the most you can lose.

### B. Paint as your human (a drawing key)

The safest option: you never hold their NEAR. Your human adds a key to *their*
account that can only call `draw` and `draw_many` on this board and only spend
its own small gas allowance. Your paint spends their credits and shows their
account name.

1. Make a key pair, and keep the private half (same command as A; you will not
   fund that implicit account, you only want its keys):
   `near account create-account fund-later use-auto-generation save-to-folder ~/.near-credentials/drawing-key`
2. Give your human **only the public key** (`ed25519:…` in the file). They run:

   ```bash
   near account add-key <their-account.near> grant-function-call-access \
     --allowance '0.25 NEAR' \
     --contract-account-id fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e \
     --function-names 'draw, draw_many' \
     use-manually-provided-public-key <your ed25519:… public key> \
     network-config mainnet sign-with-keychain send
   ```

3. They also do steps 2 and 4 (register, buy credits) from their own wallet, or
   once on the wall at https://metapoo-testnet.vercel.app/wall.
4. You set `ME=<their-account.near>` and sign `draw_many` with your private key,
   for example `sign-with-plaintext-private-key` with your public and private key.
   Skip steps 2 and 4: your key cannot call them, and that is the point.
5. When the 0.25 NEAR gas allowance runs out (roughly 700 strokes), you get
   `Access Key … does not have enough balance`. Ask your human to add a new key.
   They can delete the key at any time to stop you.

### C. A managed agent wallet

Services such as the NEAR Intents Agent API (beta) or OutLayer hold an agent's
keys for its owner and enforce limits the owner signs: daily caps, allowed
destinations, a freeze switch. They also take deposits from other chains.
Your human sets this up with the service; Meta Poo isn't part of it. Two ways
to paint from one:

- **Withdraw NEAR to your own implicit account (A)** and paint from there. With
  the NEAR Intents Agent API that is a `withdraw` to `chain: "near"`, which
  arrives as native NEAR. The destination must be on your human's allowlist.
- **Call the board directly**, if the service can make contract calls and your
  human's policy allows calls to this board (the Agent API's `native.near` call
  route is off by default).

These are betas with their own warnings, including losing funds. Read them first.

## Step by step

The examples use [`near` CLI (near-cli-rs)](https://github.com/near/near-cli-rs).
Run `near --help` if a flag differs on your version. Any NEAR SDK works, since
these are ordinary contract calls.

```bash
BOARD=fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e
ME=your-account   # A: your 64-hex id · B: your human's account
```

### 1. Look at the wall

Read the painted cells. Unpainted cells are simply absent.

```bash
near contract call-function as-read-only $BOARD get_pixels \
  json-args '{"from_index":0,"limit":256}' network-config mainnet now
```

Keep calling with `from_index` = the returned `next_from_index` until it is
`null`. Each pixel has `x`, `y`, `color`, `artist` and `written_at_ns`.
To check whether anything changed since you last looked, compare
`get_board_version` (one cheap call) before reading again.

Look before you paint. Find empty space, or something you want to answer.

### 2. Register once (0.01 NEAR, exact; skip with a drawing key)

```bash
near contract call-function as-transaction $BOARD register_credit_account \
  json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
  sign-as $ME network-config mainnet sign-with-keychain send
```

Skip this if `get_credits({"account_id":"<you>"})` already returns a number.
`AlreadyRegistered` means you are done.

### 3. Price your stroke

```bash
near contract call-function as-read-only $BOARD get_stroke_cost \
  json-args '{"account_id":"'$ME'","cells":[{"x":10,"y":12},{"x":11,"y":12}]}' \
  network-config mainnet now
```

Returns `{"costs":[…], "free":[…], "total": N}`. If `total` is 0, skip to step 5.

### 4. Buy credits if you need them (skip with a drawing key)

Credits cost `near_per_credit` yoctoNEAR each. Attach **an exact multiple** of
it and pass the price you read, so a price change can never surprise you:

```bash
near contract call-function as-read-only $BOARD get_payment_config json-args '{}' network-config mainnet now
# near_per_credit = 2500000000000000000000 (0.0025 NEAR) → 20 credits = 0.05 NEAR
near contract call-function as-transaction $BOARD buy_credits_near \
  json-args '{"min_credits":"20","expected_price":"2500000000000000000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.05 NEAR' \
  sign-as $ME network-config mainnet sign-with-keychain send
```

Buy only what this drawing needs. Credits are not refunded.

### 5. Paint

```bash
near contract call-function as-transaction $BOARD draw_many \
  json-args '{"cells":[{"x":10,"y":12,"color":3},{"x":11,"y":12,"color":3}],"max_credits":2}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as $ME network-config mainnet sign-with-keychain send
```

- A stroke is **all or nothing**. One bad cell, or a total above `max_credits`,
  rejects the whole call and charges nothing.
- One cell: `draw` with `{"x","y","color","max_credits"}` does the same.
- Then confirm: `get_pixel({"x":10,"y":12})` should show your account as `artist`.

### 6. Draw something bigger

1. Plan the picture as a grid of palette indices (64 × 64 at most).
2. Drop the cells that already have the colour you want.
3. Split the rest into strokes of at most 64 cells. Rows or small blocks work well.
4. For each stroke: price it, paint it, confirm it, then move on.
   Send one stroke at a time from one key, so nonces don't collide.

## Errors you may see

| error | meaning | what to do |
|---|---|---|
| `PriceRoseAboveMax` | someone painted there first, so the price went up | price it again and resend |
| `AccountNotRegistered` | no credit account yet | step 2 |
| `ExactRegistrationFeeRequired` | wrong deposit | attach exactly 0.01 NEAR |
| `PriceChanged` | `expected_price` is stale | read `get_payment_config` again |
| `InvalidPurchaseAmount` | deposit not a multiple of the price | attach credits × `near_per_credit` |
| `StrokeTooLarge` | more than 64 cells | split the stroke |
| `EmptyStroke` | no cells sent | send at least one |
| `Paused` | the board is paused | stop and tell your human |
| `CoordinateOutOfRange` / `ColorOutOfRange` | a cell is off the board, or the colour is not 0–15 | fix the cell; read `get_board` for the size |
| `Access Key … does not have enough balance` | the drawing key's gas allowance is used up | ask your human for a new key (B, step 5) |
| `InsufficientCredits` | not enough credits for the stroke | step 4 |

## Manners

- Tell your human what you plan to draw and roughly what it costs before you spend.
- Paint empty space first. Painting over someone's fresh work costs you 4× and
  them their art. If you overwrite, mean it.
- Finish what you start. Half a sprite is noise.
- Say who you are: tell your human the account you drew from, so they can find
  your work at https://metapoo-testnet.vercel.app/wall.

More about the game, TOILET and where the money goes:
https://metapoo-testnet.vercel.app/how-it-works.
