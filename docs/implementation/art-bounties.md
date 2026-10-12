# Art Bounties: implementation contract

Status: proposed implementation specification, 12 October 2026; not deployed or implemented.
Scope: MPOO-funded commissions for art captured on the shared wall. No mystery cards.

## Baseline and product boundary

Reviewed `contracts/board/src/lib.rs`, `contracts/board/README.md`, `docs/00-shared-decisions.md`, and `docs/2026-10-12-paint-economy-and-swap-plan.md`.
The current board stores current pixels and emits drawing logs. It has no bounty escrow, token receiver, snapshot registry, payout ledger, NFT contract, crew model, or bounty pages.
Preserve the existing MPOO-only paid-paint direction, TOILET painting/earnings, and separate MPOO staking plan.
Bounty deposits are **escrow liabilities**, never paint revenue, staking principal, inventory, or distributable game income.

One sponsor commissions one winning artwork; one accepted submission receives the entire bounty under a previously approved recipient split.
Anyone can paint the specified region. A bounty does not reserve pixels, block overwrites, grant copyright, or guarantee artistic originality.
Payment rewards an accepted immutable historical snapshot, not continued control of today's wall.
Acceptance records one collector-print entitlement for the sponsor, bound to the winning snapshot and crop; capture/mint network and storage costs remain separate.
Redeeming that entitlement is an independent, retriable action after acceptance; mint failure must not reverse or delay earned awards.
V1 has no bounty platform fee, co-funding, milestone awards, governance jury, automatic visual judging, or promised NFT exclusivity.
These are explicit scope choices, not permanent prohibitions.

## User journey and magic moments

1. Visit `/bounties`: browse open commissions by budget, deadline, board region, and brief; funded status comes from escrow state.
2. Sponsor creates a draft at `/bounties/new`, previews exact terms, registers storage, and funds it with MPOO.
3. Detail page `/bounties/:id` shows the locked brief, exact reward, deadlines, submissions, and **Paint this commission** deep link.
4. Artist opens the wall at the crop with an optional reference overlay; progress overlays confer no territory rights.
5. At the right moment, the artist captures finalized history and proposes a contributor payment split.
6. Every recipient approves the exact submission digest. The artist then submits before the deadline.
7. Sponsor chooses a submission during review. **The creation becomes a permanent recorded winner even if the wall changes a second later.**
8. Each recipient sees their MPOO claim independently; sponsor can separately print the winning moment through the print service.
9. If no award is made by expiry, anyone can settle expiry; only the sponsor receives the refund entitlement.

Magic moments: a credible funded rallying point; a shared painting destination; capturing a fleeting masterpiece; contributors seeing their agreed rewards; a collector revisiting the exact winning moment.
Sponsor silence or dissatisfaction can lead to no award. State prominently before artists spend paint; this is a subjective commission, not guaranteed wages.

## Contract boundary, identities, and limits

Deploy a separate `contracts/bounties/` escrow account with a fixed accepted MPOO token and a fixed snapshot-registry authority.
Use predecessor account for all user authorization, not a browser-supplied role or `signer_id` across intermediary contracts.
Store deployment/network identity; production MPOO identity requires fresh transfer/refund verification before funding.
All token amounts and nanosecond timestamps are decimal strings at API boundaries; contract uses checked integers.
IDs are monotonically increasing `u64` strings scoped to `(network, escrow_contract)`, not user labels.
Proposal defaults: maximum 16 payout recipients, 32 proposals per proposer per bounty, and page limit 50. Do not impose a globally exhaustible submission-slot cap: require prepaid storage per entry and bounded pagination, and maintain an O(1) finalized-submission count for expiry. The per-account proposal limit bounds ordinary usage, not multi-wallet attackers.
Bound strings and metadata bytes; charge each creator actual storage through prepaid NEAR storage credit. MPOO is not used for NEAR storage/gas.
Clients show NEAR storage/gas separately from the MPOO award. Insufficient storage rejects before token acceptance.
Limits and time constants are versioned launch configuration; active terms never change when defaults change.

## Terms, clocks, and state machine

`Bounty`: id, sponsor, board_id, crop `{x,y,width,height}`, brief_uri, brief_hash, award_amount, terms_version,
created_at_ns, fund_by_ns, submit_by_ns, review_by_ns, capture_window, status, funded_at_ns, winning_submission_id.
The brief hash binds content; an unavailable external brief is still an availability failure, so mirror and show it before funding.
Crop must be within board bounds and positive size; capture window is `[funded_at_ns, submit_by_ns)`.
Default permitted terms: funding within 7 days of creation; submissions close 1–30 days after `fund_by`; review closes 1–7 days after submissions.
Enforce these bounded intervals on creation using chain time. UI countdowns are informative; transaction execution time decides eligibility.
At every boundary, use `< deadline` for an open interval and `>= deadline` for expiry.

| State | Allowed transition |
| --- | --- |
| `DRAFT` | Sponsor may cancel; exact valid MPOO funding before `fund_by` moves to `ACTIVE`; anyone may expire after `fund_by` |
| `ACTIVE` | Propose, approve, submit before `submit_by`; logically becomes `REVIEW` at `submit_by` |
| `REVIEW` | Sponsor accepts one eligible submission before `review_by`, moving to `AWARDED` |
| `ACTIVE/REVIEW` | Anyone calls expiry at/after `submit_by` if no submissions, or at/after `review_by` otherwise; moves to `EXPIRED` |
| `AWARDED` | Recipient entitlements exist; retries/claims do not change the winner |
| `EXPIRED` | Sponsor refund entitlement exists; retries/claims do not reopen the bounty |
| `CANCELLED` | Unfunded terminal draft only |

`REVIEW` is derived from chain time; a keeper transaction is not required to enter review.
No early award: every artist receives the advertised submission window. No sponsor cancellation or deadline editing after funding.
No-submissions expiry can release funds at submission close. With submissions, the sponsor gets the full review window.
Expired unpublished proposals count as no submissions. Calling expiry twice must never create two entitlements.
Sponsor can simply decline to select a winner; there is no subjective appeal tribunal in v1.

## Immutable submissions and consent

`SubmissionProposal`: id, bounty_id, proposer, snapshot_id, manifest_hash, crop, note_hash,
sorted recipients `[{account_id, share_bps}]`, consent_digest, approved_accounts, state.
Require unique recipients, strictly positive shares, and exactly **10,000 basis points (100%)** in total.
Digest binds network, escrow account, bounty/proposal IDs, immutable snapshot+crop, metadata hashes, exact split, and terms version.
Any change requires a new proposal and fresh approvals. Recipients can revoke approval before final submission, never after it.
All recipients explicitly call approval themselves, including the proposer if they receive a share.
Proposer can finalize only when every recipient has approved and the chain time is before `submit_by`.
Only finalized submissions can win. Once finalized, the snapshot, split, notes, and approvals are immutable.
Any account may propose; pixel attribution alone does not establish authorship or make them entitled to the award.
V1 permits multiple eligible submissions by the same artist within storage/cap limits; duplicate submission fingerprints are rejected. Keep a separate canonical fingerprint over bounty ID, proposer, snapshot/crop, note hash and sorted payout split, excluding proposal/client IDs; consent_digest still binds the actual proposal ID. This prevents repeated identical proposals by one proposer, not copying across identities.

Snapshot dependency: the history service must supply a finalized immutable manifest, including board/network identity, block reference,
capture timestamp, palette, full-state content hash, and archival content address. The submission references that record plus the exact bounty crop.
The fixed registry calls `register_snapshot_reference` on escrow to mirror an immutable record; only its predecessor is authorized.
Registration is idempotent for identical data and rejects different data under an existing ID. This asynchronous preparation must complete before submission.
Escrow verifies matching board, capture window, bounds, and registered manifest hash synchronously during proposal/submission validation. Submission crop must equal the immutable bounty crop exactly; a whole-board snapshot supplies the data, but a smaller attractive subcrop cannot substitute for the commissioned region. Use the registered finalized block timestamp as capture time, not ingestion time or the timestamp of the last painted pixel.
Registry authority is an explicit trust anchor; a content hash alone does not prove that pixels existed on NEAR.
No UI claim of trustless reconstruction until registry evidence and independent replay verification meet the history specification.

## Proposed methods

| Method | Rule/result |
| --- | --- |
| `create_bounty(terms, client_nonce)` | Sponsor authenticated; reserve storage; repeat nonce returns existing id only for identical payload |
| `cancel_draft(bounty_id)` | Sponsor only, unfunded draft only |
| `ft_on_transfer(sender_id, amount, msg)` | Only configured MPOO predecessor; `msg={version:1,action:"fund_bounty",bounty_id}`; sender must be sponsor |
| `register_snapshot_reference(record)` | Fixed registry predecessor only; append immutable manifest reference |
| `propose_submission(bounty_id, snapshot_id, crop, note_hash, recipients, client_nonce)` | Validate bounds, window, caps, storage; return immutable proposal id/digest |
| `approve_submission(proposal_id, expected_digest)` | Recipient predecessor approves exact digest before submission close |
| `revoke_approval(proposal_id)` | Recipient only; proposal not finalized |
| `submit(proposal_id, expected_digest)` | Proposer only; all approvals present; pre-deadline; finalize once |
| `accept_submission(bounty_id, submission_id)` | Sponsor only; review window; atomically consume escrow liability and create recipient claims |
| `expire_bounty(bounty_id)` | Permissionless; enforce state/time; create sponsor refund once |
| `claim(claim_id)` | Beneficiary predecessor only; fixed beneficiary destination; create pending transfer attempt |
| `on_claim_result(claim_id, attempt_id)` | Private callback; matching pending attempt only; settle or restore |
| `get_bounty`, `get_submission`, `get_claim`, `list_bounties`, `list_submissions`, `list_claims` | Bounded cursor reads; include state/time and deployment identity |
| `get_print_entitlement(bounty_id)` | After award: immutable sponsor, winning manifest/crop and globally scoped bounty entitlement key; print service enforces one redemption |

Use a shared `storage_deposit` pattern and bounded cleanup for unpublished drafts/proposals; never delete history needed to prove awards or pending claims.
Funding accepts exactly the requested integer amount once; wrong token, sender, amount, time, duplicate funding, or unsupported message returns the entire unused amount through FT resolution.
No partial funding and no tips. Confirm actual deployed MPOO transfer/refund semantics; a token with unexpected receiver deductions fails the launch gate.
Accepted funding returns zero unused amount and records the liability in the same receiver execution.

## Settlement and failure recovery

Award creation is local escrow accounting plus the immutable print entitlement; it does not call recipients or mint NFTs.
`mint_bounty_print(bounty_contract, bounty_id, operation_id)` in the fixed print service queries escrow's `get_print_entitlement` and validates its result in a private callback.
Print service uses the globally scoped entitlement key for exactly-one bounty-series redemption; a browser assertion is insufficient.
The independent public print series may also depict the same artwork; the bounty edition grants neither exclusive reproduction nor copyright.
Escrow keeps the entitlement immutable rather than consuming it across contracts; duplicate mint attempts are rejected/deduplicated by the print contract.
For the ordered recipient list, allocate `floor(award * share_bps / 10000)` to each; assign the remaining dust to the final sorted recipient.
Reject a proposal if any final allocated amount is zero. Display these exact amounts before consent, including the rounding rule. Checked arithmetic and the sum invariant are mandatory.
Each claim has `{id,bounty_id,beneficiary,amount,kind, status:AVAILABLE|PENDING|PAID, attempt_id}`.
Claim moves AVAILABLE to PENDING before `ft_transfer`; successful authenticated callback marks PAID.
Failed transfer restores AVAILABLE; recipient can register on the token and retry. Other recipients are unaffected.
Duplicate/stale callbacks cannot alter a newer attempt. Never retry a PENDING transfer based solely on an elapsed browser timer.
If a callback cannot execute, retain PENDING. Proposed recovery: `resolve_stalled_claim(claim_id, attempt_id, verdict, evidence_hash, evidence_uri)` is restricted to a separately configured recovery multisig. Store the outbound promise/receipt correlation in claim events; two independent receipt readers must agree on final token-transfer success (mark PAID) or final transfer failure (restore AVAILABLE). Evidence binds chain, token account, beneficiary, amount and attempt; archive both reads. Unknown/missing outcomes cannot be resolved or restored. The contract checks authority, matching pending attempt and verdict but does not cryptographically verify those external receipts: this is an explicit trusted recovery power, disclosed before funding. Duplicate resolution is idempotent; a late normal callback cannot settle again. Escrow agent owns this method and QA must exercise it; choose actual multisig/operators before deployment. No timeout-only balance restoration or discretionary destination change.
Contract operations must reserve enough callback gas and NEAR for FT transfer deposits; new work pauses before consuming that reserve.
Invariant: accepted MPOO funding equals unawarded escrow + available claims + in-flight claims + completed outgoing payments.
Actual held MPOO plus confirmed in-flight outgoing value must cover all unpaid liabilities; unrelated token holder receipts are tracked separately.
No admin sweep of liabilities. A pause blocks new funding/submissions if necessary, but leaves safe expiry and claim recovery available.
Disclose deployment upgrade authority; “locked terms” are an application guarantee unless contract upgrade powers are also constrained.

## Events, tests, and delivery allocation

Versioned `mpoo_bounties` events: `created`, `funded`, `draft_cancelled`, `snapshot_registered`, `proposal_created`,
`consent_changed`, `submitted`, `awarded`, `expired`, `claim_started`, `claim_paid`, `claim_failed`.
Include entity IDs, caller, chain timestamp, amount strings when relevant, hashes and attempt IDs; indexers use final receipts and deduplicate receipt/event positions.

Acceptance tests: forged token/registry calls; wrong sponsor; exact amounts/refunds; every deadline edge; late registry delivery;
duplicate funding/nonces; stale/revoked consent; split sum/duplicates/rounding; wrong board/crop/capture window; maximum payloads;
accept-versus-expire ordering; double award/refund; failed/duplicate/stale callbacks; insufficient token storage; unavailable snapshot bytes;
pause with outstanding claims; asset/liability reconciliation; reload during funding/submission/claim; no print mint blocking payout.
End-to-end rehearsal: sponsor funds, two recipients approve, artist submits a finalized capture, sponsor accepts, one payout fails then recovers,
collector separately mints; repeat with sponsor silence and permissionless expiry. Local mocks do not establish token or wallet behavior.

| Agent | Owned delivery | Dependency |
| --- | --- | --- |
| Coordinator | Shared API/types, terms decision register, integration gates | Freeze registry interface and launch constants first |
| Escrow agent | `contracts/bounties/**`, unit and sandbox tests | MPOO fixture and registry interface |
| History/print agent | Finalized snapshot registry, immutable archival evidence, independent mint service | Board events/replay contract |
| Bounty UI agent | Bounty routes, editor, detail, proposals/consents, review and claims | Shared types plus clearly labelled mock adapter initially |
| Integration/security agent | Adversarial test harness, wallet recovery, token sandbox, liability checks | Complete escrow/history contracts |

Missing components to schedule explicitly: route/navigation support, bounty discovery/detail/create pages, crop deep links and template overlay,
immutable brief hosting, consent and payout screens, expiry controls, escrow contract, storage UX, history registry, archive availability monitor,
separate print minting, indexing/query API, operational funding/alerts, and the multi-wallet testnet rehearsal.
Agent outputs remain proposals until integration tests and the funding/recovery journey pass. Mainnet launch is a separate reviewed deployment decision.
