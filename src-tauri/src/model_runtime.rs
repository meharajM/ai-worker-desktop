use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

const SERVER_SHA256: &str = "93c9a6ddd5870fae262f728f54be710b5d3c5436b8980f4ab684bba87b5c34f7";
const MODEL_NAME: &str = "Qwen3-1.7B-Q4_K_M.gguf";
const MODEL_SIZE: u64 = 1_107_408_544;
const MODEL_SHA256: &str = "228fb5627f7510b8b3516cdb6435e4b0d2a2bf330fe5b0ab19284a3570a8bb1f";
const START_TIMEOUT: Duration = Duration::from_secs(60);
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
    cancel_generation: AtomicU64,
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
        let assets = resolve_assets(app)?;
        self.start_assets(assets, None)
    }

    pub fn stop(&self) {
        self.cancel_generation.fetch_add(1, Ordering::SeqCst);
        let Ok(mut owned) = self.server.lock() else {
            return;
        };
        stop_owned(&mut owned);
    }

    fn start_assets(&self, assets: Assets, forced_port: Option<u16>) -> Result<u16, &'static str> {
        let generation = self.cancel_generation.load(Ordering::SeqCst);
        verify_assets(&assets)?;
        if self.cancel_generation.load(Ordering::SeqCst) != generation {
            return Err("runtime start cancelled");
        }

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
        let mut command = Command::new(&assets.executable);
        command
            .arg("-m")
            .arg(&assets.model)
            .args(["--offline", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .arg("--api-key-file")
            .arg(auth_file)
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
        ) {
            stop_owned(&mut current);
            return Err(error);
        }
        Ok(port)
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

fn verify_assets(assets: &Assets) -> Result<(), &'static str> {
    verify_file(&assets.executable, None, SERVER_SHA256)?;
    verify_file(&assets.model, Some(MODEL_SIZE), MODEL_SHA256)?;
    for (name, digest) in RUNTIME_LIBRARIES {
        verify_file(&assets.library_dir.join(name), None, digest)?;
    }
    Ok(())
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
) -> Result<(), &'static str> {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
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
                    generation
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
