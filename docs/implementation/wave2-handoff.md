# Wave 2 handoff log

Date: 13 October 2026. Staffing: coordinator (A) + workers C / D / G.

Wave 1 review fixes committed as `0184d1c` (local; push when ready). Outcome columns: **implemented** | **fixture-tested** | **live-verified**.

## Goal

Wire one vertical slice of joins (not a substitute for missing domains):

| Join | Meaning |
|---|---|
| T2.BC | Board v2 events → history ingest |
| T2.CD | Encoded snapshot → registry |
| T2.DE | Registry reference → escrow eligibility |
| T2.EG | Escrow ↔ bounty UI (gated funding) |
| T2.EDH | Award entitlement → independent print mint |
| T2.Fops | Shared wallet/ops recovery (mostly Wave 0/1) |

## Status

| Task | Owner | Status | Outcome |
|---|---|---|---|
| T1.C history service (fixture ingest) | [C](75763b75-751b-4370-a458-2c8c7da58010) | **Done** | implemented ✓ · fixture-tested ✓ (19) · live-verified N/A |
| T1.D1/D2 registry + prints | [D](27e028b9-fe2e-442d-bd23-20dba0bf6fba) | **Done** | implemented ✓ · fixture-tested ✓ (16) · live-verified N/A |

### Worker D notes (T2.CD / T2.DE / T2.EDH)

- Package: `contracts/prints/**` (near-sdk 5.29.1). Board/bounties crates untouched and still green.
- Methods: `register_snapshot`, `publish_snapshot_reference`, `mint_print`, `mint_bounty_print` / `on_print_entitlement`.
- **Open joins for Worker E:** point escrow `registry` at real prints account; sandbox `publish_snapshot_reference` ↔ `register_snapshot_reference` with storage deposit; live entitlement callback; allowlist bootstrap + genesis hash for bounty series ids.
- **T2.CD shape test still open:** register from `services/history/fixtures/manifest-for-worker-d.json` (C handoff) — not yet wired into prints unit tests.
| T1.G live bounty adapters (funding gated) | [G](1c8e7a12-1d01-4e68-a13a-a471dd49324c) | **Done** | implemented ✓ · fixture-tested ✓ (163 web) · live-verified ✗ |

### Worker G notes (T2.EG)

- Default: fixture demo (`Demo data — no funds or NFTs`).
- Live views: set `VITE_BOUNTY_CONTRACT_ID`; funding CTA needs `VITE_BOUNTY_FUNDING_ENABLED=true` (default false).
- No wallet broadcast of fund txs from G; confirm-only when unlocked.

### Worker C notes (T2.BC / T2.CD)

- Package: `services/history/**` — fixture ingest only (NEAR Lake not wired).
- Handoff for D: `services/history/fixtures/manifest-for-worker-d.json` (rev 5 snapshot + state/snapshot hex + overwrite pair).
- Tests: `cd services/history && npm test`

## Prerequisites already landed

- Paid board schema 3 + pressure (fixture-tested)
- Escrow with claim `ft_transfer` + storage metering (fixture-tested)
- Schema-3 paid wall FunctionCall shape test (fixture-tested)
- Canonical hash encoding goldens (raw 32-byte genesis/block hashes)

## Rules

Report implemented / fixture-tested / live-verified separately. No mainnet. Prefer one cross-component shape test per join. Funding UI stays gated until live FT sandbox.

## Wave 2 review fixes (13 Oct 2026)

| Pri | Finding | Fix |
|---|---|---|
| P1 | Bounty mint storage paid by contract | `mint_bounty_print` reserves deposit; callback settles mint storage then refunds |
| P1 | Halted history still certifies manifests | `snapshot` → `halted`; `buildManifestForWorkerD` throws |
| P2 | Failed storage refunds inaccessible | `on_storage_refund` → `pull_credits`; `withdraw_pull_credit` |
| P2 | Incomplete NFT interface | `nft_token` / `nft_metadata` / `nft_transfer_call`; custom view as `get_print_edition` |
| P2 | Live lists stop at 50 | Walk `next_from_index`; expose `truncated` / `nextFromIndex` |

### Follow-up review (same day)

| Pri | Finding | Fix |
|---|---|---|
| P2 | Malformed entitlement panic rolled back failure+refund | Decode via `match`; return after fail+refund |
| P2 | Truncated empty search → false NO_MATCHES | Keep `ok`+`truncated`; browse/detail show partial + Load more |
| P2 | Load more final NO_MATCHES treated as failure | Clear cursor/partial; keep accumulated; show complete empty |
| P2 | `nft_resolve_transfer` false after onward move | Return `true` when not restored; transfer-call cases covered |

Still open: T2.CD shape test against C’s manifest fixture; E sandbox joins (T2.DE / T2.EDH).
