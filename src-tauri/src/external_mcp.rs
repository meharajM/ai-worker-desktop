//! Local MCP endpoint with authenticated inference, task lifecycle, and user-approved writes.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex, TryLockError,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::{a2a, agent_task, model_runtime::ModelRuntime, workspace::StagedWrite};

const STATUS_FILE: &str = "ai-worker-mcp-status.json";
const MAX_HEADERS: usize = 8 * 1024;
const MAX_BODY: usize = 52 * 1024;
const MAX_PROMPT: usize = 8_000; // JS adapter counts UTF-16 code units.
const MAX_CLIENTS: usize = 4;
const MAX_ACTIVE_TASKS: usize = 4;
const MAX_TASK_RECORDS: usize = 32;
const MAX_HOST_SESSIONS: usize = 16;
const TASK_RETENTION: Duration = Duration::from_secs(30 * 60);
const HOST_SESSION_RETENTION: Duration = Duration::from_secs(45);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT: Duration = Duration::from_secs(10);
const LOCK_RETRY: Duration = Duration::from_millis(250);
const TASK_POLL: Duration = Duration::from_millis(50);
const WRITE_APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(315);
const WRITE_APPROVAL_WINDOW: &str = "write-approval";

#[derive(Default)]
pub struct ExternalMcp {
    service: Mutex<Option<Service>>,
    tasks: TaskManager,
}

#[derive(Clone, Default)]
struct TaskManager {
    records: Arc<Mutex<HashMap<String, Arc<TaskRecord>>>>,
    host_sessions: Arc<Mutex<HashMap<String, HostSession>>>,
    stopping: Arc<AtomicBool>,
    write_approval_gate: Arc<Mutex<()>>,
}

struct HostSession {
    connected_at_ms: u64,
    last_seen: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskMode {
    Synchronous,
    Background,
}

struct TaskRecord {
    mode: TaskMode,
    id: String,
    request: agent_task::TaskRequest,
    a2a_context_id: Option<String>,
    a2a_message_ids: Mutex<HashSet<String>>,
    cancelled: AtomicBool,
    progress: Mutex<TaskProgress>,
    changed: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
    created_at: Instant,
}

#[derive(Default)]
struct TaskProgress {
    state: TaskState,
    model_turns: usize,
    pending_question: Option<ParentQuestion>,
    answer: Option<String>,
    pending_approval: Option<PendingWriteApproval>,
    approval_decision: Option<bool>,
    result: Option<agent_task::TaskResult>,
    error: Option<String>,
    terminal_at: Option<Instant>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskState {
    #[default]
    Queued,
    Running,
    WaitingForParent,
    WaitingForApproval,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
}

impl TaskState {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Cancelled | Self::Completed | Self::Failed)
    }

    fn is_active(self) -> bool {
        !self.is_terminal()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityTask {
    id: String,
    protocol: &'static str,
    host_session_id: Option<String>,
    prompt: String,
    handoff_context: Option<agent_task::HandoffContext>,
    web_access: bool,
    state: TaskState,
    model_turns: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivitySnapshot {
    pub(crate) host_sessions: Vec<ActivityHostSession>,
    pub(crate) tasks: Vec<ActivityTask>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityHostSession {
    pub(crate) id: String,
    pub(crate) connected_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParentQuestion {
    id: String,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingWriteApproval {
    pub(crate) task_id: String,
    pub(crate) approval_id: String,
    pub(crate) task_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) handoff_context: Option<agent_task::HandoffContext>,
    pub(crate) workspace_root: String,
    pub(crate) relative_path: String,
    pub(crate) before: Option<String>,
    pub(crate) proposed: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskView {
    id: String,
    state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_question: Option<ParentQuestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<agent_task::TaskResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskAck {
    id: String,
    state: TaskState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSessionRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSessionAck {
    session_id: String,
    connected_sessions: usize,
}

struct Service {
    stopping: Arc<AtomicBool>,
    worker: JoinHandle<io::Result<()>>,
}

struct InferenceGuard(Arc<AtomicBool>);

impl Drop for InferenceGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    schema_version: u8,
    app: &'static str,
    version: String,
    running: bool,
    started_at: u64,
    heartbeat_at: u64,
    privacy_mode: &'static str,
    model: ModelStatus,
    port: Option<u16>,
    token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    available: bool,
    checked_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn random_hex() -> io::Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| io::Error::other("OS randomness unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn owner_only_file() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

impl Snapshot {
    fn write(&mut self, dir: &Path, available: bool) -> io::Result<()> {
        self.heartbeat_at = now_ms();
        self.model = ModelStatus {
            available,
            checked_at: self.heartbeat_at,
        };
        let temporary = dir.join(format!(".{STATUS_FILE}.{}.tmp", random_hex()?));
        let mut file = owner_only_file().create_new(true).open(&temporary)?;
        let result = serde_json::to_writer(&mut file, self).map_err(io::Error::other);
        drop(file);
        let result = result.and_then(|()| fs::rename(&temporary, dir.join(STATUS_FILE)));
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    fn stopped(&mut self, dir: &Path) -> io::Result<()> {
        self.running = false;
        self.port = None;
        self.token = None;
        self.write(dir, false)
    }
}

impl ExternalMcp {
    pub fn start(&self, app: &AppHandle) -> io::Result<()> {
        let mut service = self
            .service
            .lock()
            .map_err(|_| io::Error::other("MCP state unavailable"))?;
        if service.is_some() {
            return Ok(());
        }
        let dir = app.path().app_data_dir().map_err(io::Error::other)?;
        let stopping = Arc::new(AtomicBool::new(false));
        let tasks = self.tasks.clone();
        let app = app.clone();
        let stop = stopping.clone();
        let worker = thread::spawn(move || {
            fs::create_dir_all(&dir)?;
            let Some(lock) = wait_for_service_lock(&dir, &stop)? else {
                return Ok(());
            };
            run_service(&app, &dir, lock, stop, tasks)
        });
        *service = Some(Service { stopping, worker });
        Ok(())
    }

    pub fn shutdown<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        runtime: &ModelRuntime,
    ) -> io::Result<()> {
        self.tasks.cancel_all();
        if let Some(window) = app.get_webview_window(WRITE_APPROVAL_WINDOW) {
            let _ = window.close();
        }
        let mut service = self.service.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(service) = service.as_ref() {
            service.stopping.store(true, Ordering::Release);
            service.worker.thread().unpark();
        }
        runtime.shutdown();
        if let Some(Service { worker, .. }) = service.take() {
            worker
                .join()
                .map_err(|_| io::Error::other("MCP listener stopped unexpectedly"))??;
        }
        self.tasks.join_all();
        Ok(())
    }

    pub(crate) fn task_activity(&self) -> ActivitySnapshot {
        self.tasks.activity_snapshot()
    }

    pub(crate) fn pending_write_approval(&self) -> Option<PendingWriteApproval> {
        self.tasks.pending_write_approval()
    }

    pub(crate) fn resolve_write_approval(
        &self,
        task_id: &str,
        approval_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        self.tasks
            .resolve_write_approval(task_id, approval_id, approved)
    }

    pub(crate) fn dismiss_pending_write_approval(&self) {
        if let Some(approval) = self.tasks.pending_write_approval() {
            let _ =
                self.tasks
                    .resolve_write_approval(&approval.task_id, &approval.approval_id, false);
        }
    }

    pub(crate) fn disable_online_research(&self) {
        self.tasks.cancel_online_tasks();
    }

    pub(crate) fn has_active_work(&self) -> bool {
        self.tasks.has_active_work()
    }
}

impl TaskManager {
    fn open_host_session(&self, body: &[u8]) -> Result<HostSessionAck, (u16, String)> {
        let request = parse_host_session_request(body)?;
        let now = Instant::now();
        let mut sessions = self
            .host_sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        prune_host_sessions(&mut sessions, now);
        if let Some(session) = sessions.get_mut(&request.session_id) {
            session.last_seen = now;
        } else {
            if sessions.len() >= MAX_HOST_SESSIONS {
                return Err((
                    503,
                    "AI-Worker has reached its active host session limit.".into(),
                ));
            }
            sessions.insert(
                request.session_id.clone(),
                HostSession {
                    connected_at_ms: now_ms(),
                    last_seen: now,
                },
            );
        }
        Ok(HostSessionAck {
            session_id: request.session_id,
            connected_sessions: sessions.len(),
        })
    }

    fn heartbeat_host_session(&self, body: &[u8]) -> Result<HostSessionAck, (u16, String)> {
        let request = parse_host_session_request(body)?;
        let now = Instant::now();
        let mut sessions = self
            .host_sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        prune_host_sessions(&mut sessions, now);
        let Some(session) = sessions.get_mut(&request.session_id) else {
            return Err((404, "Host session was not found or has expired.".into()));
        };
        session.last_seen = now;
        Ok(HostSessionAck {
            session_id: request.session_id,
            connected_sessions: sessions.len(),
        })
    }

    fn close_host_session(&self, body: &[u8]) -> Result<HostSessionAck, (u16, String)> {
        let request = parse_host_session_request(body)?;
        let now = Instant::now();
        let mut sessions = self
            .host_sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        prune_host_sessions(&mut sessions, now);
        sessions.remove(&request.session_id);
        Ok(HostSessionAck {
            session_id: request.session_id,
            connected_sessions: sessions.len(),
        })
    }

    fn activity_snapshot(&self) -> ActivitySnapshot {
        let now = Instant::now();
        let mut sessions = self
            .host_sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        prune_host_sessions(&mut sessions, now);
        let mut host_sessions = sessions
            .iter()
            .map(|(id, session)| ActivityHostSession {
                id: id.clone(),
                connected_at_ms: session.connected_at_ms,
            })
            .collect::<Vec<_>>();
        host_sessions.sort_by(|left, right| {
            left.connected_at_ms
                .cmp(&right.connected_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });
        drop(sessions);
        ActivitySnapshot {
            host_sessions,
            tasks: self.activity(),
        }
    }

    fn has_active_tasks(&self) -> bool {
        let mut records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        prune_records(&mut records);
        records.values().any(|record| record.is_active())
    }

    fn has_active_work(&self) -> bool {
        self.has_active_tasks() || self.has_active_host_sessions()
    }

    fn has_active_host_sessions(&self) -> bool {
        let mut sessions = self
            .host_sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        prune_host_sessions(&mut sessions, Instant::now());
        !sessions.is_empty()
    }

    fn start(
        &self,
        app: AppHandle,
        inference: Arc<AtomicBool>,
        body: &[u8],
    ) -> Result<TaskAck, (u16, String)> {
        self.start_with_a2a(app, inference, body, None, None)
    }

    fn start_a2a(
        &self,
        app: AppHandle,
        inference: Arc<AtomicBool>,
        body: &[u8],
        context_id: String,
        message_id: String,
    ) -> Result<TaskAck, (u16, String)> {
        self.start_with_a2a(app, inference, body, Some(context_id), Some(message_id))
    }

    fn start_with_a2a(
        &self,
        app: AppHandle,
        inference: Arc<AtomicBool>,
        body: &[u8],
        context_id: Option<String>,
        message_id: Option<String>,
    ) -> Result<TaskAck, (u16, String)> {
        let request =
            agent_task::parse_validated_request(body).map_err(|message| (422, message))?;
        let online_allowed = crate::preferences::get(&app)
            .is_ok_and(|preferences| preferences.allow_online_research);
        if request
            .capabilities
            .iter()
            .any(|capability| capability == "web")
            && !online_allowed
        {
            return Err((
                403,
                "Public web research is off. Enable it in AI-Worker Settings and retry the task."
                    .into(),
            ));
        }
        if self.stopping.load(Ordering::Acquire) {
            return Err((503, "AI-Worker is shutting down.".into()));
        }
        {
            let mut records = self.records.lock().unwrap_or_else(|err| err.into_inner());
            if self.stopping.load(Ordering::Acquire) {
                return Err((503, "AI-Worker is shutting down.".into()));
            }
            prune_records(&mut records);
            if let (Some(context_id), Some(message_id)) =
                (context_id.as_deref(), message_id.as_deref())
            {
                if let Some(record) = records
                    .values()
                    .find(|record| record.has_a2a_message_in_context(context_id, message_id))
                {
                    let view = record.view();
                    return Ok(TaskAck {
                        id: view.id,
                        state: view.state,
                    });
                }
            }
            let record = Self::insert_task(
                &mut records,
                TaskMode::Background,
                request,
                context_id,
                message_id,
            )?;

            let manager = self.clone();
            let task = Arc::clone(&record);
            let worker = thread::spawn(move || {
                let cancelled = || {
                    task.cancelled.load(Ordering::Acquire)
                        || manager.stopping.load(Ordering::Acquire)
                };
                if cancelled() {
                    task.finish(Err("Task cancelled.".into()));
                    manager.close_activity_if_idle(&app);
                    return;
                }
                crate::task_activity::show(&app, false);
                task.set_state(TaskState::Running);
                let result = agent_task::run_controlled_live(
                    &app,
                    &task.request,
                    |prompt| manager.infer(&app, &inference, &task, prompt, &cancelled),
                    |question| task.ask_parent(question),
                    |request, workspace_root, proposal| {
                        manager.approve_write(
                            &app,
                            &task,
                            request,
                            workspace_root,
                            proposal,
                            &cancelled,
                        )
                    },
                    || {
                        crate::preferences::get(&app)
                            .is_ok_and(|preferences| preferences.allow_online_research)
                    },
                    cancelled,
                );
                task.finish(result);
                manager.close_activity_if_idle(&app);
            });
            *record.worker.lock().unwrap_or_else(|err| err.into_inner()) = Some(worker);
            return Ok(TaskAck {
                id: record.id.clone(),
                state: TaskState::Queued,
            });
        }
    }

    fn insert_task(
        records: &mut HashMap<String, Arc<TaskRecord>>,
        mode: TaskMode,
        request: agent_task::TaskRequest,
        context_id: Option<String>,
        message_id: Option<String>,
    ) -> Result<Arc<TaskRecord>, (u16, String)> {
        if records.values().filter(|record| record.is_active()).count() >= MAX_ACTIVE_TASKS {
            return Err((503, "AI-Worker has reached its active task limit.".into()));
        }
        if records.len() >= MAX_TASK_RECORDS {
            let oldest_terminal = records
                .iter()
                .filter(|(_, record)| record.is_terminal())
                // Synchronous callers already received their result directly.
                .min_by_key(|(_, record)| (record.mode == TaskMode::Background, record.created_at))
                .map(|(id, _)| id.clone());
            if let Some(oldest_terminal) = oldest_terminal {
                records.remove(&oldest_terminal);
            } else {
                return Err((503, "AI-Worker has reached its retained task limit.".into()));
            }
        }
        let id = random_hex().map_err(|_| (503, "Could not create a task identifier.".into()))?;
        let record = Arc::new(TaskRecord::new(
            id.clone(),
            mode,
            context_id,
            message_id,
            request,
        ));
        records.insert(id, Arc::clone(&record));
        Ok(record)
    }

    fn begin_readonly_task(&self, body: &[u8]) -> Result<Arc<TaskRecord>, (u16, String)> {
        let request = agent_task::parse_validated_request(body).map_err(|error| (422, error))?;
        let mut records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        if self.stopping.load(Ordering::Acquire) {
            return Err((503, "AI-Worker is shutting down.".into()));
        }
        prune_records(&mut records);
        let record = Self::insert_task(&mut records, TaskMode::Synchronous, request, None, None)?;
        record.set_state(TaskState::Running);
        Ok(record)
    }

    fn close_activity_if_idle<R: Runtime>(&self, app: &AppHandle<R>) {
        if !self.has_active_tasks() {
            let tasks = self.clone();
            crate::task_activity::close_after_idle(app, move || !tasks.has_active_tasks());
        }
    }

    fn approve_write<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        task: &TaskRecord,
        request: &agent_task::TaskRequest,
        workspace: &crate::workspace::Workspace,
        proposal: &StagedWrite,
        cancelled: &impl Fn() -> bool,
    ) -> Result<(), String> {
        let _gate = loop {
            if cancelled() {
                return Err("Task cancelled.".into());
            }
            match self.write_approval_gate.try_lock() {
                Ok(gate) => break gate,
                Err(TryLockError::Poisoned(error)) => break error.into_inner(),
                Err(TryLockError::WouldBlock) => thread::sleep(TASK_POLL),
            }
        };
        if cancelled() {
            return Err("Task cancelled.".into());
        }
        let approval = PendingWriteApproval {
            task_id: task.id.clone(),
            approval_id: random_hex()
                .map_err(|_| "Could not create a write approval identifier.".to_owned())?,
            task_prompt: request.prompt.clone(),
            handoff_context: request.handoff_context.clone(),
            workspace_root: workspace.root().display().to_string(),
            relative_path: proposal.relative_path.clone(),
            before: proposal.before.clone(),
            proposed: proposal.proposed.clone(),
        };
        task.begin_write_approval(approval.clone())?;
        if let Err(error) = show_write_approval_window(app) {
            task.resolve_write_approval(&approval.approval_id, false)?;
            let _ = self.refresh_write_approval_window(app);
            return Err(error);
        }
        let result = task.wait_for_write_approval(&approval, cancelled);
        self.refresh_write_approval_window(app)?;
        match result? {
            true if cancelled() => Err("Task cancelled.".into()),
            true => workspace
                .commit_write(proposal)
                .map_err(|error| error.to_string()),
            false => Err("Workspace write was declined. No file was changed.".into()),
        }
    }

    fn pending_write_approval(&self) -> Option<PendingWriteApproval> {
        let records = self
            .records
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut ordered = records;
        ordered.sort_by_key(|record| record.created_at);
        ordered
            .into_iter()
            .find_map(|record| record.pending_write_approval())
    }

    fn resolve_write_approval(
        &self,
        task_id: &str,
        approval_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        validate_task_id(task_id).map_err(|(_, error)| error)?;
        validate_task_id(approval_id).map_err(|(_, error)| error)?;
        let record = self.record(task_id).map_err(|(_, error)| error)?;
        record.resolve_write_approval(approval_id, approved)
    }

    fn refresh_write_approval_window<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let app = app.clone();
        let main_thread_app = app.clone();
        let tasks = self.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = if tasks.pending_write_approval().is_some() {
                if let Some(window) = main_thread_app.get_webview_window(WRITE_APPROVAL_WINDOW) {
                    window
                        .show()
                        .and_then(|()| window.set_focus())
                        .map_err(|error| error.to_string())
                } else {
                    build_write_approval_window(&main_thread_app)
                }
            } else if let Some(window) = main_thread_app.get_webview_window(WRITE_APPROVAL_WINDOW) {
                window.close().map_err(|error| error.to_string())
            } else {
                Ok(())
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not update the write approval window: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Timed out while updating the write approval window.".to_owned())?
    }

    fn infer(
        &self,
        app: &AppHandle,
        admission: &Arc<AtomicBool>,
        task: &TaskRecord,
        prompt: &str,
        cancelled: &impl Fn() -> bool,
    ) -> Result<String, String> {
        loop {
            if cancelled() {
                return Err("Task cancelled.".into());
            }
            if admission
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                let _guard = InferenceGuard(Arc::clone(admission));
                task.begin_inference();
                let model = app.state::<ModelRuntime>();
                let result = model
                    .infer_task_cancellable(app, prompt, Some(&task.cancelled))
                    .map(|result| result.content)
                    .map_err(str::to_owned);
                if cancelled() {
                    return Err("Task cancelled.".into());
                }
                return result;
            }
            task.set_state(TaskState::Queued);
            thread::sleep(TASK_POLL);
        }
    }

    fn get(&self, id: &str) -> Result<TaskView, (u16, String)> {
        validate_task_id(id)?;
        self.prune();
        let records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        let record = records
            .get(id)
            .ok_or_else(|| (404, "Task was not found or has expired.".into()))?;
        Ok(record.view())
    }

    fn activity(&self) -> Vec<ActivityTask> {
        let mut records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        prune_records(&mut records);
        let mut recent = records
            .values()
            .map(|record| (record.is_terminal(), record.created_at, record))
            .collect::<Vec<_>>();
        recent.sort_unstable_by_key(|(terminal, created_at, _)| {
            (*terminal, std::cmp::Reverse(*created_at))
        });
        recent
            .into_iter()
            .take(MAX_ACTIVE_TASKS * 2)
            .map(|(_, _, record)| record.activity())
            .collect()
    }

    fn answer(&self, id: &str, body: &[u8]) -> Result<TaskAck, (u16, String)> {
        validate_task_id(id)?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct AnswerRequest {
            question_id: String,
            answer: String,
        }
        if body.first() != Some(&b'{') {
            return Err((400, "Invalid parent answer request.".into()));
        }
        let request: AnswerRequest = serde_json::from_slice(body)
            .map_err(|_| (400, "Invalid parent answer request.".into()))?;
        validate_task_id(&request.question_id)?;
        if request.answer.trim().is_empty()
            || request.answer.encode_utf16().count() > 2_000
            || request.answer.chars().any(|character| {
                character == '\0'
                    || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            })
        {
            return Err((
                400,
                "Parent answer must contain up to 2000 characters.".into(),
            ));
        }
        let record = self.record(id)?;
        let mut progress = record
            .progress
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if progress.state != TaskState::WaitingForParent
            || progress
                .pending_question
                .as_ref()
                .is_none_or(|question| question.id != request.question_id)
        {
            return Err((409, "Task is not waiting for this parent question.".into()));
        }
        if record.cancelled.load(Ordering::Acquire) {
            return Err((409, "Task is being cancelled.".into()));
        }
        progress.pending_question = None;
        progress.answer = Some(request.answer);
        progress.state = TaskState::Queued;
        record.changed.notify_all();
        Ok(TaskAck {
            id: id.to_owned(),
            state: progress.state,
        })
    }

    fn cancel(&self, id: &str) -> Result<TaskAck, (u16, String)> {
        validate_task_id(id)?;
        let record = self.record(id)?;
        Ok(TaskAck {
            id: record.id.clone(),
            state: record.cancel(),
        })
    }

    fn record(&self, id: &str) -> Result<Arc<TaskRecord>, (u16, String)> {
        self.prune();
        let records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        records
            .get(id)
            .cloned()
            .ok_or_else(|| (404, "Task was not found or has expired.".into()))
    }

    fn a2a_record(&self, id: &str) -> Result<Arc<TaskRecord>, (u16, String)> {
        let record = self.record(id)?;
        if record.a2a_context_id.is_none() {
            return Err((404, "A2A task was not found or has expired.".into()));
        }
        Ok(record)
    }

    fn a2a_records(&self) -> Vec<Arc<TaskRecord>> {
        self.prune();
        let records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        let mut records = records
            .values()
            .filter(|record| record.a2a_context_id.is_some())
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.created_at);
        records
    }

    fn prune(&self) {
        let mut records = self.records.lock().unwrap_or_else(|err| err.into_inner());
        prune_records(&mut records);
    }

    fn cancel_all(&self) {
        self.stopping.store(true, Ordering::Release);
        let records = self
            .records
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for record in records {
            record.cancel();
        }
    }

    fn cancel_online_tasks(&self) {
        let records = self
            .records
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .filter(|record| {
                record
                    .request
                    .capabilities
                    .iter()
                    .any(|capability| capability == "web")
            })
            .cloned()
            .collect::<Vec<_>>();
        for record in records {
            record.cancel();
        }
    }

    fn join_all(&self) {
        let records = self
            .records
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for record in records {
            if let Some(worker) = record
                .worker
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .take()
            {
                let _ = worker.join();
            }
        }
    }
}

impl TaskRecord {
    fn new(
        id: String,
        mode: TaskMode,
        a2a_context_id: Option<String>,
        a2a_message_id: Option<String>,
        request: agent_task::TaskRequest,
    ) -> Self {
        let a2a_message_ids = a2a_message_id.into_iter().collect();
        Self {
            id,
            mode,
            request,
            a2a_context_id,
            a2a_message_ids: Mutex::new(a2a_message_ids),
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(TaskProgress::default()),
            changed: Condvar::new(),
            worker: Mutex::new(None),
            created_at: Instant::now(),
        }
    }

    fn has_a2a_message_id(&self, message_id: &str) -> bool {
        self.a2a_message_ids
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .contains(message_id)
    }

    fn has_a2a_message_in_context(&self, context_id: &str, message_id: &str) -> bool {
        self.a2a_context_id.as_deref() == Some(context_id) && self.has_a2a_message_id(message_id)
    }

    fn remember_a2a_message_id(&self, message_id: &str) -> bool {
        self.a2a_message_ids
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(message_id.to_owned())
    }

    fn forget_a2a_message_id(&self, message_id: &str) {
        self.a2a_message_ids
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(message_id);
    }

    fn wait_for_a2a_response(&self) {
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        while !progress.state.is_terminal()
            && !matches!(
                progress.state,
                TaskState::WaitingForParent | TaskState::WaitingForApproval
            )
        {
            progress = self
                .changed
                .wait(progress)
                .unwrap_or_else(|err| err.into_inner());
        }
    }

    fn is_active(&self) -> bool {
        self.progress
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .state
            .is_active()
    }

    fn is_terminal(&self) -> bool {
        self.progress
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .state
            .is_terminal()
    }

    fn set_state(&self, state: TaskState) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        if !self.cancelled.load(Ordering::Acquire) && progress.state.is_active() {
            progress.state = state;
        }
    }

    fn begin_inference(&self) {
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        if !self.cancelled.load(Ordering::Acquire) && progress.state.is_active() {
            progress.state = TaskState::Running;
            progress.model_turns += 1;
        }
    }

    fn ask_parent(&self, text: String) -> Result<String, String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Task cancelled.".into());
        }
        let question = ParentQuestion {
            id: random_hex().map_err(|_| "Could not create a question identifier.".to_owned())?,
            text,
        };
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Task cancelled.".into());
        }
        progress.state = TaskState::WaitingForParent;
        progress.pending_question = Some(question);
        self.changed.notify_all();
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return Err("Task cancelled.".into());
            }
            if let Some(answer) = progress.answer.take() {
                progress.pending_question = None;
                progress.state = TaskState::Queued;
                self.changed.notify_all();
                return Ok(answer);
            }
            progress = self
                .changed
                .wait_timeout(progress, TASK_POLL)
                .unwrap_or_else(|err| err.into_inner())
                .0;
        }
    }

    fn begin_write_approval(&self, approval: PendingWriteApproval) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Task cancelled.".into());
        }
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        if self.cancelled.load(Ordering::Acquire) || !progress.state.is_active() {
            return Err("Task cancelled.".into());
        }
        progress.state = TaskState::WaitingForApproval;
        progress.pending_approval = Some(approval);
        progress.approval_decision = None;
        self.changed.notify_all();
        Ok(())
    }

    fn wait_for_write_approval(
        &self,
        approval: &PendingWriteApproval,
        cancelled: &impl Fn() -> bool,
    ) -> Result<bool, String> {
        let deadline = Instant::now() + WRITE_APPROVAL_TIMEOUT;
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        loop {
            if cancelled() {
                progress.pending_approval = None;
                progress.approval_decision = None;
                self.changed.notify_all();
                return Err("Task cancelled.".into());
            }
            if let Some(decision) = progress.approval_decision.take() {
                progress.pending_approval = None;
                if progress.state.is_active() {
                    progress.state = TaskState::Running;
                }
                self.changed.notify_all();
                return Ok(decision);
            }
            if !progress.pending_approval.as_ref().is_some_and(|pending| {
                pending.task_id == approval.task_id && pending.approval_id == approval.approval_id
            }) {
                return Err("Write approval is no longer pending.".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                progress.pending_approval = None;
                progress.approval_decision = None;
                if progress.state.is_active() {
                    progress.state = TaskState::Running;
                }
                self.changed.notify_all();
                return Err("Write approval expired. No file was changed.".into());
            }
            progress = self
                .changed
                .wait_timeout(progress, remaining.min(TASK_POLL))
                .unwrap_or_else(|err| err.into_inner())
                .0;
        }
    }

    fn pending_write_approval(&self) -> Option<PendingWriteApproval> {
        self.progress
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .pending_approval
            .clone()
    }

    fn resolve_write_approval(&self, approval_id: &str, approved: bool) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Task is being cancelled.".into());
        }
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        if progress.state != TaskState::WaitingForApproval
            || progress
                .pending_approval
                .as_ref()
                .is_none_or(|approval| approval.approval_id != approval_id)
        {
            return Err("Task is not waiting for this write approval.".into());
        }
        progress.pending_approval = None;
        progress.approval_decision = Some(approved);
        progress.state = TaskState::Queued;
        self.changed.notify_all();
        Ok(())
    }

    fn cancel(&self) -> TaskState {
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        if progress.state.is_active() {
            self.cancelled.store(true, Ordering::Release);
            progress.state = TaskState::Cancelling;
            progress.pending_question = None;
            progress.answer = None;
            progress.pending_approval = None;
            progress.approval_decision = None;
            self.changed.notify_all();
        }
        progress.state
    }

    fn finish(&self, result: Result<agent_task::TaskResult, String>) -> TaskState {
        let mut progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        progress.pending_question = None;
        progress.answer = None;
        progress.pending_approval = None;
        progress.approval_decision = None;
        if self.cancelled.load(Ordering::Acquire) {
            progress.state = TaskState::Cancelled;
            progress.error = None;
        } else {
            match result {
                Ok(result) => {
                    progress.state = TaskState::Completed;
                    progress.result = Some(result);
                }
                Err(error) => {
                    progress.state = TaskState::Failed;
                    progress.error = Some(error.chars().take(500).collect());
                }
            }
        }
        progress.terminal_at = Some(Instant::now());
        self.changed.notify_all();
        progress.state
    }

    fn view(&self) -> TaskView {
        let progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        TaskView {
            id: self.id.clone(),
            state: progress.state,
            pending_question: progress.pending_question.clone(),
            result: progress.result.clone(),
            error: progress.error.clone(),
        }
    }

    fn activity(&self) -> ActivityTask {
        let progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        ActivityTask {
            id: self.id.clone(),
            protocol: if self.a2a_context_id.is_some() {
                "A2A"
            } else {
                "MCP"
            },
            host_session_id: self.request.host_session_id.clone(),
            prompt: self.request.prompt.clone(),
            handoff_context: self.request.handoff_context.clone(),
            web_access: self
                .request
                .capabilities
                .iter()
                .any(|capability| capability == "web"),
            state: progress.state,
            model_turns: progress.model_turns,
        }
    }

    fn a2a_value(&self) -> Option<Value> {
        let context_id = self.a2a_context_id.as_deref()?;
        let progress = self.progress.lock().unwrap_or_else(|err| err.into_inner());
        let (state, status_text) = match progress.state {
            TaskState::Queued => ("TASK_STATE_SUBMITTED", None),
            TaskState::Running | TaskState::Cancelling => ("TASK_STATE_WORKING", None),
            TaskState::WaitingForParent => (
                "TASK_STATE_INPUT_REQUIRED",
                progress
                    .pending_question
                    .as_ref()
                    .map(|question| question.text.as_str()),
            ),
            TaskState::WaitingForApproval => (
                "TASK_STATE_AUTH_REQUIRED",
                Some("Review the proposed workspace write in AI-Worker to continue."),
            ),
            TaskState::Cancelled => ("TASK_STATE_CANCELED", None),
            TaskState::Completed => ("TASK_STATE_COMPLETED", None),
            TaskState::Failed => (
                "TASK_STATE_FAILED",
                Some("The local task could not be completed. Check AI-Worker for details."),
            ),
        };
        let mut status = json!({"state": state});
        if let Some(text) = status_text {
            status["message"] = json!({
                "messageId": format!("{}-status", self.id),
                "contextId": context_id,
                "taskId": self.id,
                "role": "ROLE_AGENT",
                "parts": [{"text": text}],
            });
        }
        let mut task = json!({"id": self.id, "contextId": context_id, "status": status});
        if let Some(result) = &progress.result {
            task["artifacts"] = json!([{
                "artifactId": format!("{}-result", self.id),
                "name": "AI-Worker task result",
                "parts": [{"text": result.content}],
                "metadata": {a2a::WORKSPACE_EXTENSION: {"sources": result.sources}},
            }]);
        }
        Some(task)
    }
}

fn show_write_approval_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let app = app.clone();
    let main_thread_app = app.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = if let Some(window) = main_thread_app.get_webview_window(WRITE_APPROVAL_WINDOW)
        {
            window
                .show()
                .and_then(|()| window.set_focus())
                .map_err(|error| error.to_string())
        } else {
            build_write_approval_window(&main_thread_app)
        };
        let _ = sender.send(result);
    })
    .map_err(|error| format!("Could not show the write approval window: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Timed out while opening the write approval window.".to_owned())?
}

fn build_write_approval_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    WebviewWindowBuilder::new(
        app,
        WRITE_APPROVAL_WINDOW,
        WebviewUrl::App("index.html?surface=write-approval".into()),
    )
    .title("Review file change · AI-Worker")
    .inner_size(720.0, 600.0)
    .min_inner_size(560.0, 440.0)
    .center()
    .build()
    .map(|_| ())
    .map_err(|error| format!("Could not create the write approval window: {error}"))
}

fn validate_task_id(id: &str) -> Result<(), (u16, String)> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Err((400, "Invalid task or question identifier.".into()))
    } else {
        Ok(())
    }
}

fn prune_records(records: &mut HashMap<String, Arc<TaskRecord>>) {
    records.retain(|_, record| {
        let progress = record
            .progress
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        !progress
            .terminal_at
            .is_some_and(|terminal| terminal.elapsed() >= TASK_RETENTION)
    });
}

fn prune_host_sessions(sessions: &mut HashMap<String, HostSession>, now: Instant) {
    sessions.retain(|_, session| {
        now.saturating_duration_since(session.last_seen) < HOST_SESSION_RETENTION
    });
}

fn parse_host_session_request(body: &[u8]) -> Result<HostSessionRequest, (u16, String)> {
    if body.first() != Some(&b'{') {
        return Err((400, "Invalid host session request.".into()));
    }
    let request: HostSessionRequest =
        serde_json::from_slice(body).map_err(|_| (400, "Invalid host session request.".into()))?;
    let id = request.session_id.as_str();
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err((400, "Host session ID is invalid.".into()));
    }
    Ok(request)
}

fn wait_for_service_lock(dir: &Path, stopping: &AtomicBool) -> io::Result<Option<std::fs::File>> {
    // A duplicate UI process waits here so it can become the bridge owner if the current owner exits.
    let lock = owner_only_file()
        .create(true)
        .truncate(false)
        .open(dir.join("ai-worker-mcp-status.lock"))?;
    loop {
        if stopping.load(Ordering::Acquire) {
            return Ok(None);
        }
        match lock.try_lock() {
            Ok(()) => return Ok(Some(lock)),
            Err(std::fs::TryLockError::WouldBlock) => thread::park_timeout(LOCK_RETRY),
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

fn run_service(
    app: &AppHandle,
    dir: &Path,
    lock: std::fs::File,
    stopping: Arc<AtomicBool>,
    tasks: TaskManager,
) -> io::Result<()> {
    if stopping.load(Ordering::Acquire) {
        return Ok(());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = random_hex()?;
    let auth = Arc::new(Endpoint {
        host: format!("127.0.0.1:{port}"),
        port,
        token_hash: Sha256::digest(token.as_bytes()).into(),
    });
    let mut snapshot = Snapshot {
        schema_version: 1,
        app: "AI-Worker",
        version: app.package_info().version.to_string(),
        running: true,
        started_at: now_ms(),
        heartbeat_at: 0,
        privacy_mode: if crate::preferences::get(app)
            .is_ok_and(|preferences| preferences.allow_online_research)
        {
            "connected"
        } else {
            "local-only"
        },
        model: ModelStatus {
            available: false,
            checked_at: 0,
        },
        port: Some(port),
        token: Some(token),
    };
    snapshot.write(dir, app.state::<ModelRuntime>().is_ready())?;
    let inference_in_flight = Arc::new(AtomicBool::new(false));
    let mut heartbeat = Instant::now();
    let mut worker_idle_since = None;
    let mut clients: Vec<JoinHandle<()>> = Vec::new();
    let result = loop {
        if stopping.load(Ordering::Acquire) {
            break Ok(());
        }
        if heartbeat.elapsed() >= HEARTBEAT {
            snapshot.privacy_mode = if crate::preferences::get(app)
                .is_ok_and(|preferences| preferences.allow_online_research)
            {
                "connected"
            } else {
                "local-only"
            };
            if let Err(error) = snapshot.write(dir, app.state::<ModelRuntime>().is_ready()) {
                break Err(error);
            }
            let worker_service_mode = crate::lifecycle::is_worker_service(app);
            let main_window_exists = app.get_webview_window("main").is_some();
            let has_active_work = tasks.has_active_work();
            if worker_service_mode && !main_window_exists && !has_active_work {
                let idle_since = worker_idle_since.get_or_insert_with(Instant::now);
                if crate::lifecycle::should_exit_worker_service(
                    worker_service_mode,
                    main_window_exists,
                    has_active_work,
                    idle_since.elapsed(),
                ) {
                    app.exit(0);
                    break Ok(());
                }
            } else {
                worker_idle_since = None;
            }
            heartbeat = Instant::now();
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback()
                    || stream.set_nonblocking(false).is_err()
                    || stream.set_write_timeout(Some(RESPONSE_TIMEOUT)).is_err()
                {
                    continue;
                }
                clients.retain(|client| !client.is_finished());
                if clients.len() >= MAX_CLIENTS {
                    respond(
                        &mut stream,
                        503,
                        &json!({"error": "Local bridge busy. Retry shortly."}),
                    );
                    continue;
                }
                let (app, auth, stopping, inference, tasks) = (
                    app.clone(),
                    auth.clone(),
                    stopping.clone(),
                    inference_in_flight.clone(),
                    tasks.clone(),
                );
                clients.push(thread::spawn(move || {
                    let result = read_request(&mut stream, &auth)
                        .map_err(|(status, message)| (status, message.to_owned()))
                        .and_then(|request| {
                            if stopping.load(Ordering::Acquire) {
                                return Err((503, "AI-Worker is shutting down.".to_owned()));
                            }
                            process_request(&app, &tasks, inference, request, auth.port)
                        });
                    match result {
                        Ok((status, answer)) => respond(&mut stream, status, &answer),
                        Err((status, message)) => respond(
                            &mut stream,
                            status,
                            &json!({"error": message.chars().take(500).collect::<String>()}),
                        ),
                    }
                }));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::park_timeout(Duration::from_millis(100));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => break Err(error),
        }
    };
    drop(listener);
    let cleared = snapshot.stopped(dir);
    for client in clients {
        let _ = client.join();
    }
    drop(lock);
    result.and(cleared)
}

fn process_request(
    app: &AppHandle,
    tasks: &TaskManager,
    inference: Arc<AtomicBool>,
    request: BridgeRequest,
    a2a_port: u16,
) -> Result<(u16, Value), (u16, String)> {
    match request.route {
        RequestRoute::AgentCard => Ok((
            200,
            a2a::agent_card(
                format!("http://127.0.0.1:{a2a_port}/a2a"),
                app.package_info().version.to_string(),
            ),
        )),
        RequestRoute::A2a => Ok((
            200,
            handle_a2a_request(tasks, app, inference, &request.body),
        )),
        RequestRoute::AskLocal => {
            let prompt = parse_prompt(&request.body)
                .map_err(|(status, message)| (status, message.to_owned()))?;
            let _guard = try_inference(inference)?;
            app.state::<ModelRuntime>()
                .infer(app, &prompt)
                .map(|answer| (200, json!(answer)))
                .map_err(|message| (503, message.to_owned()))
        }
        RequestRoute::RunAgentTask => {
            let _guard = try_inference(inference)?;
            let task = tasks.begin_readonly_task(&request.body)?;
            crate::task_activity::show(app, false);
            let model = app.state::<ModelRuntime>();
            let result = agent_task::run_readonly(
                app,
                &task.request,
                |prompt| {
                    task.begin_inference();
                    model
                        .infer_task_cancellable(app, prompt, Some(&task.cancelled))
                        .map(|result| result.content)
                        .map_err(str::to_owned)
                },
                || task.cancelled.load(Ordering::Acquire),
            );
            let state = task.finish(result.clone());
            tasks.close_activity_if_idle(app);
            if state == TaskState::Cancelled {
                return Err((422, "Task cancelled.".into()));
            }
            result
                .map(|answer| (200, json!(answer)))
                .map_err(|message| (422, message))
        }
        RequestRoute::StartAgentTask => tasks
            .start(app.clone(), inference, &request.body)
            .map(|ack| (202, json!(ack))),
        RequestRoute::OpenHostSession => {
            let ack = tasks.open_host_session(&request.body)?;
            crate::task_activity::show(app, false);
            tasks.close_activity_if_idle(app);
            Ok((200, json!(ack)))
        }
        RequestRoute::HeartbeatHostSession => tasks
            .heartbeat_host_session(&request.body)
            .map(|ack| (200, json!(ack))),
        RequestRoute::CloseHostSession => {
            let ack = tasks.close_host_session(&request.body)?;
            tasks.close_activity_if_idle(app);
            Ok((200, json!(ack)))
        }
        RequestRoute::GetAgentTask(id) => tasks.get(&id).map(|status| (200, json!(status))),
        RequestRoute::AnswerAgentQuestion(id) => tasks
            .answer(&id, &request.body)
            .map(|ack| (200, json!(ack))),
        RequestRoute::CancelAgentTask(id) => {
            let empty: Value = serde_json::from_slice(&request.body)
                .map_err(|_| (400, "Cancel request must be an empty JSON object.".into()))?;
            if !empty.as_object().is_some_and(|object| object.is_empty()) {
                return Err((400, "Cancel request must be an empty JSON object.".into()));
            }
            let result = tasks.cancel(&id);
            tasks
                .refresh_write_approval_window(app)
                .map_err(|error| (503, error))?;
            result.map(|ack| (200, json!(ack)))
        }
    }
}

fn a2a_error(id: Value, code: i64, message: &str, reason: &str, metadata: Value) -> Value {
    let metadata = metadata
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    a2a::error(Some(id), code, message, reason, metadata)
}

fn handle_a2a_request(
    tasks: &TaskManager,
    app: &AppHandle,
    inference: Arc<AtomicBool>,
    body: &[u8],
) -> Value {
    let request = match a2a::parse_request(body) {
        Ok(request) => request,
        Err(error) => {
            let (code, reason) = match error.kind {
                a2a::ParseErrorKind::ParseError => (-32700, "PARSE_ERROR"),
                a2a::ParseErrorKind::InvalidRequest => (-32600, "INVALID_REQUEST"),
                a2a::ParseErrorKind::InvalidParams => (-32602, "INVALID_PARAMS"),
            };
            return a2a_error(Value::Null, code, error.message, reason, json!({}));
        }
    };
    let id = request.id.clone();
    match a2a::Method::parse(&request.method) {
        Some(a2a::Method::SendMessage) => {
            handle_a2a_send_message(tasks, app, inference, id, request.params)
        }
        Some(a2a::Method::GetTask) => handle_a2a_get_task(tasks, id, request.params),
        Some(a2a::Method::ListTasks) => handle_a2a_list_tasks(tasks, id, request.params),
        Some(a2a::Method::CancelTask) => handle_a2a_cancel_task(tasks, app, id, request.params),
        None => a2a_error(
            id,
            -32601,
            "Method not found",
            "METHOD_NOT_FOUND",
            json!({}),
        ),
    }
}

fn handle_a2a_send_message(
    tasks: &TaskManager,
    app: &AppHandle,
    inference: Arc<AtomicBool>,
    rpc_id: Value,
    params: serde_json::Map<String, Value>,
) -> Value {
    let message = match a2a::parse_send_message(&params) {
        Ok(message) => message,
        Err(error) => return a2a_error(rpc_id, -32602, error.message, "INVALID_PARAMS", json!({})),
    };

    if let Some(task_id) = message.task_id.as_deref() {
        let record = match tasks.a2a_record(task_id) {
            Ok(record) => record,
            Err(_) => return a2a_task_not_found(rpc_id, task_id),
        };
        let context_id = record
            .a2a_context_id
            .as_deref()
            .expect("A2A task has context");
        if message
            .context_id
            .as_deref()
            .is_some_and(|provided| provided != context_id)
        {
            return a2a_error(
                rpc_id,
                -32602,
                "Message contextId does not match the referenced task.",
                "INVALID_PARAMS",
                json!({"taskId": task_id}),
            );
        }
        if record.has_a2a_message_id(&message.message_id) {
            return a2a_task_success(rpc_id, &record);
        }

        let view = record.view();
        if view.state == TaskState::WaitingForApproval {
            return a2a_task_success(rpc_id, &record);
        }
        if view.state != TaskState::WaitingForParent {
            return a2a_error(
                rpc_id,
                -32004,
                "This task accepts follow-up messages only when it requests input.",
                "UNSUPPORTED_OPERATION",
                json!({"taskId": task_id}),
            );
        }
        let Some(question_id) = view.pending_question.map(|question| question.id) else {
            return a2a_error(
                rpc_id,
                -32603,
                "The task input request is unavailable.",
                "INTERNAL",
                json!({}),
            );
        };
        if !record.remember_a2a_message_id(&message.message_id) {
            return a2a_task_success(rpc_id, &record);
        }
        let answer = json!({"questionId": question_id, "answer": message.task.prompt}).to_string();
        if tasks.answer(task_id, answer.as_bytes()).is_err() {
            record.forget_a2a_message_id(&message.message_id);
            return a2a_error(
                rpc_id,
                -32602,
                "The task is no longer waiting for this input.",
                "INVALID_PARAMS",
                json!({"taskId": task_id}),
            );
        }
        if !message.return_immediately {
            record.wait_for_a2a_response();
        }
        return a2a_task_success(rpc_id, &record);
    }

    let supplied_context_id = message.context_id.clone();
    let context_id = match supplied_context_id.clone() {
        Some(context_id) => context_id,
        None => match random_hex() {
            Ok(context_id) => context_id,
            Err(_) => {
                return a2a_error(
                    rpc_id,
                    -32603,
                    "Could not create a task context.",
                    "INTERNAL",
                    json!({}),
                )
            }
        },
    };
    let task_body = match serde_json::to_vec(&message.task) {
        Ok(body) => body,
        Err(_) => {
            return a2a_error(
                rpc_id,
                -32603,
                "Could not encode the task request.",
                "INTERNAL",
                json!({}),
            )
        }
    };
    let ack = match tasks.start_a2a(
        app.clone(),
        inference,
        &task_body,
        context_id,
        message.message_id,
    ) {
        Ok(ack) => ack,
        Err((status, _)) => return a2a_bridge_error(rpc_id, status),
    };
    let record = match tasks.a2a_record(&ack.id) {
        Ok(record) => record,
        Err(_) => return a2a_task_not_found(rpc_id, &ack.id),
    };
    if supplied_context_id
        .as_deref()
        .is_some_and(|provided| record.a2a_context_id.as_deref() != Some(provided))
    {
        return a2a_error(
            rpc_id,
            -32602,
            "Message contextId does not match the existing message task.",
            "INVALID_PARAMS",
            json!({"taskId": ack.id}),
        );
    }
    if !message.return_immediately {
        record.wait_for_a2a_response();
    }
    a2a_task_success(rpc_id, &record)
}

fn handle_a2a_get_task(
    tasks: &TaskManager,
    rpc_id: Value,
    params: serde_json::Map<String, Value>,
) -> Value {
    let Some(id) = params.get("id").and_then(Value::as_str) else {
        return a2a_error(
            rpc_id,
            -32602,
            "GetTask requires an id.",
            "INVALID_PARAMS",
            json!({}),
        );
    };
    if params
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "historyLength"))
        || !valid_history_length(&params)
    {
        return a2a_error(
            rpc_id,
            -32602,
            "GetTask parameters are invalid.",
            "INVALID_PARAMS",
            json!({}),
        );
    }
    match tasks.a2a_record(id) {
        Ok(record) => match record.a2a_value() {
            Some(task) => a2a::success(rpc_id, task),
            None => a2a_task_not_found(rpc_id, id),
        },
        Err(_) => a2a_task_not_found(rpc_id, id),
    }
}

fn handle_a2a_list_tasks(
    tasks: &TaskManager,
    rpc_id: Value,
    params: serde_json::Map<String, Value>,
) -> Value {
    if params.keys().any(|key| {
        !matches!(
            key.as_str(),
            "contextId" | "status" | "pageSize" | "pageToken" | "historyLength"
        )
    }) || !valid_history_length(&params)
    {
        return a2a_error(
            rpc_id,
            -32602,
            "ListTasks parameters are invalid.",
            "INVALID_PARAMS",
            json!({}),
        );
    }
    let context_filter = params.get("contextId").and_then(Value::as_str);
    if params.contains_key("contextId") && context_filter.is_none() {
        return a2a_error(
            rpc_id,
            -32602,
            "contextId must be text.",
            "INVALID_PARAMS",
            json!({}),
        );
    }
    let status_filter = match params.get("status") {
        None => None,
        Some(Value::String(value)) if is_a2a_task_state(value) => Some(value.as_str()),
        _ => {
            return a2a_error(
                rpc_id,
                -32602,
                "status is not a supported task state.",
                "INVALID_PARAMS",
                json!({}),
            )
        }
    };
    let page_size = match params.get("pageSize") {
        None => 50,
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|size| (1..=100).contains(size))
            .unwrap_or(0) as usize,
        _ => 0,
    };
    if page_size == 0 {
        return a2a_error(
            rpc_id,
            -32602,
            "pageSize must be between 1 and 100.",
            "INVALID_PARAMS",
            json!({}),
        );
    }
    let offset = match params.get("pageToken") {
        None => 0,
        Some(Value::String(token)) if token.is_empty() => 0,
        Some(Value::String(token)) => match token.parse::<usize>() {
            Ok(offset) => offset,
            Err(_) => {
                return a2a_error(
                    rpc_id,
                    -32602,
                    "pageToken is invalid.",
                    "INVALID_PARAMS",
                    json!({}),
                )
            }
        },
        _ => {
            return a2a_error(
                rpc_id,
                -32602,
                "pageToken is invalid.",
                "INVALID_PARAMS",
                json!({}),
            )
        }
    };
    let matching = tasks
        .a2a_records()
        .into_iter()
        .filter(|record| {
            let context_matches = context_filter
                .is_none_or(|context| record.a2a_context_id.as_deref() == Some(context));
            let state_matches = status_filter.is_none_or(|status| {
                let state = record.view().state;
                status == "TASK_STATE_UNSPECIFIED" || a2a_task_state_name(state) == status
            });
            context_matches && state_matches
        })
        .collect::<Vec<_>>();
    let total = matching.len();
    let selected = matching
        .iter()
        .skip(offset)
        .take(page_size)
        .filter_map(|record| record.a2a_value())
        .collect::<Vec<_>>();
    let next = if offset.saturating_add(selected.len()) < total {
        (offset + selected.len()).to_string()
    } else {
        String::new()
    };
    a2a::success(
        rpc_id,
        json!({
            "tasks": selected,
            "totalSize": total,
            "pageSize": page_size,
            "nextPageToken": next,
        }),
    )
}

fn handle_a2a_cancel_task(
    tasks: &TaskManager,
    app: &AppHandle,
    rpc_id: Value,
    params: serde_json::Map<String, Value>,
) -> Value {
    if params.keys().any(|key| key != "id") {
        return a2a_error(
            rpc_id,
            -32602,
            "CancelTask parameters are invalid.",
            "INVALID_PARAMS",
            json!({}),
        );
    }
    let Some(id) = params.get("id").and_then(Value::as_str) else {
        return a2a_error(
            rpc_id,
            -32602,
            "CancelTask requires an id.",
            "INVALID_PARAMS",
            json!({}),
        );
    };
    let record = match tasks.a2a_record(id) {
        Ok(record) => record,
        Err(_) => return a2a_task_not_found(rpc_id, id),
    };
    if tasks.cancel(id).is_err() {
        return a2a_task_not_found(rpc_id, id);
    }
    let _ = tasks.refresh_write_approval_window(app);
    match record.a2a_value() {
        Some(task) => a2a::success(rpc_id, task),
        None => a2a_task_not_found(rpc_id, id),
    }
}

fn a2a_task_success(rpc_id: Value, record: &TaskRecord) -> Value {
    match record.a2a_value() {
        Some(task) => a2a::success(rpc_id, json!({"task": task})),
        None => a2a_task_not_found(rpc_id, &record.id),
    }
}

fn a2a_task_not_found(rpc_id: Value, id: &str) -> Value {
    a2a_error(
        rpc_id,
        -32001,
        "Task not found",
        "TASK_NOT_FOUND",
        json!({"taskId": id}),
    )
}

fn a2a_bridge_error(rpc_id: Value, status: u16) -> Value {
    match status {
        400 | 422 => a2a_error(
            rpc_id,
            -32602,
            "Task request is invalid or outside the selected workspace.",
            "INVALID_PARAMS",
            json!({}),
        ),
        503 => a2a_error(
            rpc_id,
            -32603,
            "AI-Worker could not start this task.",
            "INTERNAL",
            json!({}),
        ),
        _ => a2a_error(
            rpc_id,
            -32603,
            "AI-Worker could not start this task.",
            "INTERNAL",
            json!({}),
        ),
    }
}

fn valid_history_length(params: &serde_json::Map<String, Value>) -> bool {
    params
        .get("historyLength")
        .is_none_or(|value| value.as_u64().is_some_and(|length| length <= 1_000))
}

fn is_a2a_task_state(value: &str) -> bool {
    matches!(
        value,
        "TASK_STATE_UNSPECIFIED"
            | "TASK_STATE_SUBMITTED"
            | "TASK_STATE_WORKING"
            | "TASK_STATE_COMPLETED"
            | "TASK_STATE_FAILED"
            | "TASK_STATE_CANCELED"
            | "TASK_STATE_REJECTED"
            | "TASK_STATE_INPUT_REQUIRED"
            | "TASK_STATE_AUTH_REQUIRED"
    )
}

fn a2a_task_state_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Queued => "TASK_STATE_SUBMITTED",
        TaskState::Running | TaskState::Cancelling => "TASK_STATE_WORKING",
        TaskState::WaitingForParent => "TASK_STATE_INPUT_REQUIRED",
        TaskState::WaitingForApproval => "TASK_STATE_AUTH_REQUIRED",
        TaskState::Cancelled => "TASK_STATE_CANCELED",
        TaskState::Completed => "TASK_STATE_COMPLETED",
        TaskState::Failed => "TASK_STATE_FAILED",
    }
}

fn try_inference(inference: Arc<AtomicBool>) -> Result<InferenceGuard, (u16, String)> {
    inference
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| {
            (
                409,
                "AI-Worker is already handling a local request. Try again shortly.".into(),
            )
        })?;
    Ok(InferenceGuard(inference))
}

struct Endpoint {
    host: String,
    port: u16,
    token_hash: [u8; 32],
}

type RequestError = (u16, &'static str);
const INVALID: RequestError = (400, "Invalid request.");
const LARGE: RequestError = (413, "Request is too large.");

#[derive(Clone, Debug, PartialEq, Eq)]
enum RequestRoute {
    AgentCard,
    A2a,
    AskLocal,
    RunAgentTask,
    StartAgentTask,
    OpenHostSession,
    HeartbeatHostSession,
    CloseHostSession,
    GetAgentTask(String),
    AnswerAgentQuestion(String),
    CancelAgentTask(String),
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedHeaders {
    route: RequestRoute,
    content_length: usize,
}

struct BridgeRequest {
    route: RequestRoute,
    body: Vec<u8>,
}

fn parse_headers(bytes: &[u8], auth: &Endpoint) -> Result<ParsedHeaders, RequestError> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    if bytes.starts_with(b"\r\n")
        || !bytes.split_inclusive(|&b| b == b'\n').all(|line| {
            line.strip_suffix(b"\r\n")
                .is_some_and(|line| !line.contains(&b'\r'))
        })
        || request.parse(bytes).map_err(|_| INVALID)? != httparse::Status::Complete(bytes.len())
    {
        return Err(INVALID);
    }
    let method = request.method.ok_or(INVALID)?;
    let path = request.path.ok_or(INVALID)?;
    let route = match (method, path) {
        ("GET", "/.well-known/agent-card.json") => RequestRoute::AgentCard,
        ("POST", "/a2a") => RequestRoute::A2a,
        ("POST", "/ask-local") => RequestRoute::AskLocal,
        ("POST", "/run-agent-task") => RequestRoute::RunAgentTask,
        ("POST", "/start-agent-task") => RequestRoute::StartAgentTask,
        ("POST", "/host-session/open") => RequestRoute::OpenHostSession,
        ("POST", "/host-session/heartbeat") => RequestRoute::HeartbeatHostSession,
        ("POST", "/host-session/close") => RequestRoute::CloseHostSession,
        ("GET", path) if path.starts_with("/agent-task/") => {
            let id = &path["/agent-task/".len()..];
            if !valid_task_id_shape(id) {
                return Err(INVALID);
            }
            RequestRoute::GetAgentTask(id.to_owned())
        }
        ("POST", path) if path.starts_with("/agent-task/") && path.ends_with("/answer") => {
            let id = &path["/agent-task/".len()..path.len() - "/answer".len()];
            if !valid_task_id_shape(id) {
                return Err(INVALID);
            }
            RequestRoute::AnswerAgentQuestion(id.to_owned())
        }
        ("POST", path) if path.starts_with("/agent-task/") && path.ends_with("/cancel") => {
            let id = &path["/agent-task/".len()..path.len() - "/cancel".len()];
            if !valid_task_id_shape(id) {
                return Err(INVALID);
            }
            RequestRoute::CancelAgentTask(id.to_owned())
        }
        _ => return Err((404, "Not found.")),
    };
    let is_get = matches!(
        route,
        RequestRoute::GetAgentTask(_) | RequestRoute::AgentCard
    );
    let public_card = matches!(route, RequestRoute::AgentCard);
    let a2a_route = matches!(route, RequestRoute::A2a);
    if request.version != Some(1) {
        return Err(INVALID);
    }
    let mut seen = HashSet::new();
    let mut authorized = false;
    let mut host_matches = false;
    let mut json_type = false;
    let mut length = None;
    for header in request.headers.iter() {
        let name = header.name.to_ascii_lowercase();
        if !seen.insert(name.clone()) {
            return Err(INVALID);
        }
        match name.as_str() {
            "host" => host_matches = header.value == auth.host.as_bytes(),
            "authorization" => {
                if let Some(token) = header.value.strip_prefix(b"Bearer ") {
                    authorized = token_matches(token, &auth.token_hash);
                }
            }
            "origin" => return Err((403, "Browser-origin requests are not supported.")),
            "transfer-encoding" => return Err(INVALID),
            "content-type" => {
                json_type = header.value.eq_ignore_ascii_case(b"application/json")
                    || header
                        .value
                        .eq_ignore_ascii_case(b"application/json; charset=utf-8");
            }
            "content-length" => {
                if header.value.is_empty() || !header.value.iter().all(u8::is_ascii_digit) {
                    return Err(INVALID);
                }
                let value = std::str::from_utf8(header.value).map_err(|_| INVALID)?;
                length = Some(value.parse::<usize>().map_err(|_| LARGE)?);
            }
            "a2a-version" if a2a_route && header.value != b"1.0" => {
                return Err((400, "A2A protocol version 1.0 is required."));
            }
            _ => {}
        }
    }
    if !host_matches {
        return Err((403, "Loopback requests only."));
    }
    if !authorized && !public_card {
        return Err((401, "Unauthorized."));
    }
    if !is_get && !json_type {
        return Err((415, "Expected application/json."));
    }
    let length = match length {
        Some(length) => length,
        None if is_get => 0,
        None => return Err(INVALID),
    };
    if is_get && length != 0 {
        return Err(INVALID);
    }
    if length > MAX_BODY {
        return Err(LARGE);
    }
    Ok(ParsedHeaders {
        route,
        content_length: length,
    })
}

fn token_matches(token: &[u8], expected_hash: &[u8; 32]) -> bool {
    if token.len() != 64 {
        return false;
    }
    let digest = Sha256::digest(token);
    digest
        .iter()
        .zip(expected_hash)
        .fold(0u8, |difference, (actual, expected)| {
            difference | (actual ^ expected)
        })
        == 0
}

fn valid_task_id_shape(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_request(stream: &mut TcpStream, auth: &Endpoint) -> Result<BridgeRequest, RequestError> {
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut bytes = Vec::new();
    let mut chunk = [0; 2048];
    let mut read = |bytes: &mut Vec<u8>| -> Result<(), RequestError> {
        let timeout = deadline
            .checked_duration_since(Instant::now())
            .ok_or(INVALID)?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| INVALID)?;
        let n = stream.read(&mut chunk).map_err(|_| INVALID)?;
        if n == 0 {
            return Err(INVALID);
        }
        bytes.extend_from_slice(&chunk[..n]);
        Ok(())
    };
    let header_end = loop {
        read(&mut bytes)?;
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if index + 4 > MAX_HEADERS {
                return Err(LARGE);
            }
            break index + 4;
        }
        if bytes.len() >= MAX_HEADERS {
            return Err(LARGE);
        }
    };
    let headers = parse_headers(&bytes[..header_end], auth)?;
    while bytes.len() < header_end + headers.content_length {
        read(&mut bytes)?;
    }
    if bytes.len() != header_end + headers.content_length {
        return Err(INVALID);
    }
    Ok(BridgeRequest {
        route: headers.route,
        body: bytes[header_end..].to_vec(),
    })
}

fn parse_prompt(bytes: &[u8]) -> Result<String, RequestError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Body {
        prompt: String,
    }
    // Serde's derived struct also accepts a positional array.
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err(INVALID);
    }
    let body: Body = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    if body.prompt.trim().is_empty() || body.prompt.encode_utf16().count() > MAX_PROMPT {
        return Err((400, "Provide a non-empty prompt up to 8000 characters."));
    }
    Ok(body.prompt.trim().to_owned())
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let body = body.to_string();
    let reason = tauri::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|s| s.canonical_reason())
        .unwrap_or("Error");
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn test_task(id: String, context_id: Option<String>, message_id: Option<String>) -> TaskRecord {
        let request = agent_task::parse_validated_request(
            br#"{"prompt":"Review local changes.","handoffContext":{"sourceAgent":"Parent","summary":"Focus on tests."}}"#,
        )
        .unwrap();
        TaskRecord::new(id, TaskMode::Background, context_id, message_id, request)
    }

    fn test_host_task(id: String, session_id: &str) -> TaskRecord {
        let body = json!({"prompt":"Review local changes.", "hostSessionId":session_id});
        let request = agent_task::parse_validated_request(body.to_string().as_bytes()).unwrap();
        TaskRecord::new(id, TaskMode::Background, None, None, request)
    }

    fn endpoint() -> Endpoint {
        Endpoint {
            host: "127.0.0.1:43123".into(),
            port: 43123,
            token_hash: Sha256::digest(TOKEN.as_bytes()).into(),
        }
    }

    fn headers(extra: &str) -> Vec<u8> {
        format!(
            "POST /ask-local HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 17\r\n{extra}\r\n"
        )
        .into_bytes()
    }

    fn get_headers(path: &str) -> Vec<u8> {
        format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nAuthorization: Bearer {TOKEN}\r\nAccept: application/json\r\n\r\n"
        )
        .into_bytes()
    }

    fn post_headers(path: &str, body: &str) -> Vec<u8> {
        format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn authenticates_only_exact_loopback_json_request() {
        let auth = endpoint();
        assert_eq!(
            parse_headers(&headers(""), &auth).unwrap().content_length,
            17
        );
        assert!(!token_matches(b"short", &auth.token_hash));

        for request in [
            headers("Origin: http://localhost\r\n"),
            headers("Transfer-Encoding: chunked\r\n"),
            headers("Host: 127.0.0.1:43124\r\n"),
            headers("Content-Length: 17\r\n"),
            headers("Authorization: Bearer wrong\r\n"),
        ] {
            assert!(parse_headers(&request, &auth).is_err());
        }
    }

    #[test]
    fn rejects_invalid_methods_routes_headers_and_lengths() {
        let auth = endpoint();
        assert_eq!(
            parse_headers(&headers(""), &auth).unwrap().content_length,
            17
        );
        let wrong_method = headers("").into_iter().collect::<Vec<_>>();
        let wrong_method = String::from_utf8(wrong_method)
            .unwrap()
            .replacen("POST", "GET", 1)
            .into_bytes();
        assert_eq!(
            parse_headers(&wrong_method, &auth),
            Err((404, "Not found."))
        );

        let wrong_route = String::from_utf8(headers(""))
            .unwrap()
            .replacen("/ask-local", "/unknown", 1)
            .into_bytes();
        assert_eq!(
            parse_headers(&wrong_route, &auth).unwrap_err(),
            (404, "Not found.")
        );

        let task_route = String::from_utf8(headers(""))
            .unwrap()
            .replacen("/ask-local", "/run-agent-task", 1)
            .into_bytes();
        assert_eq!(
            parse_headers(&task_route, &auth).unwrap().route,
            RequestRoute::RunAgentTask
        );

        let start_route = post_headers("/start-agent-task", "{}");
        assert_eq!(
            parse_headers(&start_route, &auth).unwrap().route,
            RequestRoute::StartAgentTask
        );
        for (path, expected) in [
            ("/host-session/open", RequestRoute::OpenHostSession),
            (
                "/host-session/heartbeat",
                RequestRoute::HeartbeatHostSession,
            ),
            ("/host-session/close", RequestRoute::CloseHostSession),
        ] {
            assert_eq!(
                parse_headers(&post_headers(path, "{}"), &auth)
                    .unwrap()
                    .route,
                expected
            );
        }
        let id = "a".repeat(64);
        let status_route = get_headers(&format!("/agent-task/{id}"));
        assert_eq!(
            parse_headers(&status_route, &auth).unwrap().route,
            RequestRoute::GetAgentTask(id.clone())
        );
        let answer_route = post_headers(&format!("/agent-task/{id}/answer"), "{}");
        assert_eq!(
            parse_headers(&answer_route, &auth).unwrap().route,
            RequestRoute::AnswerAgentQuestion(id.clone())
        );
        let cancel_route = post_headers(&format!("/agent-task/{id}/cancel"), "{}");
        assert_eq!(
            parse_headers(&cancel_route, &auth).unwrap().route,
            RequestRoute::CancelAgentTask(id)
        );
        assert!(parse_headers(&get_headers("/agent-task/not-an-id"), &auth).is_err());

        let oversized = String::from_utf8(headers(""))
            .unwrap()
            .replace(
                "Content-Length: 17",
                &format!("Content-Length: {}", MAX_BODY + 1),
            )
            .into_bytes();
        assert_eq!(parse_headers(&oversized, &auth), Err(LARGE));

        let duplicate = headers("Host: 127.0.0.1:43123\r\n");
        assert_eq!(parse_headers(&duplicate, &auth), Err(INVALID));
    }

    #[test]
    fn exposes_only_loopback_agent_card_without_bearer() {
        let auth = endpoint();
        let card = String::from_utf8(get_headers("/.well-known/agent-card.json"))
            .unwrap()
            .replace(&format!("Authorization: Bearer {TOKEN}\r\n"), "")
            .into_bytes();
        assert_eq!(
            parse_headers(&card, &auth).unwrap().route,
            RequestRoute::AgentCard
        );

        let a2a = post_headers("/a2a", "{}");
        assert_eq!(parse_headers(&a2a, &auth).unwrap().route, RequestRoute::A2a);
        let unauthorized = String::from_utf8(a2a)
            .unwrap()
            .replace(&format!("Authorization: Bearer {TOKEN}\r\n"), "")
            .into_bytes();
        assert_eq!(
            parse_headers(&unauthorized, &auth),
            Err((401, "Unauthorized."))
        );

        let old_version = String::from_utf8(post_headers("/a2a", "{}"))
            .unwrap()
            .replace("Content-Type:", "A2A-Version: 0.3\r\nContent-Type:")
            .into_bytes();
        assert_eq!(
            parse_headers(&old_version, &auth),
            Err((400, "A2A protocol version 1.0 is required."))
        );

        let remote = String::from_utf8(card)
            .unwrap()
            .replace("127.0.0.1:43123", "192.0.2.10:43123")
            .into_bytes();
        assert_eq!(
            parse_headers(&remote, &auth),
            Err((403, "Loopback requests only."))
        );
    }

    #[test]
    fn requires_crlf_and_complete_consumption() {
        let valid = String::from_utf8(headers("")).unwrap();
        for malformed in [
            format!("\n{valid}"),
            format!("\r\n{valid}"),
            valid.replacen("\r\n", "\n", 1),
            valid.replace("\r\nContent-Type", "\nContent-Type"),
            valid.replace("Host:", "Ho\rst:"),
            valid.replace("\r\n\r\n", "\r\n\n"),
            format!("{valid}Extra: trailing\r\n\r\n"),
        ] {
            assert_eq!(
                parse_headers(malformed.as_bytes(), &endpoint()),
                Err(INVALID)
            );
        }
    }

    #[test]
    fn accepts_bounded_prompt_and_rejects_extra_or_oversized_input() {
        assert_eq!(
            parse_prompt(br#"{"prompt":"  local answer  "}"#),
            Ok("local answer".into())
        );
        for shape in [
            &br#"["answer"]"#[..],
            br#""answer""#,
            b"null",
            b"{}",
            br#"{"prompt":123}"#,
            br#"{"prompt":"first","prompt":"second"}"#,
        ] {
            assert_eq!(parse_prompt(shape), Err(INVALID));
        }
        assert!(parse_prompt(br#"{"prompt":"  "}"#).is_err());
        assert!(parse_prompt(br#"{"prompt":"answer","workspaceRoot":"/tmp"}"#).is_err());
        let oversized = serde_json::to_vec(&json!({"prompt":"雪".repeat(MAX_PROMPT + 1)})).unwrap();
        assert_eq!(
            parse_prompt(&oversized),
            Err((400, "Provide a non-empty prompt up to 8000 characters."))
        );
    }

    #[test]
    fn synchronous_handoffs_share_activity_and_capacity_with_background_tasks() {
        let tasks = TaskManager::default();
        let body = br#"{"prompt":"Review the handoff.","hostSessionId":"session-two"}"#;
        assert_eq!(tasks.begin_readonly_task(b"{}").err().unwrap().0, 422);
        assert!(tasks.activity_snapshot().tasks.is_empty());

        for index in 0..MAX_ACTIVE_TASKS - 1 {
            let id = format!("{index:064x}");
            tasks
                .records
                .lock()
                .unwrap()
                .insert(id.clone(), Arc::new(test_host_task(id, "session-one")));
        }
        let sync = tasks.begin_readonly_task(body).unwrap();
        let snapshot = tasks.activity_snapshot();
        let activity = snapshot
            .tasks
            .iter()
            .find(|task| task.id == sync.id)
            .unwrap();
        assert_eq!(activity.state, TaskState::Running);
        assert_eq!(activity.host_session_id.as_deref(), Some("session-two"));
        assert_eq!(tasks.begin_readonly_task(body).err().unwrap().0, 503);
        sync.finish(Ok(agent_task::TaskResult {
            content: "Done".into(),
            sources: vec![],
        }));
        assert_eq!(tasks.get(&sync.id).unwrap().state, TaskState::Completed);
        let next = tasks.begin_readonly_task(body).unwrap();
        assert_ne!(next.id, sync.id);
        next.finish(Err("Read failed.".into()));
        assert_eq!(tasks.get(&next.id).unwrap().state, TaskState::Failed);
    }

    #[test]
    fn late_cancellation_preserves_the_finished_result_and_early_cancellation_wins() {
        let tasks = TaskManager::default();
        let body = br#"{"prompt":"Review the handoff."}"#;
        let result = Ok(agent_task::TaskResult {
            content: "Done".into(),
            sources: vec![],
        });

        let finished = tasks.begin_readonly_task(body).unwrap();
        assert_eq!(finished.finish(result.clone()), TaskState::Completed);
        assert_eq!(
            tasks.cancel(&finished.id).unwrap().state,
            TaskState::Completed
        );
        assert!(!finished.cancelled.load(Ordering::Acquire));
        assert_eq!(finished.view().result.unwrap().content, "Done");

        let cancelled = tasks.begin_readonly_task(body).unwrap();
        assert_eq!(
            tasks.cancel(&cancelled.id).unwrap().state,
            TaskState::Cancelling
        );
        assert_eq!(cancelled.finish(result), TaskState::Cancelled);
        assert!(cancelled.cancelled.load(Ordering::Acquire));
        assert!(cancelled.view().result.is_none());
        assert_eq!(cancelled.activity().state, TaskState::Cancelled);
    }

    #[test]
    fn capacity_evicts_directly_returned_results_before_older_background_results() {
        let tasks = TaskManager::default();
        let body = br#"{"prompt":"Review the handoff."}"#;
        {
            let mut records = tasks.records.lock().unwrap();
            for index in 0..MAX_TASK_RECORDS - 1 {
                let id = format!("{index:064x}");
                let task = Arc::new(test_task(id.clone(), Some("context".into()), None));
                task.finish(Err("Finished.".into()));
                records.insert(id, task);
            }
        }
        let direct = tasks.begin_readonly_task(body).unwrap();
        direct.finish(Err("Finished.".into()));
        let next = tasks.begin_readonly_task(body).unwrap();
        let records = tasks.records.lock().unwrap();
        assert_eq!(records.len(), MAX_TASK_RECORDS);
        assert!(!records.contains_key(&direct.id));
        assert!(records.contains_key(&next.id));
        assert!(records.contains_key(&format!("{:064x}", 0)));
    }

    #[test]
    fn tracks_multiple_host_sessions_and_keeps_tasks_attached_to_their_session() {
        let manager = TaskManager::default();
        let first = json!({"sessionId":"codex-1"}).to_string();
        let second = json!({"sessionId":"opencode:2"}).to_string();
        assert_eq!(
            manager
                .open_host_session(first.as_bytes())
                .unwrap()
                .connected_sessions,
            1
        );
        assert_eq!(
            manager
                .open_host_session(first.as_bytes())
                .unwrap()
                .connected_sessions,
            1
        );
        assert_eq!(
            manager
                .open_host_session(second.as_bytes())
                .unwrap()
                .connected_sessions,
            2
        );

        let first_task_id = "a".repeat(64);
        let second_task_id = "b".repeat(64);
        {
            let mut records = manager.records.lock().unwrap();
            records.insert(
                first_task_id.clone(),
                Arc::new(test_host_task(first_task_id.clone(), "codex-1")),
            );
            records.insert(
                second_task_id.clone(),
                Arc::new(test_host_task(second_task_id.clone(), "opencode:2")),
            );
        }

        let snapshot = manager.activity_snapshot();
        assert_eq!(snapshot.host_sessions.len(), 2);
        assert_eq!(snapshot.tasks.len(), 2);
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .find(|task| task.id == first_task_id)
                .unwrap()
                .host_session_id
                .as_deref(),
            Some("codex-1")
        );
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .find(|task| task.id == second_task_id)
                .unwrap()
                .host_session_id
                .as_deref(),
            Some("opencode:2")
        );

        assert_eq!(
            manager
                .close_host_session(first.as_bytes())
                .unwrap()
                .connected_sessions,
            1
        );
        assert_eq!(
            manager
                .heartbeat_host_session(first.as_bytes())
                .unwrap_err()
                .0,
            404
        );
        assert_eq!(
            manager
                .heartbeat_host_session(second.as_bytes())
                .unwrap()
                .connected_sessions,
            1
        );
    }

    #[test]
    fn rejects_malformed_host_session_ids_and_enforces_live_session_limit() {
        let manager = TaskManager::default();
        let too_long = "x".repeat(65);
        for id in ["", "has space", "../unsafe", too_long.as_str()] {
            let body = json!({"sessionId":id}).to_string();
            assert_eq!(
                manager.open_host_session(body.as_bytes()).unwrap_err().0,
                400
            );
        }
        for index in 0..MAX_HOST_SESSIONS {
            let body = json!({"sessionId":format!("session-{index}")}).to_string();
            manager.open_host_session(body.as_bytes()).unwrap();
        }
        let overflow = json!({"sessionId":"session-overflow"}).to_string();
        assert_eq!(
            manager
                .open_host_session(overflow.as_bytes())
                .unwrap_err()
                .0,
            503
        );
    }

    #[test]
    fn duplicate_instance_takes_lock_after_current_owner_exits() {
        let dir = std::env::temp_dir().join(format!(
            "ai-worker-mcp-lock-{}-{}",
            std::process::id(),
            random_hex().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        let lock_path = dir.join("ai-worker-mcp-status.lock");
        let owner = owner_only_file()
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        owner.try_lock().unwrap();

        let waiter_dir = dir.clone();
        let (ready, acquired) = std::sync::mpsc::channel();
        let waiter = thread::spawn(move || {
            let result = wait_for_service_lock(&waiter_dir, &AtomicBool::new(false));
            ready.send(()).unwrap();
            result
        });
        assert!(acquired.recv_timeout(Duration::from_millis(50)).is_err());

        drop(owner);
        let lock = waiter.join().unwrap().unwrap().unwrap();
        assert!(lock.metadata().unwrap().is_file());
        drop(lock);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shutdown_cancels_duplicate_instance_lock_wait() {
        let dir = std::env::temp_dir().join(format!(
            "ai-worker-mcp-lock-stop-{}-{}",
            std::process::id(),
            random_hex().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        let owner = owner_only_file()
            .create(true)
            .truncate(false)
            .open(dir.join("ai-worker-mcp-status.lock"))
            .unwrap();
        owner.try_lock().unwrap();

        let stopping = Arc::new(AtomicBool::new(false));
        let waiter_stop = Arc::clone(&stopping);
        let waiter_dir = dir.clone();
        let waiter = thread::spawn(move || wait_for_service_lock(&waiter_dir, &waiter_stop));
        thread::sleep(Duration::from_millis(25));
        stopping.store(true, Ordering::Release);
        waiter.thread().unpark();
        assert!(waiter.join().unwrap().unwrap().is_none());

        drop(owner);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parent_question_waits_for_matching_answer_and_rejects_duplicate_answer() {
        let id = random_hex().unwrap();
        let manager = TaskManager::default();
        let record = Arc::new(test_task(id.clone(), None, None));
        manager
            .records
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&record));

        let waiting_record = Arc::clone(&record);
        let waiting = thread::spawn(move || waiting_record.ask_parent("Which folder?".into()));
        let deadline = Instant::now() + Duration::from_secs(1);
        let question = loop {
            if let Some(question) = record.view().pending_question {
                break question;
            }
            assert!(
                Instant::now() < deadline,
                "task did not publish parent question"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(record.view().state, TaskState::WaitingForParent);

        let wrong = json!({ "questionId": "a".repeat(64), "answer": "src/" }).to_string();
        assert_eq!(manager.answer(&id, wrong.as_bytes()).unwrap_err().0, 409);

        let right = json!({ "questionId": question.id, "answer": "src/" }).to_string();
        assert_eq!(
            manager.answer(&id, right.as_bytes()).unwrap().state,
            TaskState::Queued
        );
        assert_eq!(waiting.join().unwrap().unwrap(), "src/");
        assert_eq!(manager.answer(&id, right.as_bytes()).unwrap_err().0, 409);

        record.finish(Ok(agent_task::TaskResult {
            content: "Found source files.".into(),
            sources: vec!["src/lib.rs".into()],
        }));
        let status = manager.get(&id).unwrap();
        assert_eq!(status.state, TaskState::Completed);
        assert_eq!(status.result.unwrap().sources, vec!["src/lib.rs"]);
        assert!(serde_json::to_string(&manager.get(&id).unwrap())
            .unwrap()
            .contains("Found source files."));
    }

    fn pending_write(task_id: &str, approval_id: &str) -> PendingWriteApproval {
        PendingWriteApproval {
            task_id: task_id.into(),
            approval_id: approval_id.into(),
            task_prompt: "PRIVATE_TASK_PROMPT".into(),
            handoff_context: None,
            workspace_root: "/project".into(),
            relative_path: "README.md".into(),
            before: Some("PRIVATE_OLD_CONTENT".into()),
            proposed: "PRIVATE_NEW_CONTENT".into(),
        }
    }

    #[test]
    fn activity_surfaces_progress_and_context_without_write_proposals_or_results() {
        let manager = TaskManager::default();
        let id = random_hex().unwrap();
        let record = Arc::new(test_task(id.clone(), None, None));
        let mut records = manager.records.lock().unwrap();
        records.insert(id.clone(), Arc::clone(&record));
        drop(records);

        assert_eq!(manager.activity()[0].state, TaskState::Queued);
        record.begin_inference();
        assert_eq!(manager.activity()[0].state, TaskState::Running);

        let approval_id = random_hex().unwrap();
        record
            .begin_write_approval(pending_write(&id, &approval_id))
            .unwrap();
        let snapshot = serde_json::to_value(manager.activity()).unwrap();
        assert_eq!(
            snapshot[0],
            json!({
                "id": id,
                "protocol": "MCP",
                "hostSessionId": null,
                "prompt": "Review local changes.",
                "handoffContext": {
                    "sourceAgent": "Parent",
                    "summary": "Focus on tests.",
                    "constraints": [],
                    "relevantFiles": [],
                    "workingDirectory": null
                },
                "state": "waiting_for_approval",
                "modelTurns": 1,
                "webAccess": false
            })
        );
        assert!(manager.pending_write_approval().is_some());
        manager
            .resolve_write_approval(&id, &approval_id, true)
            .unwrap();
        record.begin_inference();
        record.finish(Ok(agent_task::TaskResult {
            content: "PRIVATE_TASK_RESULT".into(),
            sources: vec![],
        }));
        let tasks = manager.activity();
        assert_eq!(tasks[0].state, TaskState::Completed);
        assert_eq!(tasks[0].model_turns, 2);
        assert!(!serde_json::to_string(&tasks)
            .unwrap()
            .contains("PRIVATE_TASK_RESULT"));
    }

    #[test]
    fn activity_keeps_active_a2a_tasks_ahead_of_recent_completed_tasks() {
        let manager = TaskManager::default();
        let active = Arc::new(test_task("active".into(), Some("context".into()), None));
        let mut records = manager.records.lock().unwrap();
        records.insert(active.id.clone(), Arc::clone(&active));
        for index in 0..10 {
            let record = Arc::new(test_task(format!("finished-{index}"), None, None));
            record.finish(Err("Failure detail".into()));
            records.insert(record.id.clone(), record);
        }
        drop(records);

        let tasks = manager.activity();
        assert_eq!(tasks.len(), MAX_ACTIVE_TASKS * 2);
        assert_eq!(tasks[0].id, active.id);
        assert_eq!(tasks[0].protocol, "A2A");
        assert!(tasks[1..]
            .iter()
            .all(|task| task.state == TaskState::Failed));
    }

    #[test]
    fn approval_state_is_private_from_mcp_status_and_requires_exact_id() {
        let id = random_hex().unwrap();
        let approval_id = random_hex().unwrap();
        let manager = TaskManager::default();
        let record = Arc::new(test_task(id.clone(), None, None));
        record
            .begin_write_approval(pending_write(&id, &approval_id))
            .unwrap();
        manager
            .records
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&record));

        assert_eq!(
            manager.pending_write_approval().unwrap().approval_id,
            approval_id
        );
        let status = serde_json::to_string(&manager.get(&id).unwrap()).unwrap();
        assert!(status.contains("waiting_for_approval"));
        assert!(!status.contains("PRIVATE_TASK_PROMPT"));
        assert!(!status.contains("PRIVATE_OLD_CONTENT"));
        assert!(!status.contains("PRIVATE_NEW_CONTENT"));

        assert!(manager
            .resolve_write_approval(&id, &random_hex().unwrap(), true)
            .is_err());
        manager
            .resolve_write_approval(&id, &approval_id, true)
            .unwrap();
        assert!(manager.pending_write_approval().is_none());
        assert_eq!(record.view().state, TaskState::Queued);
    }

    #[test]
    fn write_approval_wait_returns_approved_or_declined_decision() {
        for approved in [true, false] {
            let id = random_hex().unwrap();
            let approval_id = random_hex().unwrap();
            let record = Arc::new(test_task(id.clone(), None, None));
            let approval = pending_write(&id, &approval_id);
            record.begin_write_approval(approval.clone()).unwrap();

            let waiting_record = Arc::clone(&record);
            let waiting_approval = approval.clone();
            let waiting = thread::spawn(move || {
                waiting_record.wait_for_write_approval(&waiting_approval, &|| false)
            });
            let deadline = Instant::now() + Duration::from_secs(1);
            while record.view().state != TaskState::WaitingForApproval {
                assert!(Instant::now() < deadline, "task did not wait for approval");
                thread::sleep(Duration::from_millis(5));
            }
            record
                .resolve_write_approval(&approval_id, approved)
                .unwrap();
            assert_eq!(waiting.join().unwrap().unwrap(), approved);
            assert_eq!(record.view().state, TaskState::Running);
        }
    }

    #[test]
    fn cancellation_clears_pending_write_and_wakes_waiter_without_approval() {
        let id = random_hex().unwrap();
        let approval_id = random_hex().unwrap();
        let record = Arc::new(test_task(id.clone(), None, None));
        let approval = pending_write(&id, &approval_id);
        record.begin_write_approval(approval.clone()).unwrap();

        let waiting_record = Arc::clone(&record);
        let waiting_approval = approval.clone();
        let waiting = thread::spawn(move || {
            waiting_record.wait_for_write_approval(&waiting_approval, &|| {
                waiting_record.cancelled.load(Ordering::Acquire)
            })
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while record.view().state != TaskState::WaitingForApproval {
            assert!(Instant::now() < deadline, "task did not wait for approval");
            thread::sleep(Duration::from_millis(5));
        }
        record.cancel();

        assert_eq!(waiting.join().unwrap().unwrap_err(), "Task cancelled.");
        assert_eq!(record.view().state, TaskState::Cancelling);
        assert!(record.pending_write_approval().is_none());
    }

    #[test]
    fn cancellation_is_not_reported_until_waiting_task_stops() {
        let id = random_hex().unwrap();
        let manager = TaskManager::default();
        let record = Arc::new(test_task(id.clone(), None, None));
        manager
            .records
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&record));

        let waiting_record = Arc::clone(&record);
        let waiting = thread::spawn(move || waiting_record.ask_parent("Need a choice.".into()));
        let deadline = Instant::now() + Duration::from_secs(1);
        while record.view().state != TaskState::WaitingForParent {
            assert!(Instant::now() < deadline, "task did not start waiting");
            thread::sleep(Duration::from_millis(5));
        }
        let question_id = record.view().pending_question.unwrap().id;

        assert_eq!(manager.cancel(&id).unwrap().state, TaskState::Cancelling);
        assert_eq!(record.view().state, TaskState::Cancelling);
        assert!(waiting.join().unwrap().is_err());
        record.finish(Err("Task cancelled.".into()));
        assert_eq!(record.view().state, TaskState::Cancelled);
        assert_eq!(manager.cancel(&id).unwrap().state, TaskState::Cancelled);
        let late = json!({ "questionId": question_id, "answer": "too late" }).to_string();
        assert_eq!(manager.answer(&id, late.as_bytes()).unwrap_err().0, 409);
    }

    #[test]
    fn status_and_identifier_expiry_do_not_depend_on_inference_admission() {
        let id = random_hex().unwrap();
        let manager = TaskManager::default();
        let record = Arc::new(test_task(id.clone(), None, None));
        record.set_state(TaskState::Running);
        manager
            .records
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&record));
        let inference_in_flight = AtomicBool::new(true);
        let started = Instant::now();
        assert_eq!(manager.get(&id).unwrap().state, TaskState::Running);
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(inference_in_flight.load(Ordering::Acquire));

        assert_eq!(manager.get("invalid").unwrap_err().0, 400);
        assert_eq!(manager.get(&"b".repeat(64)).unwrap_err().0, 404);
        {
            let mut progress = record.progress.lock().unwrap();
            progress.state = TaskState::Completed;
            progress.terminal_at = Some(Instant::now() - TASK_RETENTION - Duration::from_secs(1));
        }
        assert_eq!(manager.get(&id).unwrap_err().0, 404);
    }

    #[test]
    fn maps_a2a_task_states_and_results_without_leaking_internal_errors() {
        let id = random_hex().unwrap();
        let record = test_task(id.clone(), Some("ctx-1".into()), Some("msg-1".into()));
        assert_eq!(
            record.a2a_value().unwrap()["status"]["state"],
            "TASK_STATE_SUBMITTED"
        );

        {
            let mut progress = record.progress.lock().unwrap();
            progress.state = TaskState::WaitingForParent;
            progress.pending_question = Some(ParentQuestion {
                id: "question-1".into(),
                text: "Which file should I read?".into(),
            });
        }
        let question = record.a2a_value().unwrap();
        assert_eq!(question["status"]["state"], "TASK_STATE_INPUT_REQUIRED");
        assert_eq!(
            question["status"]["message"]["parts"][0]["text"],
            "Which file should I read?"
        );

        {
            let mut progress = record.progress.lock().unwrap();
            progress.state = TaskState::WaitingForApproval;
            progress.pending_question = None;
        }
        let approval = record.a2a_value().unwrap();
        assert_eq!(approval["status"]["state"], "TASK_STATE_AUTH_REQUIRED");
        assert!(approval["status"]["message"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("AI-Worker"));

        {
            let mut progress = record.progress.lock().unwrap();
            progress.state = TaskState::Completed;
            progress.result = Some(agent_task::TaskResult {
                content: "Read complete".into(),
                sources: vec!["README.md".into()],
            });
        }
        let completed = record.a2a_value().unwrap();
        assert_eq!(completed["status"]["state"], "TASK_STATE_COMPLETED");
        assert_eq!(
            completed["artifacts"][0]["parts"][0]["text"],
            "Read complete"
        );
        assert_eq!(
            completed["artifacts"][0]["metadata"][a2a::WORKSPACE_EXTENSION]["sources"][0],
            "README.md"
        );

        {
            let mut progress = record.progress.lock().unwrap();
            progress.state = TaskState::Failed;
            progress.error = Some("/private/workspace/secret.txt not readable".into());
        }
        let failed = record.a2a_value().unwrap().to_string();
        assert!(failed.contains("TASK_STATE_FAILED"));
        assert!(!failed.contains("/private/workspace/secret.txt"));
    }

    #[test]
    fn a2a_task_lookup_excludes_mcp_only_records_and_deduplicates_message_ids() {
        let manager = TaskManager::default();
        let a2a_id = random_hex().unwrap();
        let a2a_record = Arc::new(test_task(
            a2a_id.clone(),
            Some("context-1".into()),
            Some("message-1".into()),
        ));
        let mcp_id = random_hex().unwrap();
        let mcp_record = Arc::new(test_task(mcp_id.clone(), None, None));
        {
            let mut records = manager.records.lock().unwrap();
            records.insert(a2a_id.clone(), Arc::clone(&a2a_record));
            records.insert(mcp_id.clone(), mcp_record);
        }

        assert_eq!(manager.a2a_records().len(), 1);
        assert!(manager.a2a_record(&mcp_id).is_err());
        assert!(a2a_record.has_a2a_message_id("message-1"));
        assert!(a2a_record.has_a2a_message_in_context("context-1", "message-1"));
        assert!(!a2a_record.has_a2a_message_in_context("context-2", "message-1"));
        assert!(!a2a_record.remember_a2a_message_id("message-1"));
        assert!(a2a_record.remember_a2a_message_id("message-2"));
    }
}
