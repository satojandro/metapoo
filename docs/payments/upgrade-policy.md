# Contract upgrades: proposed MVP policy

2026-10-28. Guidance for approval before deployment, not an implemented upgrade system.

## Code versus saved data

NEAR can replace contract code on the same account while retaining stored data.
A full-access key can authorize deployment; alternatively the existing contract can
implement an authorized self-upgrade. Removing all deployment keys without a working
self-upgrade route can make that account's contract effectively immutable.

A code replacement does not automatically translate saved data. A migration is code
that reads the old layout and writes the new one while preserving balances and pixels.
Never run `new` over existing state. The schema-4 paid board is a fresh deployment,
not a migration of schema 2. A schema version number alone does not implement migration.

## Current source, checked 2026-10-28

`contracts/paid-board/src/lib.rs` stores schema, payments and pixel collections.
`payments.rs` stores owner, token, prices and a non-iterable `LookupMap` of balances.
It has owner-only price changes and, since 2026-10-28, an owner-only `upgrade()` self-deploy, but **no
migration, pause, ownership transfer, timelock or multisig enforcement**. Whether deployment is possible will
depend on the keys/control model selected for the eventual contract account.
The pricing owner is not automatically the account's deployment-key holder.

The credit map cannot enumerate every user. Before the first paid deployment,
choose and test how future migrations will discover/preserve all balances: retain
compatible storage prefixes/layout, introduce a versioned lazy migration, or add an
account registry with bounded migration batches. Events alone are not a complete
replacement for recoverable state. Account for extra storage/gas in the cost checklist.

## Classify each change

| Change | Expected process |
|---|---|
| Text, layout, NEARLY link | Frontend release; no contract upgrade |
| NEAR/mPOO prices | Existing owner-only configuration call; no redeployment; preserve credits |
| New read method / compatible logic fix | Code upgrade with old-state compatibility tests |
| New stored fields, changed map values/prefixes or accounting | Explicit versioned migration; adding a Rust field can break deserialization |
| Staking, rewards, shop, bounties | Prefer separately bounded contracts where useful; specify cross-contract failure handling and liabilities |

## Recommended launch posture

Keep an explicit, disclosed upgrade path while the MVP evolves. Choose who controls
it before deployment. Prefer multisig-controlled upgrades for public paid use;
a single protected deployment key is simpler for a bounded rehearsal but remains
an explicit trust assumption. A contract timelock does not constrain a retained
full-access key that can bypass it; the account's actual keys must match the policy.

Separate pricing authority from upgrade authority where practical. Do not silently
remove the recovery route. Document admin powers so users know the rules can change.
Adding governance, pause controls or new authority requires a concrete design/review;
this document does not add them to the contract.

## Checklist for every upgrade

- [ ] Classify state compatibility; identify source/target schema and supported paths.
- [ ] Capture old WASM, exact build inputs, code hash, account keys and state evidence.
- [ ] Test with old serialized state: zero/nonzero balances, long IDs, near-full board,
  active sessions, partially completed cross-contract flows and relevant liabilities.
- [ ] Prove no reset, loss, inflation, double spend or repeat-migration effect; reject
  unauthorized migration and wrong source versions. Bound gas/storage by batch.
- [ ] Rehearse deployment plus migration on testnet. Use an atomic same-account
  deploy-and-migrate batch where feasible and verified; large migrations require
  an explicit staged protocol with compatibility while old/new records coexist.
- [ ] Handle in-flight token callbacks. Hiding the UI alone does not stop direct calls;
  add/test contract-level controls if a migration needs a quiet period.
- [ ] Review independently; obtain human release approval; record the transaction.
- [ ] Verify code/state/schema, representative balances/pixels, config, receipts and
  frontend/session compatibility after deployment. Same-account redeployment does
  not itself revoke access keys; check their methods, allowance and authorization.
- [ ] Re-run affected mainnet cost cases and keep liabilities/storage reserves funded.

Rollback is not simply deploying the old code: once state has changed, old code may
not read it. Plan a compatible rollback or forward repair. Never restore an old
snapshot over newer legitimate user payments/writes.

Learning references: [NEAR update/migration examples](https://github.com/near-examples/update-migrate-rust),
[NEAR access-control and upgrade plugins](https://github.com/near/near-plugins).
