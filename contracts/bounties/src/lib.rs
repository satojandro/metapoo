//! Meta Poo art-bounty escrow contract.
//!
//! Bounty MPOO deposits are **escrow liabilities**, never paint revenue.
//! This crate is Wave 1 unit-testable logic. `claim` schedules a real
//! `ft_transfer` Promise on the configured MPOO token, then settles via a
//! private callback that reads `env::promise_result(0)`. No mainnet deploy.
//!
//! Mock token / registry account ids used in tests are clearly labelled
//! `*.mock.test.near`.

mod digest;
mod split;

use digest::{compute_consent_digest, proposal_fingerprint};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue, PromiseResult,
};
use split::{
    allocate_award_amounts, sort_recipients, RecipientShare, MAX_RECIPIENTS, SHARE_BPS_TOTAL,
};

/// Nanoseconds in one day.
const NS_PER_DAY: u64 = 86_400_000_000_000;
const MAX_FUND_WINDOW_NS: u64 = 7 * NS_PER_DAY;
const MIN_SUBMIT_AFTER_FUND_NS: u64 = NS_PER_DAY;
const MAX_SUBMIT_AFTER_FUND_NS: u64 = 30 * NS_PER_DAY;
const MIN_REVIEW_AFTER_SUBMIT_NS: u64 = NS_PER_DAY;
const MAX_REVIEW_AFTER_SUBMIT_NS: u64 = 7 * NS_PER_DAY;

const BOARD_WIDTH: u32 = 128;
const BOARD_HEIGHT: u32 = 128;
const MAX_PROPOSALS_PER_PROPOSER: u32 = 32;
const MAX_PAGE: u32 = 50;
const MAX_BRIEF_URI_LEN: usize = 512;
const MAX_HASH_LEN: usize = 128;
const MAX_NOTE_HASH_LEN: usize = 128;
const MAX_SNAPSHOT_ID_LEN: usize = 128;
const EVENT_STANDARD: &str = "mpoo_bounties";
const EVENT_VERSION: &str = "1.0.0";

/// 1 yoctoNEAR required by NEP-141 `ft_transfer`.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Gas for the outbound MPOO `ft_transfer`.
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(30);
/// Gas reserved for the private claim settlement callback.
const GAS_FOR_CLAIM_CALLBACK: Gas = Gas::from_tgas(15);

/// Labelled mock FT account used when unset in unit tests / local scaffolding.
pub const MOCK_MPOO_TOKEN: &str = "mpoo.token.mock.test.near";
/// Labelled mock snapshot-registry authority.
pub const MOCK_REGISTRY: &str = "snapshot.registry.mock.test.near";

/// Minimal NEP-141 surface used for claim payouts.
#[ext_contract(ext_mpoo_ft)]
pub trait ExtMpooFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Bounties,
    Proposals,
    Claims,
    Snapshots,
    CreateNonces,
    ProposalNonces,
    Fingerprints,
    BountyProposalIndex,
    BountyClaimIndex,
    PrintEntitlements,
    FinalizedCounts,
    ProposerCounts,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BountyTermsInput {
    pub board_id: String,
    pub crop: CropRect,
    pub brief_uri: String,
    pub brief_hash: String,
    /// Decimal string integer amount (yocto-MPOO).
    pub award_amount: String,
    pub terms_version: String,
    pub fund_by_ns: String,
    pub submit_by_ns: String,
    pub review_by_ns: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PayoutRecipientInput {
    pub account_id: AccountId,
    pub share_bps: u16,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BoardIdentityInput {
    pub chain_id: String,
    pub board_account_id: String,
    pub board_epoch: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SnapshotReferenceInput {
    pub snapshot_id: String,
    pub manifest_hash: String,
    pub board: BoardIdentityInput,
    pub width: u32,
    pub height: u32,
    pub finalized_block_hash: String,
    pub finalized_block_height: String,
    pub finalized_block_timestamp_ns: String,
    pub revision: String,
    pub crop_bounds_valid: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredBountyStatus {
    Draft,
    Active,
    Awarded,
    Expired,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProposalState {
    Open,
    Finalized,
    Withdrawn,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimKind {
    Award,
    Refund,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimStatus {
    Available,
    Pending,
    Paid,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Bounty {
    id: u64,
    sponsor: AccountId,
    board_id: String,
    crop: CropRect,
    brief_uri: String,
    brief_hash: String,
    award_amount: u128,
    terms_version: String,
    created_at_ns: u64,
    fund_by_ns: u64,
    submit_by_ns: u64,
    review_by_ns: u64,
    status: StoredBountyStatus,
    funded_at_ns: Option<u64>,
    winning_submission_id: Option<u64>,
    escrow_held: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Proposal {
    id: u64,
    bounty_id: u64,
    proposer: AccountId,
    snapshot_id: String,
    manifest_hash: String,
    crop: CropRect,
    note_hash: String,
    recipients: Vec<RecipientShareStored>,
    consent_digest: String,
    approved_accounts: Vec<AccountId>,
    state: ProposalState,
    created_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct RecipientShareStored {
    account_id: AccountId,
    share_bps: u16,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Claim {
    id: u64,
    bounty_id: u64,
    beneficiary: AccountId,
    amount: u128,
    kind: ClaimKind,
    status: ClaimStatus,
    attempt_id: Option<u64>,
    next_attempt: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct SnapshotRef {
    snapshot_id: String,
    manifest_hash: String,
    board_id_key: String,
    width: u32,
    height: u32,
    finalized_block_timestamp_ns: u64,
    revision: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct PrintEntitlement {
    bounty_id: u64,
    sponsor: AccountId,
    snapshot_id: String,
    manifest_hash: String,
    crop: CropRect,
    entitlement_key: String,
}

#[near(serializers = [json])]
pub struct BountyView {
    pub id: String,
    pub network_id: String,
    pub escrow_account_id: String,
    pub sponsor: String,
    pub board_id: String,
    pub crop: CropRect,
    pub brief_uri: String,
    pub brief_hash: String,
    pub award_amount: String,
    pub terms_version: String,
    pub created_at_ns: String,
    pub fund_by_ns: String,
    pub submit_by_ns: String,
    pub review_by_ns: String,
    pub status: String,
    pub funded_at_ns: Option<String>,
    pub winning_submission_id: Option<String>,
    pub escrow_held: String,
}

#[near(serializers = [json])]
pub struct SubmissionView {
    pub id: String,
    pub bounty_id: String,
    pub proposer: String,
    pub snapshot_id: String,
    pub manifest_hash: String,
    pub crop: CropRect,
    pub note_hash: String,
    pub recipients: Vec<PayoutRecipientView>,
    pub consent_digest: String,
    pub approved_accounts: Vec<String>,
    pub state: String,
    pub created_at_ns: String,
}

#[near(serializers = [json])]
pub struct PayoutRecipientView {
    pub account_id: String,
    pub share_bps: u16,
}

#[near(serializers = [json])]
pub struct ClaimView {
    pub id: String,
    pub bounty_id: String,
    pub beneficiary: String,
    pub amount: String,
    pub kind: String,
    pub status: String,
    pub attempt_id: Option<String>,
}

#[near(serializers = [json])]
pub struct PrintEntitlementView {
    pub bounty_id: String,
    pub sponsor: String,
    pub snapshot_id: String,
    pub manifest_hash: String,
    pub crop: CropRect,
    pub entitlement_key: String,
}

#[near(serializers = [json])]
pub struct ListPage<T> {
    pub items: Vec<T>,
    pub from_index: u32,
    pub limit: u32,
    pub total: u32,
    pub next_from_index: Option<u32>,
}

#[near(serializers = [json])]
pub struct ProposeResult {
    pub proposal_id: String,
    pub consent_digest: String,
}

/// On-chain escrow state.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bounties {
    network_id: String,
    /// Production MPOO identity requires fresh verification before funding.
    /// Tests use [`MOCK_MPOO_TOKEN`].
    mpoo_token: AccountId,
    /// Fixed snapshot-registry authority. Tests use [`MOCK_REGISTRY`].
    registry: AccountId,
    next_bounty_id: u64,
    next_proposal_id: u64,
    next_claim_id: u64,
    bounties: IterableMap<u64, Bounty>,
    proposals: IterableMap<u64, Proposal>,
    claims: IterableMap<u64, Claim>,
    snapshots: IterableMap<String, SnapshotRef>,
    create_nonces: LookupMap<String, u64>,
    proposal_nonces: LookupMap<String, u64>,
    fingerprints: LookupMap<String, u64>,
    bounty_proposal_ids: IterableMap<u64, Vec<u64>>,
    bounty_claim_ids: IterableMap<u64, Vec<u64>>,
    print_entitlements: LookupMap<u64, PrintEntitlement>,
    finalized_counts: LookupMap<u64, u32>,
    proposer_counts: LookupMap<String, u32>,
}

#[near]
impl Bounties {
    #[init]
    pub fn new(network_id: String, mpoo_token: AccountId, registry: AccountId) -> Self {
        require!(!network_id.is_empty(), "CONFIG: network_id required");
        Self {
            network_id,
            mpoo_token,
            registry,
            next_bounty_id: 1,
            next_proposal_id: 1,
            next_claim_id: 1,
            bounties: IterableMap::new(StorageKey::Bounties),
            proposals: IterableMap::new(StorageKey::Proposals),
            claims: IterableMap::new(StorageKey::Claims),
            snapshots: IterableMap::new(StorageKey::Snapshots),
            create_nonces: LookupMap::new(StorageKey::CreateNonces),
            proposal_nonces: LookupMap::new(StorageKey::ProposalNonces),
            fingerprints: LookupMap::new(StorageKey::Fingerprints),
            bounty_proposal_ids: IterableMap::new(StorageKey::BountyProposalIndex),
            bounty_claim_ids: IterableMap::new(StorageKey::BountyClaimIndex),
            print_entitlements: LookupMap::new(StorageKey::PrintEntitlements),
            finalized_counts: LookupMap::new(StorageKey::FinalizedCounts),
            proposer_counts: LookupMap::new(StorageKey::ProposerCounts),
        }
    }

    /// Create a draft bounty. Repeat nonce returns existing id only for identical payload.
    /// Caller must attach NEAR covering new storage bytes (`env::storage_byte_cost()` × growth);
    /// excess deposit is refunded to the predecessor.
    #[payable]
    pub fn create_bounty(&mut self, terms: BountyTermsInput, client_nonce: String) -> String {
        let storage_before = env::storage_usage();
        let sponsor = env::predecessor_account_id();
        let now = env::block_timestamp();
        let nonce_key = format!("create:{}:{}", sponsor, client_nonce);

        let award_amount = parse_u128(&terms.award_amount, "AWARD_AMOUNT");
        let fund_by_ns = parse_u64(&terms.fund_by_ns, "FUND_BY");
        let submit_by_ns = parse_u64(&terms.submit_by_ns, "SUBMIT_BY");
        let review_by_ns = parse_u64(&terms.review_by_ns, "REVIEW_BY");

        if let Some(&existing_id) = self.create_nonces.get(&nonce_key) {
            let existing = self
                .bounties
                .get(&existing_id)
                .unwrap_or_else(|| reject("NOT_FOUND", "nonce bounty missing"));
            require!(
                terms_match(&existing, &terms, award_amount, fund_by_ns, submit_by_ns, review_by_ns),
                "NONCE_CONFLICT: payload differs from first create"
            );
            // Idempotent path: no storage growth; refund any attached deposit.
            self.settle_storage_deposit(storage_before);
            return existing_id.to_string();
        }

        validate_terms(
            &terms,
            award_amount,
            fund_by_ns,
            submit_by_ns,
            review_by_ns,
            now,
        );

        let id = self.next_bounty_id;
        self.next_bounty_id = id.saturating_add(1);

        let bounty = Bounty {
            id,
            sponsor: sponsor.clone(),
            board_id: terms.board_id.clone(),
            crop: terms.crop.clone(),
            brief_uri: terms.brief_uri.clone(),
            brief_hash: terms.brief_hash.clone(),
            award_amount,
            terms_version: terms.terms_version.clone(),
            created_at_ns: now,
            fund_by_ns,
            submit_by_ns,
            review_by_ns,
            status: StoredBountyStatus::Draft,
            funded_at_ns: None,
            winning_submission_id: None,
            escrow_held: 0,
        };
        self.bounties.insert(id, bounty);
        self.create_nonces.insert(nonce_key, id);
        self.bounty_proposal_ids.insert(id, Vec::new());
        self.bounty_claim_ids.insert(id, Vec::new());
        self.finalized_counts.insert(id, 0);

        emit_event(
            "created",
            &format!(
                "{{\"bounty_id\":\"{id}\",\"sponsor\":\"{sponsor}\",\"award_amount\":\"{}\",\"created_at_ns\":\"{now}\"}}",
                terms.award_amount
            ),
        );

        self.settle_storage_deposit(storage_before);
        id.to_string()
    }

    pub fn cancel_draft(&mut self, bounty_id: String) {
        let id = parse_u64(&bounty_id, "BOUNTY_ID");
        let sponsor = env::predecessor_account_id();
        let bounty = self
            .bounties
            .get_mut(&id)
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
        require!(
            bounty.sponsor == sponsor,
            "UNAUTHORIZED: only sponsor may cancel draft"
        );
        require!(
            bounty.status == StoredBountyStatus::Draft && bounty.escrow_held == 0,
            "STATE: cancel only unfunded draft"
        );
        bounty.status = StoredBountyStatus::Cancelled;
        emit_event(
            "draft_cancelled",
            &format!("{{\"bounty_id\":\"{id}\",\"sponsor\":\"{sponsor}\"}}"),
        );
    }

    /// NEP-141 receiver. Only configured MPOO predecessor; exact amount; sponsor only.
    /// Unused amount is returned (full refund on validation failure).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let predecessor = env::predecessor_account_id();
        if predecessor != self.mpoo_token {
            // Wrong token: refund entire amount.
            return PromiseOrValue::Value(amount);
        }

        match validate_fund_message(&msg) {
            Err(_) => PromiseOrValue::Value(amount),
            Ok(bounty_id) => match self.try_fund_bounty(bounty_id, &sender_id, amount.0) {
                Ok(()) => PromiseOrValue::Value(U128(0)),
                Err(_) => PromiseOrValue::Value(amount),
            },
        }
    }

    /// Registry-only snapshot registration. New records require attached NEAR for storage growth.
    #[payable]
    pub fn register_snapshot_reference(&mut self, record: SnapshotReferenceInput) {
        let storage_before = env::storage_usage();
        let caller = env::predecessor_account_id();
        require!(
            caller == self.registry,
            "UNAUTHORIZED: registry predecessor only"
        );
        require!(record.crop_bounds_valid, "SNAPSHOT: crop_bounds_valid must be true");
        require!(
            !record.snapshot_id.is_empty() && record.snapshot_id.len() <= MAX_SNAPSHOT_ID_LEN,
            "SNAPSHOT: bad snapshot_id"
        );
        let ts = parse_u64(
            &record.finalized_block_timestamp_ns,
            "SNAPSHOT_TS",
        );
        let board_id_key = format!(
            "{}:{}:{}",
            record.board.chain_id, record.board.board_account_id, record.board.board_epoch
        );
        let next = SnapshotRef {
            snapshot_id: record.snapshot_id.clone(),
            manifest_hash: record.manifest_hash.clone(),
            board_id_key,
            width: record.width,
            height: record.height,
            finalized_block_timestamp_ns: ts,
            revision: record.revision.clone(),
        };
        if let Some(existing) = self.snapshots.get(&record.snapshot_id).cloned() {
            require!(
                existing.manifest_hash == next.manifest_hash
                    && existing.board_id_key == next.board_id_key
                    && existing.width == next.width
                    && existing.height == next.height
                    && existing.finalized_block_timestamp_ns == next.finalized_block_timestamp_ns
                    && existing.revision == next.revision,
                "SNAPSHOT: conflicting data under existing id"
            );
            self.settle_storage_deposit(storage_before);
            return;
        }
        self.snapshots.insert(record.snapshot_id.clone(), next);
        emit_event(
            "snapshot_registered",
            &format!(
                "{{\"snapshot_id\":\"{}\",\"manifest_hash\":\"{}\"}}",
                record.snapshot_id, record.manifest_hash
            ),
        );
        self.settle_storage_deposit(storage_before);
    }

    /// Propose a submission. New proposals require attached NEAR for storage growth.
    #[payable]
    pub fn propose_submission(
        &mut self,
        bounty_id: String,
        snapshot_id: String,
        crop: CropRect,
        note_hash: String,
        recipients: Vec<PayoutRecipientInput>,
        client_nonce: String,
    ) -> ProposeResult {
        let storage_before = env::storage_usage();
        let proposer = env::predecessor_account_id();
        let now = env::block_timestamp();
        let bid = parse_u64(&bounty_id, "BOUNTY_ID");

        let nonce_key = format!("propose:{}:{}:{}", bid, proposer, client_nonce);
        if let Some(&existing_id) = self.proposal_nonces.get(&nonce_key) {
            let consent_digest = self
                .proposals
                .get(&existing_id)
                .unwrap_or_else(|| reject("NOT_FOUND", "nonce proposal missing"))
                .consent_digest
                .clone();
            self.settle_storage_deposit(storage_before);
            return ProposeResult {
                proposal_id: existing_id.to_string(),
                consent_digest,
            };
        }

        let bounty = self
            .bounties
            .get(&bid)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
        require!(
            matches!(
                bounty.status,
                StoredBountyStatus::Active | StoredBountyStatus::Draft
            ) && bounty.funded_at_ns.is_some(),
            "STATE: bounty not active"
        );
        // Submissions only while ACTIVE window: now < submit_by
        require!(now < bounty.submit_by_ns, "DEADLINE: submit window closed");
        require!(
            crop == bounty.crop,
            "CROP_MISMATCH: submission crop must equal bounty crop exactly"
        );

        let snap = self
            .snapshots
            .get(&snapshot_id)
            .cloned()
            .unwrap_or_else(|| reject("SNAPSHOT", "not registered"));
        require!(
            snap.manifest_hash.len() > 0 && snap.manifest_hash.len() <= MAX_HASH_LEN,
            "SNAPSHOT: bad manifest"
        );
        // Capture window [funded_at_ns, submit_by_ns)
        let funded_at = bounty.funded_at_ns.unwrap();
        require!(
            snap.finalized_block_timestamp_ns >= funded_at
                && snap.finalized_block_timestamp_ns < bounty.submit_by_ns,
            "SNAPSHOT: capture outside window"
        );
        require!(
            note_hash.len() > 0 && note_hash.len() <= MAX_NOTE_HASH_LEN,
            "NOTE_HASH: invalid"
        );

        let shares = recipients_from_input(&recipients);
        let sorted = sort_recipients(&shares);
        // Validate split + non-zero allocations against award.
        if let Err(err) = allocate_award_amounts(bounty.award_amount, &sorted) {
            reject(err.code(), err.message());
        }

        let count_key = format!("{}:{}", bid, proposer);
        let count = self.proposer_counts.get(&count_key).copied().unwrap_or(0);
        require!(
            count < MAX_PROPOSALS_PER_PROPOSER,
            "CAP: max proposals per proposer"
        );

        let fp = proposal_fingerprint(
            bid,
            proposer.as_str(),
            &snapshot_id,
            &crop,
            &note_hash,
            &sorted,
        );
        if self.fingerprints.get(&fp).is_some() {
            reject("DUPLICATE_PROPOSAL", "identical fingerprint exists");
        }

        let pid = self.next_proposal_id;
        self.next_proposal_id = pid.saturating_add(1);
        let escrow = env::current_account_id();
        let digest = compute_consent_digest(
            &self.network_id,
            escrow.as_str(),
            bid,
            pid,
            &snapshot_id,
            &snap.manifest_hash,
            &crop,
            &note_hash,
            &sorted,
            &bounty.terms_version,
        );

        let stored_recipients: Vec<RecipientShareStored> = sorted
            .iter()
            .map(|r| RecipientShareStored {
                account_id: r.account_id.clone(),
                share_bps: r.share_bps,
            })
            .collect();

        let proposal = Proposal {
            id: pid,
            bounty_id: bid,
            proposer: proposer.clone(),
            snapshot_id: snapshot_id.clone(),
            manifest_hash: snap.manifest_hash.clone(),
            crop: crop.clone(),
            note_hash: note_hash.clone(),
            recipients: stored_recipients,
            consent_digest: digest.clone(),
            approved_accounts: Vec::new(),
            state: ProposalState::Open,
            created_at_ns: now,
        };
        self.proposals.insert(pid, proposal);
        self.proposal_nonces.insert(nonce_key, pid);
        self.fingerprints.insert(fp, pid);
        self.proposer_counts.insert(count_key, count + 1);
        if let Some(list) = self.bounty_proposal_ids.get_mut(&bid) {
            list.push(pid);
        }

        emit_event(
            "proposal_created",
            &format!(
                "{{\"proposal_id\":\"{pid}\",\"bounty_id\":\"{bid}\",\"proposer\":\"{proposer}\",\"consent_digest\":\"{digest}\"}}"
            ),
        );

        self.settle_storage_deposit(storage_before);
        ProposeResult {
            proposal_id: pid.to_string(),
            consent_digest: digest,
        }
    }

    pub fn approve_submission(&mut self, proposal_id: String, expected_digest: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let pid = parse_u64(&proposal_id, "PROPOSAL_ID");
        let proposal = self
            .proposals
            .get_mut(&pid)
            .unwrap_or_else(|| reject("NOT_FOUND", "proposal"));
        require!(
            proposal.state == ProposalState::Open,
            "STATE: proposal not open"
        );
        let bounty = self
            .bounties
            .get(&proposal.bounty_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
        require!(now < bounty.submit_by_ns, "DEADLINE: submit window closed");
        require!(
            proposal.consent_digest == expected_digest,
            "CONSENT_DIGEST_MISMATCH"
        );
        let is_recipient = proposal
            .recipients
            .iter()
            .any(|r| r.account_id == caller);
        require!(is_recipient, "UNAUTHORIZED: not a recipient");
        if !proposal.approved_accounts.iter().any(|a| a == &caller) {
            proposal.approved_accounts.push(caller.clone());
        }
        emit_event(
            "consent_changed",
            &format!(
                "{{\"proposal_id\":\"{pid}\",\"account\":\"{caller}\",\"action\":\"approve\"}}"
            ),
        );
    }

    pub fn revoke_approval(&mut self, proposal_id: String) {
        let caller = env::predecessor_account_id();
        let pid = parse_u64(&proposal_id, "PROPOSAL_ID");
        let proposal = self
            .proposals
            .get_mut(&pid)
            .unwrap_or_else(|| reject("NOT_FOUND", "proposal"));
        require!(
            proposal.state == ProposalState::Open,
            "STATE: proposal not open"
        );
        proposal.approved_accounts.retain(|a| a != &caller);
        emit_event(
            "consent_changed",
            &format!(
                "{{\"proposal_id\":\"{pid}\",\"account\":\"{caller}\",\"action\":\"revoke\"}}"
            ),
        );
    }

    pub fn submit(&mut self, proposal_id: String, expected_digest: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let pid = parse_u64(&proposal_id, "PROPOSAL_ID");
        let proposal = self
            .proposals
            .get_mut(&pid)
            .unwrap_or_else(|| reject("NOT_FOUND", "proposal"));
        require!(
            proposal.proposer == caller,
            "UNAUTHORIZED: only proposer may submit"
        );
        require!(
            proposal.state == ProposalState::Open,
            "STATE: proposal not open"
        );
        require!(
            proposal.consent_digest == expected_digest,
            "CONSENT_DIGEST_MISMATCH"
        );
        let bounty = self
            .bounties
            .get(&proposal.bounty_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
        require!(now < bounty.submit_by_ns, "DEADLINE: submit window closed");

        for r in &proposal.recipients {
            require!(
                proposal
                    .approved_accounts
                    .iter()
                    .any(|a| a == &r.account_id),
                "CONSENT: missing recipient approval"
            );
        }

        proposal.state = ProposalState::Finalized;
        let bid = proposal.bounty_id;
        let count = self.finalized_counts.get(&bid).copied().unwrap_or(0);
        self.finalized_counts.insert(bid, count + 1);

        emit_event(
            "submitted",
            &format!("{{\"proposal_id\":\"{pid}\",\"bounty_id\":\"{bid}\"}}"),
        );
    }

    /// Sponsor accepts one finalized submission during review. No early award before submit_by.
    pub fn accept_submission(&mut self, bounty_id: String, submission_id: String) {
        let sponsor = env::predecessor_account_id();
        let now = env::block_timestamp();
        let bid = parse_u64(&bounty_id, "BOUNTY_ID");
        let sid = parse_u64(&submission_id, "SUBMISSION_ID");

        let bounty = self
            .bounties
            .get(&bid)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
        require!(bounty.sponsor == sponsor, "UNAUTHORIZED: sponsor only");
        require!(
            bounty.status == StoredBountyStatus::Active && bounty.escrow_held > 0,
            "STATE: bounty not awardable"
        );
        // No early award: require now >= submit_by and now < review_by
        require!(now >= bounty.submit_by_ns, "DEADLINE: review not open yet");
        require!(now < bounty.review_by_ns, "DEADLINE: review window closed");

        let proposal = self
            .proposals
            .get(&sid)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "submission"));
        require!(proposal.bounty_id == bid, "STATE: submission wrong bounty");
        require!(
            proposal.state == ProposalState::Finalized,
            "STATE: only finalized submissions win"
        );
        require!(
            proposal.crop == bounty.crop,
            "CROP_MISMATCH: winning crop must match bounty"
        );

        let shares: Vec<RecipientShare> = proposal
            .recipients
            .iter()
            .map(|r| RecipientShare {
                account_id: r.account_id.clone(),
                share_bps: r.share_bps,
            })
            .collect();
        let allocated = allocate_award_amounts(bounty.award_amount, &shares)
            .unwrap_or_else(|e| reject(e.code(), e.message()));

        // Atomically consume escrow and create claims + print entitlement.
        {
            let bounty_mut = self
                .bounties
                .get_mut(&bid)
                .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
            require!(
                bounty_mut.status == StoredBountyStatus::Active,
                "STATE: already settled"
            );
            require!(
                bounty_mut.escrow_held == bounty_mut.award_amount,
                "INVARIANT: escrow mismatch"
            );
            bounty_mut.escrow_held = 0;
            bounty_mut.status = StoredBountyStatus::Awarded;
            bounty_mut.winning_submission_id = Some(sid);
        }

        let escrow_acct = env::current_account_id();
        let entitlement_key = format!("{}:{}:{}", self.network_id, escrow_acct, bid);
        self.print_entitlements.insert(
            bid,
            PrintEntitlement {
                bounty_id: bid,
                sponsor: bounty.sponsor.clone(),
                snapshot_id: proposal.snapshot_id.clone(),
                manifest_hash: proposal.manifest_hash.clone(),
                crop: proposal.crop.clone(),
                entitlement_key: entitlement_key.clone(),
            },
        );

        for alloc in allocated {
            self.create_claim(bid, alloc.account_id, alloc.amount, ClaimKind::Award);
        }

        emit_event(
            "awarded",
            &format!(
                "{{\"bounty_id\":\"{bid}\",\"submission_id\":\"{sid}\",\"entitlement_key\":\"{entitlement_key}\"}}"
            ),
        );
    }

    /// Permissionless expiry. Sponsor silence → refund entitlement once.
    pub fn expire_bounty(&mut self, bounty_id: String) {
        let now = env::block_timestamp();
        let bid = parse_u64(&bounty_id, "BOUNTY_ID");
        let bounty = self
            .bounties
            .get(&bid)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));

        match bounty.status {
            StoredBountyStatus::Draft => {
                require!(now >= bounty.fund_by_ns, "DEADLINE: fund window still open");
                require!(bounty.escrow_held == 0, "STATE: funded draft cannot expire this path");
                let b = self.bounties.get_mut(&bid).unwrap();
                require!(
                    b.status == StoredBountyStatus::Draft,
                    "STATE: already settled"
                );
                b.status = StoredBountyStatus::Cancelled;
                emit_event(
                    "expired",
                    &format!("{{\"bounty_id\":\"{bid}\",\"kind\":\"unfunded_draft\"}}"),
                );
            }
            StoredBountyStatus::Active => {
                let finalized = self.finalized_counts.get(&bid).copied().unwrap_or(0);
                if finalized == 0 {
                    require!(
                        now >= bounty.submit_by_ns,
                        "DEADLINE: submit window still open"
                    );
                } else {
                    require!(
                        now >= bounty.review_by_ns,
                        "DEADLINE: review window still open"
                    );
                }
                let amount = bounty.escrow_held;
                require!(amount > 0, "STATE: nothing to refund");
                let sponsor = bounty.sponsor.clone();
                {
                    let b = self.bounties.get_mut(&bid).unwrap();
                    require!(
                        b.status == StoredBountyStatus::Active,
                        "STATE: already settled"
                    );
                    b.escrow_held = 0;
                    b.status = StoredBountyStatus::Expired;
                }
                self.create_claim(bid, sponsor, amount, ClaimKind::Refund);
                emit_event(
                    "expired",
                    &format!(
                        "{{\"bounty_id\":\"{bid}\",\"kind\":\"refund\",\"amount\":\"{amount}\"}}"
                    ),
                );
            }
            StoredBountyStatus::Awarded
            | StoredBountyStatus::Expired
            | StoredBountyStatus::Cancelled => {
                reject("STATE", "bounty already terminal");
            }
        }
    }

    /// Beneficiary claims payout. Marks AVAILABLE → PENDING, then schedules
    /// `ft_transfer` on `self.mpoo_token` with a private settlement callback.
    pub fn claim(&mut self, claim_id: String) -> Promise {
        let caller = env::predecessor_account_id();
        let cid = parse_u64(&claim_id, "CLAIM_ID");
        let claim = self
            .claims
            .get_mut(&cid)
            .unwrap_or_else(|| reject("NOT_FOUND", "claim"));
        require!(
            claim.beneficiary == caller,
            "UNAUTHORIZED: beneficiary only"
        );
        require!(
            claim.status == ClaimStatus::Available,
            "STATE: claim not available"
        );
        let attempt = claim.next_attempt;
        let amount = claim.amount;
        let beneficiary = claim.beneficiary.clone();
        claim.next_attempt = attempt.saturating_add(1);
        claim.attempt_id = Some(attempt);
        claim.status = ClaimStatus::Pending;

        emit_event(
            "claim_started",
            &format!(
                "{{\"claim_id\":\"{cid}\",\"attempt_id\":\"{attempt}\",\"amount\":\"{amount}\",\"ft\":\"{}\"}}",
                self.mpoo_token
            ),
        );

        ext_mpoo_ft::ext(self.mpoo_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(
                beneficiary,
                U128(amount),
                Some(format!("mpoo_bounty_claim:{cid}:{attempt}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CLAIM_CALLBACK)
                    .on_claim_ft_result(cid.to_string(), attempt.to_string()),
            )
    }

    /// Private callback after claim `ft_transfer`. Success is derived from
    /// `env::promise_result(0)` — Successful → PAID, otherwise restore AVAILABLE.
    #[private]
    pub fn on_claim_ft_result(&mut self, claim_id: String, attempt_id: String) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "UNAUTHORIZED: private callback only"
        );
        // `promise_result` remains the settlement signal for this callback; unit tests
        // inject Successful/Failed via testing_env promise_results.
        #[allow(deprecated)]
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        // Production path always settles via promise_result above.
        // `settle_claim_attempt` is the shared helper used by this callback.
        self.settle_claim_attempt(
            parse_u64(&claim_id, "CLAIM_ID"),
            parse_u64(&attempt_id, "ATTEMPT_ID"),
            success,
        );
    }

    // --- Views ---

    pub fn get_bounty(&self, bounty_id: String) -> BountyView {
        let id = parse_u64(&bounty_id, "BOUNTY_ID");
        let bounty = self
            .bounties
            .get(&id)
            .unwrap_or_else(|| reject("NOT_FOUND", "bounty"));
        self.bounty_to_view(bounty)
    }

    pub fn get_submission(&self, proposal_id: String) -> SubmissionView {
        let id = parse_u64(&proposal_id, "PROPOSAL_ID");
        let p = self
            .proposals
            .get(&id)
            .unwrap_or_else(|| reject("NOT_FOUND", "proposal"));
        self.proposal_to_view(p)
    }

    pub fn get_claim(&self, claim_id: String) -> ClaimView {
        let id = parse_u64(&claim_id, "CLAIM_ID");
        let c = self
            .claims
            .get(&id)
            .unwrap_or_else(|| reject("NOT_FOUND", "claim"));
        claim_to_view(c)
    }

    pub fn get_print_entitlement(&self, bounty_id: String) -> PrintEntitlementView {
        let id = parse_u64(&bounty_id, "BOUNTY_ID");
        let e = self
            .print_entitlements
            .get(&id)
            .unwrap_or_else(|| reject("NOT_FOUND", "print entitlement"));
        PrintEntitlementView {
            bounty_id: e.bounty_id.to_string(),
            sponsor: e.sponsor.to_string(),
            snapshot_id: e.snapshot_id.clone(),
            manifest_hash: e.manifest_hash.clone(),
            crop: e.crop.clone(),
            entitlement_key: e.entitlement_key.clone(),
        }
    }

    pub fn list_bounties(&self, from_index: u32, limit: u32) -> ListPage<BountyView> {
        let limit = limit.min(MAX_PAGE);
        let total = self.bounties.len() as u32;
        let items: Vec<BountyView> = self
            .bounties
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(_, b)| self.bounty_to_view(b))
            .collect();
        page(items, from_index, limit, total)
    }

    pub fn list_submissions(
        &self,
        bounty_id: String,
        from_index: u32,
        limit: u32,
    ) -> ListPage<SubmissionView> {
        let bid = parse_u64(&bounty_id, "BOUNTY_ID");
        let limit = limit.min(MAX_PAGE);
        let ids = self
            .bounty_proposal_ids
            .get(&bid)
            .cloned()
            .unwrap_or_default();
        let total = ids.len() as u32;
        let items: Vec<SubmissionView> = ids
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .filter_map(|pid| self.proposals.get(pid).map(|p| self.proposal_to_view(p)))
            .collect();
        page(items, from_index, limit, total)
    }

    pub fn list_claims(
        &self,
        bounty_id: String,
        from_index: u32,
        limit: u32,
    ) -> ListPage<ClaimView> {
        let bid = parse_u64(&bounty_id, "BOUNTY_ID");
        let limit = limit.min(MAX_PAGE);
        let ids = self.bounty_claim_ids.get(&bid).cloned().unwrap_or_default();
        let total = ids.len() as u32;
        let items: Vec<ClaimView> = ids
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .filter_map(|cid| self.claims.get(cid).map(claim_to_view))
            .collect();
        page(items, from_index, limit, total)
    }

    pub fn get_deployment_identity(&self) -> DeploymentIdentity {
        DeploymentIdentity {
            network_id: self.network_id.clone(),
            escrow_account_id: env::current_account_id().to_string(),
            mpoo_token: self.mpoo_token.to_string(),
            registry: self.registry.to_string(),
            board_width: BOARD_WIDTH,
            board_height: BOARD_HEIGHT,
        }
    }
}

#[near(serializers = [json])]
pub struct DeploymentIdentity {
    pub network_id: String,
    pub escrow_account_id: String,
    pub mpoo_token: String,
    pub registry: String,
    pub board_width: u32,
    pub board_height: u32,
}

impl Bounties {
    /// Flush dirty `store` collections so `env::storage_usage()` reflects writes.
    fn flush_storage(&mut self) {
        self.bounties.flush();
        self.proposals.flush();
        self.claims.flush();
        self.snapshots.flush();
        self.create_nonces.flush();
        self.proposal_nonces.flush();
        self.fingerprints.flush();
        self.bounty_proposal_ids.flush();
        self.bounty_claim_ids.flush();
        self.print_entitlements.flush();
        self.finalized_counts.flush();
        self.proposer_counts.flush();
    }

    /// Require attached deposit ≥ `storage_byte_cost * bytes_used` since `storage_before`.
    /// Refunds any excess NEAR to the predecessor. Panics (rolling back the tx) if short.
    fn settle_storage_deposit(&mut self, storage_before: u64) {
        self.flush_storage();
        let bytes_used = env::storage_usage().saturating_sub(storage_before);
        let required = env::storage_byte_cost().saturating_mul(u128::from(bytes_used));
        let attached = env::attached_deposit();
        require!(
            attached.as_yoctonear() >= required.as_yoctonear(),
            "STORAGE: attached deposit does not cover storage growth"
        );
        let refund = attached.as_yoctonear() - required.as_yoctonear();
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
    }

    /// Shared claim settlement used by `on_claim_ft_result` (production: promise_result).
    fn settle_claim_attempt(&mut self, claim_id: u64, attempt: u64, success: bool) {
        let claim = self
            .claims
            .get_mut(&claim_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "claim"));
        require!(
            claim.status == ClaimStatus::Pending,
            "STATE: claim not pending"
        );
        require!(
            claim.attempt_id == Some(attempt),
            "STATE: stale or mismatched attempt"
        );
        if success {
            claim.status = ClaimStatus::Paid;
            emit_event(
                "claim_paid",
                &format!("{{\"claim_id\":\"{claim_id}\",\"attempt_id\":\"{attempt}\"}}"),
            );
        } else {
            claim.status = ClaimStatus::Available;
            claim.attempt_id = None;
            emit_event(
                "claim_failed",
                &format!("{{\"claim_id\":\"{claim_id}\",\"attempt_id\":\"{attempt}\"}}"),
            );
        }
    }

    fn try_fund_bounty(
        &mut self,
        bounty_id: u64,
        sender: &AccountId,
        amount: u128,
    ) -> Result<(), &'static str> {
        let now = env::block_timestamp();
        let bounty = self.bounties.get_mut(&bounty_id).ok_or("NOT_FOUND")?;
        if bounty.status != StoredBountyStatus::Draft {
            return Err("STATE");
        }
        if &bounty.sponsor != sender {
            return Err("UNAUTHORIZED");
        }
        if now >= bounty.fund_by_ns {
            return Err("DEADLINE");
        }
        if amount != bounty.award_amount {
            return Err("AMOUNT");
        }
        if bounty.escrow_held != 0 {
            return Err("ALREADY_FUNDED");
        }
        bounty.escrow_held = amount;
        bounty.funded_at_ns = Some(now);
        bounty.status = StoredBountyStatus::Active;
        emit_event(
            "funded",
            &format!(
                "{{\"bounty_id\":\"{bounty_id}\",\"sponsor\":\"{sender}\",\"amount\":\"{amount}\",\"funded_at_ns\":\"{now}\"}}"
            ),
        );
        Ok(())
    }

    fn create_claim(
        &mut self,
        bounty_id: u64,
        beneficiary: AccountId,
        amount: u128,
        kind: ClaimKind,
    ) {
        let id = self.next_claim_id;
        self.next_claim_id = id.saturating_add(1);
        self.claims.insert(
            id,
            Claim {
                id,
                bounty_id,
                beneficiary,
                amount,
                kind,
                status: ClaimStatus::Available,
                attempt_id: None,
                next_attempt: 1,
            },
        );
        if let Some(list) = self.bounty_claim_ids.get_mut(&bounty_id) {
            list.push(id);
        }
    }

    fn effective_status(&self, bounty: &Bounty) -> String {
        let now = env::block_timestamp();
        match bounty.status {
            StoredBountyStatus::Draft => "DRAFT".into(),
            StoredBountyStatus::Awarded => "AWARDED".into(),
            StoredBountyStatus::Expired => "EXPIRED".into(),
            StoredBountyStatus::Cancelled => "CANCELLED".into(),
            StoredBountyStatus::Active => {
                // REVIEW is derived from chain time; no keeper tx required.
                if now >= bounty.submit_by_ns {
                    "REVIEW".into()
                } else {
                    "ACTIVE".into()
                }
            }
        }
    }

    fn bounty_to_view(&self, bounty: &Bounty) -> BountyView {
        BountyView {
            id: bounty.id.to_string(),
            network_id: self.network_id.clone(),
            escrow_account_id: env::current_account_id().to_string(),
            sponsor: bounty.sponsor.to_string(),
            board_id: bounty.board_id.clone(),
            crop: bounty.crop.clone(),
            brief_uri: bounty.brief_uri.clone(),
            brief_hash: bounty.brief_hash.clone(),
            award_amount: bounty.award_amount.to_string(),
            terms_version: bounty.terms_version.clone(),
            created_at_ns: bounty.created_at_ns.to_string(),
            fund_by_ns: bounty.fund_by_ns.to_string(),
            submit_by_ns: bounty.submit_by_ns.to_string(),
            review_by_ns: bounty.review_by_ns.to_string(),
            status: self.effective_status(bounty),
            funded_at_ns: bounty.funded_at_ns.map(|t| t.to_string()),
            winning_submission_id: bounty.winning_submission_id.map(|i| i.to_string()),
            escrow_held: bounty.escrow_held.to_string(),
        }
    }

    fn proposal_to_view(&self, p: &Proposal) -> SubmissionView {
        SubmissionView {
            id: p.id.to_string(),
            bounty_id: p.bounty_id.to_string(),
            proposer: p.proposer.to_string(),
            snapshot_id: p.snapshot_id.clone(),
            manifest_hash: p.manifest_hash.clone(),
            crop: p.crop.clone(),
            note_hash: p.note_hash.clone(),
            recipients: p
                .recipients
                .iter()
                .map(|r| PayoutRecipientView {
                    account_id: r.account_id.to_string(),
                    share_bps: r.share_bps,
                })
                .collect(),
            consent_digest: p.consent_digest.clone(),
            approved_accounts: p.approved_accounts.iter().map(|a| a.to_string()).collect(),
            state: match p.state {
                ProposalState::Open => "OPEN".into(),
                ProposalState::Finalized => "FINALIZED".into(),
                ProposalState::Withdrawn => "WITHDRAWN".into(),
            },
            created_at_ns: p.created_at_ns.to_string(),
        }
    }
}

fn claim_to_view(c: &Claim) -> ClaimView {
    ClaimView {
        id: c.id.to_string(),
        bounty_id: c.bounty_id.to_string(),
        beneficiary: c.beneficiary.to_string(),
        amount: c.amount.to_string(),
        kind: match c.kind {
            ClaimKind::Award => "AWARD".into(),
            ClaimKind::Refund => "REFUND".into(),
        },
        status: match c.status {
            ClaimStatus::Available => "AVAILABLE".into(),
            ClaimStatus::Pending => "PENDING".into(),
            ClaimStatus::Paid => "PAID".into(),
        },
        attempt_id: c.attempt_id.map(|a| a.to_string()),
    }
}

fn page<T>(items: Vec<T>, from_index: u32, limit: u32, total: u32) -> ListPage<T> {
    let consumed = from_index.saturating_add(items.len() as u32);
    let next_from_index = if consumed < total {
        Some(consumed)
    } else {
        None
    };
    ListPage {
        items,
        from_index,
        limit,
        total,
        next_from_index,
    }
}

fn recipients_from_input(input: &[PayoutRecipientInput]) -> Vec<RecipientShare> {
    require!(
        !input.is_empty() && input.len() <= MAX_RECIPIENTS,
        "SPLIT_INVALID: recipient count"
    );
    input
        .iter()
        .map(|r| {
            require!(r.share_bps > 0, "SPLIT_INVALID: non-positive share");
            RecipientShare {
                account_id: r.account_id.clone(),
                share_bps: r.share_bps,
            }
        })
        .collect()
}

fn validate_terms(
    terms: &BountyTermsInput,
    award_amount: u128,
    fund_by_ns: u64,
    submit_by_ns: u64,
    review_by_ns: u64,
    now: u64,
) {
    require!(award_amount > 0, "AWARD_AMOUNT: must be positive");
    require!(
        !terms.board_id.is_empty(),
        "BOARD_ID: required"
    );
    require!(
        terms.brief_uri.len() > 0 && terms.brief_uri.len() <= MAX_BRIEF_URI_LEN,
        "BRIEF_URI: invalid"
    );
    require!(
        terms.brief_hash.len() > 0 && terms.brief_hash.len() <= MAX_HASH_LEN,
        "BRIEF_HASH: invalid"
    );
    require!(!terms.terms_version.is_empty(), "TERMS_VERSION: required");
    validate_crop(&terms.crop);

    require!(fund_by_ns > now, "DEADLINE: fund_by must be future");
    require!(
        fund_by_ns - now <= MAX_FUND_WINDOW_NS,
        "DEADLINE: fund window exceeds 7 days"
    );
    require!(submit_by_ns > fund_by_ns, "DEADLINE: submit_by after fund_by");
    let submit_gap = submit_by_ns - fund_by_ns;
    require!(
        submit_gap >= MIN_SUBMIT_AFTER_FUND_NS && submit_gap <= MAX_SUBMIT_AFTER_FUND_NS,
        "DEADLINE: submit window must be 1–30 days after fund_by"
    );
    require!(review_by_ns > submit_by_ns, "DEADLINE: review_by after submit_by");
    let review_gap = review_by_ns - submit_by_ns;
    require!(
        review_gap >= MIN_REVIEW_AFTER_SUBMIT_NS && review_gap <= MAX_REVIEW_AFTER_SUBMIT_NS,
        "DEADLINE: review window must be 1–7 days after submit_by"
    );
}

fn validate_crop(crop: &CropRect) {
    require!(crop.width > 0 && crop.height > 0, "CROP: positive size required");
    require!(
        crop.x.checked_add(crop.width).is_some_and(|r| r <= BOARD_WIDTH)
            && crop.y.checked_add(crop.height).is_some_and(|b| b <= BOARD_HEIGHT),
        "CROP: out of board bounds"
    );
}

fn terms_match(
    existing: &Bounty,
    terms: &BountyTermsInput,
    award_amount: u128,
    fund_by_ns: u64,
    submit_by_ns: u64,
    review_by_ns: u64,
) -> bool {
    existing.board_id == terms.board_id
        && existing.crop == terms.crop
        && existing.brief_uri == terms.brief_uri
        && existing.brief_hash == terms.brief_hash
        && existing.award_amount == award_amount
        && existing.terms_version == terms.terms_version
        && existing.fund_by_ns == fund_by_ns
        && existing.submit_by_ns == submit_by_ns
        && existing.review_by_ns == review_by_ns
}

/// Pure validation used by unit tests for fund message parsing.
/// Expected JSON: `{"version":1,"action":"fund_bounty","bounty_id":"<decimal>"}`.
pub fn validate_fund_message(msg: &str) -> Result<u64, &'static str> {
    let trimmed = msg.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Err("MSG: invalid json");
    }
    let version = json_u32_field(trimmed, "version").ok_or("MSG: missing version")?;
    if version != 1 {
        return Err("MSG: unsupported version");
    }
    let action = json_string_field(trimmed, "action").ok_or("MSG: missing action")?;
    if action != "fund_bounty" {
        return Err("MSG: unsupported action");
    }
    let bounty_id = json_string_field(trimmed, "bounty_id").ok_or("MSG: missing bounty_id")?;
    bounty_id.parse::<u64>().map_err(|_| "MSG: bad bounty_id")
}

fn json_string_field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let pattern = format!("\"{key}\"");
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];
    let colon = after_key.find(':')?;
    let mut rest = after_key[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    rest = &rest[1..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn json_u32_field(json: &str, key: &str) -> Option<u32> {
    let pattern = format!("\"{key}\"");
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    num.parse().ok()
}

/// Pure funding validation for unit tests (no storage mutation).
pub fn validate_fund_attempt(
    status_is_draft: bool,
    sponsor: &str,
    sender: &str,
    now_ns: u64,
    fund_by_ns: u64,
    amount: u128,
    award_amount: u128,
    already_funded: bool,
) -> Result<(), &'static str> {
    if !status_is_draft {
        return Err("STATE");
    }
    if sponsor != sender {
        return Err("UNAUTHORIZED");
    }
    if now_ns >= fund_by_ns {
        return Err("DEADLINE");
    }
    if amount != award_amount {
        return Err("AMOUNT");
    }
    if already_funded {
        return Err("ALREADY_FUNDED");
    }
    Ok(())
}

fn parse_u64(s: &str, label: &str) -> u64 {
    s.parse::<u64>()
        .unwrap_or_else(|_| reject("PARSE", &format!("{label} must be decimal u64")))
}

fn parse_u128(s: &str, label: &str) -> u128 {
    s.parse::<u128>()
        .unwrap_or_else(|_| reject("PARSE", &format!("{label} must be decimal u128")))
}

fn emit_event(event: &str, data_object: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{data_object}]}}"
    ));
}

fn reject(code: &str, detail: &str) -> ! {
    env::panic_str(&format!("{code}: {detail}"));
}

// Silence unused SHARE_BPS_TOTAL in lib (used in split module / docs).
#[allow(dead_code)]
const _SHARE_CHECK: u16 = SHARE_BPS_TOTAL;

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    /// Generous NEAR attachment so storage-metered writes succeed; contract refunds excess.
    fn storage_deposit() -> u128 {
        NearToken::from_near(1).as_yoctonear()
    }

    // --- Mock labelled accounts ---
    fn mock_token() -> AccountId {
        MOCK_MPOO_TOKEN.parse().unwrap()
    }
    fn mock_registry() -> AccountId {
        MOCK_REGISTRY.parse().unwrap()
    }
    fn escrow_account() -> AccountId {
        "bounties.escrow.mock.test.near".parse().unwrap()
    }
    fn sponsor() -> AccountId {
        accounts(0)
    }
    fn artist() -> AccountId {
        accounts(1)
    }
    fn alice() -> AccountId {
        accounts(2)
    }
    fn bob() -> AccountId {
        accounts(3)
    }

    fn context_at(predecessor: AccountId, ts: u64, deposit: u128) {
        let ctx = VMContextBuilder::new()
            .current_account_id(escrow_account())
            .predecessor_account_id(predecessor)
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build();
        testing_env!(ctx);
    }

    /// Callback context with mocked `promise_result(0)` (production claim settlement path).
    fn context_with_promise(
        predecessor: AccountId,
        ts: u64,
        promise_result: PromiseResult,
    ) {
        let ctx = VMContextBuilder::new()
            .current_account_id(escrow_account())
            .predecessor_account_id(predecessor)
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            HashMap::default(),
            vec![promise_result],
        );
    }

    fn setup() -> Bounties {
        context_at(sponsor(), 1_000, 0);
        Bounties::new("testnet".into(), mock_token(), mock_registry())
    }

    fn day(n: u64) -> u64 {
        n * NS_PER_DAY
    }

    fn sample_terms(now: u64, award: &str) -> BountyTermsInput {
        BountyTermsInput {
            board_id: "board.mpoo.testnet:epoch-1".into(),
            crop: CropRect {
                x: 16,
                y: 16,
                width: 32,
                height: 32,
            },
            brief_uri: "ipfs://bafy-demo-brief".into(),
            brief_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .into(),
            award_amount: award.into(),
            terms_version: "bounty-terms-v1".into(),
            fund_by_ns: (now + day(3)).to_string(),
            submit_by_ns: (now + day(3) + day(7)).to_string(),
            review_by_ns: (now + day(3) + day(7) + day(3)).to_string(),
        }
    }

    fn fund_bounty(contract: &mut Bounties, bounty_id: &str, amount: u128, ts: u64) {
        context_at(mock_token(), ts, 0);
        let msg = format!(
            r#"{{"version":1,"action":"fund_bounty","bounty_id":"{bounty_id}"}}"#
        );
        let unused = contract.ft_on_transfer(sponsor(), U128(amount), msg);
        match unused {
            PromiseOrValue::Value(v) => assert_eq!(v.0, 0, "expected full accept"),
            _ => panic!("unexpected promise"),
        }
    }

    fn register_snap(contract: &mut Bounties, snap_id: &str, capture_ns: u64, hash: &str) {
        context_at(mock_registry(), capture_ns, storage_deposit());
        contract.register_snapshot_reference(SnapshotReferenceInput {
            snapshot_id: snap_id.into(),
            manifest_hash: hash.into(),
            board: BoardIdentityInput {
                chain_id: "testnet".into(),
                board_account_id: "board.mpoo.testnet".into(),
                board_epoch: "epoch-1".into(),
            },
            width: 128,
            height: 128,
            finalized_block_hash: "bh".into(),
            finalized_block_height: "100".into(),
            finalized_block_timestamp_ns: capture_ns.to_string(),
            revision: "1".into(),
            crop_bounds_valid: true,
        });
    }

    #[test]
    fn create_and_cancel_draft() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let id = c.create_bounty(sample_terms(now, "1000"), "nonce-1".into());
        let view = c.get_bounty(id.clone());
        assert_eq!(view.status, "DRAFT");
        assert_eq!(view.award_amount, "1000");
        assert!(view.funded_at_ns.is_none());

        context_at(sponsor(), now + 1, 0);
        c.cancel_draft(id.clone());
        assert_eq!(c.get_bounty(id).status, "CANCELLED");
    }

    #[test]
    #[should_panic(expected = "STORAGE")]
    fn create_bounty_requires_storage_deposit() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, 0);
        let _ = c.create_bounty(sample_terms(now, "1000"), "no-deposit".into());
    }

    #[test]
    #[should_panic(expected = "UNAUTHORIZED")]
    fn cancel_draft_wrong_sponsor() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let id = c.create_bounty(sample_terms(now, "1000"), "n".into());
        context_at(artist(), now + 1, 0);
        c.cancel_draft(id);
    }

    #[test]
    fn fund_exact_amount_sponsor_only() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let id = c.create_bounty(sample_terms(now, "1000"), "n".into());

        // Wrong sponsor → full refund
        context_at(mock_token(), now + 10, 0);
        let msg = format!(r#"{{"version":1,"action":"fund_bounty","bounty_id":"{id}"}}"#);
        let unused = c.ft_on_transfer(artist(), U128(1000), msg.clone());
        assert!(matches!(unused, PromiseOrValue::Value(U128(1000))));

        // Wrong amount → refund
        let unused = c.ft_on_transfer(sponsor(), U128(999), msg.clone());
        assert!(matches!(unused, PromiseOrValue::Value(U128(999))));

        // Exact → accept
        fund_bounty(&mut c, &id, 1000, now + 20);
        assert_eq!(c.get_bounty(id).status, "ACTIVE");
    }

    #[test]
    fn fund_validation_pure_helpers() {
        assert!(validate_fund_message(
            r#"{"version":1,"action":"fund_bounty","bounty_id":"7"}"#
        )
        .is_ok());
        assert!(validate_fund_message(r#"{"version":2,"action":"fund_bounty","bounty_id":"7"}"#)
            .is_err());
        assert_eq!(
            validate_fund_attempt(true, "s", "other", 1, 10, 100, 100, false),
            Err("UNAUTHORIZED")
        );
        assert_eq!(
            validate_fund_attempt(true, "s", "s", 10, 10, 100, 100, false),
            Err("DEADLINE")
        );
        assert_eq!(
            validate_fund_attempt(true, "s", "s", 1, 10, 99, 100, false),
            Err("AMOUNT")
        );
    }

    #[test]
    fn wrong_token_refunds() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let id = c.create_bounty(sample_terms(now, "1000"), "n".into());
        context_at("evil.token.mock.test.near".parse().unwrap(), now + 1, 0);
        let msg = format!(r#"{{"version":1,"action":"fund_bounty","bounty_id":"{id}"}}"#);
        let unused = c.ft_on_transfer(sponsor(), U128(1000), msg);
        assert!(matches!(unused, PromiseOrValue::Value(U128(1000))));
    }

    fn happy_path_to_finalized(c: &mut Bounties) -> (String, String, String) {
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let award = "1000";
        let bounty_id = c.create_bounty(sample_terms(now, award), "hp".into());
        let terms = sample_terms(now, award);
        let fund_by: u64 = terms.fund_by_ns.parse().unwrap();
        let submit_by: u64 = terms.submit_by_ns.parse().unwrap();
        fund_bounty(c, &bounty_id, 1000, now + 50);

        let capture = now + 100;
        register_snap(c, "snap-1", capture, "manifest-hash-1");

        context_at(artist(), now + 200, storage_deposit());
        let crop = CropRect {
            x: 16,
            y: 16,
            width: 32,
            height: 32,
        };
        let result = c.propose_submission(
            bounty_id.clone(),
            "snap-1".into(),
            crop,
            "note-hash-1".into(),
            vec![
                PayoutRecipientInput {
                    account_id: alice(),
                    share_bps: 6000,
                },
                PayoutRecipientInput {
                    account_id: bob(),
                    share_bps: 4000,
                },
            ],
            "p1".into(),
        );

        context_at(alice(), now + 300, 0);
        c.approve_submission(result.proposal_id.clone(), result.consent_digest.clone());
        context_at(bob(), now + 301, 0);
        c.approve_submission(result.proposal_id.clone(), result.consent_digest.clone());
        context_at(artist(), now + 302, 0);
        c.submit(result.proposal_id.clone(), result.consent_digest.clone());

        assert!(now + 302 < submit_by);
        assert!(fund_by > now);
        (bounty_id, result.proposal_id, result.consent_digest)
    }

    #[test]
    fn propose_approve_submit_accept_claim() {
        let mut c = setup();
        let (bounty_id, submission_id, _) = happy_path_to_finalized(&mut c);
        let terms = sample_terms(1_000, "1000");
        let submit_by: u64 = terms.submit_by_ns.parse().unwrap();

        // Early award rejected
        context_at(sponsor(), submit_by - 1, 0);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.accept_submission(bounty_id.clone(), submission_id.clone());
        }));
        assert!(early.is_err());

        // Accept in review window
        context_at(sponsor(), submit_by, 0);
        assert_eq!(c.get_bounty(bounty_id.clone()).status, "REVIEW");
        c.accept_submission(bounty_id.clone(), submission_id.clone());
        assert_eq!(c.get_bounty(bounty_id.clone()).status, "AWARDED");

        let entitlement = c.get_print_entitlement(bounty_id.clone());
        assert_eq!(entitlement.sponsor, sponsor().as_str());
        assert_eq!(entitlement.crop.width, 32);

        let claims = c.list_claims(bounty_id.clone(), 0, 50);
        assert_eq!(claims.total, 2);
        // alice 600, bob 400
        let alice_claim = claims
            .items
            .iter()
            .find(|x| x.beneficiary == alice().as_str())
            .unwrap();
        assert_eq!(alice_claim.amount, "600");

        context_at(alice(), submit_by + 1, 0);
        // Drop/detach so MockedBlockchain records the scheduled receipts.
        c.claim(alice_claim.id.clone()).detach();
        assert_eq!(c.get_claim(alice_claim.id.clone()).status, "PENDING");

        // Assert claim scheduled ft_transfer (+ then callback) against the mock MPOO token.
        let receipts = get_created_receipts();
        let ft_calls: Vec<_> = receipts
            .iter()
            .flat_map(|r| r.actions.iter())
            .filter(|a| {
                matches!(
                    a,
                    MockAction::FunctionCallWeight { method_name, .. }
                        if method_name == b"ft_transfer"
                )
            })
            .collect();
        assert!(
            !ft_calls.is_empty(),
            "claim must schedule ft_transfer Promise"
        );
        assert!(
            receipts.iter().any(|r| r.receiver_id == mock_token()),
            "ft_transfer must target configured mpoo_token"
        );

        // Production settlement: callback reads promise_result(0).
        context_with_promise(
            escrow_account(),
            submit_by + 2,
            PromiseResult::Successful(vec![]),
        );
        c.on_claim_ft_result(alice_claim.id.clone(), "1".into());
        assert_eq!(c.get_claim(alice_claim.id.clone()).status, "PAID");
    }

    #[test]
    fn claim_ft_failure_restores_available() {
        let mut c = setup();
        let (bounty_id, submission_id, _) = happy_path_to_finalized(&mut c);
        let terms = sample_terms(1_000, "1000");
        let submit_by: u64 = terms.submit_by_ns.parse().unwrap();
        context_at(sponsor(), submit_by, 0);
        c.accept_submission(bounty_id.clone(), submission_id);
        let claims = c.list_claims(bounty_id, 0, 50);
        let bob_claim = claims
            .items
            .iter()
            .find(|x| x.beneficiary == bob().as_str())
            .unwrap();

        context_at(bob(), submit_by + 1, 0);
        c.claim(bob_claim.id.clone()).detach();
        assert_eq!(c.get_claim(bob_claim.id.clone()).status, "PENDING");

        context_with_promise(escrow_account(), submit_by + 2, PromiseResult::Failed);
        c.on_claim_ft_result(bob_claim.id.clone(), "1".into());
        let restored = c.get_claim(bob_claim.id.clone());
        assert_eq!(restored.status, "AVAILABLE");
        assert!(restored.attempt_id.is_none());
    }

    #[test]
    #[should_panic(expected = "CROP_MISMATCH")]
    fn crop_must_match_bounty_exactly() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let bounty_id = c.create_bounty(sample_terms(now, "1000"), "crop".into());
        fund_bounty(&mut c, &bounty_id, 1000, now + 50);
        register_snap(&mut c, "snap-c", now + 100, "mh");
        context_at(artist(), now + 200, storage_deposit());
        c.propose_submission(
            bounty_id,
            "snap-c".into(),
            CropRect {
                x: 16,
                y: 16,
                width: 16, // wrong — bounty is 32x32
                height: 32,
            },
            "note".into(),
            vec![PayoutRecipientInput {
                account_id: alice(),
                share_bps: 10000,
            }],
            "n".into(),
        );
    }

    #[test]
    #[should_panic(expected = "CONSENT_DIGEST_MISMATCH")]
    fn consent_digest_mismatch_rejects_approve() {
        let mut c = setup();
        let (bounty_id, proposal_id, digest) = happy_path_to_finalized(&mut c);
        let _ = (bounty_id, digest);
        // New proposal path already finalized; craft open proposal separately
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let bounty_id = c.create_bounty(sample_terms(now, "2000"), "cd".into());
        fund_bounty(&mut c, &bounty_id, 2000, now + 50);
        register_snap(&mut c, "snap-d", now + 100, "mh-d");
        context_at(artist(), now + 200, storage_deposit());
        let r = c.propose_submission(
            bounty_id,
            "snap-d".into(),
            CropRect {
                x: 16,
                y: 16,
                width: 32,
                height: 32,
            },
            "note-d".into(),
            vec![PayoutRecipientInput {
                account_id: alice(),
                share_bps: 10000,
            }],
            "n".into(),
        );
        let _ = proposal_id;
        context_at(alice(), now + 201, 0);
        c.approve_submission(r.proposal_id, "deadbeef".into());
    }

    #[test]
    #[should_panic(expected = "SPLIT_INVALID")]
    fn bad_split_rejected() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let bounty_id = c.create_bounty(sample_terms(now, "1000"), "split".into());
        fund_bounty(&mut c, &bounty_id, 1000, now + 50);
        register_snap(&mut c, "snap-s", now + 100, "mh");
        context_at(artist(), now + 200, storage_deposit());
        c.propose_submission(
            bounty_id,
            "snap-s".into(),
            CropRect {
                x: 16,
                y: 16,
                width: 32,
                height: 32,
            },
            "note".into(),
            vec![
                PayoutRecipientInput {
                    account_id: alice(),
                    share_bps: 5000,
                },
                PayoutRecipientInput {
                    account_id: bob(),
                    share_bps: 4000,
                },
            ],
            "n".into(),
        );
    }

    #[test]
    fn double_award_and_double_refund_blocked() {
        let mut c = setup();
        let (bounty_id, submission_id, _) = happy_path_to_finalized(&mut c);
        let terms = sample_terms(1_000, "1000");
        let submit_by: u64 = terms.submit_by_ns.parse().unwrap();
        let review_by: u64 = terms.review_by_ns.parse().unwrap();

        context_at(sponsor(), submit_by, 0);
        c.accept_submission(bounty_id.clone(), submission_id.clone());

        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.accept_submission(bounty_id.clone(), submission_id.clone());
        }));
        assert!(again.is_err());

        let expire = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            context_at(artist(), review_by, 0);
            c.expire_bounty(bounty_id.clone());
        }));
        assert!(expire.is_err());
    }

    #[test]
    fn accept_vs_expire_race() {
        let mut c = setup();
        let (bounty_id, submission_id, _) = happy_path_to_finalized(&mut c);
        let terms = sample_terms(1_000, "1000");
        let review_by: u64 = terms.review_by_ns.parse().unwrap();

        // Expire wins first at review_by
        context_at(artist(), review_by, 0);
        c.expire_bounty(bounty_id.clone());
        assert_eq!(c.get_bounty(bounty_id.clone()).status, "EXPIRED");
        let claims = c.list_claims(bounty_id.clone(), 0, 10);
        assert_eq!(claims.total, 1);
        assert_eq!(claims.items[0].kind, "REFUND");
        assert_eq!(claims.items[0].amount, "1000");

        let accept = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            context_at(sponsor(), review_by, 0);
            c.accept_submission(bounty_id.clone(), submission_id);
        }));
        assert!(accept.is_err());

        // Second expire must not create another entitlement
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            context_at(artist(), review_by + 1, 0);
            c.expire_bounty(bounty_id);
        }));
        assert!(again.is_err());
    }

    #[test]
    fn sponsor_silence_permissionless_expiry_no_submissions() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let bounty_id = c.create_bounty(sample_terms(now, "500"), "silent".into());
        fund_bounty(&mut c, &bounty_id, 500, now + 50);
        let submit_by: u64 = sample_terms(now, "500").submit_by_ns.parse().unwrap();

        // Before submit_by cannot expire with no submissions
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            context_at(artist(), submit_by - 1, 0);
            c.expire_bounty(bounty_id.clone());
        }));
        assert!(early.is_err());

        // At submit_by, anyone may expire
        context_at(artist(), submit_by, 0);
        c.expire_bounty(bounty_id.clone());
        assert_eq!(c.get_bounty(bounty_id).status, "EXPIRED");
    }

    #[test]
    fn deadline_edges_open_lt_closed_gte() {
        // < deadline open, >= deadline expired — funding edge
        assert!(validate_fund_attempt(true, "s", "s", 9, 10, 1, 1, false).is_ok());
        assert_eq!(
            validate_fund_attempt(true, "s", "s", 10, 10, 1, 1, false),
            Err("DEADLINE")
        );
    }

    #[test]
    fn revoke_approval_before_submit() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        let bounty_id = c.create_bounty(sample_terms(now, "1000"), "rev".into());
        fund_bounty(&mut c, &bounty_id, 1000, now + 50);
        register_snap(&mut c, "snap-r", now + 100, "mh-r");
        context_at(artist(), now + 200, storage_deposit());
        let r = c.propose_submission(
            bounty_id,
            "snap-r".into(),
            CropRect {
                x: 16,
                y: 16,
                width: 32,
                height: 32,
            },
            "note-r".into(),
            vec![
                PayoutRecipientInput {
                    account_id: alice(),
                    share_bps: 5000,
                },
                PayoutRecipientInput {
                    account_id: bob(),
                    share_bps: 5000,
                },
            ],
            "n".into(),
        );
        context_at(alice(), now + 201, 0);
        c.approve_submission(r.proposal_id.clone(), r.consent_digest.clone());
        c.revoke_approval(r.proposal_id.clone());
        context_at(bob(), now + 202, 0);
        c.approve_submission(r.proposal_id.clone(), r.consent_digest.clone());
        context_at(artist(), now + 203, 0);
        let missing = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.submit(r.proposal_id.clone(), r.consent_digest.clone());
        }));
        assert!(missing.is_err());
    }

    #[test]
    fn registry_only_may_register_snapshots() {
        let mut c = setup();
        let forged = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            context_at(artist(), 1_000, storage_deposit());
            c.register_snapshot_reference(SnapshotReferenceInput {
                snapshot_id: "x".into(),
                manifest_hash: "m".into(),
                board: BoardIdentityInput {
                    chain_id: "t".into(),
                    board_account_id: "b".into(),
                    board_epoch: "e".into(),
                },
                width: 128,
                height: 128,
                finalized_block_hash: "h".into(),
                finalized_block_height: "1".into(),
                finalized_block_timestamp_ns: "1000".into(),
                revision: "1".into(),
                crop_bounds_valid: true,
            });
        }));
        assert!(forged.is_err());
    }

    #[test]
    fn list_helpers_bounded() {
        let mut c = setup();
        let now = 1_000u64;
        context_at(sponsor(), now, storage_deposit());
        for i in 0..3 {
            c.create_bounty(sample_terms(now, "100"), format!("list-{i}"));
        }
        let page = c.list_bounties(0, 2);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 3);
        assert_eq!(page.next_from_index, Some(2));
        let page2 = c.list_bounties(2, 50);
        assert_eq!(page2.items.len(), 1);
        assert!(page2.next_from_index.is_none());
        assert_eq!(page.limit.min(MAX_PAGE), page.limit);
    }

    #[test]
    fn shared_split_fixture_matches() {
        let raw = include_str!("../../../shared/fixtures/bounties/split-allocation.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let award: u128 = v["awardAmount"].as_str().unwrap().parse().unwrap();
        let mut recipients = Vec::new();
        for r in v["recipients"].as_array().unwrap() {
            recipients.push(RecipientShare {
                account_id: r["accountId"].as_str().unwrap().parse().unwrap(),
                share_bps: r["shareBps"].as_u64().unwrap() as u16,
            });
        }
        let allocated = allocate_award_amounts(award, &recipients).unwrap();
        let expected = v["expectedSortedAllocations"].as_array().unwrap();
        assert_eq!(allocated.len(), expected.len());
        for (got, exp) in allocated.iter().zip(expected) {
            assert_eq!(got.account_id.as_str(), exp["accountId"].as_str().unwrap());
            assert_eq!(
                got.amount.to_string(),
                exp["amount"].as_str().unwrap()
            );
        }
    }
}
