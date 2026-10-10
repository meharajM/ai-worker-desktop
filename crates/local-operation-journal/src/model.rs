use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Immutable task identity. IDs are caller-provided, globally unique, nonempty,
/// at most 128 UTF-8 bytes, and contain no control characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewTask {
    pub id: String,
    pub title: String,
}

/// Task grouping metadata. Workflow scheduling remains a host concern.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub task: NewTask,
    pub created_ms: i64,
}

/// Immutable proposal; the ID is its idempotency key. The host must validate
/// payload semantics and bind all paths, hashes, argv, scope and effects here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    /// Opaque JSON, at most 64 KiB serialized. Never store credentials here.
    pub payload: Value,
}

/// Durable facts, never proof that an OS effect happened exactly once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Approved,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

impl State {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Uncertain => "uncertain",
        }
    }
}

/// Current operation and its native-owned approval/execution receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub intent: Intent,
    pub state: State,
    pub run_id: Option<String>,
    pub approval_expires_ms: Option<i64>,
    pub outcome: Option<Value>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// Verified terminal outcome. Use `uncertain` if effects cannot be established.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "receipt", rename_all = "snake_case")]
pub enum Outcome {
    Succeeded(Value),
    Failed(Value),
}

impl Outcome {
    pub(crate) fn parts(&self) -> (State, &Value) {
        match self {
            Self::Succeeded(v) => (State::Succeeded, v),
            Self::Failed(v) => (State::Failed, v),
        }
    }
}

/// Append-only state transition, committed with the operation update.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub sequence: i64,
    pub operation_id: String,
    pub state: State,
    pub at_ms: i64,
}

/// Bounded pagination. Offset pagination is a live view, not a stable snapshot.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub limit: u16,
    pub offset: u32,
}

impl Default for Page {
    fn default() -> Self {
        Self {
            limit: 50,
            offset: 0,
        }
    }
}

/// Explicit recovery affects only one run the host has proved is no longer live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovery {
    pub invalidated_approvals: u64,
    pub uncertain_operations: u64,
}
