use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use sha2::{Digest, Sha256};
use sysinfo::{Disks, System};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    bridge::{BridgeState, StatusRequest},
    model_runtime::{
        local_ollama_models, pull_ollama_model, MODEL_DISK_REQUIREMENT, MODEL_NAME, MODEL_SHA256,
        MODEL_SIZE, MODEL_SOURCE, SERVER_SHA256, TEMPLATE_SHA256,
    },
};

const GIB: u64 = 1024 * 1024 * 1024;
// shortcut: conservative Qwen3 RAM/disk tiers, not benchmarked; measure on each platform before certification.
const MODEL_PROFILES: &[RecommendedModel] = &[
    RecommendedModel {
        id: "qwen3-0.6b",
        name: "Qwen3 0.6B",
        ollama_name: "qwen3:0.6b",
        minimum_memory: 4 * GIB,
        minimum_available_memory: 2 * GIB,
        estimated_size: 523_000_000,
    },
    RecommendedModel {
        id: "qwen3-1.7b",
        name: "Qwen3 1.7B",
        ollama_name: "qwen3:1.7b",
        minimum_memory: 8 * GIB,
        minimum_available_memory: 4 * GIB,
        estimated_size: 1_400_000_000,
    },
    RecommendedModel {
        id: "qwen3-4b",
        name: "Qwen3 4B",
        ollama_name: "qwen3:4b",
        minimum_memory: 16 * GIB,
        minimum_available_memory: 8 * GIB,
        estimated_size: 2_500_000_000,
    },
    RecommendedModel {
        id: "qwen3-8b",
        name: "Qwen3 8B",
        ollama_name: "qwen3:8b",
        minimum_memory: 32 * GIB,
        minimum_available_memory: 16 * GIB,
        estimated_size: 5_200_000_000,
    },
];

#[derive(Default)]
pub struct ModelSetup {
    active: Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>,
}

fn developer_candidate_available() -> bool {
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
    system: SystemProfile,
    ollama_available: bool,
    installed_models: Vec<String>,
    configured_model: Option<String>,
    selected_model: Option<String>,
    recommended_model: Option<ModelRecommendation>,
    certified_profiles: Vec<String>,
    developer_candidate: Option<ModelCandidate>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProfile {
    operating_system: &'static str,
    architecture: &'static str,
    logical_cpu_count: usize,
    total_memory_bytes: u64,
    available_memory_bytes: u64,
    available_model_disk_bytes: Option<u64>,
}

#[derive(Clone, Copy)]
struct RecommendedModel {
    id: &'static str,
    name: &'static str,
    ollama_name: &'static str,
    minimum_memory: u64,
    minimum_available_memory: u64,
    estimated_size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecommendation {
    id: &'static str,
    name: &'static str,
    ollama_name: &'static str,
    minimum_memory_bytes: u64,
    estimated_size_bytes: u64,
    disk_required_bytes: u64,
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
    message: Option<String>,
}

fn system_profile() -> SystemProfile {
    let mut system = System::new();
    system.refresh_memory();
    SystemProfile {
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        logical_cpu_count: std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1),
        total_memory_bytes: system.total_memory(),
        available_memory_bytes: system.available_memory(),
        available_model_disk_bytes: ollama_model_directory().and_then(|path| {
            let disks = Disks::new_with_refreshed_list();
            disks
                .iter()
                .filter(|disk| path.starts_with(disk.mount_point()))
                .max_by_key(|disk| disk.mount_point().components().count())
                .map(|disk| disk.available_space())
        }),
    }
}

fn ollama_model_directory() -> Option<std::path::PathBuf> {
    let path = std::env::var_os("OLLAMA_MODELS")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            let home = if cfg!(target_os = "windows") {
                std::env::var_os("USERPROFILE")
            } else {
                std::env::var_os("HOME")
            }?;
            Some(
                std::path::PathBuf::from(home)
                    .join(".ollama")
                    .join("models"),
            )
        })?;
    if path.is_absolute() {
        Some(path)
    } else {
        std::env::current_dir()
            .ok()
            .map(|directory| directory.join(path))
    }
}

fn configured_local_model() -> Option<String> {
    std::env::var("AI_WORKER_OLLAMA_MODEL")
        .ok()
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty())
}

fn selected_local_model(installed: &[String], configured: Option<&str>) -> Option<String> {
    if let Some(configured) = configured {
        return installed
            .iter()
            .find(|model| model.as_str() == configured)
            .cloned();
    }
    installed.first().cloned()
}

fn recommended_model(
    system: &SystemProfile,
    configured: Option<&str>,
) -> Option<ModelRecommendation> {
    let fits = |candidate: &&RecommendedModel| {
        system.total_memory_bytes >= candidate.minimum_memory
            && system.available_memory_bytes >= candidate.minimum_available_memory
            && system
                .available_model_disk_bytes
                .is_none_or(|available| available >= candidate.estimated_size.saturating_mul(2))
    };
    let candidate = if let Some(configured) = configured {
        MODEL_PROFILES
            .iter()
            .find(|candidate| candidate.ollama_name == configured && fits(candidate))
    } else {
        MODEL_PROFILES.iter().rev().find(fits)
    }?;
    Some(ModelRecommendation {
        id: candidate.id,
        name: candidate.name,
        ollama_name: candidate.ollama_name,
        minimum_memory_bytes: candidate.minimum_memory,
        estimated_size_bytes: candidate.estimated_size,
        disk_required_bytes: candidate.estimated_size.saturating_mul(2),
    })
}

#[tauri::command]
pub async fn model_catalog(
    request: StatusRequest,
    window: WebviewWindow,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
) -> Result<ModelCatalogReply, &'static str> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "model setup request rejected")?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "model storage unavailable")?;
    let model_path = app_data.join("models").join(MODEL_NAME);
    let installed = fs::symlink_metadata(&model_path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
    let system = system_profile();
    let ollama_models = local_ollama_models()?;
    let installed_models = ollama_models.clone().unwrap_or_default();
    let configured_model = configured_local_model();
    let selected_model = selected_local_model(&installed_models, configured_model.as_deref());
    let recommended_model = recommended_model(&system, configured_model.as_deref());
    Ok(ModelCatalogReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        system,
        ollama_available: ollama_models.is_some(),
        installed_models,
        configured_model,
        selected_model,
        recommended_model,
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
pub async fn model_import(
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
    let destination = app
        .path()
        .app_data_dir()
        .map_err(|_| "model storage unavailable")?
        .join("models");
    let cancel = reserve_operation(&setup, &request.request_id)?;
    let request_id = request.request_id.clone();
    let active_state = Arc::clone(&setup.active);
    let on_progress_task = on_progress.clone();
    let cancel_for_dialog = Arc::clone(&cancel);
    let request_id_for_dialog = request_id.clone();
    let progress_for_dialog = on_progress.clone();
    let _ = on_progress.send(ModelImportProgress {
        request_id: request_id.clone(),
        state: "progress",
        copied: 0,
        total: 0,
        message: Some("Choose a GGUF file to import.".into()),
    });
    app.dialog()
        .file()
        .set_title("Import verified Qwen3 GGUF model")
        .add_filter("GGUF model", &["gguf"])
        .pick_file(move |selected| {
            let Some(selected) = selected else {
                finish_operation(
                    &active_state,
                    &progress_for_dialog,
                    &request_id_for_dialog,
                    "cancelled",
                    Some("Model import canceled.".into()),
                    0,
                    MODEL_SIZE,
                );
                return;
            };
            let source = match selected.into_path() {
                Ok(path) => path,
                Err(_) => {
                    finish_operation(
                        &active_state,
                        &progress_for_dialog,
                        &request_id_for_dialog,
                        "failed",
                        Some("Selected model path is unavailable.".into()),
                        0,
                        MODEL_SIZE,
                    );
                    return;
                }
            };
            if cancel_for_dialog.load(Ordering::SeqCst) {
                finish_operation(
                    &active_state,
                    &progress_for_dialog,
                    &request_id_for_dialog,
                    "cancelled",
                    Some("Model import canceled.".into()),
                    0,
                    MODEL_SIZE,
                );
                return;
            }
            tauri::async_runtime::spawn_blocking(move || {
                let result = import_candidate(
                    &source,
                    &destination,
                    &request_id,
                    &cancel_for_dialog,
                    &on_progress_task,
                );
                let (state, message) = match result {
                    Ok(()) => ("completed", None),
                    Err(ImportFailure::Cancelled) => (
                        "cancelled",
                        Some("Import canceled; partial data is kept safely for retry.".into()),
                    ),
                    Err(ImportFailure::Mismatch) => (
                        "failed",
                        Some("Selected GGUF does not match the pinned model identity.".into()),
                    ),
                    Err(ImportFailure::InsufficientDisk) => (
                        "failed",
                        Some("Not enough disk space to import this model.".into()),
                    ),
                    Err(ImportFailure::Invalid) => (
                        "failed",
                        Some("Selected file is not a supported GGUF model.".into()),
                    ),
                    Err(ImportFailure::Io) => (
                        "failed",
                        Some("Model import failed. Free disk space or retry.".into()),
                    ),
                };
                finish_operation(
                    &active_state,
                    &on_progress_task,
                    &request_id,
                    state,
                    message,
                    if state == "completed" { MODEL_SIZE } else { 0 },
                    MODEL_SIZE,
                );
            });
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
pub fn model_install(
    request: StatusRequest,
    model_id: String,
    on_progress: Channel<ModelImportProgress>,
    window: WebviewWindow,
    bridge: State<'_, BridgeState>,
    setup: State<'_, ModelSetup>,
) -> Result<ModelImportReply, &'static str> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "model setup request rejected")?;
    if model_id.len() > 32
        || !model_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("model setup request rejected");
    }
    let candidate = MODEL_PROFILES
        .iter()
        .find(|candidate| candidate.id == model_id.as_str())
        .copied()
        .ok_or("model setup request rejected")?;
    let cancel = reserve_operation(&setup, &request.request_id)?;
    let active_state = Arc::clone(&setup.active);
    let request_id = request.request_id.clone();
    let on_progress_task = on_progress.clone();
    let install_name = candidate.ollama_name;
    let display_name = candidate.name;
    tauri::async_runtime::spawn_blocking(move || {
        let started = on_progress_task.send(ModelImportProgress {
            request_id: request_id.clone(),
            state: "progress",
            copied: 0,
            total: 0,
            message: Some(format!(
                "Downloading {display_name} from Ollama in the background…"
            )),
        });
        let (heartbeat_stop, heartbeat_wait) = mpsc::channel();
        let heartbeat_cancel = Arc::clone(&cancel);
        let heartbeat_progress = on_progress_task.clone();
        let heartbeat_request = request_id.clone();
        let heartbeat_name = display_name;
        let heartbeat = std::thread::spawn(move || loop {
            match heartbeat_wait.recv_timeout(Duration::from_secs(5)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if heartbeat_cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    if heartbeat_progress
                        .send(ModelImportProgress {
                            request_id: heartbeat_request.clone(),
                            state: "progress",
                            copied: 0,
                            total: 0,
                            message: Some(format!("Still downloading {heartbeat_name}…")),
                        })
                        .is_err()
                    {
                        heartbeat_cancel.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
        let result = if started.is_err() {
            Err("model progress channel closed")
        } else if cancel.load(Ordering::SeqCst) {
            Err("local model download cancelled")
        } else if configured_local_model()
            .as_deref()
            .is_some_and(|configured| configured != install_name)
        {
            Err("The configured local model differs from this recommendation; no model was downloaded.")
        } else {
            let profile = system_profile();
            if profile.total_memory_bytes < candidate.minimum_memory {
                Err("This model no longer fits the detected system memory.")
            } else if profile.available_memory_bytes < candidate.minimum_available_memory {
                Err("Close memory-heavy apps, then retry this model download.")
            } else if profile
                .available_model_disk_bytes
                .is_some_and(|available| available < candidate.estimated_size.saturating_mul(2))
            {
                Err("Not enough free space in the Ollama model storage volume.")
            } else {
                match local_ollama_models() {
                    Err(_) => Err("Ollama local model catalog is unavailable."),
                    Ok(None) => Err("Ollama is not running. Start Ollama and retry the model setup."),
                    Ok(Some(models)) if models.iter().any(|model| model.as_str() == install_name) => Ok(()),
                    Ok(Some(models))
                        if !models.is_empty()
                            && configured_local_model().as_deref() != Some(install_name) =>
                    {
                        Err("A local model is already installed. No additional model was downloaded.")
                    }
                    Ok(Some(_)) => pull_ollama_model(install_name, &cancel).and_then(|()| {
                        match local_ollama_models() {
                            Ok(Some(models)) if models.iter().any(|model| model.as_str() == install_name) => Ok(()),
                            _ => Err("Ollama did not report the downloaded model as a local text model."),
                        }
                    }),
                }
            }
        };
        let _ = heartbeat_stop.send(());
        let _ = heartbeat.join();
        let (state, message) = match result {
            Ok(()) => (
                "completed",
                Some(format!(
                    "{display_name} is installed locally and ready to use."
                )),
            ),
            Err("local model download cancelled") => (
                "cancelled",
                Some("Model download canceled. You can retry later.".into()),
            ),
            Err(message) => ("failed", Some(message.to_owned())),
        };
        finish_operation(
            &active_state,
            &on_progress_task,
            &request_id,
            state,
            message,
            0,
            0,
        );
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
    cancel_operation(&setup, &import_request_id)?;
    Ok(ModelImportReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        started: false,
    })
}

#[tauri::command]
pub fn model_cancel_install(
    request: StatusRequest,
    install_request_id: String,
    window: WebviewWindow,
    bridge: State<'_, BridgeState>,
    setup: State<'_, ModelSetup>,
) -> Result<ModelImportReply, &'static str> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "model setup request rejected")?;
    cancel_operation(&setup, &install_request_id)?;
    Ok(ModelImportReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        started: false,
    })
}

fn reserve_operation(
    setup: &ModelSetup,
    request_id: &str,
) -> Result<Arc<AtomicBool>, &'static str> {
    let mut active = setup.active.lock().map_err(|_| "model setup unavailable")?;
    if active.is_some() {
        return Err("another model setup operation is already running");
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some((request_id.to_owned(), Arc::clone(&cancel)));
    Ok(cancel)
}

fn cancel_operation(setup: &ModelSetup, request_id: &str) -> Result<(), &'static str> {
    if request_id.len() > 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("model setup request rejected");
    }
    let active = setup.active.lock().map_err(|_| "model setup unavailable")?;
    let Some((_, cancel)) = active.as_ref().filter(|(id, _)| id == request_id) else {
        return Err("model setup operation is no longer active");
    };
    cancel.store(true, Ordering::SeqCst);
    Ok(())
}

fn finish_operation(
    active_state: &Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>,
    on_progress: &Channel<ModelImportProgress>,
    request_id: &str,
    state: &'static str,
    message: Option<String>,
    copied: u64,
    total: u64,
) {
    let _ = on_progress.send(ModelImportProgress {
        request_id: request_id.to_owned(),
        state,
        copied,
        total,
        message,
    });
    if let Ok(mut active) = active_state.lock() {
        if active.as_ref().is_some_and(|(id, _)| id == request_id) {
            *active = None;
        }
    }
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
