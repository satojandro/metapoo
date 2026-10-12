//! Meta Poo snapshot registry + numbered historical print NFTs.
//!
//! Trusted-attester registration (not a trustless state proof). Public series
//! and bounty collector series are separate; public mint never consumes a
//! bounty entitlement. Wave 2 unit-testable logic — no mainnet deploy.
//!
//! Hash fields are stored as lowercase hex strings; identity hashing follows
//! `shared/history` / `identity.rs` (raw 32-byte SHA-256 inputs).

mod identity;

use identity::{
    compute_bounty_series_id, compute_print_id, print_token_id, PUBLIC_SERIES_ID,
};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue, PromiseResult,
};
use std::collections::HashMap;

const BOARD_WIDTH_DEFAULT: u32 = 128;
const BOARD_HEIGHT_DEFAULT: u32 = 128;
const MAX_HASH_LEN: usize = 128;
const MAX_URI_LEN: usize = 512;
const MAX_SNAPSHOT_ID_LEN: usize = 128;
const MAX_OPERATION_ID_LEN: usize = 128;
const EVENT_STANDARD: &str = "mpoo_prints";
const EVENT_VERSION: &str = "1.0.0";
const NEP171_STANDARD: &str = "nep171";
const NEP171_VERSION: &str = "1.0.0";

/// Labelled mock accounts for unit tests / local scaffolding.
pub const MOCK_ATTESTER: &str = "attester.prints.mock.test.near";
pub const MOCK_ESCROW: &str = "bounties.escrow.mock.test.near";
pub const MOCK_PRINTS: &str = "prints.registry.mock.test.near";

/// Gas for escrow `register_snapshot_reference`.
const GAS_FOR_REGISTER_REF: Gas = Gas::from_tgas(30);
/// Gas for escrow `get_print_entitlement`.
const GAS_FOR_ENTITLEMENT: Gas = Gas::from_tgas(20);
/// Gas reserved for private entitlement callback.
const GAS_FOR_ENTITLEMENT_CALLBACK: Gas = Gas::from_tgas(40);
/// Gas for storage-refund failure callback.
const GAS_FOR_REFUND_CALLBACK: Gas = Gas::from_tgas(10);
/// Gas for `nft_on_transfer` receiver hook.
const GAS_FOR_NFT_TRANSFER_CALL: Gas = Gas::from_tgas(25);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);

/// Escrow surface matching `contracts/bounties` (documented interface for unit stubs).
#[ext_contract(ext_bounty_escrow)]
pub trait ExtBountyEscrow {
    fn register_snapshot_reference(&mut self, record: SnapshotReferenceInput);
    fn get_print_entitlement(&self, bounty_id: String) -> PrintEntitlementView;
}

#[ext_contract(ext_nft_receiver)]
pub trait ExtNftReceiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool>;
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Snapshots,
    Artworks,
    Series,
    Tokens,
    TokenOwners,
    Operations,
    EscrowAllowlist,
    BountySeriesIssued,
    PullCredits,
}

// ─── Wire types (JSON boundary: large ints / IDs as strings) ─────────────────

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardIdentity {
    pub chain_id: String,
    pub board_account_id: String,
    pub board_epoch: String,
}

/// Manifest registered by the trusted attester (mirrors `shared/protocol/history.ts`).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SnapshotManifestInput {
    pub snapshot_id: String,
    pub state_hash: String,
    pub board: BoardIdentity,
    pub width: u32,
    pub height: u32,
    pub palette_version: String,
    pub finalized_block_hash: String,
    pub finalized_block_height: String,
    pub finalized_block_timestamp_ns: String,
    pub revision: String,
    /// Empty string only for baseline / end-of-block legacy snapshots.
    pub receipt_id: String,
    pub manifest_uri: String,
    pub manifest_hash: String,
    pub attester_account_id: String,
    pub media_hash: Option<String>,
}

/// Payload forwarded to allowlisted escrow `register_snapshot_reference`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SnapshotReferenceInput {
    pub snapshot_id: String,
    pub manifest_hash: String,
    pub board: BoardIdentity,
    pub width: u32,
    pub height: u32,
    pub finalized_block_hash: String,
    pub finalized_block_height: String,
    pub finalized_block_timestamp_ns: String,
    pub revision: String,
    pub crop_bounds_valid: bool,
}

/// Escrow entitlement view (matches bounties `PrintEntitlementView`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrintEntitlementView {
    pub bounty_id: String,
    pub sponsor: String,
    pub snapshot_id: String,
    pub manifest_hash: String,
    pub crop: CropRect,
    pub entitlement_key: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrintOperationStatus {
    Pending,
    QueryingEntitlement,
    Minted,
    Failed,
    Conflict,
}

impl PrintOperationStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::QueryingEntitlement => "querying_entitlement",
            Self::Minted => "minted",
            Self::Failed => "failed",
            Self::Conflict => "conflict",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SeriesKind {
    Public,
    Bounty,
}

impl SeriesKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Bounty => "bounty",
        }
    }
}

// ─── Stored records ──────────────────────────────────────────────────────────

#[near(serializers = [borsh])]
#[derive(Clone)]
struct SnapshotRecord {
    snapshot_id: String,
    state_hash: String,
    board: BoardIdentity,
    width: u32,
    height: u32,
    palette_version: String,
    finalized_block_hash: String,
    finalized_block_height: String,
    finalized_block_timestamp_ns: u64,
    revision: String,
    receipt_id: String,
    manifest_uri: String,
    manifest_hash: String,
    attester_account_id: AccountId,
    media_hash: Option<String>,
    registered_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct ArtworkRecord {
    print_id: String,
    snapshot_id: String,
    state_hash: String,
    crop: CropRect,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct SeriesRecord {
    print_id: String,
    series_id: String,
    kind: SeriesKind,
    cap: u32,
    next_edition: u32,
    /// For bounty series: escrow + bounty binding.
    source_bounty_id: Option<u64>,
    source_escrow: Option<AccountId>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct TokenRecord {
    token_id: String,
    print_id: String,
    series_id: String,
    series_kind: SeriesKind,
    edition_number: u32,
    mint_recipient: AccountId,
    owner: AccountId,
    operation_id: String,
    caller: AccountId,
    minted_at_ns: u64,
    source_bounty_id: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct OperationRecord {
    caller: AccountId,
    operation_id: String,
    status: PrintOperationStatus,
    /// Discriminator: "public" | "bounty"
    kind: String,
    snapshot_id: Option<String>,
    crop: Option<CropRect>,
    recipient: Option<AccountId>,
    bounty_contract: Option<AccountId>,
    bounty_id: Option<u64>,
    print_id: Option<String>,
    token_id: Option<String>,
    series_id: Option<String>,
    edition_number: Option<u32>,
    error_code: Option<String>,
    /// Attached NEAR held until bounty callback settles mint storage (yocto).
    reserved_deposit: u128,
}

// ─── Views ───────────────────────────────────────────────────────────────────

#[near(serializers = [json])]
pub struct SnapshotView {
    pub snapshot_id: String,
    pub state_hash: String,
    pub board: BoardIdentity,
    pub width: u32,
    pub height: u32,
    pub palette_version: String,
    pub finalized_block_hash: String,
    pub finalized_block_height: String,
    pub finalized_block_timestamp_ns: String,
    pub revision: String,
    pub receipt_id: String,
    pub manifest_uri: String,
    pub manifest_hash: String,
    pub attester_account_id: String,
    pub media_hash: Option<String>,
    pub registered_at_ns: String,
}

#[near(serializers = [json])]
pub struct SeriesAvailabilityView {
    pub series_id: String,
    pub series_kind: String,
    pub cap: u32,
    pub issued: u32,
    pub remaining: u32,
    pub source_bounty_id: Option<String>,
}

#[near(serializers = [json])]
pub struct PrintView {
    pub print_id: String,
    pub snapshot_id: String,
    pub state_hash: String,
    pub crop: CropRect,
    pub series: Vec<SeriesAvailabilityView>,
}

#[near(serializers = [json])]
pub struct PrintEditionView {
    pub token_id: String,
    pub print_id: String,
    pub series_id: String,
    pub series_kind: String,
    pub edition_number: u32,
    pub mint_recipient: String,
    pub current_owner: String,
    pub operation_id: String,
    pub minted_at_ns: String,
    pub source_bounty_id: Option<String>,
}

#[near(serializers = [json])]
pub struct PrintOperationView {
    pub caller: String,
    pub operation_id: String,
    pub status: String,
    pub print_id: Option<String>,
    pub token_id: Option<String>,
    pub series_id: Option<String>,
    pub edition_number: Option<u32>,
    pub error_code: Option<String>,
    /// YoctoNEAR still held for callback mint storage (decimal string).
    pub reserved_deposit: String,
}

#[near(serializers = [json])]
pub struct DeploymentIdentity {
    pub attester: String,
    pub prints_account_id: String,
    pub chain_genesis_hash: String,
    pub board_width: u32,
    pub board_height: u32,
    pub public_series_id: String,
    pub public_series_cap: u32,
}

#[near(serializers = [json])]
pub struct MintResult {
    pub print_id: String,
    pub token_id: String,
    pub series_id: String,
    pub edition_number: u32,
    pub status: String,
}

/// NEP-177 contract-level metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-177 per-token metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-171 `nft_token` response.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub approved_account_ids: Option<HashMap<AccountId, u64>>,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Prints {
    /// Trusted snapshot attester. Only this account may `register_snapshot`.
    attester: AccountId,
    /// Chain genesis hash (lowercase hex) used in bounty series identity.
    chain_genesis_hash: String,
    board_width: u32,
    board_height: u32,
    public_series_cap: u32,
    snapshots: IterableMap<String, SnapshotRecord>,
    artworks: IterableMap<String, ArtworkRecord>,
    /// Key: `{print_id}\\0{series_id}`
    series: IterableMap<String, SeriesRecord>,
    tokens: IterableMap<String, TokenRecord>,
    /// operation key: `{caller}\\0{operation_id}`
    operations: LookupMap<String, OperationRecord>,
    escrow_allowlist: IterableMap<AccountId, bool>,
    /// series_id → token_id for bounty series (exactly one mint).
    bounty_series_issued: LookupMap<String, String>,
    pull_credits: LookupMap<AccountId, u128>,
}

#[near]
impl Prints {
    #[init]
    pub fn new(
        attester: AccountId,
        chain_genesis_hash: String,
        board_width: u32,
        board_height: u32,
        public_series_cap: u32,
    ) -> Self {
        require!(!chain_genesis_hash.is_empty(), "CONFIG: chain_genesis_hash required");
        require!(board_width > 0 && board_height > 0, "CONFIG: board dimensions");
        require!(public_series_cap > 0, "CONFIG: public_series_cap must be positive");
        // Validate genesis is 32-byte hex (frozen encoding inputs).
        identity::hex_to_bytes32(&chain_genesis_hash)
            .unwrap_or_else(|e| reject("CONFIG", &format!("bad genesis hash: {e}")));
        Self {
            attester,
            chain_genesis_hash,
            board_width,
            board_height,
            public_series_cap,
            snapshots: IterableMap::new(StorageKey::Snapshots),
            artworks: IterableMap::new(StorageKey::Artworks),
            series: IterableMap::new(StorageKey::Series),
            tokens: IterableMap::new(StorageKey::Tokens),
            operations: LookupMap::new(StorageKey::Operations),
            escrow_allowlist: IterableMap::new(StorageKey::EscrowAllowlist),
            bounty_series_issued: LookupMap::new(StorageKey::BountySeriesIssued),
            pull_credits: LookupMap::new(StorageKey::PullCredits),
        }
    }

    /// Convenience init for fixtures (128×128, public cap 100).
    #[init]
    pub fn new_fixture(attester: AccountId, chain_genesis_hash: String) -> Self {
        Self::new(
            attester,
            chain_genesis_hash,
            BOARD_WIDTH_DEFAULT,
            BOARD_HEIGHT_DEFAULT,
            100,
        )
    }

    /// Attester-only: allow an escrow to receive snapshot references / entitlement queries.
    pub fn allowlist_escrow(&mut self, escrow: AccountId) {
        require!(
            env::predecessor_account_id() == self.attester,
            "UNAUTHORIZED: attester only"
        );
        self.escrow_allowlist.insert(escrow, true);
    }

    /// Attester-only immutable snapshot registration. Exact duplicates are idempotent.
    #[payable]
    pub fn register_snapshot(&mut self, manifest: SnapshotManifestInput) {
        let storage_before = env::storage_usage();
        let caller = env::predecessor_account_id();
        require!(caller == self.attester, "UNAUTHORIZED: attester only");
        self.validate_manifest(&manifest);
        require!(
            manifest.attester_account_id == caller.to_string(),
            "ATTESTER: manifest attester_account_id must match caller"
        );

        let ts = parse_u64(
            &manifest.finalized_block_timestamp_ns,
            "SNAPSHOT_TS",
        );
        let next = SnapshotRecord {
            snapshot_id: manifest.snapshot_id.clone(),
            state_hash: manifest.state_hash.clone(),
            board: manifest.board.clone(),
            width: manifest.width,
            height: manifest.height,
            palette_version: manifest.palette_version.clone(),
            finalized_block_hash: manifest.finalized_block_hash.clone(),
            finalized_block_height: manifest.finalized_block_height.clone(),
            finalized_block_timestamp_ns: ts,
            revision: manifest.revision.clone(),
            receipt_id: manifest.receipt_id.clone(),
            manifest_uri: manifest.manifest_uri.clone(),
            manifest_hash: manifest.manifest_hash.clone(),
            attester_account_id: caller.clone(),
            media_hash: manifest.media_hash.clone(),
            registered_at_ns: env::block_timestamp(),
        };

        if let Some(existing) = self.snapshots.get(&manifest.snapshot_id).cloned() {
            require!(
                snapshot_equal(&existing, &next),
                "SNAPSHOT: conflicting data under existing id"
            );
            self.settle_storage_deposit(storage_before);
            return;
        }

        self.snapshots
            .insert(manifest.snapshot_id.clone(), next);
        emit_event(
            "snapshot_registered",
            &format!(
                "{{\"snapshot_id\":\"{}\",\"manifest_hash\":\"{}\",\"attester\":\"{}\"}}",
                manifest.snapshot_id, manifest.manifest_hash, caller
            ),
        );
        self.settle_storage_deposit(storage_before);
    }

    /// Dispatch immutable registry reference to an allowlisted escrow.
    /// Failed delivery does not remove the registry entry. Forwards attached deposit.
    #[payable]
    pub fn publish_snapshot_reference(
        &mut self,
        snapshot_id: String,
        bounty_contract: AccountId,
    ) -> Promise {
        require!(
            self.escrow_allowlist.get(&bounty_contract).copied().unwrap_or(false),
            "UNAUTHORIZED: escrow not allowlisted"
        );
        let snap = self
            .snapshots
            .get(&snapshot_id)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "snapshot"));
        let record = SnapshotReferenceInput {
            snapshot_id: snap.snapshot_id.clone(),
            manifest_hash: snap.manifest_hash.clone(),
            board: snap.board.clone(),
            width: snap.width,
            height: snap.height,
            finalized_block_hash: snap.finalized_block_hash.clone(),
            finalized_block_height: snap.finalized_block_height.clone(),
            finalized_block_timestamp_ns: snap.finalized_block_timestamp_ns.to_string(),
            revision: snap.revision.clone(),
            crop_bounds_valid: true,
        };
        let deposit = env::attached_deposit();
        emit_event(
            "snapshot_reference_publish",
            &format!(
                "{{\"snapshot_id\":\"{snapshot_id}\",\"bounty_contract\":\"{bounty_contract}\"}}"
            ),
        );
        ext_bounty_escrow::ext(bounty_contract)
            .with_attached_deposit(deposit)
            .with_static_gas(GAS_FOR_REGISTER_REF)
            .register_snapshot_reference(record)
    }

    /// Public-series mint. Allocates the next edition within the frozen public cap.
    /// Same `operation_id` + args recovers the prior token; conflicting args fail.
    #[payable]
    pub fn mint_print(
        &mut self,
        snapshot_id: String,
        crop: CropRect,
        recipient: AccountId,
        operation_id: String,
    ) -> MintResult {
        let storage_before = env::storage_usage();
        let caller = env::predecessor_account_id();
        require!(
            !operation_id.is_empty() && operation_id.len() <= MAX_OPERATION_ID_LEN,
            "OPERATION: bad operation_id"
        );
        let op_key = operation_key(&caller, &operation_id);

        if let Some(existing) = self.operations.get(&op_key).cloned() {
            require!(
                existing.kind == "public"
                    && existing.snapshot_id.as_deref() == Some(snapshot_id.as_str())
                    && existing.crop.as_ref() == Some(&crop)
                    && existing.recipient.as_ref() == Some(&recipient),
                "OPERATION: conflicting arguments for existing operation_id"
            );
            if existing.status == PrintOperationStatus::Minted {
                let result = mint_result_from_op(&existing);
                self.settle_storage_deposit(storage_before);
                return result;
            }
            require!(
                existing.status != PrintOperationStatus::Conflict,
                "OPERATION: conflict"
            );
        }

        let snap = self
            .snapshots
            .get(&snapshot_id)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "snapshot"));
        let crop = normalize_crop(&crop, snap.width, snap.height);
        validate_crop(&crop, snap.width, snap.height);

        let print_id = compute_print_id(&snapshot_id, crop.x, crop.y, crop.width, crop.height)
            .unwrap_or_else(|e| reject("PRINT_ID", &e));

        self.ensure_artwork(&print_id, &snapshot_id, &snap.state_hash, &crop);
        let series_key = series_map_key(&print_id, PUBLIC_SERIES_ID);
        if self.series.get(&series_key).is_none() {
            self.series.insert(
                series_key.clone(),
                SeriesRecord {
                    print_id: print_id.clone(),
                    series_id: PUBLIC_SERIES_ID.to_string(),
                    kind: SeriesKind::Public,
                    cap: self.public_series_cap,
                    next_edition: 1,
                    source_bounty_id: None,
                    source_escrow: None,
                },
            );
        }

        let series = self
            .series
            .get_mut(&series_key)
            .unwrap_or_else(|| reject("NOT_FOUND", "series"));
        require!(
            series.next_edition <= series.cap,
            "SERIES_CAP: public series exhausted"
        );
        let edition = series.next_edition;
        series.next_edition = edition
            .checked_add(1)
            .unwrap_or_else(|| reject("OVERFLOW", "edition"));
        let series_id = series.series_id.clone();
        let token_id = print_token_id(&print_id, &series_id, edition);
        let minted_at = env::block_timestamp();

        let token = TokenRecord {
            token_id: token_id.clone(),
            print_id: print_id.clone(),
            series_id: series_id.clone(),
            series_kind: SeriesKind::Public,
            edition_number: edition,
            mint_recipient: recipient.clone(),
            owner: recipient.clone(),
            operation_id: operation_id.clone(),
            caller: caller.clone(),
            minted_at_ns: minted_at,
            source_bounty_id: None,
        };
        self.tokens.insert(token_id.clone(), token);

        let op = OperationRecord {
            caller: caller.clone(),
            operation_id: operation_id.clone(),
            status: PrintOperationStatus::Minted,
            kind: "public".into(),
            snapshot_id: Some(snapshot_id),
            crop: Some(crop),
            recipient: Some(recipient.clone()),
            bounty_contract: None,
            bounty_id: None,
            print_id: Some(print_id.clone()),
            token_id: Some(token_id.clone()),
            series_id: Some(series_id.clone()),
            edition_number: Some(edition),
            error_code: None,
            reserved_deposit: 0,
        };
        self.operations.insert(op_key, op);

        emit_nep171_mint(&token_id, &recipient);
        emit_event(
            "print_minted",
            &format!(
                "{{\"print_id\":\"{print_id}\",\"token_id\":\"{token_id}\",\"series_id\":\"{series_id}\",\"edition\":{edition},\"kind\":\"public\"}}"
            ),
        );

        self.settle_storage_deposit(storage_before);
        MintResult {
            print_id,
            token_id,
            series_id,
            edition_number: edition,
            status: "minted".into(),
        }
    }

    /// Query allowlisted escrow entitlement, then mint exactly one bounty-series edition
    /// in the private callback. Recipient is fixed from entitlement (sponsor).
    #[payable]
    pub fn mint_bounty_print(
        &mut self,
        bounty_contract: AccountId,
        bounty_id: String,
        operation_id: String,
    ) -> Promise {
        let storage_before = env::storage_usage();
        let caller = env::predecessor_account_id();
        require!(
            !operation_id.is_empty() && operation_id.len() <= MAX_OPERATION_ID_LEN,
            "OPERATION: bad operation_id"
        );
        require!(
            self.escrow_allowlist.get(&bounty_contract).copied().unwrap_or(false),
            "UNAUTHORIZED: escrow not allowlisted"
        );
        let bid = parse_u64(&bounty_id, "BOUNTY_ID");
        let op_key = operation_key(&caller, &operation_id);

        if let Some(existing) = self.operations.get(&op_key).cloned() {
            require!(
                existing.kind == "bounty"
                    && existing.bounty_contract.as_ref() == Some(&bounty_contract)
                    && existing.bounty_id == Some(bid),
                "OPERATION: conflicting arguments for existing operation_id"
            );
            if existing.status == PrintOperationStatus::Minted {
                // Already done — return a no-op promise; client reads get_print_operation.
                self.settle_storage_deposit(storage_before);
                return Promise::new(env::current_account_id());
            }
            require!(
                existing.status != PrintOperationStatus::Conflict,
                "OPERATION: conflict"
            );
            // Failed or querying → allow re-query with same immutable args / recipient lock.
            if let Some(locked) = existing.recipient.as_ref() {
                // Recipient already bound from a prior successful entitlement read path.
                let _ = locked;
            }
        }

        let prior_reserved = self
            .operations
            .get(&op_key)
            .map(|o| o.reserved_deposit)
            .unwrap_or(0);
        let prior_recipient = self
            .operations
            .get(&op_key)
            .and_then(|o| o.recipient.clone());
        let op = OperationRecord {
            caller: caller.clone(),
            operation_id: operation_id.clone(),
            status: PrintOperationStatus::QueryingEntitlement,
            kind: "bounty".into(),
            snapshot_id: None,
            crop: None,
            recipient: prior_recipient,
            bounty_contract: Some(bounty_contract.clone()),
            bounty_id: Some(bid),
            print_id: None,
            token_id: None,
            series_id: None,
            edition_number: None,
            error_code: None,
            // Placeholder; overwritten after measuring storage growth.
            reserved_deposit: prior_reserved,
        };
        self.operations.insert(op_key.clone(), op);
        // Hold excess deposit for callback mint storage — do not refund yet.
        self.reserve_storage_deposit(storage_before, &op_key, prior_reserved);

        emit_event(
            "entitlement_query",
            &format!(
                "{{\"operation_id\":\"{operation_id}\",\"bounty_contract\":\"{bounty_contract}\",\"bounty_id\":\"{bid}\"}}"
            ),
        );

        ext_bounty_escrow::ext(bounty_contract.clone())
            .with_static_gas(GAS_FOR_ENTITLEMENT)
            .get_print_entitlement(bounty_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ENTITLEMENT_CALLBACK)
                    .on_print_entitlement(caller.to_string(), operation_id),
            )
    }

    /// Private callback after `get_print_entitlement`. Authenticates promise result;
    /// mints exactly one bounty edition; cannot change recipient on retry.
    #[private]
    pub fn on_print_entitlement(&mut self, caller: String, operation_id: String) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "UNAUTHORIZED: private callback only"
        );
        let caller: AccountId = caller.parse().unwrap_or_else(|_| reject("PARSE", "caller"));
        let op_key = operation_key(&caller, &operation_id);
        // Capture storage before any mint writes so callback growth is charged
        // against the reserved deposit from mint_bounty_print.
        let storage_before = env::storage_usage();

        #[allow(deprecated)]
        let result = env::promise_result(0);
        match result {
            PromiseResult::Successful(bytes) => {
                // Match decode so failure + refund commit; never panic after side effects.
                match near_sdk::serde_json::from_slice::<PrintEntitlementView>(&bytes) {
                    Ok(entitlement) => {
                        self.settle_bounty_mint(
                            &op_key,
                            &caller,
                            &operation_id,
                            entitlement,
                            storage_before,
                        );
                    }
                    Err(_) => {
                        self.fail_operation(&op_key, "ENTITLEMENT_DECODE");
                        self.refund_reserved_deposit(&op_key);
                    }
                }
            }
            _ => {
                // Query failure: retryable — keep reserved deposit for the next attempt.
                self.fail_operation(&op_key, "ENTITLEMENT_QUERY_FAILED");
            }
        }
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    pub fn get_snapshot(&self, snapshot_id: String) -> SnapshotView {
        let s = self
            .snapshots
            .get(&snapshot_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "snapshot"));
        snapshot_to_view(s)
    }

    pub fn get_print(&self, print_id: String) -> PrintView {
        let art = self
            .artworks
            .get(&print_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "print"));
        let mut series_views = Vec::new();
        for (_k, s) in self.series.iter() {
            if s.print_id == print_id {
                let issued = s.next_edition.saturating_sub(1);
                series_views.push(SeriesAvailabilityView {
                    series_id: s.series_id.clone(),
                    series_kind: s.kind.as_str().into(),
                    cap: s.cap,
                    issued,
                    remaining: s.cap.saturating_sub(issued),
                    source_bounty_id: s.source_bounty_id.map(|id| id.to_string()),
                });
            }
        }
        // Always surface public series availability even before first mint.
        if !series_views.iter().any(|s| s.series_id == PUBLIC_SERIES_ID) {
            series_views.insert(
                0,
                SeriesAvailabilityView {
                    series_id: PUBLIC_SERIES_ID.into(),
                    series_kind: "public".into(),
                    cap: self.public_series_cap,
                    issued: 0,
                    remaining: self.public_series_cap,
                    source_bounty_id: None,
                },
            );
        }
        PrintView {
            print_id: art.print_id.clone(),
            snapshot_id: art.snapshot_id.clone(),
            state_hash: art.state_hash.clone(),
            crop: art.crop.clone(),
            series: series_views,
        }
    }

    pub fn get_print_operation(&self, caller: String, operation_id: String) -> PrintOperationView {
        let caller_id: AccountId = caller.parse().unwrap_or_else(|_| reject("PARSE", "caller"));
        let op = self
            .operations
            .get(&operation_key(&caller_id, &operation_id))
            .unwrap_or_else(|| reject("NOT_FOUND", "operation"));
        PrintOperationView {
            caller: op.caller.to_string(),
            operation_id: op.operation_id.clone(),
            status: op.status.as_str().into(),
            print_id: op.print_id.clone(),
            token_id: op.token_id.clone(),
            series_id: op.series_id.clone(),
            edition_number: op.edition_number,
            error_code: op.error_code.clone(),
            reserved_deposit: op.reserved_deposit.to_string(),
        }
    }

    /// Custom edition view (print/series/edition metadata). Prefer `nft_token` for NEP-171.
    pub fn get_print_edition(&self, token_id: String) -> PrintEditionView {
        let t = self
            .tokens
            .get(&token_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "token"));
        token_to_view(t)
    }

    /// NEP-171 token view. Returns `null` when the token does not exist.
    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.tokens.get(&token_id).map(token_to_json)
    }

    /// NEP-177 contract metadata.
    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Meta Poo Historical Prints".into(),
            symbol: "MPOOP".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    /// Minimal NEP-171 transfer (1 yocto). Does not alter mint_recipient.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, memo: Option<String>) {
        self.internal_transfer(receiver_id, token_id, memo);
    }

    /// NEP-171 transfer-and-call (1 yocto).
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(
            env::prepaid_gas()
                > GAS_FOR_NFT_TRANSFER_CALL
                    .saturating_add(GAS_FOR_RESOLVE_TRANSFER)
                    .saturating_add(Gas::from_tgas(10)),
            "NEP171: insufficient gas for nft_transfer_call"
        );
        let sender_id = env::predecessor_account_id();
        let previous_owner_id = self.internal_transfer(receiver_id.clone(), token_id.clone(), memo);
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_NFT_TRANSFER_CALL)
            .nft_on_transfer(sender_id, previous_owner_id.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .nft_resolve_transfer(previous_owner_id, receiver_id, token_id),
            )
    }

    /// Private: revert transfer if receiver returns true / promise fails (NEP-171).
    /// Returns `true` when the token stays with (or has left) the receiver;
    /// `false` only when ownership is restored to `previous_owner_id`.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
    ) -> bool {
        #[allow(deprecated)]
        let result = env::promise_result(0);
        let revert = match result {
            PromiseResult::Successful(bytes) => {
                near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(true)
            }
            _ => true,
        };
        if !revert {
            return true;
        }
        if let Some(token) = self.tokens.get_mut(&token_id) {
            if token.owner == receiver_id {
                token.owner = previous_owner_id.clone();
                emit_nep171_transfer(&token_id, &receiver_id, &previous_owner_id);
                return false;
            }
        }
        // Receiver already transferred onward (or token missing) — cannot revert.
        true
    }

    pub fn get_deployment_identity(&self) -> DeploymentIdentity {
        DeploymentIdentity {
            attester: self.attester.to_string(),
            prints_account_id: env::current_account_id().to_string(),
            chain_genesis_hash: self.chain_genesis_hash.clone(),
            board_width: self.board_width,
            board_height: self.board_height,
            public_series_id: PUBLIC_SERIES_ID.into(),
            public_series_cap: self.public_series_cap,
        }
    }

    pub fn is_escrow_allowlisted(&self, escrow: AccountId) -> bool {
        self.escrow_allowlist.get(&escrow).copied().unwrap_or(false)
    }

    /// Recoverable pull credit for excess storage refunds that failed to transfer.
    pub fn get_pull_credit(&self, account_id: AccountId) -> String {
        self.pull_credits
            .get(&account_id)
            .copied()
            .unwrap_or(0)
            .to_string()
    }

    /// Withdraw accumulated pull credits (failed storage refunds). Re-credits on failure.
    pub fn withdraw_pull_credit(&mut self) -> Promise {
        let account_id = env::predecessor_account_id();
        let amount = self.pull_credits.get(&account_id).copied().unwrap_or(0);
        require!(amount > 0, "PULL_CREDIT: nothing to withdraw");
        self.pull_credits.remove(&account_id);
        self.pull_credits.flush();
        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_REFUND_CALLBACK)
                    .on_storage_refund(account_id, amount.to_string()),
            )
    }

    /// Private: restore pull credit exactly once when a storage refund transfer fails.
    #[private]
    pub fn on_storage_refund(&mut self, account_id: AccountId, amount: String) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "UNAUTHORIZED: private callback only"
        );
        #[allow(deprecated)]
        let result = env::promise_result(0);
        if matches!(result, PromiseResult::Successful(_)) {
            return;
        }
        let amt: u128 = amount
            .parse()
            .unwrap_or_else(|_| reject("PARSE", "refund amount"));
        let prior = self.pull_credits.get(&account_id).copied().unwrap_or(0);
        self.pull_credits
            .insert(account_id, prior.saturating_add(amt));
        self.pull_credits.flush();
    }
}

impl Prints {
    fn validate_manifest(&self, m: &SnapshotManifestInput) {
        require!(
            !m.snapshot_id.is_empty() && m.snapshot_id.len() <= MAX_SNAPSHOT_ID_LEN,
            "SNAPSHOT: bad snapshot_id"
        );
        identity::hex_to_bytes32(&m.snapshot_id)
            .unwrap_or_else(|e| reject("SNAPSHOT", &format!("snapshot_id hex: {e}")));
        identity::hex_to_bytes32(&m.state_hash)
            .unwrap_or_else(|e| reject("SNAPSHOT", &format!("state_hash hex: {e}")));
        require!(
            !m.manifest_hash.is_empty() && m.manifest_hash.len() <= MAX_HASH_LEN,
            "SNAPSHOT: bad manifest_hash"
        );
        require!(
            !m.manifest_uri.is_empty() && m.manifest_uri.len() <= MAX_URI_LEN,
            "SNAPSHOT: bad manifest_uri"
        );
        require!(
            m.width == self.board_width && m.height == self.board_height,
            "SNAPSHOT: dimensions must match registry board"
        );
        require!(!m.board.chain_id.is_empty(), "SNAPSHOT: board.chain_id");
        require!(
            !m.board.board_account_id.is_empty(),
            "SNAPSHOT: board.board_account_id"
        );
        require!(!m.board.board_epoch.is_empty(), "SNAPSHOT: board.board_epoch");
        require!(!m.palette_version.is_empty(), "SNAPSHOT: palette_version");
        require!(!m.finalized_block_hash.is_empty(), "SNAPSHOT: block hash");
        require!(!m.revision.is_empty(), "SNAPSHOT: revision");
        let _ = parse_u64(&m.finalized_block_height, "BLOCK_HEIGHT");
        let _ = parse_u64(&m.finalized_block_timestamp_ns, "SNAPSHOT_TS");
    }

    fn ensure_artwork(
        &mut self,
        print_id: &str,
        snapshot_id: &str,
        state_hash: &str,
        crop: &CropRect,
    ) {
        if let Some(existing) = self.artworks.get(print_id) {
            require!(
                existing.snapshot_id == snapshot_id
                    && existing.state_hash == state_hash
                    && &existing.crop == crop,
                "PRINT: conflicting artwork under print_id"
            );
            return;
        }
        self.artworks.insert(
            print_id.to_string(),
            ArtworkRecord {
                print_id: print_id.to_string(),
                snapshot_id: snapshot_id.to_string(),
                state_hash: state_hash.to_string(),
                crop: crop.clone(),
            },
        );
    }

    fn fail_operation(&mut self, op_key: &str, code: &str) {
        if let Some(op) = self.operations.get_mut(op_key) {
            if op.status != PrintOperationStatus::Minted {
                op.status = PrintOperationStatus::Failed;
                op.error_code = Some(code.into());
            }
        }
        emit_event(
            "print_operation_failed",
            &format!("{{\"error_code\":\"{code}\"}}"),
        );
    }

    fn settle_bounty_mint(
        &mut self,
        op_key: &str,
        caller: &AccountId,
        operation_id: &str,
        entitlement: PrintEntitlementView,
        storage_before: u64,
    ) {
        let mut op = self
            .operations
            .get(op_key)
            .cloned()
            .unwrap_or_else(|| reject("NOT_FOUND", "operation"));
        require!(
            op.status == PrintOperationStatus::QueryingEntitlement
                || op.status == PrintOperationStatus::Failed,
            "STATE: operation not awaiting entitlement"
        );
        let bounty_contract = op
            .bounty_contract
            .clone()
            .unwrap_or_else(|| reject("STATE", "missing bounty_contract"));
        let bid = op
            .bounty_id
            .unwrap_or_else(|| reject("STATE", "missing bounty_id"));
        require!(
            entitlement.bounty_id == bid.to_string(),
            "ENTITLEMENT: bounty_id mismatch"
        );

        let recipient: AccountId = entitlement
            .sponsor
            .parse()
            .unwrap_or_else(|_| reject("ENTITLEMENT", "bad sponsor"));

        // Recipient lock: first successful entitlement binds forever for this op.
        if let Some(locked) = op.recipient.as_ref() {
            require!(
                locked == &recipient,
                "OPERATION: cannot change recipient on retry"
            );
        } else {
            op.recipient = Some(recipient.clone());
        }

        let Some(snap) = self.snapshots.get(&entitlement.snapshot_id).cloned() else {
            op.status = PrintOperationStatus::Failed;
            op.error_code = Some("SNAPSHOT_NOT_REGISTERED".into());
            self.operations.insert(op_key.to_string(), op);
            emit_event(
                "print_operation_failed",
                "{\"error_code\":\"SNAPSHOT_NOT_REGISTERED\"}",
            );
            self.refund_reserved_deposit(op_key);
            return;
        };
        if snap.manifest_hash != entitlement.manifest_hash {
            op.status = PrintOperationStatus::Failed;
            op.error_code = Some("MANIFEST_HASH_MISMATCH".into());
            self.operations.insert(op_key.to_string(), op);
            emit_event(
                "print_operation_failed",
                "{\"error_code\":\"MANIFEST_HASH_MISMATCH\"}",
            );
            self.refund_reserved_deposit(op_key);
            return;
        }

        let crop = normalize_crop(&entitlement.crop, snap.width, snap.height);
        validate_crop(&crop, snap.width, snap.height);

        let print_id = compute_print_id(
            &entitlement.snapshot_id,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
        )
        .unwrap_or_else(|e| reject("PRINT_ID", &e));

        let series_id = compute_bounty_series_id(
            &self.chain_genesis_hash,
            &bounty_contract.to_string(),
            bid,
        )
        .unwrap_or_else(|e| reject("SERIES_ID", &e));

        // Exactly one bounty-series mint globally.
        if let Some(existing_token) = self.bounty_series_issued.get(&series_id).cloned() {
            if op.token_id.as_ref() == Some(&existing_token)
                || self
                    .tokens
                    .get(&existing_token)
                    .map(|t| t.caller == *caller && t.operation_id == operation_id)
                    .unwrap_or(false)
            {
                op.status = PrintOperationStatus::Minted;
                op.print_id = Some(print_id);
                op.token_id = Some(existing_token.clone());
                op.series_id = Some(series_id);
                if let Some(t) = self.tokens.get(&existing_token) {
                    op.edition_number = Some(t.edition_number);
                }
                self.operations.insert(op_key.to_string(), op);
                self.settle_reserved_deposit(op_key, storage_before);
                return;
            }
            op.status = PrintOperationStatus::Conflict;
            op.error_code = Some("BOUNTY_SERIES_ALREADY_MINTED".into());
            self.operations.insert(op_key.to_string(), op);
            self.refund_reserved_deposit(op_key);
            return;
        }

        self.ensure_artwork(
            &print_id,
            &entitlement.snapshot_id,
            &snap.state_hash,
            &crop,
        );
        let series_key = series_map_key(&print_id, &series_id);
        if self.series.get(&series_key).is_none() {
            self.series.insert(
                series_key.clone(),
                SeriesRecord {
                    print_id: print_id.clone(),
                    series_id: series_id.clone(),
                    kind: SeriesKind::Bounty,
                    cap: 1,
                    next_edition: 1,
                    source_bounty_id: Some(bid),
                    source_escrow: Some(bounty_contract.clone()),
                },
            );
        }
        let series = self
            .series
            .get_mut(&series_key)
            .unwrap_or_else(|| reject("NOT_FOUND", "series"));
        require!(series.next_edition <= series.cap, "SERIES_CAP: bounty series exhausted");
        let edition = series.next_edition;
        series.next_edition = 2;
        let token_id = print_token_id(&print_id, &series_id, edition);
        let minted_at = env::block_timestamp();

        let token = TokenRecord {
            token_id: token_id.clone(),
            print_id: print_id.clone(),
            series_id: series_id.clone(),
            series_kind: SeriesKind::Bounty,
            edition_number: edition,
            mint_recipient: recipient.clone(),
            owner: recipient.clone(),
            operation_id: operation_id.to_string(),
            caller: caller.clone(),
            minted_at_ns: minted_at,
            source_bounty_id: Some(bid),
        };
        self.tokens.insert(token_id.clone(), token);
        self.bounty_series_issued
            .insert(series_id.clone(), token_id.clone());

        op.status = PrintOperationStatus::Minted;
        op.snapshot_id = Some(entitlement.snapshot_id);
        op.crop = Some(crop);
        op.recipient = Some(recipient.clone());
        op.print_id = Some(print_id.clone());
        op.token_id = Some(token_id.clone());
        op.series_id = Some(series_id.clone());
        op.edition_number = Some(edition);
        op.error_code = None;
        self.operations.insert(op_key.to_string(), op);

        emit_nep171_mint(&token_id, &recipient);
        emit_event(
            "print_minted",
            &format!(
                "{{\"print_id\":\"{print_id}\",\"token_id\":\"{token_id}\",\"series_id\":\"{series_id}\",\"edition\":{edition},\"kind\":\"bounty\",\"bounty_id\":\"{bid}\"}}"
            ),
        );
        self.settle_reserved_deposit(op_key, storage_before);
    }

    fn flush_storage(&mut self) {
        self.snapshots.flush();
        self.artworks.flush();
        self.series.flush();
        self.tokens.flush();
        self.operations.flush();
        self.escrow_allowlist.flush();
        self.bounty_series_issued.flush();
        self.pull_credits.flush();
    }

    /// Charge current call's storage growth from attached (+ prior hold), keep the rest reserved.
    fn reserve_storage_deposit(
        &mut self,
        storage_before: u64,
        op_key: &str,
        prior_reserved: u128,
    ) {
        self.flush_storage();
        let bytes_used = env::storage_usage().saturating_sub(storage_before);
        let required = env::storage_byte_cost()
            .saturating_mul(u128::from(bytes_used))
            .as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        let available = attached.saturating_add(prior_reserved);
        require!(
            available >= required,
            "STORAGE: attached deposit does not cover storage growth"
        );
        let reserved = available - required;
        if let Some(op) = self.operations.get_mut(op_key) {
            op.reserved_deposit = reserved;
        }
        self.operations.flush();
    }

    /// After callback mint writes: charge growth against reserved hold, refund remainder.
    fn settle_reserved_deposit(&mut self, op_key: &str, storage_before: u64) {
        self.flush_storage();
        let bytes_used = env::storage_usage().saturating_sub(storage_before);
        let required = env::storage_byte_cost()
            .saturating_mul(u128::from(bytes_used))
            .as_yoctonear();
        let Some(mut op) = self.operations.get(op_key).cloned() else {
            return;
        };
        let reserved = op.reserved_deposit;
        require!(
            reserved >= required,
            "STORAGE: reserved deposit does not cover mint storage growth"
        );
        let refund = reserved - required;
        op.reserved_deposit = 0;
        let caller = op.caller.clone();
        self.operations.insert(op_key.to_string(), op);
        self.operations.flush();
        if refund > 0 {
            self.refund_with_recovery(caller, refund);
        }
    }

    /// Return unused reserved deposit (permanent failure / conflict paths).
    fn refund_reserved_deposit(&mut self, op_key: &str) {
        let Some(mut op) = self.operations.get(op_key).cloned() else {
            return;
        };
        let refund = op.reserved_deposit;
        if refund == 0 {
            return;
        }
        op.reserved_deposit = 0;
        let caller = op.caller.clone();
        self.operations.insert(op_key.to_string(), op);
        self.operations.flush();
        self.refund_with_recovery(caller, refund);
    }

    /// Sync paths: charge attached deposit for storage growth and refund excess with recovery.
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
            self.refund_with_recovery(env::predecessor_account_id(), refund);
        }
    }

    /// Transfer refund; on failure credit `pull_credits` exactly once via callback.
    fn refund_with_recovery(&mut self, account_id: AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let _ = Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_REFUND_CALLBACK)
                    .on_storage_refund(account_id, amount.to_string()),
            );
    }

    /// NEP-171 ownership transfer. Returns previous owner. Requires 1 yocto.
    fn internal_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        memo: Option<String>,
    ) -> AccountId {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "NEP171: requires exactly 1 yoctoNEAR"
        );
        let owner = env::predecessor_account_id();
        let token = self
            .tokens
            .get_mut(&token_id)
            .unwrap_or_else(|| reject("NOT_FOUND", "token"));
        require!(token.owner == owner, "UNAUTHORIZED: owner only");
        require!(
            owner != receiver_id,
            "NEP171: current owner must differ from receiver"
        );
        token.owner = receiver_id.clone();
        let _ = memo;
        emit_nep171_transfer(&token_id, &owner, &receiver_id);
        owner
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn snapshot_equal(a: &SnapshotRecord, b: &SnapshotRecord) -> bool {
    a.snapshot_id == b.snapshot_id
        && a.state_hash == b.state_hash
        && a.board == b.board
        && a.width == b.width
        && a.height == b.height
        && a.palette_version == b.palette_version
        && a.finalized_block_hash == b.finalized_block_hash
        && a.finalized_block_height == b.finalized_block_height
        && a.finalized_block_timestamp_ns == b.finalized_block_timestamp_ns
        && a.revision == b.revision
        && a.receipt_id == b.receipt_id
        && a.manifest_uri == b.manifest_uri
        && a.manifest_hash == b.manifest_hash
        && a.attester_account_id == b.attester_account_id
        && a.media_hash == b.media_hash
}

fn normalize_crop(crop: &CropRect, board_w: u32, board_h: u32) -> CropRect {
    // Whole-board alias already expressed as (0,0,w,h) — no further rewrite needed.
    let _ = (board_w, board_h);
    crop.clone()
}

fn validate_crop(crop: &CropRect, board_w: u32, board_h: u32) {
    require!(crop.width > 0 && crop.height > 0, "CROP: positive size required");
    require!(
        crop.x
            .checked_add(crop.width)
            .is_some_and(|r| r <= board_w)
            && crop
                .y
                .checked_add(crop.height)
                .is_some_and(|b| b <= board_h),
        "CROP: out of board bounds"
    );
}

fn operation_key(caller: &AccountId, operation_id: &str) -> String {
    format!("{caller}\0{operation_id}")
}

fn series_map_key(print_id: &str, series_id: &str) -> String {
    format!("{print_id}\0{series_id}")
}

fn snapshot_to_view(s: &SnapshotRecord) -> SnapshotView {
    SnapshotView {
        snapshot_id: s.snapshot_id.clone(),
        state_hash: s.state_hash.clone(),
        board: s.board.clone(),
        width: s.width,
        height: s.height,
        palette_version: s.palette_version.clone(),
        finalized_block_hash: s.finalized_block_hash.clone(),
        finalized_block_height: s.finalized_block_height.clone(),
        finalized_block_timestamp_ns: s.finalized_block_timestamp_ns.to_string(),
        revision: s.revision.clone(),
        receipt_id: s.receipt_id.clone(),
        manifest_uri: s.manifest_uri.clone(),
        manifest_hash: s.manifest_hash.clone(),
        attester_account_id: s.attester_account_id.to_string(),
        media_hash: s.media_hash.clone(),
        registered_at_ns: s.registered_at_ns.to_string(),
    }
}

fn token_to_view(t: &TokenRecord) -> PrintEditionView {
    PrintEditionView {
        token_id: t.token_id.clone(),
        print_id: t.print_id.clone(),
        series_id: t.series_id.clone(),
        series_kind: t.series_kind.as_str().into(),
        edition_number: t.edition_number,
        mint_recipient: t.mint_recipient.to_string(),
        current_owner: t.owner.to_string(),
        operation_id: t.operation_id.clone(),
        minted_at_ns: t.minted_at_ns.to_string(),
        source_bounty_id: t.source_bounty_id.map(|id| id.to_string()),
    }
}

fn token_to_json(t: &TokenRecord) -> JsonToken {
    let extra = format!(
        "{{\"print_id\":\"{}\",\"series_id\":\"{}\",\"series_kind\":\"{}\",\"edition_number\":{},\"operation_id\":\"{}\"}}",
        t.print_id,
        t.series_id,
        t.series_kind.as_str(),
        t.edition_number,
        t.operation_id,
    );
    JsonToken {
        token_id: t.token_id.clone(),
        owner_id: t.owner.clone(),
        metadata: Some(TokenMetadata {
            title: Some(format!(
                "Meta Poo print {} #{}",
                &t.print_id[..8.min(t.print_id.len())],
                t.edition_number
            )),
            description: Some(format!(
                "Historical print attested via Meta Poo registry. Series {} ({})",
                t.series_id,
                t.series_kind.as_str()
            )),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(t.minted_at_ns.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(extra),
            reference: None,
            reference_hash: None,
        }),
        approved_account_ids: None,
    }
}

fn mint_result_from_op(op: &OperationRecord) -> MintResult {
    MintResult {
        print_id: op.print_id.clone().unwrap_or_default(),
        token_id: op.token_id.clone().unwrap_or_default(),
        series_id: op.series_id.clone().unwrap_or_default(),
        edition_number: op.edition_number.unwrap_or(0),
        status: op.status.as_str().into(),
    }
}

fn parse_u64(s: &str, label: &str) -> u64 {
    s.parse::<u64>()
        .unwrap_or_else(|_| reject("PARSE", &format!("{label} must be decimal u64")))
}

fn emit_event(event: &str, data_object: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{data_object}]}}"
    ));
}

fn emit_nep171_mint(token_id: &str, owner: &AccountId) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{NEP171_STANDARD}\",\"version\":\"{NEP171_VERSION}\",\"event\":\"nft_mint\",\"data\":[{{\"owner_id\":\"{owner}\",\"token_ids\":[\"{token_id}\"]}}]}}"
    ));
}

fn emit_nep171_transfer(token_id: &str, old_owner: &AccountId, new_owner: &AccountId) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{NEP171_STANDARD}\",\"version\":\"{NEP171_VERSION}\",\"event\":\"nft_transfer\",\"data\":[{{\"old_owner_id\":\"{old_owner}\",\"new_owner_id\":\"{new_owner}\",\"token_ids\":[\"{token_id}\"]}}]}}"
    ));
}

fn reject(code: &str, detail: &str) -> ! {
    env::panic_str(&format!("{code}: {detail}"));
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    const GENESIS: &str =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const SNAP_A: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const STATE_A: &str =
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const BLOCK_A: &str =
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn storage_deposit() -> u128 {
        NearToken::from_near(1).as_yoctonear()
    }

    fn attester() -> AccountId {
        MOCK_ATTESTER.parse().unwrap()
    }
    fn escrow() -> AccountId {
        MOCK_ESCROW.parse().unwrap()
    }
    fn prints_account() -> AccountId {
        MOCK_PRINTS.parse().unwrap()
    }
    fn alice() -> AccountId {
        accounts(0)
    }
    fn bob() -> AccountId {
        accounts(1)
    }
    fn sponsor() -> AccountId {
        accounts(2)
    }

    fn context_at(predecessor: AccountId, deposit: u128) {
        let ctx = VMContextBuilder::new()
            .current_account_id(prints_account())
            .predecessor_account_id(predecessor)
            .block_timestamp(1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build();
        testing_env!(ctx);
    }

    fn context_with_promise(predecessor: AccountId, promise_result: PromiseResult) {
        let ctx = VMContextBuilder::new()
            .current_account_id(prints_account())
            .predecessor_account_id(predecessor)
            .block_timestamp(1_000_000)
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

    fn setup() -> Prints {
        context_at(attester(), 0);
        let mut c = Prints::new_fixture(attester(), GENESIS.into());
        context_at(attester(), 0);
        c.allowlist_escrow(escrow());
        c
    }

    fn sample_manifest(snapshot_id: &str) -> SnapshotManifestInput {
        SnapshotManifestInput {
            snapshot_id: snapshot_id.into(),
            state_hash: STATE_A.into(),
            board: BoardIdentity {
                chain_id: "testnet".into(),
                board_account_id: "board.mpoo.testnet".into(),
                board_epoch: "epoch-1".into(),
            },
            width: 128,
            height: 128,
            palette_version: "1".into(),
            finalized_block_hash: BLOCK_A.into(),
            finalized_block_height: "100".into(),
            finalized_block_timestamp_ns: "5000".into(),
            revision: "42".into(),
            receipt_id: String::new(),
            manifest_uri: "ipfs://bafy-manifest".into(),
            manifest_hash: "mh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            attester_account_id: MOCK_ATTESTER.into(),
            media_hash: Some("media-hash".into()),
        }
    }

    fn whole_board() -> CropRect {
        CropRect {
            x: 0,
            y: 0,
            width: 128,
            height: 128,
        }
    }

    fn crop_16() -> CropRect {
        CropRect {
            x: 16,
            y: 16,
            width: 32,
            height: 32,
        }
    }

    fn register(c: &mut Prints, snap: &str) {
        context_at(attester(), storage_deposit());
        c.register_snapshot(sample_manifest(snap));
    }

    #[test]
    fn register_snapshot_attester_only_and_idempotent() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        let view = c.get_snapshot(SNAP_A.into());
        assert_eq!(view.revision, "42");
        assert_eq!(view.attester_account_id, MOCK_ATTESTER);

        // Exact duplicate is idempotent.
        register(&mut c, SNAP_A);
        assert_eq!(c.get_snapshot(SNAP_A.into()).manifest_hash, view.manifest_hash);
    }

    #[test]
    #[should_panic(expected = "UNAUTHORIZED: attester only")]
    fn wrong_attester_rejected() {
        let mut c = setup();
        context_at(alice(), storage_deposit());
        c.register_snapshot(sample_manifest(SNAP_A));
    }

    #[test]
    #[should_panic(expected = "SNAPSHOT: conflicting data")]
    fn conflicting_snapshot_rejected() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(attester(), storage_deposit());
        let mut bad = sample_manifest(SNAP_A);
        bad.revision = "99".into();
        c.register_snapshot(bad);
    }

    #[test]
    fn publish_snapshot_reference_calls_allowlisted_escrow() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let _ = c.publish_snapshot_reference(SNAP_A.into(), escrow());
        let receipts = get_created_receipts();
        assert!(
            !receipts.is_empty(),
            "expected outbound register_snapshot_reference receipt"
        );
        let found = receipts.iter().any(|r| {
            r.receiver_id == escrow()
                && r.actions.iter().any(|a| matches!(
                    a,
                    MockAction::FunctionCallWeight { method_name, .. }
                        if method_name == b"register_snapshot_reference"
                ))
        });
        assert!(found, "escrow register_snapshot_reference call missing");
    }

    #[test]
    #[should_panic(expected = "UNAUTHORIZED: escrow not allowlisted")]
    fn publish_rejects_wrong_escrow() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let _ = c.publish_snapshot_reference(
            SNAP_A.into(),
            "evil.escrow.test.near".parse().unwrap(),
        );
    }

    #[test]
    fn public_mint_and_operation_recovery() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let r1 = c.mint_print(SNAP_A.into(), whole_board(), alice(), "op-1".into());
        assert_eq!(r1.edition_number, 1);
        assert_eq!(r1.series_id, PUBLIC_SERIES_ID);
        assert_eq!(r1.status, "minted");

        // Duplicate operation recovers same token.
        context_at(alice(), storage_deposit());
        let r2 = c.mint_print(SNAP_A.into(), whole_board(), alice(), "op-1".into());
        assert_eq!(r2.token_id, r1.token_id);
        assert_eq!(r2.edition_number, 1);

        let op = c.get_print_operation(alice().to_string(), "op-1".into());
        assert_eq!(op.status, "minted");
        assert_eq!(op.token_id.as_deref(), Some(r1.token_id.as_str()));

        let print = c.get_print(r1.print_id.clone());
        assert_eq!(print.series[0].issued, 1);
        assert_eq!(print.series[0].cap, 100);
    }

    #[test]
    #[should_panic(expected = "OPERATION: conflicting arguments")]
    fn duplicate_op_different_args_fails() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let _ = c.mint_print(SNAP_A.into(), whole_board(), alice(), "op-x".into());
        context_at(alice(), storage_deposit());
        let _ = c.mint_print(SNAP_A.into(), crop_16(), alice(), "op-x".into());
    }

    #[test]
    fn concurrent_last_edition_allocates_distinct_numbers() {
        // Cap = 2: two callers each get a unique edition (atomic next_edition).
        context_at(attester(), 0);
        let mut c = Prints::new(attester(), GENESIS.into(), 128, 128, 2);
        context_at(attester(), 0);
        c.allowlist_escrow(escrow());
        register(&mut c, SNAP_A);

        context_at(alice(), storage_deposit());
        let a = c.mint_print(SNAP_A.into(), whole_board(), alice(), "last-a".into());
        assert_eq!(a.edition_number, 1);

        context_at(bob(), storage_deposit());
        let b = c.mint_print(SNAP_A.into(), whole_board(), bob(), "last-b".into());
        assert_eq!(b.edition_number, 2);
        assert_ne!(a.token_id, b.token_id);

        let print = c.get_print(a.print_id);
        let public = print
            .series
            .iter()
            .find(|s| s.series_id == PUBLIC_SERIES_ID)
            .unwrap();
        assert_eq!(public.issued, 2);
        assert_eq!(public.remaining, 0);
    }

    #[test]
    #[should_panic(expected = "SERIES_CAP: public series exhausted")]
    fn last_edition_loser_rejected() {
        context_at(attester(), 0);
        let mut c = Prints::new(attester(), GENESIS.into(), 128, 128, 2);
        context_at(attester(), 0);
        c.allowlist_escrow(escrow());
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let _ = c.mint_print(SNAP_A.into(), whole_board(), alice(), "cap-a".into());
        context_at(bob(), storage_deposit());
        let _ = c.mint_print(SNAP_A.into(), whole_board(), bob(), "cap-b".into());
        // Losing concurrent claim after cap is exhausted.
        context_at(alice(), storage_deposit());
        let _ = c.mint_print(SNAP_A.into(), whole_board(), alice(), "cap-c".into());
    }

    #[test]
    fn public_mint_does_not_consume_bounty_series() {
        let mut c = setup();
        register(&mut c, SNAP_A);

        context_at(alice(), storage_deposit());
        let pub_mint = c.mint_print(SNAP_A.into(), crop_16(), alice(), "pub-1".into());
        assert_eq!(pub_mint.series_id, PUBLIC_SERIES_ID);

        // Bounty path via callback stub.
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "7".into(), "bounty-op-1".into());

        let entitlement = PrintEntitlementView {
            bounty_id: "7".into(),
            sponsor: sponsor().to_string(),
            snapshot_id: SNAP_A.into(),
            manifest_hash: sample_manifest(SNAP_A).manifest_hash,
            crop: crop_16(),
            entitlement_key: format!("testnet:{}:7", MOCK_ESCROW),
        };
        let bytes = near_sdk::serde_json::to_vec(&entitlement).unwrap();
        context_with_promise(
            prints_account(),
            PromiseResult::Successful(bytes),
        );
        c.on_print_entitlement(sponsor().to_string(), "bounty-op-1".into());

        let op = c.get_print_operation(sponsor().to_string(), "bounty-op-1".into());
        assert_eq!(op.status, "minted");
        assert_ne!(op.series_id.as_deref(), Some(PUBLIC_SERIES_ID));
        assert_eq!(op.edition_number, Some(1));

        // Public series still only issued 1.
        let print = c.get_print(pub_mint.print_id);
        let public = print
            .series
            .iter()
            .find(|s| s.series_id == PUBLIC_SERIES_ID)
            .unwrap();
        assert_eq!(public.issued, 1);
        let bounty = print
            .series
            .iter()
            .find(|s| s.series_kind == "bounty")
            .unwrap();
        assert_eq!(bounty.cap, 1);
        assert_eq!(bounty.issued, 1);
    }

    #[test]
    #[should_panic(expected = "UNAUTHORIZED: escrow not allowlisted")]
    fn mint_bounty_rejects_wrong_escrow() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(
            "evil.escrow.test.near".parse().unwrap(),
            "1".into(),
            "op".into(),
        );
    }

    #[test]
    fn bounty_recipient_locked_on_retry() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "3".into(), "lock-op".into());

        let entitlement = PrintEntitlementView {
            bounty_id: "3".into(),
            sponsor: sponsor().to_string(),
            snapshot_id: SNAP_A.into(),
            manifest_hash: sample_manifest(SNAP_A).manifest_hash,
            crop: crop_16(),
            entitlement_key: "k".into(),
        };
        let bytes = near_sdk::serde_json::to_vec(&entitlement).unwrap();
        context_with_promise(prints_account(), PromiseResult::Successful(bytes.clone()));
        c.on_print_entitlement(sponsor().to_string(), "lock-op".into());

        let token_id = c
            .get_print_operation(sponsor().to_string(), "lock-op".into())
            .token_id
            .unwrap();
        let edition = c.get_print_edition(token_id.clone());
        assert_eq!(edition.mint_recipient, sponsor().to_string());
        let nep = c.nft_token(token_id.clone()).expect("nep token");
        assert_eq!(nep.owner_id, sponsor());
        assert!(nep.metadata.is_some());

        // Retry same op → same token / recipient (recovery).
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "3".into(), "lock-op".into());
        let again = c.get_print_operation(sponsor().to_string(), "lock-op".into());
        assert_eq!(again.token_id.as_deref(), Some(token_id.as_str()));
        assert_eq!(again.status, "minted");
    }

    #[test]
    fn entitlement_query_failure_is_retryable() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "9".into(), "fail-op".into());

        context_with_promise(prints_account(), PromiseResult::Failed);
        c.on_print_entitlement(sponsor().to_string(), "fail-op".into());
        let failed = c.get_print_operation(sponsor().to_string(), "fail-op".into());
        assert_eq!(failed.status, "failed");
        assert!(failed.token_id.is_none());

        // Retry query then succeed — still no prior edition consumed.
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "9".into(), "fail-op".into());
        let entitlement = PrintEntitlementView {
            bounty_id: "9".into(),
            sponsor: sponsor().to_string(),
            snapshot_id: SNAP_A.into(),
            manifest_hash: sample_manifest(SNAP_A).manifest_hash,
            crop: crop_16(),
            entitlement_key: "k".into(),
        };
        let bytes = near_sdk::serde_json::to_vec(&entitlement).unwrap();
        context_with_promise(prints_account(), PromiseResult::Successful(bytes));
        c.on_print_entitlement(sponsor().to_string(), "fail-op".into());
        assert_eq!(
            c.get_print_operation(sponsor().to_string(), "fail-op".into())
                .status,
            "minted"
        );
    }

    #[test]
    fn series_caps_discoverable_before_mint() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        // Artwork is created on first mint; probe identity prep by minting then checking.
        context_at(alice(), storage_deposit());
        let r = c.mint_print(SNAP_A.into(), whole_board(), alice(), "disc".into());
        let view = c.get_print(r.print_id);
        assert!(view.series.iter().any(|s| s.series_id == PUBLIC_SERIES_ID && s.cap == 100));
        let ident = c.get_deployment_identity();
        assert_eq!(ident.public_series_cap, 100);
        assert_eq!(ident.public_series_id, PUBLIC_SERIES_ID);
    }

    #[test]
    fn bounty_mint_reserves_deposit_until_callback_settles() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "12".into(), "reserve-op".into());
        let pending = c.get_print_operation(sponsor().to_string(), "reserve-op".into());
        assert_eq!(pending.status, "querying_entitlement");
        let reserved: u128 = pending.reserved_deposit.parse().unwrap();
        assert!(
            reserved > 0,
            "excess deposit must remain reserved for callback mint storage"
        );

        let entitlement = PrintEntitlementView {
            bounty_id: "12".into(),
            sponsor: sponsor().to_string(),
            snapshot_id: SNAP_A.into(),
            manifest_hash: sample_manifest(SNAP_A).manifest_hash,
            crop: crop_16(),
            entitlement_key: "k".into(),
        };
        let bytes = near_sdk::serde_json::to_vec(&entitlement).unwrap();
        context_with_promise(prints_account(), PromiseResult::Successful(bytes));
        c.on_print_entitlement(sponsor().to_string(), "reserve-op".into());

        let done = c.get_print_operation(sponsor().to_string(), "reserve-op".into());
        assert_eq!(done.status, "minted");
        assert_eq!(done.reserved_deposit, "0");
    }

    #[test]
    fn failed_storage_refund_credits_pull_and_withdraw_retries() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let _ = c.mint_print(SNAP_A.into(), whole_board(), alice(), "refund-op".into());

        // Simulate refund transfer failure → restore pull credit once.
        context_with_promise(prints_account(), PromiseResult::Failed);
        c.on_storage_refund(alice(), "12345".into());
        assert_eq!(c.get_pull_credit(alice()), "12345");

        // Withdraw clears credit and schedules another transfer+callback.
        context_at(alice(), 0);
        let _ = c.withdraw_pull_credit();
        assert_eq!(c.get_pull_credit(alice()), "0");

        // If that transfer also fails, credit is restored exactly once.
        context_with_promise(prints_account(), PromiseResult::Failed);
        c.on_storage_refund(alice(), "12345".into());
        assert_eq!(c.get_pull_credit(alice()), "12345");
    }

    #[test]
    fn nep171_token_and_metadata_views() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let minted = c.mint_print(SNAP_A.into(), crop_16(), alice(), "nep-op".into());
        let meta = c.nft_metadata();
        assert_eq!(meta.spec, "nft-1.0.0");
        assert_eq!(meta.symbol, "MPOOP");
        let token = c.nft_token(minted.token_id.clone()).expect("token");
        assert_eq!(token.token_id, minted.token_id);
        assert_eq!(token.owner_id, alice());
        assert!(token.metadata.as_ref().unwrap().title.is_some());
        assert!(c.nft_token("missing".into()).is_none());
        // Custom edition view remains available separately.
        let edition = c.get_print_edition(minted.token_id);
        assert_eq!(edition.edition_number, 1);
        assert_eq!(edition.series_kind, "public");
    }

    #[test]
    fn malformed_entitlement_commits_failure_and_refunds_reserve() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(sponsor(), storage_deposit());
        let _ = c.mint_bounty_print(escrow(), "44".into(), "bad-json-op".into());
        let pending = c.get_print_operation(sponsor().to_string(), "bad-json-op".into());
        assert_eq!(pending.status, "querying_entitlement");
        let reserved_before: u128 = pending.reserved_deposit.parse().unwrap();
        assert!(reserved_before > 0);

        // Malformed entitlement JSON — must not panic (rollback would undo failure+refund).
        context_with_promise(
            prints_account(),
            PromiseResult::Successful(b"not-valid-json".to_vec()),
        );
        c.on_print_entitlement(sponsor().to_string(), "bad-json-op".into());

        let failed = c.get_print_operation(sponsor().to_string(), "bad-json-op".into());
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error_code.as_deref(), Some("ENTITLEMENT_DECODE"));
        assert_eq!(failed.reserved_deposit, "0");
        assert!(failed.token_id.is_none());
    }

    #[test]
    fn nft_resolve_transfer_acceptance_keeps_receiver() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let minted = c.mint_print(SNAP_A.into(), crop_16(), alice(), "xfer-accept".into());
        let token_id = minted.token_id;

        context_at(alice(), 1);
        c.nft_transfer(bob(), token_id.clone(), None);
        assert_eq!(c.nft_token(token_id.clone()).unwrap().owner_id, bob());

        // Receiver returns false → keep transfer (NEP-171: do not revert).
        context_with_promise(
            prints_account(),
            PromiseResult::Successful(near_sdk::serde_json::to_vec(&false).unwrap()),
        );
        let kept = c.nft_resolve_transfer(alice(), bob(), token_id.clone());
        assert!(kept);
        assert_eq!(c.nft_token(token_id).unwrap().owner_id, bob());
    }

    #[test]
    fn nft_resolve_transfer_rejection_restores_previous_owner() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let minted = c.mint_print(SNAP_A.into(), crop_16(), alice(), "xfer-reject".into());
        let token_id = minted.token_id;

        context_at(alice(), 1);
        c.nft_transfer(bob(), token_id.clone(), None);

        context_with_promise(
            prints_account(),
            PromiseResult::Successful(near_sdk::serde_json::to_vec(&true).unwrap()),
        );
        let reverted = c.nft_resolve_transfer(alice(), bob(), token_id.clone());
        assert!(!reverted);
        assert_eq!(c.nft_token(token_id).unwrap().owner_id, alice());
    }

    #[test]
    fn nft_resolve_transfer_receiver_failure_restores_previous_owner() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let minted = c.mint_print(SNAP_A.into(), crop_16(), alice(), "xfer-fail".into());
        let token_id = minted.token_id;

        context_at(alice(), 1);
        c.nft_transfer(bob(), token_id.clone(), None);

        context_with_promise(prints_account(), PromiseResult::Failed);
        let reverted = c.nft_resolve_transfer(alice(), bob(), token_id.clone());
        assert!(!reverted);
        assert_eq!(c.nft_token(token_id).unwrap().owner_id, alice());
    }

    #[test]
    fn nft_resolve_transfer_onward_move_returns_success() {
        let mut c = setup();
        register(&mut c, SNAP_A);
        context_at(alice(), storage_deposit());
        let minted = c.mint_print(SNAP_A.into(), crop_16(), alice(), "xfer-onward".into());
        let token_id = minted.token_id;

        // Alice → Bob, then Bob → sponsor before resolve asks to revert.
        context_at(alice(), 1);
        c.nft_transfer(bob(), token_id.clone(), None);
        context_at(bob(), 1);
        c.nft_transfer(sponsor(), token_id.clone(), None);
        assert_eq!(c.nft_token(token_id.clone()).unwrap().owner_id, sponsor());

        context_with_promise(
            prints_account(),
            PromiseResult::Successful(near_sdk::serde_json::to_vec(&true).unwrap()),
        );
        // Cannot restore Alice←Bob because Bob no longer owns it.
        let outcome = c.nft_resolve_transfer(alice(), bob(), token_id.clone());
        assert!(outcome);
        assert_eq!(c.nft_token(token_id).unwrap().owner_id, sponsor());
    }
}
