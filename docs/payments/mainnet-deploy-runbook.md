# Mainnet testing deploy — runbook

2026-11-05. A **testing** release on mainnet: real chain, real NEAR, small money, meant for
tester feedback ahead of a public launch. `web/.env.production` already points at these
addresses (PR #68), so the page is configured; nothing is deployed yet.

Two contracts, four accounts, one owner key the owner keeps.

## Accounts

| Role | Account | Balance | State |
|---|---|---|---|
| Board (paid, schema 4) | `fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e` | 0.25 NEAR | empty |
| TOILET token | `a571dead0abc8d307f6da72e38ae9c9006c87db9007b1e186eae14b2ee7801ee` | 0.25 NEAR | empty |
| Treasury / TOILET tax sink | `816562893deda87a6a847023b2f17cd1220dd7cbcbd2aa5c27dd1b487186ab51` | 0.05 NEAR | — |
| Buyback | `e297202da796949aeeeffa2e43999847d68de7bf97f7857cbfdc517c0d8487a9` | 0.05 NEAR | — |

They are **implicit accounts**, so a burn or a mistake costs the balance, not a name. This is
deliberate for a testing round. Real names (`board.metapoo.near`) need `metapoo.near`, which
would have to be bought at auction and its key held locally; `nearlytrade.near` exists but has
no full-access key retained, so sub-accounts of it are not creatable today.

Signer / fee payer for the deploy: `247460301d7086e5586a6aaae5a1e361e87f3c5ef4779aef54be883eea803147`,
key at `~/.near-credentials/mainnet/`. Key type: full access.

## Money

Measured wasm sizes and the storage they pin:

| Artifact | Size | Storage cost |
|---|---|---|
| `metapoo_paid_board.wasm` (sha256 `145671e9…c06e39b`) | 441,213 B | ≈ 4.41 NEAR |
| `metapoo_toilet.wasm` (sha256 `4ae3739a…dbe525`) | 231,550 B | ≈ 2.32 NEAR |

Plus the board's `reserve_floor` (5 NEAR) and the empty-cell storage reserve, and a little
headroom for the deploy transactions: **budget ~12–15 NEAR** across the two contract accounts.
The signer currently holds ~0.40 NEAR, which pays fees but covers neither deploy.

Board is deliberately the larger reserve: `get_withdrawable_near` protects
`storage used + empty cells × 664_000_000_000_000_000_000 + reserve floor` before anything
distributes, so a thinner balance reports 0 rather than under-funding paint.

## Order

1. Fund `board` with ≥ 10 NEAR and `toilet` with ≥ 4 NEAR. Nothing else works without it.
2. Deploy the TOILET token first — the board stores its address in `new()`.

   ```bash
   near contract deploy <toilet> use-file contracts/toilet/target/near/metapoo_toilet.wasm \
     with-init-call new json-args \
     '{"emitter":"<board>","tax":{"buy_bps":0,"sell_bps":0,"exchange":"<treasury>","treasury":"<treasury>","burn_bps":3300,"treasury_bps":6700,"exempt":[]}}' \
     prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
     network-config mainnet sign-with-keychain send
   ```

   `buy_bps` / `sell_bps` are 0 for the testing round: there is no venue yet, so a tax would
   only muddy cost measurement. The burn/treasury split mirrors testnet `toilet3`
   (33% / 67%, read from its `get_tax` on 2026-11-05). **The tax is frozen at `new()`** — D4 —
   so a rate change later means a new token.
3. Deploy the board and init in the same transaction:

   ```bash
   near contract deploy <board> use-file contracts/paid-board/target/near/metapoo_paid_board.wasm \
     with-init-call new json-args \
     '{"mpoo_token":"mpoo.nearlytrade.near","mpoo_per_credit":"1000000000000000000","team_account":"<treasury>","buyback_account":"<buyback>","toilet":"<toilet>"}' \
     prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
     network-config mainnet sign-with-keychain send
   ```

   `mpoo_token` is the live mainnet mPOO account (`mpoo.nearlytrade.near`, recorded in
   `docs/00-shared-decisions.md`). `mpoo_per_credit` 1e18 is a plumbing fixture, not a price.
4. `new()` sets `payments.owner` to the deployer — the board account itself if you sign as it.
   If the owner should be a different account, call `set_*`-style transfers or redeploy with the
   owner as predecessor instead; check `get_owner` before handing out the address.
5. Set the launch rate: `set_toilet_rate` (1 yocto, owner only) — it starts at **0** and a board
   at 0 accrues nothing and reports no error. 64² makes the per-tile rate ~4× the 128² figure, so
   pick deliberately (testnet used `1000000000000000`).
6. Leave `paused = false` only when step 7 passes.

## Verify before telling anyone it is live

```bash
near contract call-function as-read-only <board> get_board json-args '{}' network-config mainnet now   # 64 × 64, schema 4
near contract call-function as-read-only <board> get_owner json-args '{}' network-config mainnet now   # the expected owner
near contract call-function as-read-only <toilet> ft_total_supply json-args '{}' network-config mainnet now  # "0"
near contract call-function as-read-only <board> get_tunables json-args '{}' network-config mainnet now    # rate, reserve floor
```

Then the paint path, in the deployment record's shape (`docs/payments/testnet-deployment-2026-10.md`
B-series): register a credit account, buy 1 credit, paint one cell, paint one stroke, confirm the
pixel reads back and credits decrement for a paid paint but not a free first paint.

Record every transaction id in `docs/payments/mainnet-cost-validation.md` as the rows are
exercised — C01 is the deploy itself, and it stays pending until gas and storage are written down.

## Failure modes to expect

- **`new()` args are locked into state.** A wrong `mpoo_token`, `toilet` or treasury is a redeploy,
  not a fix (`upgrade()` replaces code, not state).
- **`draw` takes 0 deposit**, `expand_board` takes 1 yocto. Passing the wrong one panics with
  `Method draw doesn't accept deposit`.
- **No `set_tax` on TOILET**, no owner: a bad rate means a new token and a new board pointing at it.
- **`rpc.mainnet.near.org` is not a stable write path.** Deploys here used the CLI default; if it
  starts answering 429, pass a different RPC rather than retrying in a loop at a known-bad endpoint.
- **Recovery:** both contracts are fresh implicit accounts with no data worth keeping during the
  testing round. Recover by funding four new accounts and re-running this page rather than
  migrating; only after real paint appears does an in-place `upgrade()` become worth its cost.

## Still open

- Full-access key custody: currently a file on the Mac Mini. Fine for a testing round, not for a
  launch.
- `mpoo.nearlytrade.near` is only 0.69 NEAR and its own FT registration on the board must succeed
  before mPOO purchases work — exercise C06/C07 before advertising the mPOO path.
- The board's `upgrade()` self-deploy and the keeper/buyback/burn wiring are out of scope here.
