//! Native-only queue and fixed loopback transport for the developer local profile.
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};

use crate::{
    bridge::{BridgeState, StatusRequest},
    model_runtime::{ModelRuntime, MODEL_NAME},
};

const MAX_QUEUED: usize = 10;
const MAX_MESSAGES: usize = 32;
const MAX_MESSAGE_BYTES: usize = 8 * 1024;
const MAX_PROMPT_BYTES: usize = 32 * 1024;
const MAX_TASK_ID: usize = 64;
const RESPONSE_DEADLINE: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequest {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
    pub task_id: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAccepted {
    protocol_version: u8,
    owner_id: String,
    session_id: String,
    request_id: String,
    task_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCancelled {
    protocol_version: u8,
    owner_id: String,
    session_id: String,
    request_id: String,
    task_id: String,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
#[serde(rename_all_fields = "camelCase")]
pub enum ChatEvent {
    Started {
        task_id: String,
        request_id: String,
    },
    Chunk {
        task_id: String,
        request_id: String,
        content: String,
    },
    Complete {
        task_id: String,
        request_id: String,
    },
    Failed {
        task_id: String,
        request_id: String,
        message: &'static str,
    },
    Cancelled {
        task_id: String,
        request_id: String,
    },
}

#[derive(Default)]
pub struct ChatState {
    inner: Arc<Mutex<Queue>>,
}

#[derive(Default)]
struct Queue {
    tasks: HashMap<String, Arc<Task>>,
    pending: VecDeque<Arc<Task>>,
    running: bool,
}

struct Task {
    owner: String,
    session: String,
    request: String,
    id: String,
    messages: Vec<ChatMessage>,
    channel: Channel<ChatEvent>,
    cancelled: AtomicBool,
    deadline: Instant,
}

impl ChatState {
    fn submit(&self, task: Arc<Task>) -> Result<bool, &'static str> {
        let mut q = self.inner.lock().map_err(|_| "chat queue unavailable")?;
        if q.tasks.contains_key(&task.id) {
            return Err("chat task already exists");
        }
        if q.running && q.tasks.len() >= MAX_QUEUED + 1 {
            return Err("chat queue is full");
        }
        q.tasks.insert(task.id.clone(), Arc::clone(&task));
        q.pending.push_back(task);
        if !q.running {
            q.running = true;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn cancel(&self, owner: &str, session: &str, id: &str) -> Result<bool, &'static str> {
        let mut q = self.inner.lock().map_err(|_| "chat queue unavailable")?;
        let task = q
            .tasks
            .get(id)
            .filter(|task| task.owner == owner && task.session == session)
            .cloned()
            .ok_or("chat task is no longer active")?;
        task.cancelled.store(true, Ordering::Release);
        let queued = q.pending.iter().any(|item| item.id == id);
        if queued {
            q.pending.retain(|item| item.id != id);
            q.tasks.remove(id);
        }
        drop(q);
        if queued {
            let _ = task.channel.send(ChatEvent::Cancelled {
                task_id: task.id.clone(),
                request_id: task.request.clone(),
            });
        }
        Ok(!queued)
    }

    pub(crate) fn invalidate_sessions(&self, owner: &str, keep_session: &str) -> bool {
        if let Ok(mut q) = self.inner.lock() {
            let queued = q
                .pending
                .iter()
                .map(|task| task.id.clone())
                .collect::<std::collections::HashSet<_>>();
            let stale = q
                .tasks
                .values()
                .filter(|task| task.owner == owner && task.session != keep_session)
                .cloned()
                .collect::<Vec<_>>();
            let active = stale.iter().any(|task| !queued.contains(&task.id));
            for task in &stale {
                task.cancelled.store(true, Ordering::Release);
            }
            q.pending
                .retain(|task| task.owner != owner || task.session == keep_session);
            q.tasks.retain(|_, task| {
                task.owner != owner || task.session == keep_session || !queued.contains(&task.id)
            });
            drop(q);
            for task in stale.into_iter().filter(|task| queued.contains(&task.id)) {
                let _ = task.channel.send(ChatEvent::Cancelled {
                    task_id: task.id.clone(),
                    request_id: task.request.clone(),
                });
            }
            active
        } else {
            false
        }
    }

    pub(crate) fn owner_destroyed(&self, owner: &str) -> bool {
        if let Ok(mut q) = self.inner.lock() {
            let active = q.tasks.values().any(|task| {
                task.owner == owner && !q.pending.iter().any(|pending| pending.id == task.id)
            });
            for task in q.tasks.values().filter(|task| task.owner == owner) {
                task.cancelled.store(true, Ordering::Release);
            }
            q.pending.retain(|task| task.owner != owner);
            q.tasks.retain(|_, task| task.owner != owner);
            active
        } else {
            false
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_chat_start(
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
    window: WebviewWindow,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
    state: State<'_, ChatState>,
) -> Result<ChatAccepted, crate::bridge::BridgeError> {
    validate_payload(&request)?;
    let identity = StatusRequest {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id.clone(),
        session_id: request.session_id.clone(),
        request_id: request.request_id.clone(),
    };
    let task = Arc::new(Task {
        owner: request.owner_id.clone(),
        session: request.session_id.clone(),
        request: request.request_id.clone(),
        id: request.task_id.clone(),
        messages: request.messages,
        channel: on_event,
        cancelled: AtomicBool::new(false),
        deadline: Instant::now() + RESPONSE_DEADLINE,
    });
    let launch = bridge
        .with_authorized_model_request(&window, &identity, || state.submit(Arc::clone(&task)))?
        .map_err(|error| {
            if error == "chat queue unavailable" {
                crate::bridge::BridgeError::internal()
            } else {
                crate::bridge::BridgeError::invalid()
            }
        })?;
    if launch {
        let queue = Arc::clone(&state.inner);
        let app_handle = app.clone();
        if thread::Builder::new()
            .name("native-local-chat".into())
            .spawn(move || worker(queue, app_handle))
            .is_err()
        {
            let failed = if let Ok(mut q) = state.inner.lock() {
                q.running = false;
                q.pending.clear();
                q.tasks.drain().map(|(_, task)| task).collect::<Vec<_>>()
            } else {
                vec![task.clone()]
            };
            for task in failed {
                let _ = task.channel.send(ChatEvent::Failed {
                    task_id: task.id.clone(),
                    request_id: task.request.clone(),
                    message: "chat worker unavailable",
                });
            }
            return Err(crate::bridge::BridgeError::internal());
        }
    }
    Ok(ChatAccepted {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        task_id: request.task_id,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_chat_cancel(
    request: StatusRequest,
    task_id: String,
    window: WebviewWindow,
    bridge: State<'_, BridgeState>,
    state: State<'_, ChatState>,
    runtime: State<'_, ModelRuntime>,
) -> Result<ChatCancelled, crate::bridge::BridgeError> {
    bridge.authorize_model_request(&window, &request)?;
    if !valid_task_id(&task_id) {
        return Err(crate::bridge::BridgeError::invalid());
    }
    let active = state
        .cancel(&request.owner_id, &request.session_id, &task_id)
        .map_err(|error| {
            if error == "chat queue unavailable" {
                crate::bridge::BridgeError::internal()
            } else {
                crate::bridge::BridgeError::invalid()
            }
        })?;
    if active {
        runtime.stop();
    }
    Ok(ChatCancelled {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        task_id,
        cancelled: true,
    })
}

fn validate_payload(request: &ChatRequest) -> Result<(), crate::bridge::BridgeError> {
    if !crate::model_setup::developer_candidate_available()
        || !valid_task_id(&request.task_id)
        || request.messages.is_empty()
        || request.messages.len() > MAX_MESSAGES
    {
        return Err(crate::bridge::BridgeError::invalid());
    }
    validate_messages(&request.messages).map_err(|_| crate::bridge::BridgeError::invalid())
}

fn validate_messages(messages: &[ChatMessage]) -> Result<(), &'static str> {
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err("chat request rejected");
    }
    let mut total = 0usize;
    for message in messages {
        let n = message.content.len();
        if n == 0 || n > MAX_MESSAGE_BYTES || message.content.contains('\0') {
            return Err("chat request rejected");
        }
        total = total.checked_add(n).ok_or("chat request rejected")?;
    }
    if total > MAX_PROMPT_BYTES {
        return Err("chat request rejected");
    }
    Ok(())
}

fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_TASK_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn worker(queue: Arc<Mutex<Queue>>, app: AppHandle) {
    loop {
        let task = match queue.lock() {
            Ok(mut q) => match q.pending.pop_front() {
                Some(task) => Some(task),
                None => {
                    q.running = false;
                    None
                }
            },
            Err(_) => None,
        };
        let Some(task) = task else { return };
        let mut failed = None;
        if task.cancelled.load(Ordering::Acquire) {
            // Skip startup when cancellation wins before the worker begins.
        } else if task_deadline_expired(&task) {
            failed = Some("chat response timed out");
        } else {
            if task
                .channel
                .send(ChatEvent::Started {
                    task_id: task.id.clone(),
                    request_id: task.request.clone(),
                })
                .is_err()
            {
                task.cancelled.store(true, Ordering::Release);
            } else {
                let result = app
                    .state::<ModelRuntime>()
                    .chat_endpoint(&app, task.deadline, &task.cancelled)
                    .and_then(|(port, auth)| request_stream(port, &auth, &task));
                if let Err(message) = result {
                    failed = Some(message);
                }
            }
        }
        let terminal = queue
            .lock()
            .ok()
            .and_then(|mut q| terminal_event(&mut q, &task, failed));
        if let Some(event) = terminal {
            let _ = task.channel.send(event);
        }
    }
}

fn terminal_event(q: &mut Queue, task: &Task, failed: Option<&'static str>) -> Option<ChatEvent> {
    q.tasks.remove(&task.id).map(|_| {
        if task.cancelled.load(Ordering::Acquire) {
            ChatEvent::Cancelled {
                task_id: task.id.clone(),
                request_id: task.request.clone(),
            }
        } else if let Some(message) = failed {
            ChatEvent::Failed {
                task_id: task.id.clone(),
                request_id: task.request.clone(),
                message,
            }
        } else {
            ChatEvent::Complete {
                task_id: task.id.clone(),
                request_id: task.request.clone(),
            }
        }
    })
}

fn task_deadline_expired(task: &Task) -> bool {
    Instant::now() >= task.deadline
}

fn request_stream(port: u16, auth: &str, task: &Task) -> Result<(), &'static str> {
    if task.cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    if Instant::now() >= task.deadline {
        return Err("chat response timed out");
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "model": MODEL_NAME,
        "messages": task.messages,
        "stream": true,
        "max_tokens": 128,
        "temperature": 0.7
    }))
    .map_err(|_| "chat backend failed")?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let connect_timeout = task.deadline.saturating_duration_since(Instant::now());
    if connect_timeout.is_zero() {
        return Err("chat response timed out");
    }
    let mut stream =
        TcpStream::connect_timeout(&address, connect_timeout.min(Duration::from_secs(2))).map_err(
            |_| {
                if task_deadline_expired(task) {
                    "chat response timed out"
                } else {
                    "chat backend unavailable"
                }
            },
        )?;
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|_| "chat backend failed")?;
    let write_timeout = task.deadline.saturating_duration_since(Instant::now());
    if write_timeout.is_zero() {
        return Err("chat response timed out");
    }
    stream
        .set_write_timeout(Some(write_timeout.min(Duration::from_secs(2))))
        .map_err(|_| "chat backend failed")?;
    write!(stream, "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {auth}\r\nContent-Type: application/json\r\nAccept: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).and_then(|_| stream.write_all(&body)).map_err(|_| {
        if task_deadline_expired(task) {
            "chat response timed out"
        } else {
            "chat backend failed"
        }
    })?;
    let deadline = task.deadline;
    let mut wire = Vec::new();
    let mut total = 0usize;
    let (header_end, headers) = loop {
        if task.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("chat response timed out");
        }
        let mut buffer = [0u8; 4096];
        match stream.read(&mut buffer) {
            Ok(0) => return Err("chat backend closed before response"),
            Ok(n) => {
                total += n;
                if total > MAX_RESPONSE_BYTES {
                    return Err("chat response exceeded limit");
                }
                wire.extend_from_slice(&buffer[..n]);
                if let Some(end) = find_header_end(&wire) {
                    let headers = wire[..end].to_vec();
                    if !successful_response(&headers) {
                        return Err("chat backend rejected request");
                    }
                    break (end, headers);
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Err("chat backend failed"),
        }
    };
    let chunked = String::from_utf8_lossy(&headers)
        .to_ascii_lowercase()
        .lines()
        .any(|line| line.trim() == "transfer-encoding: chunked");
    wire.drain(..header_end + 4);
    let mut sse = Vec::new();
    loop {
        if task.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let chunk_done = if chunked {
            decode_chunks(&mut wire, &mut sse)?.unwrap_or(false)
        } else {
            false
        };
        if chunk_done {
            let _ = consume_sse(&mut sse, task)?;
            return Ok(());
        } else if !wire.is_empty() {
            sse.extend(wire.drain(..));
        }
        if consume_sse(&mut sse, task)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("chat response timed out");
        }
        let mut buffer = [0u8; 4096];
        match stream.read(&mut buffer) {
            Ok(0) => return Err("chat backend closed before completion"),
            Ok(n) => {
                total += n;
                if total > MAX_RESPONSE_BYTES {
                    return Err("chat response exceeded limit");
                }
                wire.extend_from_slice(&buffer[..n]);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Err("chat backend failed"),
        }
    }
}

fn decode_chunks(wire: &mut Vec<u8>, sse: &mut Vec<u8>) -> Result<Option<bool>, &'static str> {
    loop {
        let Some(line_end) = wire.windows(2).position(|w| w == b"\r\n") else {
            return Ok(None);
        };
        let line = std::str::from_utf8(&wire[..line_end])
            .map_err(|_| "chat backend returned invalid data")?;
        let size = usize::from_str_radix(line.split(';').next().unwrap_or(""), 16)
            .map_err(|_| "chat backend returned invalid data")?;
        if size == 0 {
            return Ok(Some(true));
        }
        let data_start = line_end + 2;
        let data_end = data_start
            .checked_add(size)
            .ok_or("chat response exceeded limit")?;
        if wire.len() < data_end + 2 {
            return Ok(None);
        }
        sse.extend_from_slice(&wire[data_start..data_end]);
        if &wire[data_end..data_end + 2] != b"\r\n" {
            return Err("chat backend returned invalid data");
        }
        wire.drain(..data_end + 2);
    }
}

fn consume_sse(bytes: &mut Vec<u8>, task: &Task) -> Result<bool, &'static str> {
    loop {
        let delimiter = bytes
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| (i, 4))
            .or_else(|| bytes.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)));
        let Some((end, sep)) = delimiter else {
            return Ok(false);
        };
        let event = bytes[..end].to_vec();
        bytes.drain(..end + sep);
        if is_done_event(&event) {
            return Ok(true);
        }
        process_sse(&event, task)?;
    }
}

fn is_done_event(event: &[u8]) -> bool {
    event
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(b"data:"))
        .any(|data| trim_ascii(data) == b"[DONE]")
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|w| w == b"\r\n\r\n")
}

fn successful_response(headers: &[u8]) -> bool {
    headers.starts_with(b"HTTP/1.1 200 ") || headers.starts_with(b"HTTP/1.0 200 ")
}

fn process_sse(bytes: &[u8], task: &Task) -> Result<(), &'static str> {
    let data = bytes
        .strip_prefix(b"data:")
        .map(|d| trim_ascii(d))
        .unwrap_or_default();
    if data.is_empty() || data == b"[DONE]" {
        return Ok(());
    }
    let value: serde_json::Value =
        serde_json::from_slice(data).map_err(|_| "chat backend returned invalid data")?;
    if let Some(error) = value.get("error") {
        let _ = error;
        return Err("chat backend returned an error");
    }
    let content = value
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("delta"))
        .and_then(|v| v.get("content"))
        .and_then(serde_json::Value::as_str);
    if let Some(content) = content.filter(|s| !s.is_empty()) {
        if task.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        task.channel
            .send(ChatEvent::Chunk {
                task_id: task.id.clone(),
                request_id: task.request.clone(),
                content: content.to_owned(),
            })
            .map_err(|_| "chat receiver unavailable")?;
    }
    Ok(())
}

fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |i| i + 1);
    &bytes[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_http_request(socket: &mut TcpStream) {
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
        }
        let headers = std::str::from_utf8(&request).unwrap();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let body_start = request.len();
        request.resize(request.len() + content_length, 0);
        socket.read_exact(&mut request[body_start..]).unwrap();
    }

    fn task(id: &str, owner: &str, session: &str) -> Arc<Task> {
        Arc::new(Task {
            owner: owner.into(),
            session: session.into(),
            request: format!("req-{id}"),
            id: id.into(),
            messages: vec![ChatMessage {
                role: Role::User,
                content: "hi".into(),
            }],
            channel: Channel::new(|_| Ok(())),
            cancelled: AtomicBool::new(false),
            deadline: Instant::now() + RESPONSE_DEADLINE,
        })
    }

    #[test]
    fn expired_queued_task_is_rejected_before_runtime_start() {
        let mut task = task("expired", "main", "s1");
        Arc::get_mut(&mut task).unwrap().deadline = Instant::now() - Duration::from_millis(1);
        assert!(task_deadline_expired(&task));
        assert!(!task.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn queue_bounds_pending_work_and_scopes_cancel_to_owner_session() {
        let state = ChatState::default();
        assert!(state.submit(task("t0", "main", "s1")).unwrap());
        for n in 1..=MAX_QUEUED {
            assert!(!state.submit(task(&format!("t{n}"), "main", "s1")).unwrap());
        }
        assert_eq!(
            state.submit(task("overflow", "main", "s1")).unwrap_err(),
            "chat queue is full"
        );
        assert_eq!(
            state.cancel("other", "s1", "t1").unwrap_err(),
            "chat task is no longer active"
        );
        state.cancel("main", "s1", "t1").unwrap();
        assert!(!state.inner.lock().unwrap().tasks.contains_key("t1"));
        state.invalidate_sessions("main", "s2");
        assert!(state.inner.lock().unwrap().tasks.is_empty());
        let active = task("active", "main", "s2");
        state.submit(Arc::clone(&active)).unwrap();
        state.owner_destroyed("main");
        assert!(active.cancelled.load(Ordering::Acquire));
        assert!(state.inner.lock().unwrap().tasks.is_empty());
    }

    #[test]
    fn queue_allows_one_active_plus_ten_waiting_after_worker_pops_active() {
        let state = ChatState::default();
        let active = task("active", "main", "s1");
        assert!(state.submit(Arc::clone(&active)).unwrap());
        assert_eq!(
            state.inner.lock().unwrap().pending.pop_front().unwrap().id,
            "active"
        );
        for n in 1..=MAX_QUEUED {
            assert!(!state.submit(task(&format!("t{n}"), "main", "s1")).unwrap());
        }
        assert_eq!(
            state.submit(task("overflow", "main", "s1")).unwrap_err(),
            "chat queue is full"
        );
    }

    #[test]
    fn cancel_and_completion_choose_only_one_terminal_event() {
        let state = Arc::new(ChatState::default());
        let task = task("race", "main", "s1");
        state.submit(Arc::clone(&task)).unwrap();
        state.inner.lock().unwrap().pending.clear();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let cancel_state = Arc::clone(&state);
        let cancel_barrier = Arc::clone(&barrier);
        let cancel = thread::spawn(move || {
            cancel_barrier.wait();
            cancel_state.cancel("main", "s1", "race")
        });
        let finish_state = Arc::clone(&state);
        let finish_task = Arc::clone(&task);
        let finish_barrier = Arc::clone(&barrier);
        let finish = thread::spawn(move || {
            finish_barrier.wait();
            terminal_event(&mut finish_state.inner.lock().unwrap(), &finish_task, None).unwrap()
        });
        barrier.wait();
        let cancel = cancel.join().unwrap();
        let terminal = finish.join().unwrap();
        match (cancel.is_ok(), terminal) {
            (true, ChatEvent::Cancelled { .. }) | (false, ChatEvent::Complete { .. }) => {}
            pair => panic!("cancel and completion chose conflicting terminal events: {pair:?}"),
        }
        assert!(state.inner.lock().unwrap().tasks.is_empty());
    }

    #[test]
    fn payload_and_response_policy_reject_tampering_and_redirects() {
        let unknown = r#"{"protocolVersion":1,"ownerId":"main","sessionId":"s-1","requestId":"r-1","taskId":"t-1","messages":[{"role":"user","content":"hi","extra":true}]}"#;
        assert!(serde_json::from_str::<ChatRequest>(unknown).is_err());
        assert!(validate_messages(&[]).is_err());
        assert!(validate_messages(&[ChatMessage {
            role: Role::User,
            content: "x".repeat(MAX_MESSAGE_BYTES + 1)
        }])
        .is_err());
        assert!(successful_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream"
        ));
        assert!(!successful_response(
            b"HTTP/1.1 302 Found\r\nLocation: https://example.com"
        ));
        assert!(!successful_response(b"HTTP/1.1 2000 OK"));
        assert!(is_done_event(b"data: [DONE]\r\n"));
        assert!(!is_done_event(b"data: {\"content\":\"[DONE]\"}\r\n"));
    }

    #[test]
    fn decodes_chunked_body_and_refuses_bad_chunk_lengths() {
        let mut wire = b"4\r\ndata\r\n0\r\n\r\n".to_vec();
        let mut body = Vec::new();
        assert_eq!(decode_chunks(&mut wire, &mut body).unwrap(), Some(true));
        assert_eq!(body, b"data");
        assert!(decode_chunks(&mut b"z\r\n".to_vec(), &mut Vec::new()).is_err());
    }

    #[test]
    fn late_backend_frames_are_discarded_after_cancellation_and_errors_fail_closed() {
        let (tx, rx) = std::sync::mpsc::channel();
        let channel = Channel::new(move |_| {
            tx.send(()).unwrap();
            Ok(())
        });
        let task = Task {
            owner: "main".into(),
            session: "s1".into(),
            request: "r1".into(),
            id: "t1".into(),
            messages: vec![],
            channel,
            cancelled: AtomicBool::new(true),
            deadline: Instant::now() + RESPONSE_DEADLINE,
        };
        assert!(process_sse(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}",
            &task
        )
        .is_ok());
        assert!(rx.try_recv().is_err());
        task.cancelled.store(false, Ordering::Release);
        assert!(process_sse(
            b"data: {\"error\":{\"message\":\"backend failure\"}}",
            &task
        )
        .is_err());
        let closed = Task {
            owner: "main".into(),
            session: "s1".into(),
            request: "r2".into(),
            id: "t2".into(),
            messages: vec![],
            channel: Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage)),
            cancelled: AtomicBool::new(false),
            deadline: Instant::now() + RESPONSE_DEADLINE,
        };
        assert_eq!(
            process_sse(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}",
                &closed
            )
            .unwrap_err(),
            "chat receiver unavailable"
        );
    }

    #[test]
    fn streams_local_sse_and_rejects_backend_redirect() {
        use std::{net::TcpListener, sync::mpsc};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
        let response = format!("{:X}\r\n", body.len());
        let mut wire = response.into_bytes();
        wire.extend_from_slice(body);
        wire.extend_from_slice(b"\r\n0\r\n\r\n");
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_http_request(&mut socket);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            socket.write_all(&wire).unwrap();
        });
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |message| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = message {
                tx.send(body).unwrap();
            }
            Ok(())
        });
        let task = Task {
            owner: "main".into(),
            session: "s1".into(),
            request: "r1".into(),
            id: "t1".into(),
            messages: vec![ChatMessage {
                role: Role::User,
                content: "hello".into(),
            }],
            channel,
            cancelled: AtomicBool::new(false),
            deadline: Instant::now() + RESPONSE_DEADLINE,
        };
        request_stream(port, "native-secret", &task).unwrap();
        server.join().unwrap();
        let chunk: serde_json::Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
        assert_eq!(chunk["event"], "chunk");
        assert_eq!(chunk["data"]["content"], "hi");
        let mut queue = Queue::default();
        queue.tasks.insert(
            task.id.clone(),
            Arc::new(Task {
                owner: task.owner.clone(),
                session: task.session.clone(),
                request: task.request.clone(),
                id: task.id.clone(),
                messages: task.messages.clone(),
                channel: task.channel.clone(),
                cancelled: AtomicBool::new(false),
                deadline: task.deadline,
            }),
        );
        let complete = terminal_event(&mut queue, &task, None).unwrap();
        assert!(matches!(complete, ChatEvent::Complete { .. }));

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_http_request(&mut socket);
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.com\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        assert_eq!(
            request_stream(port, "native-secret", &task).unwrap_err(),
            "chat backend rejected request"
        );
        server.join().unwrap();
    }
}
