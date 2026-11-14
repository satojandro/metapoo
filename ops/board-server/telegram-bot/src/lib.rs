//! AWAY-B (return-and-growth spec §1.3): the Telegram bot. It long-polls Telegram
//! (`getUpdates`; no webhook and no listening socket), takes link codes and `/stop`, and sends
//! "your tiles were covered" alerts from the cover events the board server already keeps in
//! Valkey. Public as a library so the tests can drive it with a fake Telegram.
pub mod alerts;
pub mod bot;
pub mod tg;
