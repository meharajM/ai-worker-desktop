use crate::{
    Error, Event, Intent, NewTask, Operation, Outcome, Page, Recovery, Result, State, Task,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior, params};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const APPLICATION_ID: i64 = 0x4c4f4a52;
const SCHEMA_VERSION: i64 = 1;
const OP_COLUMNS: &str = "id, task_id, kind, payload, state, run_id, approval_expires_ms, outcome, created_ms, updated_ms";

/// One synchronous SQLite connection. Move it to a host-owned blocking worker;
/// do not block a WebView/UI thread. Connections serialize mutations with SQLite.
pub struct Journal {
    conn: Connection,
}

impl Journal {
    /// Opens an app-owned local database; rejects foreign/newer schemas.
    /// The parent directory must exist and have appropriate user-only permissions.
    /// Uses WAL, FULL sync and a five-second lock timeout. Never recovers on open.
    /// Errors include IO/SQLite failures and incompatible database identity.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        // macOS /var and similar parent aliases are legitimate; the final DB must
        // still not be a symlink. Host-owned parent permissions prevent substitution.
        let path = path.as_ref();
        let name = path
            .file_name()
            .ok_or(Error::InvalidInput("database filename required"))?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let path = std::fs::canonicalize(parent)?.join(name);
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let app: i64 = tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
        let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if app == 0 && version == 0 {
            let tables: i64 = tx.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )?;
            if tables != 0 {
                return Err(Error::IncompatibleDatabase);
            }
            tx.execute_batch("CREATE TABLE tasks (
                id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, created_ms INTEGER NOT NULL
            );
            CREATE TABLE operations (
                id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT NOT NULL REFERENCES tasks(id),
                kind TEXT NOT NULL, payload TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending','approved','running','succeeded','failed','cancelled','uncertain')),
                run_id TEXT, approval_expires_ms INTEGER, outcome TEXT,
                created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
            );
            CREATE INDEX operations_task ON operations(task_id, created_ms, id);
            CREATE INDEX operations_run ON operations(run_id, state);
            CREATE TABLE events (
                sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id),
                state TEXT NOT NULL, at_ms INTEGER NOT NULL
            );
            CREATE INDEX events_operation ON events(operation_id, sequence);")?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        } else if app != APPLICATION_ID || version != SCHEMA_VERSION {
            return Err(Error::IncompatibleDatabase);
        }
        tx.commit()?;
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
        if mode != "wal" {
            let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
            if mode != "wal" {
                return Err(Error::InvalidInput("WAL unavailable on this database"));
            }
        }
        conn.pragma_update(None, "synchronous", "FULL")?;
        Ok(Self { conn })
    }

    /// Creates immutable grouping metadata. Repeating identical input is safe;
    /// changing a title for an existing ID returns `Conflict`.
    pub fn create_task(&mut self, task: NewTask) -> Result<Task> {
        text(&task.id, 128)?;
        text(&task.title, 512)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = get_task(&tx, &task.id)? {
            if existing.task != task {
                return Err(Error::Conflict);
            }
            return Ok(existing);
        }
        let created_ms = now_ms()?;
        tx.execute(
            "INSERT INTO tasks VALUES (?1, ?2, ?3)",
            params![task.id, task.title, created_ms],
        )?;
        tx.commit()?;
        Ok(Task { task, created_ms })
    }

    /// Returns task metadata, or `None` when absent. Invalid IDs are rejected.
    pub fn task(&self, id: &str) -> Result<Option<Task>> {
        text(id, 128)?;
        get_task(&self.conn, id)
    }

    /// Lists at most 100 tasks in creation/ID order. Does not infer task completion.
    pub fn tasks(&self, page: Page) -> Result<Vec<Task>> {
        page_check(page)?;
        Ok(self.conn.prepare("SELECT id, title, created_ms FROM tasks ORDER BY created_ms, id LIMIT ?1 OFFSET ?2")?
            .query_map(params![page.limit, page.offset], task_row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Persists immutable pending intent before review. Reusing an ID with
    /// identical intent returns its current state, never resets/replays it.
    /// The task must exist; JSON is limited to 64 KiB, kind to 128 bytes.
    pub fn propose(&mut self, intent: Intent) -> Result<Operation> {
        text(&intent.id, 128)?;
        text(&intent.task_id, 128)?;
        text(&intent.kind, 128)?;
        let payload = json(&intent.payload)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = get_operation(&tx, &intent.id)? {
            if existing.intent != intent {
                return Err(Error::Conflict);
            }
            return Ok(existing);
        }
        if get_task(&tx, &intent.task_id)?.is_none() {
            return Err(Error::NotFound);
        }
        let at = now_ms()?;
        tx.execute(
            "INSERT INTO operations (id, task_id, kind, payload, state, created_ms, updated_ms)
            VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)",
            params![intent.id, intent.task_id, intent.kind, payload, at],
        )?;
        event(&tx, &intent.id, State::Pending, at)?;
        let operation = get_operation(&tx, &intent.id)?.ok_or(Error::NotFound)?;
        tx.commit()?;
        Ok(operation)
    }

    /// Returns an immutable proposal plus its current durable state, or `None`.
    pub fn operation(&self, id: &str) -> Result<Option<Operation>> {
        text(id, 128)?;
        get_operation(&self.conn, id)
    }

    /// Lists at most 100 operations belonging to this task in creation/ID order.
    pub fn operations(&self, task_id: &str, page: Page) -> Result<Vec<Operation>> {
        text(task_id, 128)?;
        page_check(page)?;
        Ok(self.conn.prepare(&format!("SELECT {OP_COLUMNS} FROM operations WHERE task_id=?1 ORDER BY created_ms, id LIMIT ?2 OFFSET ?3"))?
            .query_map(params![task_id, page.limit, page.offset], operation_row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Lists at most 100 append-only transitions in sequence order.
    pub fn events(&self, operation_id: &str, page: Page) -> Result<Vec<Event>> {
        text(operation_id, 128)?;
        page_check(page)?;
        Ok(self.conn.prepare("SELECT sequence, operation_id, state, at_ms FROM events WHERE operation_id=?1 ORDER BY sequence LIMIT ?2 OFFSET ?3")?
            .query_map(params![operation_id, page.limit, page.offset], |r| Ok(Event {
                sequence: r.get(0)?, operation_id: r.get(1)?, state: state_column(r, 2)?, at_ms: r.get(3)?
            }))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Trusted host only: records actual human approval for this immutable ID.
    /// `run_id` must be unique per host execution lifetime; TTL is 1 ms–24 hours.
    /// An identical unexpired repeated approval does not extend its deadline.
    /// This records authority; it does not authenticate the caller or sandbox effects.
    pub fn approve(&mut self, id: &str, run_id: &str, ttl: Duration) -> Result<Operation> {
        text(run_id, 128)?;
        let ttl =
            i64::try_from(ttl.as_millis()).map_err(|_| Error::InvalidInput("approval TTL"))?;
        if !(1..=86_400_000).contains(&ttl) {
            return Err(Error::InvalidInput("approval TTL must be 1 ms–24 hours"));
        }
        self.change(id, |op, at| {
            if op.state == State::Approved {
                check_run(op, run_id)?;
                if op.approval_expires_ms.is_none_or(|expiry| expiry <= at) {
                    return Err(Error::ApprovalExpired);
                }
                return Ok(());
            }
            require(op, State::Pending)?;
            op.state = State::Approved;
            op.run_id = Some(run_id.to_owned());
            op.approval_expires_ms = Some(
                at.checked_add(ttl)
                    .ok_or(Error::InvalidInput("approval expiry overflow"))?,
            );
            Ok(())
        })
    }

    /// Revokes an unused approval. A fresh human review is needed to approve again.
    pub fn revoke(&mut self, id: &str) -> Result<Operation> {
        self.change(id, |op, _| {
            require(op, State::Approved)?;
            op.state = State::Pending;
            op.run_id = None;
            op.approval_expires_ms = None;
            Ok(())
        })
    }

    /// Consumes approval exactly once, committing `running` BEFORE the external
    /// effect. Revalidate grant, paths/hashes/argv and process identity in the host.
    /// A repeated begin, wrong run or expired approval fails; never execute on error.
    pub fn begin(&mut self, id: &str, run_id: &str) -> Result<Operation> {
        text(run_id, 128)?;
        self.change(id, |op, at| {
            require(op, State::Approved)?;
            check_run(op, run_id)?;
            if op.approval_expires_ms.is_none_or(|expiry| expiry <= at) {
                return Err(Error::ApprovalExpired);
            }
            op.state = State::Running;
            op.approval_expires_ms = None;
            Ok(())
        })
    }

    /// Records a verified result after an effect. A failed DB commit must NOT
    /// trigger another execution. Receipts are limited to 64 KiB.
    pub fn finish(&mut self, id: &str, run_id: &str, outcome: Outcome) -> Result<Operation> {
        text(run_id, 128)?;
        self.change(id, |op, _| {
            require(op, State::Running)?;
            check_run(op, run_id)?;
            let (state, receipt) = outcome.parts();
            json(receipt)?;
            op.state = state;
            op.outcome = Some(receipt.clone());
            Ok(())
        })
    }

    /// Records ambiguity while the owning run is live (e.g. lost process result).
    /// No future begin is allowed for this ID.
    pub fn mark_uncertain(&mut self, id: &str, run_id: &str) -> Result<Operation> {
        text(run_id, 128)?;
        self.change(id, |op, _| {
            require(op, State::Running)?;
            check_run(op, run_id)?;
            op.state = State::Uncertain;
            Ok(())
        })
    }

    /// Cancels only pending/unused approvals. For running effects, the host must
    /// stop/reconcile the effect, then finish or mark uncertain.
    pub fn cancel(&mut self, id: &str) -> Result<Operation> {
        self.change(id, |op, _| {
            if !matches!(op.state, State::Pending | State::Approved) {
                return Err(Error::InvalidState(op.state));
            }
            op.state = State::Cancelled;
            op.run_id = None;
            op.approval_expires_ms = None;
            Ok(())
        })
    }

    /// Trusted reconciliation only: settles uncertain effects after inspecting
    /// filesystem hashes/receipts or getting an explicit user decision.
    /// Never resets the old ID for retry; a reviewed retry needs a new intent ID.
    pub fn resolve(&mut self, id: &str, outcome: Outcome) -> Result<Operation> {
        self.change(id, |op, _| {
            require(op, State::Uncertain)?;
            let (state, receipt) = outcome.parts();
            json(receipt)?;
            op.state = state;
            op.outcome = Some(receipt.clone());
            Ok(())
        })
    }

    /// Host must first prove this run is dead and stop its owned processes.
    /// Atomically invalidates its unused approvals and marks its running effects
    /// uncertain. Repeated recovery is safe; other runs are untouched.
    /// Run liveness/locking is deliberately outside this library.
    pub fn recover_run(&mut self, dead_run_id: &str) -> Result<Recovery> {
        text(dead_run_id, 128)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ids = tx.prepare("SELECT id, state FROM operations WHERE run_id=?1 AND state IN ('approved','running') ORDER BY id")?
            .query_map([dead_run_id], |r| Ok((r.get::<_, String>(0)?, state_column(r, 1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let at = now_ms()?;
        let mut report = Recovery {
            invalidated_approvals: 0,
            uncertain_operations: 0,
        };
        for (id, state) in ids {
            let next = if state == State::Approved {
                report.invalidated_approvals += 1;
                tx.execute("UPDATE operations SET state='pending', run_id=NULL, approval_expires_ms=NULL, updated_ms=?2 WHERE id=?1", params![id, at])?;
                State::Pending
            } else {
                report.uncertain_operations += 1;
                tx.execute(
                    "UPDATE operations SET state='uncertain', updated_ms=?2 WHERE id=?1",
                    params![id, at],
                )?;
                State::Uncertain
            };
            event(&tx, &id, next, at)?;
        }
        tx.commit()?;
        Ok(report)
    }

    fn change(
        &mut self,
        id: &str,
        update: impl FnOnce(&mut Operation, i64) -> Result<()>,
    ) -> Result<Operation> {
        text(id, 128)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut op = get_operation(&tx, id)?.ok_or(Error::NotFound)?;
        let original = op.clone();
        let at = now_ms()?;
        update(&mut op, at)?;
        if op != original {
            op.updated_ms = at;
            let outcome = op.outcome.as_ref().map(json).transpose()?;
            tx.execute("UPDATE operations SET state=?2, run_id=?3, approval_expires_ms=?4, outcome=?5, updated_ms=?6 WHERE id=?1",
                params![id, op.state.as_str(), op.run_id, op.approval_expires_ms, outcome, at])?;
            event(&tx, id, op.state, at)?;
        }
        tx.commit()?;
        Ok(op)
    }
}

fn require(op: &Operation, state: State) -> Result<()> {
    if op.state != state {
        return Err(Error::InvalidState(op.state));
    }
    Ok(())
}

fn check_run(op: &Operation, run_id: &str) -> Result<()> {
    if op.run_id.as_deref() != Some(run_id) {
        return Err(Error::WrongRun);
    }
    Ok(())
}

fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(Error::InvalidInput(
            "text empty, oversized, or contains control characters",
        ));
    }
    Ok(())
}

fn page_check(page: Page) -> Result<()> {
    if !(1..=100).contains(&page.limit) {
        return Err(Error::InvalidInput("page limit must be 1–100"));
    }
    Ok(())
}

fn json(value: &Value) -> Result<String> {
    // JSON bridge numbers must round-trip through JavaScript without changing intent.
    fn safe(v: &Value, depth: usize) -> bool {
        if depth > 64 {
            return false;
        }
        match v {
            Value::Number(n) if n.is_i64() => n
                .as_i64()
                .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991),
            Value::Number(n) if n.is_u64() => {
                n.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
            }
            Value::Number(n) => n
                .as_f64()
                .is_some_and(|n| n.fract() != 0.0 || n.abs() <= 9_007_199_254_740_991.0),
            Value::Array(values) => values.iter().all(|v| safe(v, depth + 1)),
            Value::Object(values) => values.values().all(|v| safe(v, depth + 1)),
            _ => true,
        }
    }
    if !safe(value, 0) {
        return Err(Error::InvalidInput(
            "JSON exceeds depth 64 or contains unsafe integers; encode large integers as strings",
        ));
    }
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > 65_536 {
        return Err(Error::InvalidInput("JSON exceeds 64 KiB"));
    }
    Ok(encoded)
}

fn now_ms() -> Result<i64> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::InvalidInput("clock before Unix epoch"))?
        .as_millis();
    let ms = i64::try_from(ms).map_err(|_| Error::InvalidInput("clock overflow"))?;
    if ms > 9_007_199_254_740_991 {
        return Err(Error::InvalidInput("clock exceeds JSON safe integer"));
    }
    Ok(ms)
}

fn task_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        task: NewTask {
            id: r.get(0)?,
            title: r.get(1)?,
        },
        created_ms: r.get(2)?,
    })
}

fn get_task(conn: &Connection, id: &str) -> Result<Option<Task>> {
    Ok(conn
        .query_row(
            "SELECT id, title, created_ms FROM tasks WHERE id=?1",
            [id],
            task_row,
        )
        .optional()?)
}

fn state_column(r: &Row<'_>, column: usize) -> rusqlite::Result<State> {
    serde_json::from_value(Value::String(r.get(column)?)).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn json_column<T: DeserializeOwned>(r: &Row<'_>, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(&r.get::<_, String>(column)?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn operation_row(r: &Row<'_>) -> rusqlite::Result<Operation> {
    Ok(Operation {
        intent: Intent {
            id: r.get(0)?,
            task_id: r.get(1)?,
            kind: r.get(2)?,
            payload: json_column(r, 3)?,
        },
        state: state_column(r, 4)?,
        run_id: r.get(5)?,
        approval_expires_ms: r.get(6)?,
        outcome: if r.get::<_, Option<String>>(7)?.is_some() {
            Some(json_column(r, 7)?)
        } else {
            None
        },
        created_ms: r.get(8)?,
        updated_ms: r.get(9)?,
    })
}

fn get_operation(conn: &Connection, id: &str) -> Result<Option<Operation>> {
    Ok(conn
        .query_row(
            &format!("SELECT {OP_COLUMNS} FROM operations WHERE id=?1"),
            [id],
            operation_row,
        )
        .optional()?)
}

fn event(conn: &Connection, id: &str, state: State, at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO events(operation_id, state, at_ms) VALUES (?1, ?2, ?3)",
        params![id, state.as_str(), at],
    )?;
    Ok(())
}
