//! Embedded operation records, immutable proposals, and explicit crash recovery.
//!
//! The host owns authorization and external effects. Call [`Journal::begin`] and
//! commit before an effect; a crash afterwards requires reconciliation, not replay.
//! This synchronous library starts no threads, servers, processes, or timers.

pub mod bridge;
mod journal;
mod model;

pub use journal::Journal;
pub use model::*;

/// Failures preserve the previous committed record.
#[derive(Debug)]
pub enum Error {
    /// The host-owned database parent directory cannot be resolved.
    Io(std::io::Error),
    /// SQLite could not read, lock, or commit the journal.
    Database(rusqlite::Error),
    /// A stored or supplied JSON value is invalid.
    Json(serde_json::Error),
    /// A bounded input or clock value is invalid.
    InvalidInput(&'static str),
    /// An immutable identifier was reused with different content.
    Conflict,
    /// The requested record does not exist.
    NotFound,
    /// The requested transition is not allowed from this state.
    InvalidState(State),
    /// Another run owns this operation.
    WrongRun,
    /// The recorded approval has expired.
    ApprovalExpired,
    /// This file belongs to another application or has an unsupported schema.
    IncompatibleDatabase,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "journal directory: {e}"),
            Self::Database(e) => write!(f, "journal database: {e}"),
            Self::Json(e) => write!(f, "journal JSON: {e}"),
            Self::InvalidInput(e) => write!(f, "invalid input: {e}"),
            Self::Conflict => f.write_str("identifier already has different immutable content"),
            Self::NotFound => f.write_str("journal record not found"),
            Self::InvalidState(s) => write!(f, "transition not allowed from {s:?}"),
            Self::WrongRun => f.write_str("operation belongs to another run"),
            Self::ApprovalExpired => f.write_str("approval expired; revoke and review again"),
            Self::IncompatibleDatabase => f.write_str("foreign or unsupported journal database"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Database(e) => Some(e),
            Self::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

/// Library result; no failed transition authorizes an external effect.
pub type Result<T> = std::result::Result<T, Error>;
