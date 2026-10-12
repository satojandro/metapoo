# Meta Poo prints / snapshot registry

NEAR contract combining **trusted snapshot registration** and **numbered historical print NFT issuance**. Public series and bounty collector series are separate; public minting never consumes a bounty entitlement.

Wave 2: unit-tested registry + mint logic. **No mainnet deploy.**

## Attester trust model

Initial authenticity is **not** a trustless on-chain state proof. A named **trusted snapshot attester** account may call `register_snapshot(manifest)` after off-chain verification and storage checks. The registry binds:

- `snapshot_id` / `state_hash` (lowercase hex of SHA-256 digests; identity hashing uses raw 32-byte inputs per `shared/history`)
- board / chain / epoch, dimensions, finalized block hash/height/timestamp, revision
- immutable `manifest_uri` + `manifest_hash` and the registering attester id

UI and NFT metadata must disclose “history attested by \[account\]” and link to registered evidence. Exact duplicate registration is idempotent; conflicting data under the same id is rejected. Arbitrary users cannot register canonical snapshots.

Attester rotation is a separately authorized upgrade; existing records retain their original attester.

## Escrow wiring (Worker E)

| Method | Escrow counterpart |
| --- | --- |
| `publish_snapshot_reference(snapshot_id, bounty_contract)` | allowlisted escrow `register_snapshot_reference` (same shape as `contracts/bounties`) |
| `mint_bounty_print` → private `on_print_entitlement` | allowlisted escrow `get_print_entitlement(bounty_id)` |

Escrows must be `allowlist_escrow`’d by the attester before publish/mint-bounty. Failed reference delivery does not remove the registry entry. Bounty mint queries entitlement asynchronously; the callback authenticates the promise result and mints **exactly one** bounty-series edition to the entitlement sponsor. Retries cannot change that recipient.

## Series

| Series | Id | Cap |
| --- | --- | --- |
| Public | `public-v1` | configurable at init (fixture default 100) |
| Bounty | `bounty-` + hex(SHA256(`MPOO_BOUNTY_SERIES_V1\0` ‖ genesis ‖ escrow ‖ bounty_id)) | 1 |

Token id: `{print_id}:{series_id}:{edition_number}`. Caps are frozen when a series record is created and are discoverable via `get_print` / `get_deployment_identity`.

## Storage deposits and pull credits

- Sync methods (`register_snapshot`, `mint_print`, …) charge attached deposit for storage growth and refund excess via a transfer **with** `on_storage_refund` recovery.
- `mint_bounty_print` **reserves** remaining deposit on the operation through the entitlement callback; artwork / series / token storage is settled there before any refund.
- Failed refund transfers credit `pull_credits` exactly once. Callers withdraw with `withdraw_pull_credit` (failure restores the credit again).

## NFT interface (NEP-171 / NEP-177)

| Method | Role |
| --- | --- |
| `nft_metadata` | Contract metadata (`nft-1.0.0`) |
| `nft_token` | Standard token + optional metadata (`null` if missing) |
| `get_print_edition` | Custom edition / series view |
| `nft_transfer` / `nft_transfer_call` | 1-yocto transfers; events use the `nep171` standard (same as mint) |

## Build / test

```bash
cd contracts/prints
cargo test
```

near-sdk **5.29.1** (mirrors `contracts/board` and `contracts/bounties`). Standalone crate — do not merge into board/bounties packages.

## Not in this crate

No mainnet deploy, marketplace, royalties, artist splits, animated NFTs, or trustless history proofs. Live cross-contract rehearsal against a real escrow sandbox is owned by the E join (T2.DE / T2.EDH).
