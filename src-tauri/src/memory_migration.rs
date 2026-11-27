use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::bridge::{BridgeError, BridgeErrorCode, BridgeState, StatusRequest};
use crate::memory_store::{MemoryImportPreview, MemoryStore, MemoryStoreError};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCommandError {
    pub code: &'static str,
    pub message: String,
}

impl MemoryCommandError {
    fn from_bridge(error: BridgeError) -> Self {
        let code = match error.code {
            BridgeErrorCode::InvalidRequest => "invalid_request",
            BridgeErrorCode::Unauthorized => "unauthorized",
            BridgeErrorCode::StaleSession => "stale_session",
            BridgeErrorCode::Internal => "internal",
        };
        Self {
            code,
            message: error.message.to_owned(),
        }
    }

    fn from_store(error: MemoryStoreError) -> Self {
        let code = match &error {
            MemoryStoreError::InvalidArchive(_) | MemoryStoreError::MigrationConflict => {
                "invalid_request"
            }
            MemoryStoreError::Storage => "internal",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }

    fn internal(message: String) -> Self {
        Self {
            code: "internal",
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCommandReply<T> {
    protocol_version: u8,
    owner_id: String,
    session_id: String,
    request_id: String,
    payload: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportPayload {
    entities_imported: usize,
    relations_imported: usize,
    already_imported: bool,
    content_sha256: String,
    migration_id: String,
    backup_path: String,
}

fn reply<T>(request: &StatusRequest, payload: T) -> MemoryCommandReply<T> {
    MemoryCommandReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id.clone(),
        session_id: request.session_id.clone(),
        request_id: request.request_id.clone(),
        payload,
    }
}

#[tauri::command]
pub fn memory_preview_archive(
    request: StatusRequest,
    archive_json: String,
    window: WebviewWindow,
    bridge: State<'_, BridgeState>,
    store: State<'_, MemoryStore>,
) -> Result<MemoryCommandReply<MemoryImportPreview>, MemoryCommandError> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(MemoryCommandError::from_bridge)?;
    let preview = store
        .preview(&archive_json)
        .map_err(MemoryCommandError::from_store)?;
    Ok(reply(&request, preview))
}

#[tauri::command]
pub fn memory_import_archive(
    request: StatusRequest,
    archive_json: String,
    window: WebviewWindow,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
    store: State<'_, MemoryStore>,
) -> Result<MemoryCommandReply<MemoryImportPayload>, MemoryCommandError> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(MemoryCommandError::from_bridge)?;

    // Validate before retaining a local backup, then revalidate inside the atomic database import.
    store
        .preview(&archive_json)
        .map_err(MemoryCommandError::from_store)?;
    let backup_root = app
        .path()
        .app_data_dir()
        .map_err(|_| {
            MemoryCommandError::internal("Could not find AI-Worker's local data folder.".into())
        })?
        .join("memory-archives");
    let backup_id = format!("sha256-{:x}", Sha256::digest(archive_json.as_bytes()));
    let backup_path = save_archive_backup(&backup_root, &backup_id, &archive_json)
        .map_err(MemoryCommandError::internal)?;
    let imported = store
        .import(&archive_json)
        .map_err(MemoryCommandError::from_store)?;

    Ok(reply(
        &request,
        MemoryImportPayload {
            entities_imported: imported.entities_imported,
            relations_imported: imported.relations_imported,
            already_imported: imported.already_imported,
            content_sha256: imported.content_sha256,
            migration_id: imported.migration_id,
            backup_path: backup_path.to_string_lossy().into_owned(),
        },
    ))
}

fn save_archive_backup(root: &Path, migration_id: &str, contents: &str) -> Result<PathBuf, String> {
    let Some(digest) = migration_id.strip_prefix("sha256-") else {
        return Err("Memory archive has an invalid backup identifier.".into());
    };
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Memory archive has an invalid backup identifier.".into());
    }

    ensure_backup_root(root)?;

    let destination = root.join(format!("{migration_id}.json"));
    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err("Existing local memory backup is not a regular file.".into());
            }
            let existing = fs::read(&destination)
                .map_err(|_| "Existing local memory backup could not be read.".to_owned())?;
            if existing == contents.as_bytes() {
                sync_existing_backup(root, &destination)?;
                return Ok(destination);
            }
            return Err("A different local backup already uses this archive ID.".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Existing local memory backup could not be checked.".into()),
    }

    let temporary = root.join(format!(".{migration_id}-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Could not create the local memory backup.".to_owned())?;

    if file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err("Could not finish the local memory backup.".into());
    }
    drop(file);

    if fs::rename(&temporary, &destination).is_err() {
        let _ = fs::remove_file(&temporary);
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if metadata.file_type().is_file() {
                if let Ok(existing) = fs::read(&destination) {
                    if existing == contents.as_bytes() {
                        sync_existing_backup(root, &destination)?;
                        return Ok(destination);
                    }
                }
            }
        }
        return Err("Could not finish the local memory backup.".into());
    }

    sync_backup_directory(root)?;
    Ok(destination)
}

fn ensure_backup_root(root: &Path) -> Result<(), String> {
    match fs::create_dir(root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("Could not create the local memory backup folder.".into()),
    }
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| "Local memory backup folder could not be checked.".to_owned())?;
    if !metadata.file_type().is_dir() {
        return Err("Local memory backup folder must be a real directory.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect the local memory backup folder.".to_owned())?;
    }
    Ok(())
}

fn sync_existing_backup(root: &Path, backup: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(backup)
        .map_err(|_| "Existing local memory backup could not be checked.".to_owned())?;
    if !metadata.file_type().is_file() {
        return Err("Existing local memory backup is not a regular file.".into());
    }
    File::open(backup)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Existing local memory backup could not be made durable.".to_owned())?;
    sync_backup_directory(root)
}

fn sync_backup_directory(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Local memory backup could not be made durable before import.".to_owned())?;
    // std cannot open Windows directories for FlushFileBuffers; the file itself is synced before rename there.
    #[cfg(not(unix))]
    let _ = root;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn backup_is_atomic_private_and_never_overwrites_different_contents() {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "ai-worker-memory-backup-{}-{id}",
            std::process::id()
        ));
        let archive_id = format!("sha256-{}", "a".repeat(64));
        let contents = "synthetic validated archive";

        let path = save_archive_backup(&root, &archive_id, contents).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            save_archive_backup(&root, &archive_id, contents).unwrap(),
            path
        );
        assert!(save_archive_backup(&root, &archive_id, "different archive").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn matching_symlink_cannot_stand_in_for_a_local_backup() {
        use std::os::unix::fs::symlink;

        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "ai-worker-memory-backup-link-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive_id = format!("sha256-{}", "b".repeat(64));
        let outside = root.join("outside.json");
        fs::write(&outside, "synthetic archive").unwrap();
        symlink(&outside, root.join(format!("{archive_id}.json"))).unwrap();

        assert!(save_archive_backup(&root, &archive_id, "synthetic archive").is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "synthetic archive");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn backup_folder_symlink_is_rejected_before_writing_elsewhere() {
        use std::os::unix::fs::symlink;

        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let parent = std::env::temp_dir().join(format!(
            "ai-worker-memory-backup-root-link-{}-{id}",
            std::process::id()
        ));
        let target = parent.join("target");
        let root = parent.join("memory-archives");
        fs::create_dir_all(&target).unwrap();
        symlink(&target, &root).unwrap();
        let archive_id = format!("sha256-{}", "c".repeat(64));

        assert!(save_archive_backup(&root, &archive_id, "synthetic archive").is_err());
        assert!(!target.join(format!("{archive_id}.json")).exists());
        let _ = fs::remove_dir_all(parent);
    }
}
