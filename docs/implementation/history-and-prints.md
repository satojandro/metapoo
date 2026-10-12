# History and historical prints implementation specification

Date: 12 October 2026. Status: proposed implementation contract; no indexer, snapshot registry or NFT deployment is claimed.
Scope: chosen whole-board/crop prints and the history needed by Art Bounties. No mystery cards. Animated prints are a later extension.

## Source baseline and migration

- `contracts/board/src/lib.rs` stores schema 2: `schema_version` and sparse `IterableMap<u32, PixelRecord>`; each record has latest color, artist and timestamp only.
- `get_pixels` returns at most 256 painted cells per page. Empty means absence, not palette index 0 (Ink). The board is 128 × 128 with eight palette entries.
- `draw` emits `mpoo_board` version `1.0.0` logs containing x/y/color/artist/written_at_ns. There is no board revision, canonical snapshot, past-state query or NFT interface.
- `shared/types.ts` exposes latest-pixel attribution; `shared/palette.ts` and `shared/board.json` describe today's palette. Historical reconstruction must never substitute a future palette.
- The repository has no implemented indexer/database/history service or prints contract. Existing logs are useful inputs, not an independently verified archive.

Choose a history activation block on a verified deployment; do not assume a live deployment exists. Record chain genesis identity, board account, deployed code hash, schema, block hash and palette bytes in a signed baseline manifest. Fetch every `get_pixels` page and metadata against that **same finalized block hash**, using an archival provider when required. Check page continuity, total, unique coordinates, bounds and attribution. Retrying against a newer block requires restarting the baseline, not mixing pages.

History coverage begins at this baseline unless complete earlier execution data can be obtained and verified. Do not invent earlier writers or market an incomplete archive as history since launch. A fresh deployment can start from its empty initialized state. Baseline prints represent end-of-block state.

The contract agent owns schema migration: explicitly deserialize schema-2 state, preserve its iterable map prefix and all latest records, then add `board_epoch`, `revision: u64` and event schema metadata. Migration is authorized, one-time and tested against serialized old state. Never call `new` over old state. Set revision 0 to the baseline; subsequent successful placements increment exactly once, checked for overflow. Coordinate activation so the baseline precedes the first version-2 event with no missing writes. If this cannot be demonstrated, keep minting disabled.

## Event protocol and indexing

Proposed event `mpoo_board/2.0.0/draw`, following the NEAR event envelope:

- `board_epoch`, `revision`, `x`, `y`, `color`, `artist`, `written_at_ns`, `palette_version`.
- Revision and nanoseconds are decimal strings, not JavaScript floating-point numbers.
- Economy fields `cost_toilet`, `pricing_version` and `action_nonce` bind the paid action but do not change the historical pixel result. Use `pricing_version` consistently with the board quote interface.
- Emit only after all synchronous placement checks and state mutation succeed. Only a successful execution outcome is indexable; a log from a failed receipt is not a write.
- Batch placement, if later introduced, gets one revision per pixel in explicit batch order; publish that rule before enabling batching.

Indexer agent owns `services/history/**` and database migrations. Start with PostgreSQL and one ordered ingestion worker per board. Use a finalized execution-data source; archive receipt outcomes and block ancestry rather than depending on browser polling. Provider/library selection must be pinned and tested with actual network fixtures.

1. Verify network identity, block hash/ancestry, receiving contract and successful execution outcome before accepting an event. Ignore look-alike logs emitted by another account.
2. Persist raw receipt/log evidence and normalized events. Unique ingestion identity is `(chain, block_hash, receipt_id, log_index, data_index)`; unique state identity is `(board, epoch, revision)`.
3. Check revisions are contiguous after the baseline. Duplicate identical events are no-ops; conflicting duplicates halt certification. Never sort by transaction hash or timestamp to infer execution order.
4. Within legacy version-1 coverage, use the provider's documented execution ordering and verify reconstructed state against block-pinned contract reads. If ordering is unavailable, do not certify intermediate legacy states; use directly read end-of-block snapshots only.
5. Atomically commit events, materialized current pixels and the ingestion cursor in one database transaction. After a crash, resume from the last committed cursor and replay safely.
6. Store periodic full checkpoints (initial proposal every 1,000 revisions) and reconstruct any covered revision from the nearest checkpoint plus ordered events. Checkpoint interval is operational configuration, not an identity field.
7. Do not infer missing blocks from height arithmetic alone: validate ancestry and source coverage. Missing data pauses advancement and certification, while existing covered history stays browsable.

Never certify optimistic/head-only data. A provider inconsistency affecting a supposedly finalized checkpoint pauses new certifications and triggers independent provider reconciliation. Rebuild unpublished projections from the last verified checkpoint; preserve published attestations and issue a visible incident record rather than rewriting minted history. The web response includes `indexed_final_height`, `indexed_revision`, `observed_final_height`, `coverage_start` and `status` (`healthy`, `lagging`, `gap`, `halted`).

## Canonical state and content identity

A renderer-generated PNG is presentation, not the source of truth. Implement a dependency-light encoder in `shared/history/**` with Rust/TypeScript golden fixtures. All integers below are unsigned big-endian; strings are UTF-8 preceded by a u32 byte length; hashes are 32 raw SHA-256 bytes. Reject unexpected fields/ranges, duplicate palette indices and invalid UTF-8 before encoding.

Canonical board-state bytes, version 1, in this exact order:

1. ASCII domain `MPOO_STATE_V1` followed by zero byte.
2. Chain genesis hash; board account string; board epoch string; width u32; height u32.
3. Palette version string; palette count u16; ascending entries of index u16, name string, R/G/B u8; empty display R/G/B/A u8.
4. Exactly width × height cells, row-major (`y * width + x`). Each is presence u8. Absent: 0 and no more bytes. Present: 1, color index u16, artist string, written-at nanoseconds u64.

`state_hash = SHA256(state_bytes)`. The unpainted appearance is frozen in the baseline manifest (initial proposal transparent RGBA 0,0,0,0); contract absence remains distinct from white or Ink. Names, attribution and palette are covered by the hash. UI themes and grid lines never alter canonical bytes.

Canonical snapshot bytes: domain `MPOO_SNAPSHOT_V1\0`, state hash, finalized block hash, block height u64, block timestamp nanoseconds u64, revision u64, receipt ID string (empty only for baseline/end-of-block legacy snapshot). `snapshot_id = SHA256(snapshot_bytes)` in lowercase hex. For an intermediate revision, apply events only through that revision even if later events share its block. Store its log/data index alongside its receipt evidence. The certified block timestamp is the bounty capture time; baseline snapshots use their baseline block time. Baseline/end-of-block snapshots must never masquerade as intermediate execution snapshots.

Canonical print identity bytes: domain `MPOO_PRINT_V1\0`, snapshot hash, crop x/y/width/height u32. `print_id = SHA256(identity_bytes)` in lowercase hex. Crop origin is top-left, dimensions positive, endpoints exclusive and entirely inside the board. Whole-board selection normalizes to `(0,0,board_width,board_height)`. Do not include titles, URLs, selected UI time, requester or renderer version in identity. Requests resolving to the same snapshot and crop share one identity. Identical-looking pixels at different actual revisions remain distinct historical moments; disclose this limitation of scarcity.

Version-1 edition proposal: `print_id` identifies the canonical artwork, not an exclusive token. Each artwork has an immutable public series (proposed cap 100) and separate bounty series (one collector edition per funded bounty). Each mint gets a unique token ID `{print_id}:{series_id}:{edition_number}`. Public editions start at 1 and allocate atomically; retries keep the same number. `series_id` is `public-v1` or `bounty-` followed by lowercase SHA256 hex of the domain `MPOO_BOUNTY_SERIES_V1\0`, chain genesis hash, length-prefixed escrow account string, and bounty ID u64. This uses the canonical integer/string encoding above, so series IDs cannot collide through ambiguous concatenation. Caps are frozen when the series is created and shown before signing. Public minting can never consume a bounty collector entitlement. All series and their caps must be discoverable; never advertise overall scarcity using only the public cap. A different NFT contract can copy the image; canonical editions are scoped to the published registry/contract. The cap of 100 is a proposed configurable launch choice, not a confirmed user decision.

## Authenticity and durable availability

Initial trust model: a named **trusted snapshot attester**, not a trustless state proof. The indexer reconstructs history; an independently run verification job checks state and evidence; the authorized attester registers the manifest on-chain only after verification and storage checks. A content hash proves byte integrity, not that those bytes were ever the board. The UI and NFT metadata must say “history attested by [account]” and link to the registered evidence.

Use an authenticated attester-account call to the registry rather than inventing a browser signature scheme. Registry entry binds snapshot ID, state hash, board/chain/epoch, dimensions, block hash/height/timestamp, revision, immutable manifest URI/hash and attester ID. The registry-to-escrow reference includes those same identity/time/bounds fields so escrow validates the capture window and exact bounty crop without trusting browser metadata. Attester rotation is separately authorized and logged; old records retain the original attester. Exact duplicate registration succeeds idempotently; conflicting data is rejected. No arbitrary user can register a canonical snapshot. More decentralized attestations or on-chain state roots are a separately reviewed upgrade.

Before certification, persist canonical bytes, manifest, original-size RGBA raster/PNG, attribution data and replay evidence references in content-addressed storage plus an independently operated replica. Test retrieval and hash verification from both; pinning one IPFS CID alone is not a retention policy. Keep a recoverable object-store backup and a documented retention owner/budget. A temporary gateway failure changes availability status, not historical identity. Never silently replace metadata/media bytes at an existing URI.

Freeze renderer version, nearest-neighbour scaling, empty-pixel treatment and palette in the manifest. Archive source data so another implementation can regenerate the raster even when PNG compression bytes differ. NFT metadata references the fixed PNG using media hash and the complete manifest using reference hash. Use the NEAR NFT core, metadata and mint-event standards. Ownership is collectible-token ownership; attribution is historical placement credit, not an assertion of legal authorship/copyright transfer.

## Print contract and recovery protocol

Contract agent owns `contracts/prints/**`; keep snapshot registry and NFT issuance together initially so duplicate prevention and mint are local atomic mutations. Bounty escrow is a separate caller with explicitly registered permissions. No secondary marketplace, royalties or automatic artist splits in this slice.

Required methods (wire amounts/IDs as strings):

- `register_snapshot(manifest)` — attester only; stores immutable identity and content commitments.
- `publish_snapshot_reference(snapshot_id, bounty_contract)` — dispatch immutable registry reference to an allowlisted escrow `register_snapshot_reference`; retry idempotently. Escrow authenticates registry predecessor; failed delivery does not remove registry entry.
- `mint_print(snapshot_id, crop, recipient, operation_id)` — wallet-authorized chosen mint; recompute identity, allocate the next public edition within its cap, validate storage deposit, then mint or return the same prior result.
- `mint_bounty_print(bounty_contract, bounty_id, operation_id)` — query the registered escrow `get_print_entitlement(bounty_id)` asynchronously; private callback authenticates result, accepted eligibility, snapshot/crop and fixed recipient. Mint exactly one bounty-series edition. Whoever retries cannot change the recipient.
- `get_print_operation(caller, operation_id)`, `get_print(print_id)` (artwork plus series), `get_snapshot(snapshot_id)`, standard NFT ownership/read/transfer methods.

An operation ID is scoped to caller and binds immutable arguments; reuse with different arguments fails. Record allocated series/edition, result and NFT ownership atomically; no HTTP response is required to make the mint real. The same operation returns its existing token. A new operation may mint another public edition until its fixed cap is reached. Bounty issuance allows exactly one successful mint per entitled bounty series. MVP public mint fee is storage/gas only; any commercial fee needs a separate approved schedule and accounting spec.

For cross-contract bounty claims, the bounty award creates a durable collector entitlement independently of payout success. The prints contract records `EntitlementQueryPending(operation_id, bounty_contract, bounty_id)` before querying the allowlisted escrow. Its private callback validates the expected attempt, entitlement and registered snapshot, then atomically allocates the bounty token and records `Minted`. No callback can trust browser-provided entitlement data. Query failures become retryable without consuming the edition; an ambiguous operation is resolved by `get_print_operation` and the bounty-series issuance record before retry. A lost client response never creates another token. The original mint recipient remains recorded even if the token is later transferred. Mint service failure cannot block, reverse or release bounty payments. Bounty acceptance/payment policy is owned by the bounty spec; public minting never accesses escrow funds.

Use recoverable pull credits for excess storage-deposit refunds; failed transfers restore credit exactly once. An indexer timeout, wallet closure or missing transaction hash leads to “checking mint”, not a new operation. Users can reopen the operation URL and recover its authoritative status. Never delete a minted record to recover a failed downstream payment.

## HTTP interfaces and journey states

History service exposes bounded endpoints with chain/board/epoch in every response:

| Endpoint | Contract |
|---|---|
| `GET /v1/boards/{board}/history?after_revision=&limit=` | Ordered finalized events; max 500; opaque next cursor, coverage and health. |
| `GET /v1/boards/{board}/moments?at_time_ns=` | Latest covered revision at/before requested time; return resolved exact revision and timestamp. Same-time writes resolve to highest revision; never imply unique time ordering. |
| `GET /v1/boards/{board}/snapshots/{revision}` | Immutable state/manifest or pending/gap; no fabricated fallback to current state. |
| `POST /v1/prints/prepare` | Snapshot + crop → normalized print ID, storage estimate, attestation/availability status, series caps, issued editions and bounty entitlement status. Preparation is not a reservation. |
| `GET /v1/prints/{print_id}` | Canonical artwork manifest/media plus bounded series/edition list. Artwork has no single token owner. |
| `GET /v1/tokens/{encoded_token_id}` | One edition's recorded mint recipient, current owner source/freshness, source bounty and operation reference; token IDs are URL encoded. |

User journey: rewind → see explicit time/revision and coverage → frame crop → preview and attribution → inspect series availability and edition cap → approve wallet mint → pending → confirmed collectible → share. Route `/prints/:print_id` displays the artwork and editions; optional `?token=` selects an exact edition and its owner. A selected preview is pinned as live board changes. Show conflicts before asking to sign when known; handle the race on-chain regardless. Confirmation requires a finalized successful mint plus authoritative token read, not just a transaction identifier.

Art Bounties selects and displays the exact same snapshot/crop/print identity. Its deadline logic must select eligible chain revisions, not an image uploaded by the claimant or the later time an indexer happened to process it.

## Agent boundaries and acceptance gates

- **Board agent B:** schema migration/events only. **Print agent D:** registry/NFT contract. Coordinate shared interfaces through integration owner A; no duplicate agents editing `contracts/board` concurrently.
- **History agent:** ingest, PostgreSQL migrations, checkpoints, reconstruction, storage replication and HTTP APIs. Never holds bounty spending credentials.
- **Shared/integration owner:** encoder, fixtures, interface versions and client bindings. Lock these before parallel implementation.
- **Frontend agent:** history scrubber, crop selection, mint recovery and collectible page; integrate bounty links through shared print identity.
- **Validation agent:** independent adversarial fixtures and testnet journey evidence; no mainnet deployment implied by local tests.

Acceptance: replay duplicate/out-of-order deliveries, crash between fetch/commit, ingestion gaps, failed-receipt logs, fake-contract logs, huge nanoseconds, overwritten pixels, empty-vs-Ink, same-block multiple draws, baseline migration and changed palette. Rust/TypeScript fixtures must produce identical hashes. Rebuild checkpoints from archived events and match block-pinned contract reads. Test two concurrent last-edition mints, whole-board/crop aliases, independent bounty/public series, wrong attester, wrong chain, lost callbacks, repeated operation IDs, failed refunds and storage outage. Demonstrate on testnet: create art → overwrite it → reconstruct earlier revision → mint a numbered crop edition → retrieve both replicas and verify hashes → reopen wallet and recover final token status. Record contracts, code hashes and receipts in evidence; unit tests are not this rehearsal.

Deferred: animated NFTs, mutable edition caps, marketplace, artist payout allocation, trustless history proofs and mystery cards. Browser replay may precede animated NFT exports, using the same covered event stream.

## Primary technical references

- [NEAR Lake data and operation](https://docs.near.org/data-infrastructure/tutorials/running-near-lake/run-lake-indexer): source adapter and archived execution-data layout.
- [NEAR receipt execution model](https://github.com/near/nearcore/blob/master/docs/RuntimeSpec/Receipts.md): asynchronous cross-contract boundaries.
- [NEAR token and event standards](https://nomicon.io/Standards/): resolve/pin NFT core, metadata and events during implementation.
