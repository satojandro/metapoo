//! Shared by the indexer and the server: the board's binary format, its events, and how an
//! event is applied. A port of `fastnear/berry-fast` `backend/common`, changed only where the
//! Meta Poo contract forces it (spec §3).
pub mod account;
pub mod apply;
pub mod catchup;
pub mod demand;
pub mod event;
pub mod history;
pub mod history_wire;
pub mod keys;
pub mod palette;
pub mod region;
pub mod valkey;

pub use apply::*;
pub use catchup::*;
pub use event::*;
pub use region::*;
