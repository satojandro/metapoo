# Frontend handoff (from contract agent 05)

This note is for agent **06**. The Open wall rule is already accepted. Do not invent a different ownership rule.

## What the contract guarantees

- Network intent for the page today: **testnet** (`web/src/config.ts` → `PAGE_NETWORK`).
- Contract account id: put the deployed testnet account into `web/src/config.ts` → `CONTRACT_ID`. Leave it empty until deploy exists.
- Do **not** point `CONTRACT_ID` at the MPOO token account (`mpoo.nearlytrade.near`). That is unrelated supplied context.
- Success in the UI means: wallet returned a transaction id **and** a later `get_pixel` (or board read) shows the new cell. Never paint the canvas only because the user clicked.

## Methods

| Method | Kind | Args (JSON) | Result |
|---|---|---|---|
| `new` | init (deploy only) | none | empty board |
| `get_board` | view | none | board metadata + palette |
| `get_pixel` | view | `{"x":3,"y":4}` | one cell |
| `get_pixels` | view | `{"from_index":0,"limit":256}` | one page of currently painted cells |
| `draw` | call (signed) | `{"x":3,"y":4,"color":2}` | stores cell; panics on bad args |

Argument name on chain is `color` (palette index 0–7), not `color_index`.

`get_pixels` returns each currently painted cell **exactly once**, with the latest color and artist after overwrites. Unpainted cells are omitted. `limit` is clamped to 256. Follow `next_from_index` until it is `null`. Schema version is **2** (iterable sparse storage).

## Example: read board (view)

Replace `BOARD_CONTRACT.testnet` with the real account.

```bash
near contract call-function as-read-only BOARD_CONTRACT.testnet get_board \
  json-args {} \
  network-config testnet \
  now
```

Example shape (fields may appear in any order):

```json
{
  "schema_version": 2,
  "width": 128,
  "height": 128,
  "origin": "top-left",
  "overwrite_rule": "open_wall",
  "sponsorship_enabled": false,
  "palette": [
    { "index": 0, "name": "Ink", "hex": "#1c1917" }
  ]
}
```

## Example: read one pixel (view)

```bash
near contract call-function as-read-only BOARD_CONTRACT.testnet get_pixel \
  json-args '{"x":3,"y":4}' \
  network-config testnet \
  now
```

Empty cell:

```json
{
  "x": 3,
  "y": 4,
  "color": null,
  "artist": null,
  "written_at_ns": null
}
```

Painted cell:

```json
{
  "x": 3,
  "y": 4,
  "color": 2,
  "artist": "alice.testnet",
  "written_at_ns": 1700000000000000000
}
```

Map into page types (`shared/types.ts`) roughly as:

- `color` → `colorIndex`
- `artist` → `artistAccountId`
- `written_at_ns` → `lastWriteTimestampNs` **as a string** (JS numbers are not safe for every nanosecond value)

## Example: page painted cells (view)

```bash
near contract call-function as-read-only BOARD_CONTRACT.testnet get_pixels \
  json-args '{"from_index":0,"limit":256}' \
  network-config testnet \
  now
```

Example shape:

```json
{
  "pixels": [
    {
      "x": 3,
      "y": 4,
      "color": 2,
      "artist": "alice.testnet",
      "written_at_ns": 1700000000000000000
    }
  ],
  "from_index": 0,
  "limit": 256,
  "total": 1,
  "next_from_index": null
}
```

The page should call this on open and on Refresh, walking pages until `next_from_index` is null. Do not invent cells from clicks.

## Example: draw (change / signed)

```bash
near contract call-function as-transaction BOARD_CONTRACT.testnet draw \
  json-args '{"x":3,"y":4,"color":2}' \
  prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' \
  sign-as alice.testnet \
  network-config testnet \
  sign-with-keychain \
  send
```

Open wall behavior the UI must explain:

- Any connected testnet account may overwrite any cell.
- Same account may recolor.
- Latest successful writer is the current artist (credit only).

## Suggested UI status flow

1. Disconnected → allow looking; block draw with wallet message.
2. Connected, wrong network → block; no signature.
3. Connected, `CONTRACT_ID` empty → block with “contract not configured”.
4. Connected, configured → wallet prompt for `draw`.
5. After submit → `pending` with transaction id / explorer link.
6. After confirmation → view `get_pixel`; only then show success and update the picture.

## Out of scope for 06

No MPOO payments, balances, treasury, sponsorship signing, Intents, bridge UI, or rage quit.
