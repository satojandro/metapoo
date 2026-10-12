# Board contract (paid Open wall + pressure)

Rust NEAR contract, **schema version 3**. Sparse 128×128 board, 8-color palette, Open wall (anyone may overwrite), regional pressure pricing, internal TOILET ledger, paint sessions, and `mpoo_board` **2.0.0** draw events.

Prototype fixture economics only (base 10 → same-second 11 → cool cost 11 → heat-cap 50). Not production / mainnet pricing. Local `cargo test` is not a testnet or mainnet result. Do not deploy to mainnet from this repo’s docs.

## Migration note

**Do not call `new` over an existing schema-2 free board state.** Schema 3 is a fresh init path. There is no free-write bypass on the paid contract. Schema-2 free `draw(x,y,color)` is preserved only as a **test-only** module (`legacy_free`). Deploy a new paid board account (or a future planned migration), then point clients at schema 3 + paid APIs.

## Read these next

1. `../../docs/implementation/pressure-and-paint.md` — pricing / paint / session rules
2. `../../docs/implementation/core-board.md` — Open wall preservation
3. `../../shared/protocol/board.ts` — frozen wire types (large ints / ns as decimal strings)
4. `DEPLOY.md` — WASM build / testnet steps (no keys in git)

## Methods

| Method | Kind | Behavior |
|---|---|---|
| `new(chain_id, board_epoch, paint_token_account_id)` | init | Paid empty board, fixture pressure config |
| `get_board` | view | Schema 3 metadata, revision, pricing, ledger unit, pressure, palette |
| `get_pixel` / `get_pixels` | view | Sparse cells; `written_at_ns` as decimal **string** |
| `get_quote(x,y,color,account_id)` | view | Advisory cost / cooled heat / expiry (TTL 30s) |
| `get_account(account_id)` | view | TOILET balance, last nonce, last outcome |
| `get_regions(from_index,limit)` | view | Bounded ≤64 region prices at one block time |
| `draw(...)` | call | **0** deposit; requires registered `session_id` |
| `paint_with_wallet(...)` | call | Exactly **1** yoctoNEAR; no session |
| `register_paint_session(...)` | call | 1 yocto; predecessor == signer; binds budget + key |
| `revoke_paint_session(session_id)` | call | 1 yocto; owner revoke |
| `ft_on_transfer(...)` | call | Stub: exact fixture pack amount → TOILET credit; else refund |

Paint args (draw / paint_with_wallet): `x,y,color,max_cost,pricing_version,expires_at_ns,action_nonce` (+ `session_id` for draw). Cost is recalculated at execution; expired quote / version mismatch / max_cost / bad nonce reject without debit. Same-artist/same-color is a no-op reject without charge or heat. Only successful placements emit v2 draw events and increment `revision`.

## Local checks

```bash
cd contracts/board && cargo test
```

## Not in this crate

No mainnet pack schedule, pause/config migration batches, storage billing policy completion, or live FT sandbox integration (stub only).
