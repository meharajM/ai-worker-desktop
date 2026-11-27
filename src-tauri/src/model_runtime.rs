use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use std::os::unix::net::UnixStream;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) const SERVER_SHA256: &str =
    "93c9a6ddd5870fae262f728f54be710b5d3c5436b8980f4ab684bba87b5c34f7";
pub(crate) const MODEL_NAME: &str = "Qwen3-1.7B-Q4_K_M.gguf";
pub(crate) const MODEL_SIZE: u64 = 1_107_408_544;
pub(crate) const MODEL_SHA256: &str =
    "228fb5627f7510b8b3516cdb6435e4b0d2a2bf330fe5b0ab19284a3570a8bb1f";
pub(crate) const MODEL_SOURCE: &str =
    "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/tree/7fb011e9aee6e4dc7adf8430df9ea8de6a466aa3";
// M10a extracted this template from the exact GGUF; the pinned artifact digest binds it without another parser.
pub(crate) const TEMPLATE_SHA256: &str =
    "57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361";
pub(crate) const MODEL_DISK_REQUIREMENT: u64 = MODEL_SIZE * 2;
const START_TIMEOUT: Duration = Duration::from_secs(60);
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(60);
const OLLAMA_INFERENCE_TIMEOUT: Duration = Duration::from_secs(110);
const OLLAMA_PULL_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const MAX_PROMPT_LENGTH: usize = 8_000;
const MAX_REPLY_BYTES: usize = 64 * 1024;
const MAX_OLLAMA_HEADERS: usize = 8 * 1024;
const OLLAMA_HOST: &str = "127.0.0.1";
const OLLAMA_PORT: u16 = 11_434;
const OLLAMA_MODEL_ENV: &str = "AI_WORKER_OLLAMA_MODEL";
const OLLAMA_NO_TEXT_ERROR: &str = "The selected local model returned no answer text. Choose another installed local model and retry. No cloud fallback was used.";
const OLLAMA_STATUS_TIMEOUT: Duration = Duration::from_millis(500);
const OLLAMA_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const CANCELLATION_POLL: Duration = Duration::from_millis(100);
const STOP_GRACE: Duration = Duration::from_millis(2_500);
const STOP_KILL_WAIT: Duration = Duration::from_secs(2);

const RUNTIME_LIBRARIES: &[(&str, &str)] = &[
    (
        "libllama-common.0.6.0.dylib",
        "e6f474c60a5be78638327abfbf97ac3c97f71cde70e6e3bc0d16ed07dc9d04a0",
    ),
    (
        "libllama.0.6.0.dylib",
        "b285d66178ee8c3435647e36cc6bd083e378b1bbbe76a2b5052858052bc4c535",
    ),
    (
        "libmtmd.0.6.0.dylib",
        "83d59ebecd1bcacff005cc9e839bd0b5ed468c1b4c58ece511c2b2d1804e2634",
    ),
    (
        "libggml-blas.0.26.0.dylib",
        "01935cdd416e53248b33c41de233e18eebe12b4843efca5d1dd73df0321ae471",
    ),
    (
        "libllama-server-impl.dylib",
        "468bc05071b997ab87898d5223e28a56c6ed624b09ce6fbdfdc307a2a098ea3b",
    ),
    (
        "libggml-metal.0.26.0.dylib",
        "83f75ce4bacb85184ac2bd36db138365e444ea482f8f7f709970dd85da363748",
    ),
    (
        "libggml-cpu.0.26.0.dylib",
        "93796499f59ecfca66cc4063081fbf8bcce26417db83fed59db2ef1107345428",
    ),
    (
        "libggml.0.26.0.dylib",
        "faa5a0c8b3120e4f4339df525d5a34d005c3d688687e6a517a60f687daf5cbc2",
    ),
    (
        "libggml-base.0.26.0.dylib",
        "867d2eef449e1e513ed9160b26eee4b9d29ef014e70fe97475da0c9f94ce2a93",
    ),
];

#[derive(Default)]
pub struct ModelRuntime {
    server: Mutex<Option<OwnedServer>>,
    shutting_down: AtomicBool,
    spawn_gate: Mutex<()>,
}

#[derive(serde::Serialize)]
pub struct LocalInferenceResult {
    pub content: String,
    pub provider: &'static str,
    pub model: String,
}

struct Assets {
    executable: PathBuf,
    model: PathBuf,
    library_dir: PathBuf,
}

struct OwnedServer {
    child: Child,
    auth: String,
    private_dir: PathBuf,
}

impl OwnedServer {
    fn socket_path(&self) -> PathBuf {
        self.private_dir.join("model.sock")
    }
}

impl ModelRuntime {
    fn check_running(&self) -> Result<(), &'static str> {
        if self.shutting_down.load(Ordering::Acquire) {
            Err("runtime start cancelled")
        } else {
            Ok(())
        }
    }

    pub fn is_ready(&self) -> bool {
        if self.shutting_down.load(Ordering::Acquire) {
            return false;
        }
        let llama_ready = self.server.try_lock().is_ok_and(|mut current| {
            current.as_mut().is_some_and(|server| {
                matches!(server.child.try_wait(), Ok(None)) && authenticated_models(server)
            })
        });
        llama_ready || ollama_runtime_ready()
    }

    pub fn infer<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompt: &str,
    ) -> Result<LocalInferenceResult, &'static str> {
        self.infer_cancellable(app, prompt, None)
    }

    pub fn infer_cancellable<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompt: &str,
        cancelled: Option<&AtomicBool>,
    ) -> Result<LocalInferenceResult, &'static str> {
        let body = completion_body(prompt)?;
        check_cancelled(cancelled)?;
        self.check_running()?;
        let ollama = infer_ollama(prompt, cancelled)?;
        check_cancelled(cancelled)?;
        if let Some(result) = ollama {
            return Ok(result);
        }
        check_cancelled(cancelled)?;
        #[cfg(not(all(debug_assertions, target_os = "macos", target_arch = "aarch64")))]
        {
            let _ = (app, body);
            return Err("Local inference needs an installed local Ollama model or an Apple Silicon macOS developer build. No cloud fallback was used.");
        }
        #[cfg(all(debug_assertions, target_os = "macos", target_arch = "aarch64"))]
        {
            let socket = self.start(app).map_err(|error| match error {
            "runtime resources unavailable" => {
                "The pinned on-device runtime is not bundled in this build. No cloud fallback was used."
            }
            "verified model runtime assets missing" => {
                "The pinned local runtime or verified GGUF is missing. No cloud fallback was used."
            }
            "verified model runtime assets unreadable" => {
                "The pinned local runtime or verified GGUF could not be read."
            }
            "verified model runtime assets invalid" | "verified model runtime digest mismatch" => {
                "The pinned local runtime or verified GGUF failed its integrity check."
            }
            other => other,
        })?;
            let (stream, auth) = {
                let mut current = self
                    .server
                    .lock()
                    .map_err(|_| "runtime state unavailable")?;
                let server = current
                    .as_mut()
                    .filter(|s| s.socket_path() == socket)
                    .ok_or("local runtime stopped")?;
                self.check_running()?;
                let stream = connect_owned_socket(&socket, server.child.id())?;
                if !matches!(server.child.try_wait(), Ok(None)) {
                    return Err("local runtime exited");
                }
                (stream, server.auth.clone())
            };
            let content = request_completion(stream, &auth, &body, cancelled)?;
            check_cancelled(cancelled)?;
            Ok(LocalInferenceResult {
                content,
                provider: "llama.cpp",
                model: MODEL_NAME.to_owned(),
            })
        }
    }

    fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, &'static str> {
        if let Some(socket) = self.live_server_socket()? {
            return Ok(socket);
        }
        self.start_assets(resolve_assets(app)?)
    }

    fn live_server_socket(&self) -> Result<Option<PathBuf>, &'static str> {
        self.check_running()?;
        let mut current = self
            .server
            .lock()
            .map_err(|_| "runtime state unavailable")?;
        self.check_running()?;
        let Some(server) = current.as_mut() else {
            return Ok(None);
        };
        match server
            .child
            .try_wait()
            .map_err(|_| "runtime status unavailable")?
        {
            None => Ok(Some(server.socket_path())),
            Some(_) => {
                stop_owned(&mut current);
                Ok(None)
            }
        }
    }

    pub fn shutdown(&self) {
        {
            // Serialize the permanent shutdown flag with the final check and spawn.
            let _gate = self
                .spawn_gate
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            self.shutting_down.store(true, Ordering::Release);
        }
        let mut owned = self.server.lock().unwrap_or_else(|err| err.into_inner());
        stop_owned(&mut owned);
    }

    fn start_assets(&self, assets: Assets) -> Result<PathBuf, &'static str> {
        if let Some(socket) = self.live_server_socket()? {
            return Ok(socket);
        }
        verify_runtime_assets(&assets)?;
        let (model_file, model_argument) = open_verified_model(&assets.model, &self.shutting_down)?;
        self.check_running()?;

        let mut current = self
            .server
            .lock()
            .map_err(|_| "runtime state unavailable")?;
        if let Some(server) = current.as_mut() {
            if server
                .child
                .try_wait()
                .map_err(|_| "runtime status unavailable")?
                .is_none()
            {
                self.check_running()?;
                return Ok(server.socket_path());
            }
        }
        stop_owned(&mut current);

        self.check_running()?;
        let (private_dir, auth_file, auth) = private_auth()?;
        let socket = private_dir.join("model.sock");
        let mut command = Command::new(&assets.executable);
        command
            .arg("-m")
            .arg(model_argument)
            .args(["--offline", "--host"])
            .arg(&socket)
            .arg("--api-key-file")
            .arg(auth_file)
            // Keep the OpenAI model ID local and prevent implicit remote model loads.
            .args(["--alias", MODEL_NAME, "--no-models-autoload"])
            .args([
                "--no-webui",
                "--no-agent",
                "--no-ui-mcp-proxy",
                "--parallel",
                "1",
                "-c",
                "2048",
                "-n",
                "128",
                "-b",
                "128",
                "-ub",
                "64",
                "--threads",
                "4",
                "--threads-batch",
                "4",
                "--reasoning",
                "off",
            ])
            .current_dir(&private_dir)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &private_dir)
            .env("TMPDIR", &private_dir)
            .env("DYLD_LIBRARY_PATH", &assets.library_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        #[cfg(target_os = "macos")]
        if let Some(model_file) = model_file.as_ref() {
            use std::os::{fd::AsRawFd, unix::process::CommandExt};
            let model_fd = model_file.as_raw_fd();
            unsafe extern "C" {
                fn fcntl(fd: i32, command: i32, flags: i32) -> i32;
            }
            // Clear close-on-exec only in the child so llama-server reads the same inode that was hashed.
            unsafe {
                command.pre_exec(move || {
                    const F_GETFD: i32 = 1;
                    const F_SETFD: i32 = 2;
                    const FD_CLOEXEC: i32 = 1;
                    let flags = fcntl(model_fd, F_GETFD, 0);
                    if flags < 0 || fcntl(model_fd, F_SETFD, flags & !FD_CLOEXEC) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        let child = {
            let _gate = self
                .spawn_gate
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            self.check_running()
                .and_then(|()| command.spawn().map_err(|_| "runtime could not start"))
        }
        .inspect_err(|_| {
            let _ = fs::remove_dir_all(&private_dir);
        })?;
        *current = Some(OwnedServer {
            child,
            auth,
            private_dir,
        });
        if let Err(error) = await_ready(
            current.as_mut().expect("child just stored"),
            &self.shutting_down,
        ) {
            stop_owned(&mut current);
            return Err(error);
        }
        Ok(socket)
    }
}

impl Drop for ModelRuntime {
    fn drop(&mut self) {
        if let Ok(owned) = self.server.get_mut() {
            stop_owned(owned);
        }
    }
}

fn resolve_assets<R: Runtime>(app: &AppHandle<R>) -> Result<Assets, &'static str> {
    let runtime = app
        .path()
        .resource_dir()
        .map_err(|_| "runtime resources unavailable")?
        .join("llama-v0.6.0")
        .join("bin");
    let models = app
        .path()
        .app_data_dir()
        .map_err(|_| "model storage unavailable")?
        .join("models");
    Ok(Assets {
        executable: runtime.join("llama-server"),
        model: models.join(MODEL_NAME),
        library_dir: runtime,
    })
}

#[cfg(test)]
fn verify_assets(assets: &Assets) -> Result<(), &'static str> {
    verify_runtime_assets(assets)?;
    verify_file(&assets.model, Some(MODEL_SIZE), MODEL_SHA256)?;
    Ok(())
}

fn verify_runtime_assets(assets: &Assets) -> Result<(), &'static str> {
    verify_file(&assets.executable, None, SERVER_SHA256)?;
    for (name, digest) in RUNTIME_LIBRARIES {
        verify_file(&assets.library_dir.join(name), None, digest)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_verified_model(
    path: &Path,
    shutting_down: &AtomicBool,
) -> Result<(Option<File>, PathBuf), &'static str> {
    let mut file = File::open(path).map_err(|_| "verified model runtime assets unreadable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "verified model runtime assets unreadable")?;
    if !metadata.is_file() || metadata.len() != MODEL_SIZE {
        return Err("verified model runtime assets invalid");
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 1024 * 1024];
    loop {
        if shutting_down.load(Ordering::Acquire) {
            return Err("runtime start cancelled");
        }
        let read = file
            .read(&mut buffer)
            .map_err(|_| "verified model runtime assets unreadable")?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if format!("{:x}", digest.finalize()) != MODEL_SHA256 {
        return Err("verified model runtime digest mismatch");
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "verified model runtime assets unreadable")?;
    use std::os::fd::AsRawFd;
    let model_argument = PathBuf::from(format!("/dev/fd/{}", file.as_raw_fd()));
    Ok((Some(file), model_argument))
}

#[cfg(not(target_os = "macos"))]
fn open_verified_model(
    path: &Path,
    shutting_down: &AtomicBool,
) -> Result<(Option<File>, PathBuf), &'static str> {
    if shutting_down.load(Ordering::Acquire) {
        return Err("runtime start cancelled");
    }
    // shortcut: Windows uses path-based opening until a native inherited-handle equivalent is added.
    verify_file(path, Some(MODEL_SIZE), MODEL_SHA256)?;
    Ok((None, path.to_path_buf()))
}

fn verify_file(path: &Path, size: Option<u64>, expected: &str) -> Result<(), &'static str> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "verified model runtime assets missing")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || size.is_some_and(|n| metadata.len() != n)
    {
        return Err("verified model runtime assets invalid");
    }
    if sha256_file(path)? != expected {
        return Err("verified model runtime digest mismatch");
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, &'static str> {
    let mut file = File::open(path).map_err(|_| "verified model runtime assets unreadable")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "verified model runtime assets unreadable")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn private_auth() -> Result<(PathBuf, PathBuf, String), &'static str> {
    let mut random = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut random))
        .map_err(|_| "native auth unavailable")?;
    let auth = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "native auth unavailable")?
        .as_nanos();
    // Keep the absolute address under Darwin's 104-byte sun_path even with a long TMPDIR.
    let directory =
        Path::new("/tmp").join(format!("aiworker-llama-{}-{unique}", std::process::id()));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&directory)
        .map_err(|_| "native auth unavailable")?;
    let path = directory.join("api-key");
    let created = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?.write_all(auth.as_bytes())?;
        Ok::<_, std::io::Error>(())
    })();
    if created.is_err() {
        let _ = fs::remove_dir_all(&directory);
        return Err("native auth unavailable");
    }
    Ok((directory, path, auth))
}

fn await_ready(server: &mut OwnedServer, shutting_down: &AtomicBool) -> Result<(), &'static str> {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if shutting_down.load(Ordering::Acquire) {
            return Err("runtime start cancelled");
        }
        if server
            .child
            .try_wait()
            .map_err(|_| "runtime status unavailable")?
            .is_some()
        {
            return Err("runtime exited during startup");
        }
        if authenticated_models(server) {
            if shutting_down.load(Ordering::Acquire) {
                return Err("runtime start cancelled");
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("runtime startup timed out")
}

#[cfg(target_os = "macos")]
fn connect_owned_socket(socket: &Path, child_pid: u32) -> Result<UnixStream, &'static str> {
    use std::{ffi::c_void, os::fd::AsRawFd};
    unsafe extern "C" {
        fn getsockopt(fd: i32, level: i32, name: i32, value: *mut c_void, size: *mut u32) -> i32;
    }
    const SOL_LOCAL: i32 = 0;
    const LOCAL_PEERPID: i32 = 2;
    let stream = UnixStream::connect(socket).map_err(|_| "local runtime connection unavailable")?;
    let mut peer_pid = 0i32;
    let mut size = size_of::<i32>() as u32;
    // Darwin supplies the peer's PID for this connected socket before any secrets are sent.
    let result = unsafe {
        getsockopt(
            stream.as_raw_fd(),
            SOL_LOCAL,
            LOCAL_PEERPID,
            (&mut peer_pid as *mut i32).cast(),
            &mut size,
        )
    };
    if result != 0
        || size != size_of::<i32>() as u32
        || peer_pid <= 0
        || peer_pid as u32 != child_pid
    {
        return Err("local runtime socket owner mismatch");
    }
    Ok(stream)
}

#[cfg(not(target_os = "macos"))]
fn authenticated_models(_server: &OwnedServer) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn authenticated_models(server: &OwnedServer) -> bool {
    let Ok(mut stream) = connect_owned_socket(&server.socket_path(), server.child.id()) else {
        return false;
    };
    let auth = &server.auth;
    let timeout = Some(Duration::from_millis(200));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if write!(stream, "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {auth}\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut response = [0u8; 1024];
    let Ok(count) = stream.read(&mut response) else {
        return false;
    };
    response[..count].starts_with(b"HTTP/1.1 200") || response[..count].starts_with(b"HTTP/1.0 200")
}

fn completion_body(prompt: &str) -> Result<String, &'static str> {
    if prompt.encode_utf16().count() > MAX_PROMPT_LENGTH {
        return Err("Local prompt exceeds 8000 characters. Shorten it and retry.");
    }
    if prompt.trim().is_empty() {
        return Err("Enter a prompt for the local model.");
    }
    Ok(serde_json::json!({
        "model": MODEL_NAME,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 128,
        "stream": false
    })
    .to_string())
}

fn is_cancelled(cancelled: Option<&AtomicBool>) -> bool {
    cancelled.is_some_and(|token| token.load(Ordering::Acquire))
}

fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), &'static str> {
    if is_cancelled(cancelled) {
        Err("local inference cancelled")
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OllamaRequestError {
    Unavailable,
    TimedOut,
    Cancelled,
    InvalidResponse,
    ResponseTooLarge,
    Rejected,
}

fn ollama_request(
    method: &str,
    path: &str,
    body: Option<&str>,
    connect_timeout: Duration,
    response_timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<serde_json::Value, OllamaRequestError> {
    let address = SocketAddr::from(([127, 0, 0, 1], OLLAMA_PORT));
    let mut stream = TcpStream::connect_timeout(&address, connect_timeout)
        .map_err(|_| OllamaRequestError::Unavailable)?;
    if is_cancelled(cancelled) {
        return Err(OllamaRequestError::Cancelled);
    }
    stream
        .set_write_timeout(Some(OLLAMA_CONNECT_TIMEOUT))
        .map_err(|_| OllamaRequestError::Unavailable)?;
    let body = body.unwrap_or_default();
    let request = if method == "POST" {
        format!(
            "POST {path} HTTP/1.0\r\nHost: {OLLAMA_HOST}:{OLLAMA_PORT}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    } else {
        format!(
            "GET {path} HTTP/1.0\r\nHost: {OLLAMA_HOST}:{OLLAMA_PORT}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        )
    };
    stream
        .write_all(request.as_bytes())
        .map_err(|_| OllamaRequestError::Unavailable)?;

    let deadline = Instant::now() + response_timeout;
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        if is_cancelled(cancelled) {
            return Err(OllamaRequestError::Cancelled);
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(OllamaRequestError::TimedOut)?;
        stream
            .set_read_timeout(Some(remaining.min(CANCELLATION_POLL)))
            .map_err(|_| OllamaRequestError::Unavailable)?;
        let read = match stream.read(&mut buffer) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                if is_cancelled(cancelled) {
                    return Err(OllamaRequestError::Cancelled);
                }
                if Instant::now() >= deadline {
                    return Err(OllamaRequestError::TimedOut);
                }
                continue;
            }
            Err(_) => return Err(OllamaRequestError::Unavailable),
        };
        if read == 0 {
            break;
        }
        if response.len() + read > MAX_OLLAMA_HEADERS + MAX_REPLY_BYTES {
            return Err(OllamaRequestError::ResponseTooLarge);
        }
        response.extend_from_slice(&buffer[..read]);
    }
    parse_ollama_response(&response)
}

fn parse_ollama_response(response: &[u8]) -> Result<serde_json::Value, OllamaRequestError> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .filter(|split| *split <= MAX_OLLAMA_HEADERS)
        .ok_or(OllamaRequestError::InvalidResponse)?;
    let header =
        std::str::from_utf8(&response[..split]).map_err(|_| OllamaRequestError::InvalidResponse)?;
    let mut lines = header.split("\r\n");
    let mut status_line = lines.next().unwrap_or_default().split_ascii_whitespace();
    if !matches!(status_line.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
        return Err(OllamaRequestError::InvalidResponse);
    }
    let status = status_line
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or(OllamaRequestError::InvalidResponse)?;
    let mut content_length = None;
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or(OllamaRequestError::InvalidResponse)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            // HTTP/1.0 + Connection: close is intentional; reject ambiguous framing.
            return Err(OllamaRequestError::InvalidResponse);
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(OllamaRequestError::InvalidResponse);
            }
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| OllamaRequestError::InvalidResponse)?,
            );
        }
    }
    let body = &response[split + 4..];
    if body.len() > MAX_REPLY_BYTES || content_length.is_some_and(|length| length != body.len()) {
        return Err(OllamaRequestError::InvalidResponse);
    }
    if !(200..300).contains(&status) {
        return Err(OllamaRequestError::Rejected);
    }
    serde_json::from_slice(body).map_err(|_| OllamaRequestError::InvalidResponse)
}

fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/".contains(&byte))
}

fn local_model_names(catalog: &serde_json::Value) -> Result<Vec<String>, &'static str> {
    let models = catalog
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or("Ollama returned an invalid local model catalog.")?;
    let mut names = models
        .iter()
        .filter_map(|model| {
            let name = model
                .get("name")
                .or_else(|| model.get("model"))
                .and_then(serde_json::Value::as_str)?;
            let has_remote_origin = ["remote_model", "remote_host"].iter().any(|field| {
                model
                    .get(field)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            });
            let supports_completion = model
                .get("capabilities")
                .and_then(serde_json::Value::as_array)
                .is_none_or(|capabilities| {
                    capabilities
                        .iter()
                        .any(|capability| capability.as_str() == Some("completion"))
                });
            if !valid_model_name(name)
                || has_remote_origin
                || name.to_ascii_lowercase().contains("cloud")
                || !supports_completion
            {
                return None;
            }
            Some(name.to_owned())
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

fn selected_ollama_model(
    catalog: &serde_json::Value,
    requested: Option<&str>,
) -> Result<Option<String>, &'static str> {
    let installed = local_model_names(catalog)?;
    let requested = requested.map(str::trim).filter(|name| !name.is_empty());
    if let Some(requested) = requested {
        if !valid_model_name(requested) {
            return Err("Configured Ollama model name is invalid.");
        }
        return installed
            .iter()
            .find(|name| name.as_str() == requested)
            .cloned()
            .map(Some)
            .ok_or(
                "Configured Ollama model is not installed locally. No model download was started.",
            );
    }
    Ok(installed.into_iter().next())
}

fn ollama_catalog_model() -> Result<Option<String>, &'static str> {
    let catalog = match ollama_request(
        "GET",
        "/api/tags",
        None,
        OLLAMA_STATUS_TIMEOUT,
        OLLAMA_STATUS_TIMEOUT,
        None,
    ) {
        Ok(catalog) => catalog,
        Err(OllamaRequestError::Unavailable) => return Ok(None),
        Err(_) => {
            return Err("Ollama local model catalog is unavailable. No cloud fallback was used.")
        }
    };
    let requested = std::env::var(OLLAMA_MODEL_ENV).ok();
    selected_ollama_model(&catalog, requested.as_deref())
}

pub(crate) fn local_ollama_models() -> Result<Option<Vec<String>>, &'static str> {
    let catalog = match ollama_request(
        "GET",
        "/api/tags",
        None,
        OLLAMA_STATUS_TIMEOUT,
        OLLAMA_STATUS_TIMEOUT,
        None,
    ) {
        Ok(catalog) => catalog,
        Err(OllamaRequestError::Unavailable) => return Ok(None),
        Err(_) => {
            return Err("Ollama local model catalog is unavailable. No cloud fallback was used.")
        }
    };
    local_model_names(&catalog).map(Some)
}

pub(crate) fn pull_ollama_model(model: &str, cancelled: &AtomicBool) -> Result<(), &'static str> {
    if !valid_model_name(model) {
        return Err("Requested local model is invalid.");
    }
    let body = serde_json::json!({ "model": model, "stream": false }).to_string();
    let response = ollama_request(
        "POST",
        "/api/pull",
        Some(&body),
        OLLAMA_CONNECT_TIMEOUT,
        OLLAMA_PULL_TIMEOUT,
        Some(cancelled),
    )
    .map_err(|error| match error {
        OllamaRequestError::Cancelled => "local model download cancelled",
        OllamaRequestError::TimedOut => "Ollama local model download timed out.",
        OllamaRequestError::Unavailable => "Ollama stopped during model download.",
        OllamaRequestError::ResponseTooLarge
        | OllamaRequestError::InvalidResponse
        | OllamaRequestError::Rejected => "Ollama local model download failed.",
    })?;
    if response.get("status").and_then(serde_json::Value::as_str) != Some("success") {
        return Err("Ollama did not confirm the local model download.");
    }
    Ok(())
}

fn ollama_runtime_ready() -> bool {
    let Ok(Some(selected)) = ollama_catalog_model() else {
        return false;
    };
    let Ok(status) = ollama_request(
        "GET",
        "/api/ps",
        None,
        OLLAMA_STATUS_TIMEOUT,
        OLLAMA_STATUS_TIMEOUT,
        None,
    ) else {
        return false;
    };
    ollama_model_is_loaded(&status, &selected)
}

fn ollama_model_is_loaded(status: &serde_json::Value, selected: &str) -> bool {
    status
        .get("models")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|models| {
            models.iter().any(|model| {
                model
                    .get("name")
                    .or_else(|| model.get("model"))
                    .and_then(serde_json::Value::as_str)
                    == Some(selected)
            })
        })
}

fn ollama_generation_request(model: &str, prompt: &str) -> serde_json::Value {
    let mut request = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        // Leave enough room for models that still emit hidden reasoning even
        // when their explicit thinking mode is disabled. The bridge returns
        // only `response`, so this budget bounds user-visible output as well.
        "options": { "num_predict": 512 }
    });
    // Qwen's default reasoning stream can consume the bounded generation
    // budget without producing user-facing text or a structured tool action.
    // Ollama ignores this for models without an explicit thinking mode.
    if model.starts_with("qwen3") {
        request["think"] = serde_json::Value::Bool(false);
    }
    request
}

fn infer_ollama(
    prompt: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<LocalInferenceResult>, &'static str> {
    let Some(model) = ollama_catalog_model()? else {
        return Ok(None);
    };
    let body = ollama_generation_request(&model, prompt).to_string();
    let response = ollama_request(
        "POST",
        "/api/generate",
        Some(&body),
        OLLAMA_CONNECT_TIMEOUT,
        OLLAMA_INFERENCE_TIMEOUT,
        cancelled,
    )
    .map_err(|error| match error {
        OllamaRequestError::Cancelled => "local inference cancelled",
        OllamaRequestError::TimedOut => {
            "Ollama local inference timed out. Check its status and retry."
        }
        OllamaRequestError::ResponseTooLarge => {
            "Ollama returned a response that exceeded the local limit."
        }
        OllamaRequestError::Unavailable => {
            "Ollama local runtime stopped before inference completed."
        }
        OllamaRequestError::InvalidResponse | OllamaRequestError::Rejected => {
            "Ollama rejected or returned an invalid local inference response."
        }
    })?;
    if response.get("done") == Some(&serde_json::Value::Bool(false)) {
        return Err("Ollama did not finish the local inference response.");
    }
    let content = ollama_response_text(&response)?;
    Ok(Some(LocalInferenceResult {
        content: content.to_owned(),
        provider: "Ollama (local)",
        model,
    }))
}

fn ollama_response_text(response: &serde_json::Value) -> Result<&str, &'static str> {
    response
        .get("response")
        .and_then(serde_json::Value::as_str)
        .filter(|content| !content.trim().is_empty())
        .ok_or(OLLAMA_NO_TEXT_ERROR)
}

#[cfg(target_os = "macos")]
fn request_completion(
    mut stream: UnixStream,
    auth: &str,
    body: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<String, &'static str> {
    check_cancelled(cancelled)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "local runtime socket unavailable")?;
    let request = format!(
        "POST /v1/chat/completions HTTP/1.0\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "local runtime request failed")?;

    let deadline = Instant::now() + INFERENCE_TIMEOUT;
    // Reapplying SO_RCVTIMEO on a connected Darwin Unix socket can fail with EINVAL.
    stream
        .set_read_timeout(Some(INFERENCE_TIMEOUT.min(CANCELLATION_POLL)))
        .map_err(|_| "local runtime socket unavailable")?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        check_cancelled(cancelled)?;
        if deadline.checked_duration_since(Instant::now()).is_none() {
            return Err("local inference timed out");
        }
        let read = match stream.read(&mut buffer) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                check_cancelled(cancelled)?;
                if Instant::now() >= deadline {
                    return Err("local inference timed out");
                }
                continue;
            }
            Err(_) => return Err("local runtime response unavailable"),
        };
        if read == 0 {
            break;
        }
        if response.len() + read > MAX_REPLY_BYTES {
            return Err("local runtime response too large");
        }
        response.extend_from_slice(&buffer[..read]);
    }
    parse_completion(&response)
}

fn parse_completion(response: &[u8]) -> Result<String, &'static str> {
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("invalid local runtime HTTP response")?;
    let head = std::str::from_utf8(&response[..split])
        .map_err(|_| "invalid local runtime HTTP response")?;
    let mut status = head.lines().next().unwrap_or_default().split_whitespace();
    match (status.next(), status.next()) {
        (Some("HTTP/1.0" | "HTTP/1.1"), Some("200")) => {}
        (Some("HTTP/1.0" | "HTTP/1.1"), Some("400" | "413")) => {
            return Err("Local runtime rejected the prompt. Shorten it and retry.")
        }
        _ => return Err("local runtime completion failed"),
    }
    let reply: serde_json::Value = serde_json::from_slice(&response[split + 4..])
        .map_err(|_| "invalid local runtime completion")?;
    reply
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .filter(|content| !content.trim().is_empty())
        .map(str::to_owned)
        .ok_or("local runtime returned no text")
}

fn stop_owned(owned: &mut Option<OwnedServer>) {
    let Some(server) = owned.as_mut() else { return };
    let group = server.child.id();
    signal_process_group(group, 15);
    if !wait_until(&mut server.child, group, STOP_GRACE) {
        signal_process_group(group, 9);
        if !wait_until(&mut server.child, group, STOP_KILL_WAIT) {
            return;
        }
    }
    let server = owned.take().expect("owned process checked");
    let _ = fs::remove_dir_all(server.private_dir);
}

fn wait_until(child: &mut Child, group: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let child_exited = matches!(child.try_wait(), Ok(Some(_)));
        if child_exited && !process_group_alive(group) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    // The child enters a fresh process group before exec, so this cannot target its parent or unrelated jobs.
    unsafe {
        kill(-(pid as i32), signal);
    }
}

#[cfg(unix)]
fn process_group_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    unsafe { kill(-(pid as i32), 0) == 0 }
}

#[cfg(not(unix))]
fn signal_process_group(pid: u32, _signal: i32) {
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    #[cfg(not(windows))]
    let _ = pid;
}

#[cfg(not(unix))]
fn process_group_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inference_body_bounds_and_escapes_prompt() {
        let prompt = "quote \"\n雪";
        let body: serde_json::Value =
            serde_json::from_str(&completion_body(prompt).unwrap()).unwrap();
        assert_eq!(
            body["messages"],
            serde_json::json!([{ "role": "user", "content": prompt }])
        );
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(body["stream"], false);
        assert!(completion_body(" \n").is_err());
        assert!(completion_body(&"x".repeat(MAX_PROMPT_LENGTH)).is_ok());
        assert!(completion_body(&"😀".repeat(MAX_PROMPT_LENGTH / 2)).is_ok());
        assert!(completion_body(&"😀".repeat(MAX_PROMPT_LENGTH / 2 + 1)).is_err());
    }

    #[test]
    fn inference_checks_status_and_returns_only_assistant_text() {
        assert_eq!(
            parse_completion(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"choices\":[{\"message\":{\"content\":\"answer\"}}]}"),
            Ok("answer".into())
        );
        for response in [
            &b"HTTP/1.0 401 Unauthorized\r\n\r\nprivate error"[..],
            b"HTTP/1.0 200 OK\r\n\r\ntruncated",
            b"HTTP/1.0 200 OK\r\n\r\n{\"choices\":[]}",
            b"HTTP/1.0 200 OK\r\n\r\n{\"choices\":[{\"message\":{\"content\":\" \"}}]}",
        ] {
            assert!(parse_completion(response).is_err());
        }
    }

    #[test]
    fn cancelled_inference_token_is_checked_before_runtime_use() {
        let cancelled = AtomicBool::new(false);
        assert_eq!(check_cancelled(Some(&cancelled)), Ok(()));
        cancelled.store(true, Ordering::Release);
        assert_eq!(
            check_cancelled(Some(&cancelled)),
            Err("local inference cancelled")
        );
    }

    #[test]
    fn ollama_selects_only_installed_on_device_models() {
        let catalog = serde_json::json!({
            "models": [
                { "name": "qwen3-vl:4b", "capabilities": ["completion", "tools"] },
                { "name": "gemma3:1b", "capabilities": ["completion"] },
                { "name": "nomic-embed-text:latest", "capabilities": ["embedding"] },
                { "name": "kimi-k2:1t-cloud", "remote_model": "kimi-k2:1t", "remote_host": "https://ollama.com:443" },
                { "name": "hosted:latest", "remote_host": "https://example.invalid" },
                { "name": "malicious\\r\\nHost:example.invalid" }
            ]
        });

        assert_eq!(
            local_model_names(&catalog).unwrap(),
            vec!["gemma3:1b".to_owned(), "qwen3-vl:4b".to_owned()]
        );
        assert_eq!(
            selected_ollama_model(&catalog, None).unwrap(),
            Some("gemma3:1b".to_owned())
        );
        assert_eq!(
            selected_ollama_model(&catalog, Some("qwen3-vl:4b")).unwrap(),
            Some("qwen3-vl:4b".to_owned())
        );
        assert_eq!(
            selected_ollama_model(&catalog, Some("kimi-k2:1t-cloud")),
            Err("Configured Ollama model is not installed locally. No model download was started.")
        );
        assert_eq!(
            selected_ollama_model(&catalog, Some("bad model")),
            Err("Configured Ollama model name is invalid.")
        );
    }

    #[test]
    fn ollama_http_parser_requires_bounded_unambiguous_local_json() {
        let response = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"models\":[]}";
        assert_eq!(
            parse_ollama_response(response).unwrap(),
            serde_json::json!({ "models": [] })
        );
        assert_eq!(
            parse_ollama_response(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid\r\nContent-Length: 0\r\n\r\n"),
            Err(OllamaRequestError::Rejected)
        );
        assert_eq!(
            parse_ollama_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
            ),
            Err(OllamaRequestError::InvalidResponse)
        );
        assert_eq!(
            parse_ollama_response(
                b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx"
            ),
            Err(OllamaRequestError::InvalidResponse)
        );
        let address = SocketAddr::from(([127, 0, 0, 1], OLLAMA_PORT));
        assert!(address.ip().is_loopback());
    }

    #[test]
    fn ollama_readiness_requires_the_selected_model_to_be_loaded() {
        let status = serde_json::json!({
            "models": [{ "name": "gemma3:1b" }, { "name": "qwen3-vl:4b" }]
        });
        assert!(ollama_model_is_loaded(&status, "qwen3-vl:4b"));
        assert!(!ollama_model_is_loaded(&status, "mistral:latest"));
        assert!(!ollama_model_is_loaded(
            &serde_json::json!({ "models": [] }),
            "qwen3-vl:4b"
        ));
    }

    #[test]
    fn ollama_qwen_request_disables_hidden_reasoning_for_bounded_tool_output() {
        let request = ollama_generation_request("qwen3-vl:4b", "Return JSON.");
        assert_eq!(request["think"], false);
        assert_eq!(request["options"]["num_predict"], 512);
        assert_eq!(request["stream"], false);

        let other_model = ollama_generation_request("gemma3:4b", "Return text.");
        assert!(other_model.get("think").is_none());

        let thinking_only = serde_json::json!({
            "response": "",
            "thinking": "private reasoning must not become an action",
            "done": true,
            "done_reason": "stop"
        });
        assert_eq!(
            ollama_response_text(&thinking_only),
            Err(OLLAMA_NO_TEXT_ERROR)
        );
        assert_eq!(
            ollama_response_text(&serde_json::json!({"response":" answer "})),
            Ok(" answer ")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn inference_authenticates_socket_peer_and_bounds_response() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::net::UnixListener;
        let (dir, _, _) = private_auth().unwrap();
        let socket = dir.join("model.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = thread::spawn(move || {
            let (mut rejected, _) = listener.accept().unwrap();
            assert_eq!(rejected.read(&mut [0]).unwrap(), 0);
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = BufReader::new(&connection);
            let mut headers = String::new();
            while !headers.ends_with("\r\n\r\n") {
                assert_ne!(request.read_line(&mut headers).unwrap(), 0);
            }
            assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.0\r\n"));
            assert!(headers.contains("\r\nAuthorization: Bearer fixture\r\n"));
            assert!(headers.contains("\r\nContent-Length: 2\r\n"));
            let mut body = [0; 2];
            request.read_exact(&mut body).unwrap();
            assert_eq!(body, *b"{}");
            connection
                .write_all(&vec![b'x'; MAX_REPLY_BYTES + 1])
                .unwrap();
        });
        assert_eq!(
            connect_owned_socket(&socket, 0).unwrap_err(),
            "local runtime socket owner mismatch"
        );
        let stream = connect_owned_socket(&socket, std::process::id()).unwrap();
        assert_eq!(
            request_completion(stream, "fixture", "{}", None),
            Err("local runtime response too large")
        );
        server.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn local_socket_inference_returns_promptly_when_cancelled() {
        use std::os::unix::net::UnixListener;
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!(
            "ai-worker-cancel-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let socket = dir.join("cancel.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = thread::spawn(move || {
            let (connection, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(250));
            drop(connection);
        });
        let stream = UnixStream::connect(socket).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = Arc::clone(&cancelled);
        let timer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            cancel.store(true, Ordering::Release);
        });
        let started = Instant::now();
        assert_eq!(
            request_completion(stream, "fixture", "{}", Some(&cancelled)),
            Err("local inference cancelled")
        );
        // Keep this tolerant of a loaded host while still bounding the 60s inference deadline.
        assert!(started.elapsed() < Duration::from_millis(500));
        timer.join().unwrap();
        server.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    fn artifact_assets() -> Assets {
        let root = PathBuf::from(
            std::env::var_os("M11_ARTIFACT_BIN")
                .expect("M11_ARTIFACT_BIN must point to reviewed SSD bin directory"),
        );
        let models = PathBuf::from(
            std::env::var_os("M11_ARTIFACT_MODELS")
                .expect("M11_ARTIFACT_MODELS must point to reviewed SSD models directory"),
        );
        Assets {
            executable: root.join("llama-server"),
            library_dir: root,
            model: models.join(MODEL_NAME),
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_owned_descendants_without_touching_unrelated_process() {
        use std::os::unix::process::CommandExt;

        let private_dir =
            std::env::temp_dir().join(format!("m11-process-tree-{}", std::process::id()));
        fs::create_dir(&private_dir).unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 60 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let owned = command.spawn().unwrap();
        let group = owned.id();
        thread::sleep(Duration::from_millis(100));
        let mut unrelated = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let mut owned = Some(OwnedServer {
            child: owned,
            auth: String::new(),
            private_dir: private_dir.clone(),
        });

        stop_owned(&mut owned);

        assert!(owned.is_none(), "owned process tree reaped");
        assert!(!process_group_alive(group), "owned descendants exited");
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "unrelated process survives"
        );
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        assert!(!private_dir.exists(), "owned temporary directory removed");
    }

    #[cfg(unix)]
    #[test]
    fn start_reuses_live_server_before_verifying_large_assets() {
        use std::os::unix::process::CommandExt;

        let runtime = ModelRuntime::default();
        let private_dir = std::env::temp_dir().join(format!(
            "m12-live-fast-path-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&private_dir).unwrap();
        let mut command = Command::new("/bin/sleep");
        command
            .arg("60")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        *runtime.server.lock().unwrap() = Some(OwnedServer {
            child,
            auth: String::new(),
            private_dir: private_dir.clone(),
        });

        let assets = Assets {
            executable: PathBuf::from("/missing/llama-server"),
            model: PathBuf::from("/missing/1.1-gb-model.gguf"),
            library_dir: PathBuf::from("/missing/libs"),
        };
        assert_eq!(
            runtime.start_assets(assets),
            Ok(private_dir.join("model.sock"))
        );
        runtime.shutdown();
        assert!(!private_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn stop_cancels_pending_startup_while_readiness_holds_state_lock() {
        use std::{
            os::unix::process::CommandExt,
            sync::{mpsc, Arc},
        };

        let private_dir =
            std::env::temp_dir().join(format!("m11-cancel-start-{}", std::process::id()));
        fs::create_dir(&private_dir).unwrap();
        let mut command = Command::new("/bin/sleep");
        command
            .arg("60")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        let pid = child.id();
        let runtime = Arc::new(ModelRuntime::default());
        *runtime.server.lock().unwrap() = Some(OwnedServer {
            child,
            auth: String::new(),
            private_dir,
        });
        let (entered_tx, entered_rx) = mpsc::channel();
        let waiter = Arc::clone(&runtime);
        let readiness = thread::spawn(move || {
            let mut server = waiter.server.lock().unwrap();
            entered_tx.send(()).unwrap();
            assert_eq!(
                await_ready(server.as_mut().unwrap(), &waiter.shutting_down),
                Err("runtime start cancelled")
            );
        });
        entered_rx.recv().unwrap();

        let started = Instant::now();
        runtime.shutdown();
        readiness.join().unwrap();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(runtime.server.lock().unwrap().is_none());
        assert!(unsafe { kill(pid as i32, 0) } != 0, "startup child reaped");
    }

    #[test]
    fn permanently_rejects_start_after_shutdown_even_for_previously_admitted_request() {
        let runtime = ModelRuntime::default();
        assert!(runtime.check_running().is_ok());
        runtime.shutdown();
        runtime.shutdown();
        assert_eq!(
            runtime.start_assets(Assets {
                executable: PathBuf::from("/missing/llama-server"),
                model: PathBuf::from("/missing/model.gguf"),
                library_dir: PathBuf::from("/missing"),
            }),
            Err("runtime start cancelled")
        );
        assert!(runtime.server.lock().unwrap().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the reviewed M10a candidate artifacts on the development SSD"]
    fn candidate_process_auth_socket_crash_and_repeated_cleanup() {
        let assets = artifact_assets();
        verify_assets(&assets).unwrap();
        let unrelated_pid = std::process::id();
        let runtime = ModelRuntime::default();
        let mut wrong = assets;
        let original_model = wrong.model.clone();
        let altered = std::env::temp_dir().join(format!("m11-wrong-model-{}", unrelated_pid));
        let mut wrong_file = File::create(&altered).unwrap();
        wrong_file.set_len(MODEL_SIZE).unwrap();
        wrong_file.write_all(b"not the pinned model").unwrap();
        drop(wrong_file);
        wrong.model = altered.clone();
        assert_eq!(
            verify_assets(&wrong),
            Err("verified model runtime digest mismatch")
        );
        let _ = fs::remove_file(altered);
        wrong.model = original_model;

        let first_socket = runtime.start_assets(wrong).unwrap();
        assert!(authenticated_models(
            runtime.server.lock().unwrap().as_ref().unwrap()
        ));
        let first_pid = runtime.server.lock().unwrap().as_ref().unwrap().child.id();
        runtime
            .server
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .child
            .kill()
            .unwrap();
        assert!(wait_until(
            &mut runtime.server.lock().unwrap().as_mut().unwrap().child,
            first_pid,
            Duration::from_secs(2)
        ));
        stop_owned(&mut runtime.server.lock().unwrap());
        assert!(
            unsafe { kill(first_pid as i32, 0) } != 0,
            "crashed owned process reaped"
        );

        let second_socket = runtime.start_assets(artifact_assets()).unwrap();
        assert_ne!(first_socket, second_socket);
        let key_dir = runtime
            .server
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .private_dir
            .clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(key_dir.join("api-key"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        runtime.shutdown();
        assert!(!key_dir.exists(), "quit removes only owned auth files");
        assert!(
            unsafe { kill(unrelated_pid as i32, 0) } == 0,
            "unrelated parent process survives"
        );
        let runtime = ModelRuntime::default();
        runtime.start_assets(artifact_assets()).unwrap();
        runtime.shutdown();
        assert!(
            runtime.server.lock().unwrap().is_none(),
            "repeated open/quit leaves no owned child"
        );
    }

    #[cfg(unix)]
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
}
