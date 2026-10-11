#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) const SERVER_SHA256: &str =
    "1bf5602a2be50097c44282a6ecc63234d94ee8f96d39fd45fed6eff4e74b6b41";
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
const STOP_GRACE: Duration = Duration::from_millis(2_500);
const STOP_KILL_WAIT: Duration = Duration::from_secs(2);
pub(crate) const MINIMUM_MEMORY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const IDLE_UNLOAD: Duration = Duration::from_secs(60);
const GENERATION_ARGS: &[&str] = &[
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
];

fn admit_candidate(memory_bytes: u64) -> Result<(), &'static str> {
    if memory_bytes < MINIMUM_MEMORY_BYTES {
        return Err("local model requires at least 8 GiB physical memory (evaluation only)");
    }
    Ok(())
}

fn physical_memory_bytes() -> Result<u64, &'static str> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::c_void, mem::size_of};
        let name = CString::new("hw.memsize").expect("static sysctl key");
        let mut bytes = 0u64;
        let mut length = size_of::<u64>();
        let result = unsafe {
            unsafe extern "C" {
                fn sysctlbyname(
                    name: *const std::ffi::c_char,
                    old_value: *mut c_void,
                    old_length: *mut usize,
                    new_value: *mut c_void,
                    new_length: usize,
                ) -> i32;
            }
            sysctlbyname(
                name.as_ptr(),
                (&mut bytes as *mut u64).cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if result == 0 && length == size_of::<u64>() {
            Ok(bytes)
        } else {
            Err("physical memory could not be determined")
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("local model requires the Apple Silicon evaluation build")
    }
}

const RUNTIME_LIBRARIES: &[(&str, &str)] = &[
    (
        "libllama-common.0.6.0.dylib",
        "febeef087a261b0eb4eeee09b43239b6bf0863c58ad1dc30d0b610ef4308a411",
    ),
    (
        "libllama.0.6.0.dylib",
        "c5da330c56d4627d18714188350c14150a84237e38c1e6fd5f1d25997afd1046",
    ),
    (
        "libmtmd.0.6.0.dylib",
        "2de2c7d40b72dc5fa14aed03cb8d7521ec5ab262bbb6038d6110666f3852232b",
    ),
    (
        "libggml-blas.0.26.0.dylib",
        "6526259e8f70a5b3a394df3ba082050c290d7653846efbdc84b3710b22fb4eac",
    ),
    (
        "libllama-server-impl.dylib",
        "8bd39e3755fe1e6b5f08736e131cb94eb741a7f64ca4ab2a10725ea4ea3e6815",
    ),
    (
        "libggml-metal.0.26.0.dylib",
        "3b0e401627c00dc2843c0cdae08bd73639c21cdf97c64290dd88dd827c976045",
    ),
    (
        "libggml-cpu.0.26.0.dylib",
        "75d7c5c73bad915b536d402eae361163f69c124762fdfdd9e1d2c4bd1b4adc04",
    ),
    (
        "libggml.0.26.0.dylib",
        "85ac40d540a5cc86f28a70270ddcdde677e92eb585c3bacd1b7e82270fe8934b",
    ),
    (
        "libggml-base.0.26.0.dylib",
        "4d483957511852e398564fe248da19e9c6b2f81ba668e4591ee4c29bccfbacdc",
    ),
    (
        "libggml-rpc.0.26.0.dylib",
        "5a75e884d5feff030067ed7867925366c552c68f1b36653f03bc2b0bd87e8a56",
    ),
];

#[cfg(target_os = "macos")]
const RUNTIME_ALIASES: &[(&str, &str)] = &[
    ("libllama-common.0.dylib", "libllama-common.0.6.0.dylib"),
    ("libllama.0.dylib", "libllama.0.6.0.dylib"),
    ("libmtmd.0.dylib", "libmtmd.0.6.0.dylib"),
    ("libggml-blas.0.dylib", "libggml-blas.0.26.0.dylib"),
    ("libggml-metal.0.dylib", "libggml-metal.0.26.0.dylib"),
    ("libggml-cpu.0.dylib", "libggml-cpu.0.26.0.dylib"),
    ("libggml.0.dylib", "libggml.0.26.0.dylib"),
    ("libggml-base.0.dylib", "libggml-base.0.26.0.dylib"),
    ("libggml-rpc.0.dylib", "libggml-rpc.0.26.0.dylib"),
];

#[derive(Default)]
pub struct ModelRuntime {
    server: Arc<Mutex<Option<OwnedServer>>>,
    cancel_generation: Arc<AtomicU64>,
    idle_generation: Arc<AtomicU64>,
}

struct Assets {
    executable: PathBuf,
    model: PathBuf,
    library_dir: PathBuf,
}

struct OwnedServer {
    child: Child,
    port: u16,
    auth: String,
    private_dir: PathBuf,
}

impl ModelRuntime {
    /// Called by the native chat path only; no UI or boot hook calls this yet.
    #[allow(dead_code)]
    pub fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Result<u16, &'static str> {
        admit_candidate(physical_memory_bytes()?)?;
        self.cancel_idle_unload();
        let generation = self.cancel_generation.load(Ordering::SeqCst);
        if let Some(port) = self.live_server_port(generation)? {
            return Ok(port);
        }
        let assets = resolve_assets(app)?;
        self.start_assets_at_generation(assets, None, generation)
    }

    pub(crate) fn chat_endpoint<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> Result<(u16, String), &'static str> {
        if Self::chat_start_aborted(deadline, cancelled) {
            return Err("chat response timed out");
        }
        admit_candidate(physical_memory_bytes()?)?;
        self.cancel_idle_unload();
        let generation = self.cancel_generation.load(Ordering::SeqCst);
        if let Some(port) = self.live_server_port(generation)? {
            if Self::chat_start_aborted(deadline, cancelled) {
                return Err("chat response timed out");
            }
            let current = self
                .server
                .lock()
                .map_err(|_| "runtime state unavailable")?;
            let server = current.as_ref().ok_or("runtime unavailable")?;
            return Ok((port, server.auth.clone()));
        }
        if Self::chat_start_aborted(deadline, cancelled) {
            return Err("chat response timed out");
        }
        let assets = resolve_assets(app)?;
        if Self::chat_start_aborted(deadline, cancelled) {
            return Err("chat response timed out");
        }
        self.start_assets_at_generation_with_abort(
            assets,
            None,
            generation,
            Some((deadline, cancelled)),
        )?;
        let current = self
            .server
            .lock()
            .map_err(|_| "runtime state unavailable")?;
        let server = current.as_ref().ok_or("runtime unavailable")?;
        Ok((server.port, server.auth.clone()))
    }

    pub(crate) fn chat_start_aborted(deadline: Instant, cancelled: &AtomicBool) -> bool {
        cancelled.load(Ordering::Acquire) || Instant::now() >= deadline
    }

    fn live_server_port(&self, generation: u64) -> Result<Option<u16>, &'static str> {
        if self.cancel_generation.load(Ordering::SeqCst) != generation {
            return Err("runtime start cancelled");
        }
        let mut current = self
            .server
            .lock()
            .map_err(|_| "runtime state unavailable")?;
        if self.cancel_generation.load(Ordering::SeqCst) != generation {
            return Err("runtime start cancelled");
        }
        let Some(server) = current.as_mut() else {
            return Ok(None);
        };
        match server
            .child
            .try_wait()
            .map_err(|_| "runtime status unavailable")?
        {
            None => {
                if self.cancel_generation.load(Ordering::SeqCst) != generation {
                    return Err("runtime start cancelled");
                }
                Ok(Some(server.port))
            }
            Some(_) => {
                stop_owned(&mut current);
                Ok(None)
            }
        }
    }

    pub fn stop(&self) {
        self.cancel_idle_unload();
        self.cancel_generation.fetch_add(1, Ordering::SeqCst);
        let Ok(mut owned) = self.server.lock() else {
            return;
        };
        stop_owned(&mut owned);
    }

    pub(crate) fn unload_after_task(&self, short_idle: bool) {
        if !short_idle {
            self.stop();
            return;
        }
        self.schedule_idle_unload(IDLE_UNLOAD);
    }

    fn schedule_idle_unload(&self, delay: Duration) {
        let generation = self.idle_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let idle_generation = Arc::downgrade(&self.idle_generation);
        let cancel_generation = Arc::downgrade(&self.cancel_generation);
        let server = Arc::downgrade(&self.server);
        thread::spawn(move || {
            idle_unload_after(
                delay,
                generation,
                idle_generation,
                cancel_generation,
                server,
            )
        });
    }

    fn cancel_idle_unload(&self) {
        self.idle_generation.fetch_add(1, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn start_assets(&self, assets: Assets, forced_port: Option<u16>) -> Result<u16, &'static str> {
        let generation = self.cancel_generation.load(Ordering::SeqCst);
        self.start_assets_at_generation(assets, forced_port, generation)
    }

    fn start_assets_at_generation(
        &self,
        assets: Assets,
        forced_port: Option<u16>,
        generation: u64,
    ) -> Result<u16, &'static str> {
        self.start_assets_at_generation_with_abort(assets, forced_port, generation, None)
    }

    fn start_assets_at_generation_with_abort(
        &self,
        assets: Assets,
        forced_port: Option<u16>,
        generation: u64,
        chat_abort: Option<(Instant, &AtomicBool)>,
    ) -> Result<u16, &'static str> {
        if chat_abort
            .is_some_and(|(deadline, cancelled)| Self::chat_start_aborted(deadline, cancelled))
        {
            return Err("chat response timed out");
        }
        if let Some(port) = self.live_server_port(generation)? {
            return Ok(port);
        }
        verify_runtime_assets(&assets)?;
        if chat_abort
            .is_some_and(|(deadline, cancelled)| Self::chat_start_aborted(deadline, cancelled))
        {
            return Err("chat response timed out");
        }
        let (model_file, model_argument) = open_verified_model(
            &assets.model,
            &self.cancel_generation,
            generation,
            chat_abort,
        )?;
        if chat_abort
            .is_some_and(|(deadline, cancelled)| Self::chat_start_aborted(deadline, cancelled))
        {
            return Err("chat response timed out");
        }
        if self.cancel_generation.load(Ordering::SeqCst) != generation {
            return Err("runtime start cancelled");
        }
        if chat_abort
            .is_some_and(|(deadline, cancelled)| Self::chat_start_aborted(deadline, cancelled))
        {
            return Err("chat response timed out");
        }

        let mut current = self.lock_server_for_start(generation, chat_abort)?;
        if let Some(server) = current.as_mut() {
            if server
                .child
                .try_wait()
                .map_err(|_| "runtime status unavailable")?
                .is_none()
            {
                if self.cancel_generation.load(Ordering::SeqCst) != generation {
                    return Err("runtime start cancelled");
                }
                return Ok(server.port);
            }
        }
        stop_owned(&mut current);

        if self.cancel_generation.load(Ordering::SeqCst) != generation {
            return Err("runtime start cancelled");
        }
        let port = forced_port.unwrap_or(reserve_port()?);
        let (private_dir, auth_file, auth) = private_auth()?;
        if let Some(error) = startup_abort(&self.cancel_generation, generation, chat_abort) {
            let _ = fs::remove_dir_all(&private_dir);
            return Err(error);
        }
        let mut command = Command::new(&assets.executable);
        command
            .arg("-m")
            .arg(model_argument)
            .args(["--offline", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .arg("--api-key-file")
            .arg(auth_file)
            .args(GENERATION_ARGS)
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

        if let Some(error) = startup_abort(&self.cancel_generation, generation, chat_abort) {
            let _ = fs::remove_dir_all(&private_dir);
            return Err(error);
        }
        let child = command.spawn().map_err(|_| {
            let _ = fs::remove_dir_all(&private_dir);
            "runtime could not start"
        })?;
        *current = Some(OwnedServer {
            child,
            port,
            auth,
            private_dir,
        });
        if let Err(error) = await_ready(
            current.as_mut().expect("child just stored"),
            &self.cancel_generation,
            generation,
            chat_abort,
        ) {
            stop_owned(&mut current);
            return Err(error);
        }
        Ok(port)
    }

    fn lock_server_for_start(
        &self,
        generation: u64,
        chat_abort: Option<(Instant, &AtomicBool)>,
    ) -> Result<std::sync::MutexGuard<'_, Option<OwnedServer>>, &'static str> {
        let current = self
            .server
            .lock()
            .map_err(|_| "runtime state unavailable")?;
        if let Some(error) = startup_abort(&self.cancel_generation, generation, chat_abort) {
            return Err(error);
        }
        Ok(current)
    }
}

fn idle_unload_after(
    delay: Duration,
    generation: u64,
    idle_generation: Weak<AtomicU64>,
    cancel_generation: Weak<AtomicU64>,
    server: Weak<Mutex<Option<OwnedServer>>>,
) {
    thread::sleep(delay);
    let (Some(idle_generation), Some(cancel_generation), Some(server)) = (
        idle_generation.upgrade(),
        cancel_generation.upgrade(),
        server.upgrade(),
    ) else {
        return;
    };
    let Ok(mut server) = server.lock() else {
        return;
    };
    if idle_generation.load(Ordering::SeqCst) == generation {
        cancel_generation.fetch_add(1, Ordering::SeqCst);
        stop_owned(&mut server);
    }
}

impl Drop for ModelRuntime {
    fn drop(&mut self) {
        if let Ok(mut owned) = self.server.lock() {
            stop_owned(&mut owned);
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
    #[cfg(target_os = "macos")]
    for (alias, target) in RUNTIME_ALIASES {
        verify_runtime_alias(&assets.library_dir.join(alias), target)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_runtime_alias(path: &Path, target: &str) -> Result<(), &'static str> {
    let expected = RUNTIME_LIBRARIES
        .iter()
        .find(|(name, _)| *name == target)
        .map(|(_, digest)| *digest)
        .ok_or("verified runtime loader alias invalid")?;
    verify_runtime_alias_with_digest(path, target, expected)
}

#[cfg(target_os = "macos")]
fn verify_runtime_alias_with_digest(
    path: &Path,
    target: &str,
    expected: &str,
) -> Result<(), &'static str> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "verified runtime loader alias invalid")?;
    if metadata.file_type().is_symlink() {
        if fs::read_link(path).map_err(|_| "verified runtime loader alias invalid")?
            == Path::new(target)
        {
            return Ok(());
        }
    } else if metadata.is_file() && sha256_file(path).is_ok_and(|digest| digest == expected) {
        // Tauri's macOS bundler copies resource symlinks as files; accept only the pinned payload bytes.
        return Ok(());
    }
    Err("verified runtime loader alias invalid")
}

#[cfg(target_os = "macos")]
fn open_verified_model(
    path: &Path,
    cancel_generation: &AtomicU64,
    generation: u64,
    chat_abort: Option<(Instant, &AtomicBool)>,
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
        if let Some(error) = startup_abort(cancel_generation, generation, chat_abort) {
            return Err(error);
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
    cancel_generation: &AtomicU64,
    generation: u64,
    chat_abort: Option<(Instant, &AtomicBool)>,
) -> Result<(Option<File>, PathBuf), &'static str> {
    // shortcut: Windows uses path-based opening until a native inherited-handle equivalent is added.
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "verified model runtime assets missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != MODEL_SIZE {
        return Err("verified model runtime assets invalid");
    }
    let mut file = File::open(path).map_err(|_| "verified model runtime assets unreadable")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if let Some(error) = startup_abort(cancel_generation, generation, chat_abort) {
            return Err(error);
        }
        let count = file
            .read(&mut buffer)
            .map_err(|_| "verified model runtime assets unreadable")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != MODEL_SHA256 {
        return Err("verified model runtime digest mismatch");
    }
    Ok((None, path.to_path_buf()))
}

fn startup_abort(
    cancellation: &AtomicU64,
    generation: u64,
    chat_abort: Option<(Instant, &AtomicBool)>,
) -> Option<&'static str> {
    if cancellation.load(Ordering::SeqCst) != generation {
        Some("runtime start cancelled")
    } else if chat_abort
        .is_some_and(|(deadline, cancelled)| ModelRuntime::chat_start_aborted(deadline, cancelled))
    {
        Some("chat response timed out")
    } else {
        None
    }
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

fn reserve_port() -> Result<u16, &'static str> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| "loopback port unavailable")
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
    let directory =
        std::env::temp_dir().join(format!("aiworker-llama-{}-{unique}", std::process::id()));
    fs::create_dir(&directory).map_err(|_| "native auth unavailable")?;
    let path = directory.join("api-key");
    let created = (|| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
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

fn await_ready(
    server: &mut OwnedServer,
    cancellation: &AtomicU64,
    generation: u64,
    chat_abort: Option<(Instant, &AtomicBool)>,
) -> Result<(), &'static str> {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if chat_abort.is_some_and(|(deadline, cancelled)| {
            ModelRuntime::chat_start_aborted(deadline, cancelled)
        }) {
            return Err("chat response timed out");
        }
        if cancellation.load(Ordering::SeqCst) != generation {
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
        if authenticated_models(server.port, &server.auth) {
            if cancellation.load(Ordering::SeqCst) != generation {
                return Err("runtime start cancelled");
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("runtime startup timed out")
}

fn authenticated_models(port: u16, auth: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(100)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    if write!(stream, "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {auth}\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut response = [0u8; 1024];
    let Ok(count) = stream.read(&mut response) else {
        return false;
    };
    response[..count].starts_with(b"HTTP/1.1 200") || response[..count].starts_with(b"HTTP/1.0 200")
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
    fn evaluation_admission_rejects_memory_below_8_gib_and_accepts_floor() {
        assert_eq!(
            admit_candidate(MINIMUM_MEMORY_BYTES - 1),
            Err("local model requires at least 8 GiB physical memory (evaluation only)")
        );
        assert_eq!(admit_candidate(MINIMUM_MEMORY_BYTES), Ok(()));
        assert_eq!(admit_candidate(MINIMUM_MEMORY_BYTES * 2), Ok(()));
    }

    #[test]
    fn candidate_generation_limits_are_fixed_in_native_policy() {
        assert_eq!(
            GENERATION_ARGS,
            [
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
            ]
        );
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

    #[cfg(target_os = "macos")]
    #[test]
    fn runtime_alias_accepts_expected_symlink_or_exact_bundled_copy() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "m111-runtime-alias-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let payload = root.join("libfoo.1.2.3.dylib");
        let alias = root.join("libfoo.0.dylib");
        let bytes = b"verified payload";
        let digest = format!("{:x}", Sha256::digest(bytes));
        fs::write(&payload, bytes).unwrap();

        symlink("libfoo.1.2.3.dylib", &alias).unwrap();
        assert_eq!(
            verify_runtime_alias_with_digest(&alias, "libfoo.1.2.3.dylib", &digest),
            Ok(())
        );

        fs::remove_file(&alias).unwrap();
        symlink("wrong.dylib", &alias).unwrap();
        assert_eq!(
            verify_runtime_alias_with_digest(&alias, "libfoo.1.2.3.dylib", &digest),
            Err("verified runtime loader alias invalid")
        );

        fs::remove_file(&alias).unwrap();
        assert_eq!(
            verify_runtime_alias_with_digest(&alias, "libfoo.1.2.3.dylib", &digest),
            Err("verified runtime loader alias invalid")
        );

        fs::copy(&payload, &alias).unwrap();
        assert_eq!(
            verify_runtime_alias_with_digest(&alias, "libfoo.1.2.3.dylib", &digest),
            Ok(())
        );
        fs::write(&alias, b"different payload").unwrap();
        assert_eq!(
            verify_runtime_alias_with_digest(&alias, "libfoo.1.2.3.dylib", &digest),
            Err("verified runtime loader alias invalid")
        );

        fs::remove_file(&alias).unwrap();
        fs::write(&alias, b"not a symlink").unwrap();
        assert_eq!(
            verify_runtime_alias_with_digest(&alias, "libfoo.1.2.3.dylib", &digest),
            Err("verified runtime loader alias invalid")
        );
        fs::remove_dir_all(root).unwrap();
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
            port: 0,
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
    fn idle_unload_fires_after_deadline_and_is_cancelled_by_new_task() {
        use std::os::unix::process::CommandExt;

        let runtime = ModelRuntime::default();
        let private_dir = std::env::temp_dir().join(format!("m16a-idle-{}", std::process::id()));
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
            port: 0,
            auth: String::new(),
            private_dir,
        });

        runtime.schedule_idle_unload(Duration::from_millis(30));
        thread::sleep(Duration::from_millis(5));
        runtime.cancel_idle_unload();
        thread::sleep(Duration::from_millis(45));
        assert!(runtime
            .server
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());

        runtime.schedule_idle_unload(Duration::from_millis(20));
        thread::sleep(Duration::from_millis(60));
        assert!(runtime.server.lock().unwrap().is_none());
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
            port: 43210,
            auth: String::new(),
            private_dir: private_dir.clone(),
        });

        let assets = Assets {
            executable: PathBuf::from("/missing/llama-server"),
            model: PathBuf::from("/missing/1.1-gb-model.gguf"),
            library_dir: PathBuf::from("/missing/libs"),
        };
        assert_eq!(runtime.start_assets(assets, None), Ok(43210));
        runtime.stop();
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
        let port = reserve_port().unwrap();
        let runtime = Arc::new(ModelRuntime::default());
        *runtime.server.lock().unwrap() = Some(OwnedServer {
            child,
            port,
            auth: String::new(),
            private_dir,
        });
        let generation = runtime.cancel_generation.load(Ordering::SeqCst);
        let (entered_tx, entered_rx) = mpsc::channel();
        let waiter = Arc::clone(&runtime);
        let readiness = thread::spawn(move || {
            let mut server = waiter.server.lock().unwrap();
            entered_tx.send(()).unwrap();
            assert_eq!(
                await_ready(
                    server.as_mut().unwrap(),
                    &waiter.cancel_generation,
                    generation,
                    None,
                ),
                Err("runtime start cancelled")
            );
        });
        entered_rx.recv().unwrap();

        let started = Instant::now();
        runtime.stop();
        readiness.join().unwrap();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(runtime.server.lock().unwrap().is_none());
        assert!(unsafe { kill(pid as i32, 0) } != 0, "startup child reaped");
    }

    #[test]
    fn stop_during_asset_resolution_cancels_before_verification_or_spawn() {
        let runtime = ModelRuntime::default();
        let generation = runtime.cancel_generation.load(Ordering::SeqCst);
        runtime.stop();

        assert_eq!(
            runtime.start_assets_at_generation(
                Assets {
                    executable: PathBuf::from("/missing/llama-server"),
                    model: PathBuf::from("/missing/model.gguf"),
                    library_dir: PathBuf::from("/missing"),
                },
                None,
                generation,
            ),
            Err("runtime start cancelled")
        );
        assert!(runtime.server.lock().unwrap().is_none());
    }

    #[test]
    fn expired_chat_deadline_aborts_before_runtime_asset_work() {
        let runtime = ModelRuntime::default();
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            runtime.start_assets_at_generation_with_abort(
                Assets {
                    executable: PathBuf::from("/missing/llama-server"),
                    model: PathBuf::from("/missing/model.gguf"),
                    library_dir: PathBuf::from("/missing/libs"),
                },
                None,
                runtime.cancel_generation.load(Ordering::SeqCst),
                Some((Instant::now() - Duration::from_millis(1), &cancelled)),
            ),
            Err("chat response timed out")
        );
        assert!(runtime.server.lock().unwrap().is_none());
    }

    #[test]
    fn chat_deadline_expiring_while_waiting_for_runtime_lock_does_not_start_work() {
        let runtime = std::sync::Arc::new(ModelRuntime::default());
        let held = runtime.server.lock().unwrap();
        let deadline = Instant::now() + Duration::from_millis(20);
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let did_start = std::sync::Arc::new(AtomicBool::new(false));
        let worker_runtime = runtime.clone();
        let worker_cancelled = cancelled.clone();
        let worker_did_start = did_start.clone();
        let worker = thread::spawn(move || {
            let guard =
                worker_runtime.lock_server_for_start(0, Some((deadline, &worker_cancelled)));
            if guard.is_ok() {
                worker_did_start.store(true, Ordering::SeqCst);
            }
            guard.map(|_| ())
        });
        thread::sleep(Duration::from_millis(30));
        drop(held);

        assert_eq!(worker.join().unwrap(), Err("chat response timed out"));
        assert!(!did_start.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[test]
    fn chat_deadline_during_startup_reaps_owned_child() {
        use std::os::unix::process::CommandExt;

        let private_dir = std::env::temp_dir().join(format!(
            "m13-deadline-start-{}-{}",
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
        let pid = child.id();
        let generation = 0;
        let cancellation = AtomicU64::new(generation);
        let mut owned = Some(OwnedServer {
            child,
            port: reserve_port().unwrap(),
            auth: "secret".into(),
            private_dir,
        });
        let deadline = Instant::now() + Duration::from_millis(25);

        let result = await_ready(
            owned.as_mut().unwrap(),
            &cancellation,
            generation,
            Some((deadline, &AtomicBool::new(false))),
        );
        if result.is_err() {
            stop_owned(&mut owned);
        }

        assert_eq!(result, Err("chat response timed out"));
        assert!(owned.is_none());
        assert!(unsafe { kill(pid as i32, 0) } != 0, "startup child reaped");
    }

    #[test]
    #[ignore = "requires the reviewed M10a candidate artifacts on the development SSD"]
    fn candidate_process_auth_port_failure_crash_and_repeated_cleanup() {
        let assets = artifact_assets();
        verify_assets(&assets).unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied_port = listener.local_addr().unwrap().port();
        let unrelated_pid = std::process::id();
        let runtime = ModelRuntime::default();
        assert_eq!(
            runtime.start_assets(
                Assets {
                    executable: assets.executable.clone(),
                    model: assets.model.clone(),
                    library_dir: assets.library_dir.clone()
                },
                Some(occupied_port)
            ),
            Err("runtime exited during startup")
        );
        assert!(
            TcpStream::connect(listener.local_addr().unwrap()).is_ok(),
            "port owner remains alive"
        );
        drop(listener);

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

        let first_port = runtime.start_assets(wrong, None).unwrap();
        assert!(authenticated_models(
            first_port,
            &runtime.server.lock().unwrap().as_ref().unwrap().auth
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

        let second_port = runtime.start_assets(artifact_assets(), None).unwrap();
        assert_ne!(first_port, second_port);
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
        runtime.stop();
        assert!(!key_dir.exists(), "quit removes only owned auth files");
        assert!(
            unsafe { kill(unrelated_pid as i32, 0) } == 0,
            "unrelated parent process survives"
        );
        runtime.start_assets(artifact_assets(), None).unwrap();
        runtime.stop();
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
