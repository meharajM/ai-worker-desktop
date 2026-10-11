use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    bridge::{BridgeState, StatusRequest},
    model_runtime::{
        MODEL_DISK_REQUIREMENT, MODEL_NAME, MODEL_SHA256, MODEL_SIZE, MODEL_SOURCE, SERVER_SHA256,
        TEMPLATE_SHA256,
    },
};

#[derive(Default)]
pub struct ModelSetup {
    active: Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>,
}

pub(crate) fn developer_candidate_available() -> bool {
    cfg!(all(
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogReply {
    protocol_version: u8,
    owner_id: String,
    session_id: String,
    request_id: String,
    certified_profiles: Vec<String>,
    developer_candidate: Option<ModelCandidate>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    id: &'static str,
    name: &'static str,
    status: &'static str,
    source: &'static str,
    license: &'static str,
    artifact_size: u64,
    artifact_sha256: &'static str,
    template_sha256: &'static str,
    runtime_sha256: &'static str,
    disk_required: u64,
    installed: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportReply {
    protocol_version: u8,
    owner_id: String,
    session_id: String,
    request_id: String,
    started: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportProgress {
    request_id: String,
    state: &'static str,
    copied: u64,
    total: u64,
    message: Option<&'static str>,
}

#[tauri::command]
pub fn model_catalog(
    request: StatusRequest,
    window: WebviewWindow,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
) -> Result<ModelCatalogReply, &'static str> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "model setup request rejected")?;
    let model_path = app
        .path()
        .app_data_dir()
        .map_err(|_| "model storage unavailable")?
        .join("models")
        .join(MODEL_NAME);
    let installed = fs::symlink_metadata(&model_path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
    Ok(ModelCatalogReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        certified_profiles: Vec::new(),
        developer_candidate: if developer_candidate_available() {
            Some(ModelCandidate {
                id: "qwen3-1.7b-q4-k-m-m10a",
                name: "Qwen3 1.7B Q4_K_M",
                status: "Apple Silicon macOS evaluation only · 16 GiB candidate, not certified",
                source: MODEL_SOURCE,
                license: "Apache-2.0",
                artifact_size: MODEL_SIZE,
                artifact_sha256: MODEL_SHA256,
                template_sha256: TEMPLATE_SHA256,
                runtime_sha256: SERVER_SHA256,
                disk_required: MODEL_DISK_REQUIREMENT,
                installed,
            })
        } else {
            None
        },
    })
}

#[tauri::command]
pub fn model_import(
    request: StatusRequest,
    on_progress: Channel<ModelImportProgress>,
    window: WebviewWindow,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
    setup: State<'_, ModelSetup>,
) -> Result<ModelImportReply, &'static str> {
    // The candidate is developer-only; enforce that policy at the native IPC boundary too.
    if !developer_candidate_available() {
        return Err("developer model import is unavailable for this build target");
    }
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "model setup request rejected")?;
    let Some(source) = app
        .dialog()
        .file()
        .set_title("Import verified Qwen3 GGUF model")
        .add_filter("GGUF model", &["gguf"])
        .blocking_pick_file()
    else {
        return Ok(ModelImportReply {
            protocol_version: request.protocol_version,
            owner_id: request.owner_id,
            session_id: request.session_id,
            request_id: request.request_id,
            started: false,
        });
    };
    let source = source
        .into_path()
        .map_err(|_| "selected model path unavailable")?;
    let destination = app
        .path()
        .app_data_dir()
        .map_err(|_| "model storage unavailable")?
        .join("models");
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = setup.active.lock().map_err(|_| "model setup unavailable")?;
        if active.is_some() {
            return Err("a model import is already running");
        }
        *active = Some((request.request_id.clone(), Arc::clone(&cancel)));
    }
    let request_id = request.request_id.clone();
    let on_progress_task = on_progress.clone();
    let cancel_for_task = cancel;
    let active_state = Arc::clone(&setup.active);
    tauri::async_runtime::spawn_blocking(move || {
        let result = import_candidate(
            &source,
            &destination,
            &request_id,
            &cancel_for_task,
            &on_progress_task,
        );
        let (state, message) = match result {
            Ok(()) => ("completed", None),
            Err(ImportFailure::Cancelled) => (
                "cancelled",
                Some("Import canceled; partial data is kept safely for retry."),
            ),
            Err(ImportFailure::Mismatch) => (
                "failed",
                Some("Selected GGUF does not match the pinned model identity."),
            ),
            Err(ImportFailure::InsufficientDisk) => (
                "failed",
                Some("Not enough disk space to import this model."),
            ),
            Err(ImportFailure::Invalid) => (
                "failed",
                Some("Selected file is not a supported GGUF model."),
            ),
            Err(ImportFailure::Io) => (
                "failed",
                Some("Model import failed. Free disk space or retry."),
            ),
        };
        let _ = on_progress_task.send(ModelImportProgress {
            request_id: request_id.clone(),
            state,
            copied: if state == "completed" { MODEL_SIZE } else { 0 },
            total: MODEL_SIZE,
            message,
        });
        if let Ok(mut active) = active_state.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &request_id) {
                *active = None;
            }
        }
    });
    Ok(ModelImportReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        started: true,
    })
}

#[tauri::command]
pub fn model_cancel_import(
    request: StatusRequest,
    import_request_id: String,
    window: WebviewWindow,
    bridge: State<'_, BridgeState>,
    setup: State<'_, ModelSetup>,
) -> Result<ModelImportReply, &'static str> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "model setup request rejected")?;
    if import_request_id.len() > 64
        || !import_request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("model setup request rejected");
    }
    let active = setup.active.lock().map_err(|_| "model setup unavailable")?;
    let Some((_, cancel)) = active.as_ref().filter(|(id, _)| id == &import_request_id) else {
        return Err("model import is no longer active");
    };
    cancel.store(true, Ordering::SeqCst);
    Ok(ModelImportReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        started: false,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum ImportFailure {
    Cancelled,
    Mismatch,
    InsufficientDisk,
    Invalid,
    Io,
}

fn classify_import_io(error: std::io::Error) -> ImportFailure {
    if error.kind() == std::io::ErrorKind::StorageFull {
        ImportFailure::InsufficientDisk
    } else {
        ImportFailure::Io
    }
}

fn import_candidate(
    source: &Path,
    destination: &Path,
    request_id: &str,
    cancel: &AtomicBool,
    on_progress: &Channel<ModelImportProgress>,
) -> Result<(), ImportFailure> {
    import_candidate_with_policy(
        source,
        destination,
        MODEL_SIZE,
        MODEL_SHA256,
        cancel,
        |copied| {
            on_progress
                .send(ModelImportProgress {
                    request_id: request_id.into(),
                    state: "progress",
                    copied,
                    total: MODEL_SIZE,
                    message: None,
                })
                .is_ok()
        },
    )
}

fn import_candidate_with_policy(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
    cancel: &AtomicBool,
    report_progress: impl FnMut(u64) -> bool,
) -> Result<(), ImportFailure> {
    import_candidate_with_writer(
        source,
        destination,
        expected_size,
        expected_sha256,
        cancel,
        report_progress,
        |output, bytes| output.write_all(bytes),
        || {},
    )
}

#[allow(clippy::too_many_arguments)]
fn import_candidate_with_writer(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
    cancel: &AtomicBool,
    mut report_progress: impl FnMut(u64) -> bool,
    mut write_chunk: impl FnMut(&mut File, &[u8]) -> std::io::Result<()>,
    mut after_sync: impl FnMut(),
) -> Result<(), ImportFailure> {
    let metadata = fs::symlink_metadata(source).map_err(|_| ImportFailure::Io)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != expected_size
        || !source
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
    {
        return Err(ImportFailure::Invalid);
    }
    let mut input = File::open(source).map_err(|_| ImportFailure::Io)?;
    if input.metadata().map_err(|_| ImportFailure::Io)?.len() != expected_size {
        return Err(ImportFailure::Invalid);
    }
    fs::create_dir_all(destination).map_err(classify_import_io)?;
    let destination_metadata = fs::symlink_metadata(destination).map_err(|_| ImportFailure::Io)?;
    if destination_metadata.file_type().is_symlink() || !destination_metadata.is_dir() {
        return Err(ImportFailure::Io);
    }
    let partial = destination.join(format!(".{MODEL_NAME}.partial"));
    remove_stale_request_partials(destination, &partial).map_err(classify_import_io)?;
    let mut output = open_or_create_partial(&partial).map_err(classify_import_io)?;
    let outcome = (|| {
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut partial_buffer = vec![0u8; 1024 * 1024];
        let mut copied = resume_matching_prefix(
            &mut input,
            &mut output,
            expected_size,
            &mut hash,
            &mut buffer,
            &mut partial_buffer,
            cancel,
        )?;
        if copied > 0 && !report_progress(copied) {
            cancel.store(true, Ordering::SeqCst);
        }
        loop {
            if cancel.load(Ordering::SeqCst) {
                output.sync_all().map_err(classify_import_io)?;
                return Err(ImportFailure::Cancelled);
            }
            let read = input.read(&mut buffer).map_err(|_| ImportFailure::Io)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            write_chunk(&mut output, &buffer[..read]).map_err(classify_import_io)?;
            copied += read as u64;
            if !report_progress(copied) {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        if copied != expected_size || format!("{:x}", hash.finalize()) != expected_sha256 {
            return Err(ImportFailure::Mismatch);
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(ImportFailure::Cancelled);
        }
        output.sync_all().map_err(classify_import_io)?;
        after_sync();
        if cancel.load(Ordering::SeqCst) {
            return Err(ImportFailure::Cancelled);
        }
        replace_imported_model(&partial, &destination.join(MODEL_NAME))
            .map_err(classify_import_io)?;
        Ok(())
    })();
    if outcome.is_err() {
        let remove_partial = matches!(
            outcome,
            Err(ImportFailure::Mismatch | ImportFailure::Invalid)
        ) || output.metadata().is_ok_and(|metadata| metadata.len() == 0);
        drop(output);
        if remove_partial {
            let _ = fs::remove_file(&partial);
        }
    }
    outcome
}

fn remove_stale_request_partials(
    destination: &Path,
    current_partial: &Path,
) -> std::io::Result<()> {
    let prefix = format!(".{MODEL_NAME}.");
    for entry in fs::read_dir(destination)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path == current_partial || !name.starts_with(&prefix) || !name.ends_with(".partial") {
            continue;
        }
        if entry.file_type()?.is_file() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn open_or_create_partial(path: &Path) -> std::io::Result<File> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(path)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(path)
        }
        Ok(metadata) if metadata.is_file() => OpenOptions::new().read(true).write(true).open(path),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "partial import path is not a regular file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path),
        Err(error) => Err(error),
    }
}

fn resume_matching_prefix(
    input: &mut File,
    output: &mut File,
    expected_size: u64,
    hash: &mut Sha256,
    source_buffer: &mut [u8],
    partial_buffer: &mut [u8],
    cancel: &AtomicBool,
) -> Result<u64, ImportFailure> {
    let partial_size = output.metadata().map_err(classify_import_io)?.len();
    if partial_size > expected_size {
        output.set_len(0).map_err(classify_import_io)?;
    }
    input.seek(SeekFrom::Start(0)).map_err(classify_import_io)?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(classify_import_io)?;
    let partial_size = output.metadata().map_err(classify_import_io)?.len();
    let mut compared = 0u64;
    while compared < partial_size {
        if cancel.load(Ordering::SeqCst) {
            output.sync_all().map_err(classify_import_io)?;
            return Err(ImportFailure::Cancelled);
        }
        let amount = (partial_size - compared).min(source_buffer.len() as u64) as usize;
        input
            .read_exact(&mut source_buffer[..amount])
            .map_err(|_| ImportFailure::Io)?;
        output
            .read_exact(&mut partial_buffer[..amount])
            .map_err(|_| ImportFailure::Io)?;
        if source_buffer[..amount] != partial_buffer[..amount] {
            output.set_len(0).map_err(classify_import_io)?;
            input.seek(SeekFrom::Start(0)).map_err(classify_import_io)?;
            output
                .seek(SeekFrom::Start(0))
                .map_err(classify_import_io)?;
            *hash = Sha256::new();
            return Ok(0);
        }
        hash.update(&source_buffer[..amount]);
        compared += amount as u64;
    }
    input
        .seek(SeekFrom::Start(compared))
        .map_err(classify_import_io)?;
    output.seek(SeekFrom::End(0)).map_err(classify_import_io)?;
    Ok(compared)
}

fn replace_imported_model(partial: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(partial, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "m12-import-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn model_import_hashes_bounded_chunks_and_cleans_failed_partials() {
        let temp = TestDirectory::new();
        let source_dir = temp.0.join("source");
        let models_dir = temp.0.join("models");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("fixture.gguf");
        fs::create_dir(&models_dir).unwrap();
        fs::write(
            models_dir.join(format!(".{MODEL_NAME}.interrupted.partial")),
            b"stale partial",
        )
        .unwrap();
        let bytes = vec![0x5a; 1024 * 1024 + 17];
        fs::write(&source, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let cancel = AtomicBool::new(false);
        let mut progress = Vec::new();

        import_candidate_with_policy(
            &source,
            &models_dir,
            bytes.len() as u64,
            &hash,
            &cancel,
            |copied| {
                progress.push(copied);
                true
            },
        )
        .unwrap();
        assert_eq!(fs::read(models_dir.join(MODEL_NAME)).unwrap(), bytes);
        assert_eq!(progress, [1024 * 1024, 1024 * 1024 + 17]);
        assert_eq!(fs::read_dir(&models_dir).unwrap().count(), 1);

        fs::write(&source, vec![0x33; bytes.len()]).unwrap();
        let prior = fs::read(models_dir.join(MODEL_NAME)).unwrap();
        assert_eq!(
            import_candidate_with_policy(
                &source,
                &models_dir,
                bytes.len() as u64,
                &hash,
                &AtomicBool::new(false),
                |_| true,
            ),
            Err(ImportFailure::Mismatch)
        );
        assert_eq!(fs::read(models_dir.join(MODEL_NAME)).unwrap(), prior);
        assert_eq!(fs::read_dir(&models_dir).unwrap().count(), 1);

        fs::write(&source, &bytes).unwrap();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            import_candidate_with_policy(
                &source,
                &models_dir,
                bytes.len() as u64,
                &hash,
                &cancel,
                |copied| {
                    if copied >= 1024 * 1024 {
                        cancel.store(true, Ordering::SeqCst);
                        false
                    } else {
                        true
                    }
                },
            ),
            Err(ImportFailure::Cancelled)
        );
        assert_eq!(fs::read(models_dir.join(MODEL_NAME)).unwrap(), prior);
        let partial = models_dir.join(format!(".{MODEL_NAME}.partial"));
        assert_eq!(fs::metadata(&partial).unwrap().len(), 1024 * 1024);
        assert_eq!(fs::read_dir(&models_dir).unwrap().count(), 2);

        #[cfg(windows)]
        fs::remove_file(models_dir.join(MODEL_NAME)).unwrap();
        let mut resumed_progress = Vec::new();
        import_candidate_with_policy(
            &source,
            &models_dir,
            bytes.len() as u64,
            &hash,
            &AtomicBool::new(false),
            |copied| {
                resumed_progress.push(copied);
                true
            },
        )
        .unwrap();
        assert_eq!(resumed_progress, [1024 * 1024, 1024 * 1024 + 17]);
        assert_eq!(fs::read(models_dir.join(MODEL_NAME)).unwrap(), bytes);
        assert!(!partial.exists());
        assert_eq!(fs::read_dir(&models_dir).unwrap().count(), 1);
    }

    #[test]
    fn resumed_prefix_mismatch_restarts_the_hash_before_recopied_bytes() {
        let temp = TestDirectory::new();
        let source = temp.0.join("fixture.gguf");
        let models_dir = temp.0.join("models");
        fs::create_dir(&models_dir).unwrap();
        let bytes = vec![0x5a; 1024 * 1024 + 17];
        fs::write(&source, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let mut divergent_partial = bytes.clone();
        *divergent_partial.last_mut().unwrap() ^= 0xff;
        fs::write(
            models_dir.join(format!(".{MODEL_NAME}.partial")),
            divergent_partial,
        )
        .unwrap();

        let mut progress = Vec::new();
        import_candidate_with_policy(
            &source,
            &models_dir,
            bytes.len() as u64,
            &hash,
            &AtomicBool::new(false),
            |copied| {
                progress.push(copied);
                true
            },
        )
        .unwrap();

        assert_eq!(progress, [1024 * 1024, 1024 * 1024 + 17]);
        assert_eq!(fs::read(models_dir.join(MODEL_NAME)).unwrap(), bytes);
    }

    #[test]
    fn cancel_after_sync_keeps_partial_and_does_not_replace_installed_model() {
        let temp = TestDirectory::new();
        let source = temp.0.join("fixture.gguf");
        let models_dir = temp.0.join("models");
        fs::create_dir(&models_dir).unwrap();
        let bytes = b"synthetic complete model";
        let installed = b"previous verified model";
        fs::write(&source, bytes).unwrap();
        fs::write(models_dir.join(MODEL_NAME), installed).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        let cancel = AtomicBool::new(false);

        let result = import_candidate_with_writer(
            &source,
            &models_dir,
            bytes.len() as u64,
            &hash,
            &cancel,
            |_| true,
            |output, chunk| output.write_all(chunk),
            || cancel.store(true, Ordering::SeqCst),
        );

        assert_eq!(result, Err(ImportFailure::Cancelled));
        assert_eq!(fs::read(models_dir.join(MODEL_NAME)).unwrap(), installed);
        assert_eq!(
            fs::read(models_dir.join(format!(".{MODEL_NAME}.partial"))).unwrap(),
            bytes
        );
    }

    #[test]
    fn insufficient_space_is_classified_for_storage_full_errors() {
        let temp = TestDirectory::new();
        let source = temp.0.join("fixture.gguf");
        let destination = temp.0.join("models");
        let bytes = b"synthetic model";
        fs::write(&source, bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        let result = import_candidate_with_writer(
            &source,
            &destination,
            bytes.len() as u64,
            &hash,
            &AtomicBool::new(false),
            |_| true,
            |_output, _bytes| Err(std::io::Error::from(std::io::ErrorKind::StorageFull)),
            || {},
        );
        assert_eq!(result, Err(ImportFailure::InsufficientDisk));
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
    }
}
