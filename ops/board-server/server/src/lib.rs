//! Board server library: the parts `main.rs` wires together, public so the integration tests
//! can drive them against a real Valkey.
pub mod api;
pub mod board;
pub mod consumer;
pub mod history_api;
pub use common::valkey;
pub mod ws;
