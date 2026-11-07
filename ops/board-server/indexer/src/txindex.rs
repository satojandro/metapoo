//! The board's events from FastNEAR's transaction index (`tx.main.fastnear.com`), instead of
//! from every block.
//!
//! **Why.** The NEAR Data stream costs one request per block whether or not anyone paints:
//! about 6,200 an hour on mainnet (600 ms blocks). Measured on the owner's FastNEAR dashboard
//! on 7 Nov, it ran at ~6,000 an hour on a board that had been idle for nine hours. The index
//! is per account, so here the cost follows the board's activity:
//!
//! - nobody watching: no requests at all (the caller gates on viewers);
//! - someone watching, nothing painted: `/status` and a one-row `/v0/account`, per poll;
//! - paint: plus one `/v0/transactions` per 20 new transactions.
//!
//! A cold start reads the board's whole history the same way. That was 316 transactions on
//! 7 Nov, so about 20 requests instead of ~320k blocks.
//!
//! **Ordering.** An event is queued only once its transaction is final (every receipt it
//! created has executed) and every transaction up to the cut height has been listed. The cut
//! is the index head, lowered below any unfinished transaction. Events at or below the
//! watermark are never queued again, and the server's position guard drops any that are.

use std::collections::HashMap;
use std::future::Future;

use common::{parse_log, ParseOutcome, QueuedEvent};
use serde_json::Value;

/// Rows per `/v0/account` page: the API's maximum (web `FASTNEAR_ACCOUNT_PAGE`).
pub const ACCOUNT_PAGE: usize = 200;
/// Hashes per `/v0/transactions` request: the API's maximum (web `FASTNEAR_TX_BATCH`).
pub const TX_BATCH: usize = 20;
/// How far below the watermark to re-list transactions, in blocks. A transaction included
/// there may still have receipts executing above the watermark. A board call executes in the
/// next block; 200 blocks (~2 min) is generous.
pub const LOOKBACK_BLOCKS: u64 = 200;

/// One `/v0/account` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRow {
    pub hash: String,
    pub tx_block_height: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountPage {
    pub rows: Vec<AccountRow>,
    pub txs_count: Option<u64>,
    pub resume_token: Option<String>,
}

/// What the indexer needs from the index. A trait so the poll logic is tested without HTTP.
pub trait TxIndex {
    /// The height through which the index has transactions (`/status` `latest_tx_block_height`).
    fn head(&self) -> impl Future<Output = anyhow::Result<u64>> + Send;
    /// Newest first.
    fn account(
        &self,
        limit: usize,
        resume: Option<&str>,
    ) -> impl Future<Output = anyhow::Result<AccountPage>> + Send;
    /// Index items (RPC-shaped tx status) for up to [`TX_BATCH`] hashes.
    fn transactions(
        &self,
        hashes: &[String],
    ) -> impl Future<Output = anyhow::Result<Vec<Value>>> + Send;
}

/// The board events in one index item, or `None` while the transaction is still running.
///
/// Same filter as the block indexer: only receipts **executed by the board** that **succeeded**.
pub fn events_from_tx(item: &Value, board: &str) -> (Option<Vec<QueuedEvent>>, Vec<String>) {
    if !is_finalised(item) {
        return (None, Vec::new());
    }
    let mut events = Vec::new();
    let mut warnings = Vec::new();
    for receipt in item["receipts"].as_array().into_iter().flatten() {
        let outcome = &receipt["execution_outcome"];
        let inner = &outcome["outcome"];
        if inner["executor_id"].as_str() != Some(board)
            || receipt["receipt"]["receiver_id"].as_str() != Some(board)
        {
            continue;
        }
        let status = &inner["status"];
        if status.get("SuccessValue").is_none() && status.get("SuccessReceiptId").is_none() {
            continue;
        }
        let (Some(block_height), Some(index)) =
            (outcome["block_height"].as_u64(), outcome["index"].as_u64())
        else {
            warnings.push(format!(
                "receipt {} has no block height or index",
                outcome["id"]
            ));
            continue;
        };
        let block_timestamp_ms = outcome["block_timestamp"].as_u64().unwrap_or(0) / 1_000_000;
        let receipt_id = outcome["id"].as_str().unwrap_or_default().to_string();
        let predecessor_id = receipt["receipt"]["predecessor_id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        for (log_index, line) in inner["logs"].as_array().into_iter().flatten().enumerate() {
            let Some(line) = line.as_str() else { continue };
            match parse_log(line) {
                ParseOutcome::Skip => {}
                ParseOutcome::Malformed(why) => {
                    warnings.push(format!("block {block_height} receipt {receipt_id}: {why}"))
                }
                ParseOutcome::Event(event) => events.push(QueuedEvent {
                    block_height,
                    block_timestamp_ms,
                    // Outcome order within the block, then log order. The board lives on one
                    // shard, so this orders every board receipt in a block.
                    seq: (index as u32)
                        .saturating_mul(16)
                        .saturating_add(log_index.min(15) as u32),
                    receipt_id: receipt_id.clone(),
                    predecessor_id: predecessor_id.clone(),
                    event,
                }),
            }
        }
    }
    (Some(events), warnings)
}

/// Every receipt the transaction created has an outcome in the item. Same rule as the web
/// ledger (`buyback-ledger.ts` `isFinalised`).
pub fn is_finalised(item: &Value) -> bool {
    let outcomes: Vec<&Value> = std::iter::once(&item["execution_outcome"])
        .chain(
            item["receipts"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| &r["execution_outcome"]),
        )
        .collect();
    let present: std::collections::HashSet<&str> =
        outcomes.iter().filter_map(|o| o["id"].as_str()).collect();
    outcomes.iter().all(|o| {
        o["outcome"]["receipt_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .all(|id| id.as_str().is_some_and(|id| present.contains(id)))
    })
}

fn tx_hash(item: &Value) -> Option<&str> {
    item["transaction"]["hash"].as_str()
}

/// What one poll decided: events to queue (in order) and the new watermark.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PollResult {
    pub events: Vec<QueuedEvent>,
    /// Every board event at or below this height has been queued (now or before).
    pub watermark: u64,
    pub warnings: Vec<String>,
    /// Requests this poll made, for the log and the tests.
    pub requests: u32,
}

/// The poll state. `watermark` is persisted by the caller (`last_processed_block`).
pub struct Cursor {
    pub watermark: u64,
    /// `txs_count` at the last poll that left nothing pending. `None` forces a listing.
    known_count: Option<u64>,
    /// Final transactions already read: hash → (tx height, events). Pruned below the lookback.
    cache: HashMap<String, (u64, Vec<QueuedEvent>)>,
}

impl Cursor {
    pub fn new(watermark: u64) -> Self {
        Self {
            watermark,
            known_count: None,
            cache: HashMap::new(),
        }
    }

    pub async fn poll(&mut self, board: &str, index: &impl TxIndex) -> anyhow::Result<PollResult> {
        let mut requests = 0;
        // The head first: anything at or below it is already in the listing read next.
        let head = index.head().await?;
        requests += 1;
        let first = index.account(1, None).await?;
        requests += 1;
        if first.txs_count.is_some() && first.txs_count == self.known_count {
            // No new transaction touches the board, and nothing was pending.
            self.watermark = self.watermark.max(head);
            return Ok(PollResult {
                watermark: self.watermark,
                requests,
                ..Default::default()
            });
        }

        // Something changed: list back to the lookback.
        let floor = self.watermark.saturating_sub(LOOKBACK_BLOCKS);
        let mut rows: Vec<AccountRow> = Vec::new();
        let mut resume: Option<String> = None;
        loop {
            let page = index.account(ACCOUNT_PAGE, resume.as_deref()).await?;
            requests += 1;
            let full = page.rows.len() >= ACCOUNT_PAGE;
            let reached_floor = page.rows.iter().any(|r| r.tx_block_height <= floor);
            rows.extend(page.rows.into_iter().filter(|r| r.tx_block_height > floor));
            match page.resume_token {
                Some(token) if full && !reached_floor => resume = Some(token),
                _ => break,
            }
        }

        let mut cut = head;
        let mut above_head = false;
        let wanted: Vec<&AccountRow> = rows
            .iter()
            .filter(|r| {
                if r.tx_block_height > head {
                    above_head = true;
                    false
                } else {
                    true
                }
            })
            .collect();
        let missing: Vec<String> = wanted
            .iter()
            .filter(|r| !self.cache.contains_key(&r.hash))
            .map(|r| r.hash.clone())
            .collect();
        let heights: HashMap<&str, u64> = wanted
            .iter()
            .map(|r| (r.hash.as_str(), r.tx_block_height))
            .collect();
        let mut warnings = Vec::new();
        let mut unfinished = false;
        for batch in missing.chunks(TX_BATCH) {
            let items = index.transactions(batch).await?;
            requests += 1;
            let mut seen = 0;
            for item in &items {
                let Some(hash) = tx_hash(item) else { continue };
                let Some(&height) = heights.get(hash) else {
                    continue;
                };
                seen += 1;
                let (events, mut w) = events_from_tx(item, board);
                warnings.append(&mut w);
                match events {
                    Some(events) => {
                        self.cache.insert(hash.to_string(), (height, events));
                    }
                    None => {
                        unfinished = true;
                        cut = cut.min(height.saturating_sub(1));
                    }
                }
            }
            if seen < batch.len() {
                // The index listed a transaction it cannot return yet: treat it as unfinished.
                unfinished = true;
                for hash in batch {
                    if !self.cache.contains_key(hash) {
                        cut = cut.min(heights[hash.as_str()].saturating_sub(1));
                    }
                }
            }
        }

        let cut = cut.max(self.watermark);
        let mut events: Vec<QueuedEvent> = wanted
            .iter()
            .filter_map(|r| self.cache.get(&r.hash))
            .flat_map(|(_, events)| events.iter())
            .filter(|e| e.block_height > self.watermark && e.block_height <= cut)
            .cloned()
            .collect();
        events.sort_by_key(QueuedEvent::position);
        events.dedup_by_key(|e| e.position());

        self.watermark = cut;
        self.known_count = if unfinished || above_head {
            None
        } else {
            first.txs_count
        };
        let floor = self.watermark.saturating_sub(LOOKBACK_BLOCKS);
        self.cache.retain(|_, (height, _)| *height > floor);
        Ok(PollResult {
            events,
            watermark: self.watermark,
            warnings,
            requests,
        })
    }
}

/// The real index, over HTTP.
pub struct HttpTxIndex {
    base: String,
    board: String,
    http: reqwest::Client,
    api_key: Option<String>,
}

impl HttpTxIndex {
    /// `base`: `https://tx.main.fastnear.com` (mainnet) or `https://tx.test.fastnear.com`.
    pub fn new(base: &str, board: &str, api_key: Option<String>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("metapoo-board-server")
            .build()?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            board: board.to_string(),
            http,
            api_key,
        })
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> anyhow::Result<Value> {
        let req = match &self.api_key {
            Some(key) => req.bearer_auth(key),
            None => req,
        };
        let response = req.send().await?;
        let status = response.status();
        if !status.is_success() {
            anyhow::bail!("tx index HTTP {status}");
        }
        Ok(response.json().await?)
    }
}

impl TxIndex for HttpTxIndex {
    async fn head(&self) -> anyhow::Result<u64> {
        let body = self
            .send(self.http.get(format!("{}/status", self.base)))
            .await?;
        body["latest_tx_block_height"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("tx index /status without latest_tx_block_height"))
    }

    async fn account(&self, limit: usize, resume: Option<&str>) -> anyhow::Result<AccountPage> {
        let mut request =
            serde_json::json!({ "account_id": self.board, "desc": true, "limit": limit });
        if let Some(token) = resume {
            request["resume_token"] = Value::String(token.to_string());
        }
        let body = self
            .send(
                self.http
                    .post(format!("{}/v0/account", self.base))
                    .json(&request),
            )
            .await?;
        let rows = body["account_txs"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("tx index /v0/account without account_txs"))?
            .iter()
            .filter_map(|row| {
                Some(AccountRow {
                    hash: row["transaction_hash"].as_str()?.to_string(),
                    tx_block_height: row["tx_block_height"].as_u64()?,
                })
            })
            .collect();
        Ok(AccountPage {
            rows,
            txs_count: body["txs_count"].as_u64(),
            resume_token: body["resume_token"].as_str().map(str::to_string),
        })
    }

    async fn transactions(&self, hashes: &[String]) -> anyhow::Result<Vec<Value>> {
        let body = self
            .send(
                self.http
                    .post(format!("{}/v0/transactions", self.base))
                    .json(&serde_json::json!({ "tx_hashes": hashes })),
            )
            .await?;
        Ok(body["transactions"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("tx index /v0/transactions without transactions"))?
            .clone())
    }
}
