//! Bounded, read-only access to one explicitly selected workspace.
use std::{
    collections::VecDeque,
    env,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use sha2::{Digest, Sha256};

const MAX_PATH_BYTES: usize = 512;
const MAX_PATH_DEPTH: usize = 16;
const MAX_FILE_BYTES: u64 = 16_000;
const MAX_LIST_ENTRIES: usize = 200;
const MAX_SEARCH_ENTRIES: usize = 200;
const MAX_SEARCH_RESULTS: usize = 50;
const MAX_SEARCH_DEPTH: usize = 12;
const MAX_QUERY_BYTES: usize = 256;
const MAX_WRITE_BYTES: usize = MAX_FILE_BYTES as usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedEntries {
    pub entries: Vec<WorkspaceEntry>,
    pub scanned_entries: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Matching relative paths only; file contents are never returned by search.
    pub paths: Vec<String>,
    pub scanned_entries: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceError {
    InvalidRoot,
    InvalidPath,
    OutsideWorkspace,
    NotFound,
    NotDirectory,
    NotRegularFile,
    TooLarge,
    BinaryFile,
    InvalidQuery,
    Changed,
    ProposalUsed,
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
    UnsupportedPlatform,
    Io,
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRoot => "Select an absolute project directory outside private storage.",
            Self::InvalidPath => "Workspace path is invalid.",
            Self::OutsideWorkspace => "Workspace path is outside the selected directory.",
            Self::NotFound => "Workspace path was not found.",
            Self::NotDirectory => "Workspace path is not a directory.",
            Self::NotRegularFile => "Read requires a small regular text file.",
            Self::TooLarge => "Workspace file exceeds the 16 KB read limit.",
            Self::BinaryFile => "Workspace file is binary or not valid UTF-8 text.",
            Self::InvalidQuery => "Search query must contain 1–256 UTF-8 bytes.",
            Self::Changed => "Workspace changed during the operation.",
            Self::ProposalUsed => "This staged write has already been committed or rejected.",
            #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
            Self::UnsupportedPlatform => "Safe workspace reads are unsupported on this platform.",
            Self::Io => "Workspace could not be read.",
        })
    }
}

impl std::error::Error for WorkspaceError {}

type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity(u64, u64);

fn identity(metadata: &Metadata) -> FileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileIdentity(metadata.dev(), metadata.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        FileIdentity(metadata.creation_time(), metadata.file_size())
    }
    #[cfg(not(any(unix, windows)))]
    {
        FileIdentity(
            metadata.len(),
            metadata
                .created()
                .unwrap_or(std::time::UNIX_EPOCH)
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64,
        )
    }
}

fn is_reparse_point(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink() || is_reparse_point(metadata)
}

fn has_single_link(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink() == 1
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        true
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        true
    }
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn new_proposal_id() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| WorkspaceError::Io)?;
    let hex = b"0123456789abcdef";
    let mut proposal_id = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        proposal_id.push(hex[usize::from(byte >> 4)] as char);
        proposal_id.push(hex[usize::from(byte & 0x0f)] as char);
    }
    Ok(proposal_id)
}

fn inside(parent: &Path, candidate: &Path) -> bool {
    candidate == parent || candidate.starts_with(parent)
}

fn forbidden_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.is_empty()
        || name.starts_with('.')
        || lower.starts_with("credentials")
        || lower.starts_with("secret")
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"
        )
        || name.rsplit_once('.').is_some_and(|(_, extension)| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "pem" | "key" | "p12" | "pfx" | "kdbx"
            )
        })
        || name.ends_with('.')
        || name.ends_with(' ')
        || name
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
        || matches!(
            name.split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "con"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
        )
}

fn path_parts(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty()
        || relative.len() > MAX_PATH_BYTES
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative.contains(':')
        || relative.chars().any(char::is_control)
    {
        return Err(WorkspaceError::InvalidPath);
    }
    if relative == "." {
        return Ok(Vec::new());
    }
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() > MAX_PATH_DEPTH
        || parts
            .iter()
            .any(|part| *part == "." || *part == ".." || forbidden_name(part))
    {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(parts)
}

fn no_follow_open(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Darwin: O_NOFOLLOW | O_NONBLOCK.
        options.custom_flags(0x0000_0100 | 0x0000_0004);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Linux: O_NOFOLLOW | O_NONBLOCK.
        options.custom_flags(0x0002_0000 | 0x0000_0800);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT prevents following a final reparse point.
        options.custom_flags(0x0020_0000);
    }
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
    {
        let _ = path;
        return Err(WorkspaceError::UnsupportedPlatform);
    }
    options.open(path).map_err(|_| WorkspaceError::Io)
}

fn home_directory() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Bounded view of one canonical workspace, with private directories denied.
pub struct Workspace {
    root: PathBuf,
    root_identity: FileIdentity,
    private_dirs: Vec<PathBuf>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedWrite {
    pub proposal_id: String,
    pub relative_path: String,
    pub before: Option<String>,
    pub proposed: String,
    #[serde(skip)]
    snapshot: Arc<WriteSnapshot>,
}

#[derive(Debug)]
struct WriteSnapshot {
    proposal_id: String,
    path_digest: [u8; 32],
    proposed_digest: [u8; 32],
    root: PathBuf,
    root_identity: FileIdentity,
    private_dirs: Vec<PathBuf>,
    parent_identity: FileIdentity,
    target_identity: Option<FileIdentity>,
    before_digest: Option<[u8; 32]>,
    consumed: AtomicBool,
}

impl Workspace {
    pub fn new(selected: &Path, private_dirs: &[PathBuf]) -> Result<Self> {
        if !selected.is_absolute() {
            return Err(WorkspaceError::InvalidRoot);
        }
        let root = fs::canonicalize(selected).map_err(|_| WorkspaceError::InvalidRoot)?;
        let metadata = fs::symlink_metadata(&root).map_err(|_| WorkspaceError::InvalidRoot)?;
        if is_link(&metadata) || !metadata.is_dir() || root.parent().is_none() {
            return Err(WorkspaceError::InvalidRoot);
        }
        if home_directory()
            .and_then(|home| fs::canonicalize(home).ok())
            .is_some_and(|home| root == home)
            || root.components().any(|component| match component {
                Component::Normal(name) => name.to_string_lossy().starts_with('.'),
                _ => false,
            })
        {
            return Err(WorkspaceError::InvalidRoot);
        }
        let private_dirs = private_dirs
            .iter()
            .filter_map(|dir| fs::canonicalize(dir).ok())
            .collect::<Vec<_>>();
        if private_dirs.iter().any(|private| inside(private, &root)) {
            return Err(WorkspaceError::InvalidRoot);
        }
        Ok(Self {
            root,
            root_identity: identity(&metadata),
            private_dirs,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn check_root(&self) -> Result<()> {
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| WorkspaceError::Changed)?;
        if is_link(&metadata)
            || !metadata.is_dir()
            || identity(&metadata) != self.root_identity
            || fs::canonicalize(&self.root).map_err(|_| WorkspaceError::Changed)? != self.root
        {
            return Err(WorkspaceError::Changed);
        }
        Ok(())
    }

    fn target(&self, relative: &str) -> Result<(PathBuf, Metadata)> {
        self.check_root()?;
        let parts = path_parts(relative)?;
        let mut current = self.root.clone();
        let mut metadata = fs::symlink_metadata(&current).map_err(|_| WorkspaceError::Changed)?;
        for (index, part) in parts.iter().enumerate() {
            current.push(part);
            metadata = fs::symlink_metadata(&current).map_err(|_| WorkspaceError::NotFound)?;
            if is_link(&metadata)
                || fs::canonicalize(&current).map_err(|_| WorkspaceError::Changed)? != current
            {
                return Err(WorkspaceError::OutsideWorkspace);
            }
            if self
                .private_dirs
                .iter()
                .any(|private| inside(private, &current))
            {
                return Err(WorkspaceError::OutsideWorkspace);
            }
            if index + 1 < parts.len() && !metadata.is_dir() {
                return Err(WorkspaceError::NotDirectory);
            }
        }
        if !inside(&self.root, &current) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        self.check_root()?;
        Ok((current, metadata))
    }

    pub fn list(&self, relative: &str) -> Result<BoundedEntries> {
        self.list_limited(relative, MAX_LIST_ENTRIES)
    }

    fn list_limited(&self, relative: &str, limit: usize) -> Result<BoundedEntries> {
        let (directory, before) = self.target(relative)?;
        if is_link(&before) || !before.is_dir() {
            return Err(WorkspaceError::NotDirectory);
        }
        let before_identity = identity(&before);
        let mut entries = Vec::new();
        let mut scanned_entries = 0usize;
        let mut truncated = false;
        let iterator = fs::read_dir(&directory).map_err(|_| WorkspaceError::Io)?;
        for item in iterator {
            let item = item.map_err(|_| WorkspaceError::Io)?;
            if scanned_entries >= limit {
                truncated = true;
                break;
            }
            scanned_entries += 1;
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if forbidden_name(&name) {
                continue;
            }
            if item
                .file_type()
                .map_err(|_| WorkspaceError::Changed)?
                .is_symlink()
            {
                continue;
            }
            let path = if relative == "." {
                name
            } else {
                format!("{relative}/{name}")
            };
            let Ok((target, metadata)) = self.target(&path) else {
                continue;
            };
            let kind = if metadata.is_dir() {
                EntryKind::Directory
            } else if metadata.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            // Ensure the enumerated entry still names the same object after path validation.
            let entry_metadata = item.metadata().map_err(|_| WorkspaceError::Changed)?;
            if is_link(&entry_metadata) || identity(&metadata) != identity(&entry_metadata) {
                continue;
            }
            if !inside(&self.root, &target) {
                continue;
            }
            entries.push(WorkspaceEntry { path, kind });
        }
        self.check_root()?;
        let after = fs::symlink_metadata(&directory).map_err(|_| WorkspaceError::Changed)?;
        if is_link(&after) || identity(&after) != before_identity {
            return Err(WorkspaceError::Changed);
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(BoundedEntries {
            entries,
            scanned_entries,
            truncated,
        })
    }

    pub fn read(&self, relative: &str) -> Result<String> {
        let (path, before) = self.target(relative)?;
        if is_link(&before) || !before.is_file() || !has_single_link(&before) {
            return Err(WorkspaceError::NotRegularFile);
        }
        if before.len() > MAX_FILE_BYTES {
            return Err(WorkspaceError::TooLarge);
        }
        let file = no_follow_open(&path)?;
        let opened = file.metadata().map_err(|_| WorkspaceError::Io)?;
        if is_link(&opened)
            || !opened.is_file()
            || identity(&opened) != identity(&before)
            || !has_single_link(&opened)
        {
            return Err(WorkspaceError::Changed);
        }
        let mut bytes = Vec::with_capacity(opened.len().min(MAX_FILE_BYTES) as usize);
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| WorkspaceError::Io)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(WorkspaceError::TooLarge);
        }
        if bytes.contains(&0) {
            return Err(WorkspaceError::BinaryFile);
        }
        let after = fs::symlink_metadata(&path).map_err(|_| WorkspaceError::Changed)?;
        if is_link(&after)
            || identity(&after) != identity(&opened)
            || after.len() != bytes.len() as u64
        {
            return Err(WorkspaceError::Changed);
        }
        self.check_root()?;
        String::from_utf8(bytes).map_err(|_| WorkspaceError::BinaryFile)
    }

    /// Create an in-memory write proposal. This method never writes to disk.
    pub fn stage_write(&self, relative: &str, proposed: &str) -> Result<StagedWrite> {
        if proposed.len() > MAX_WRITE_BYTES {
            return Err(WorkspaceError::TooLarge);
        }
        if proposed.as_bytes().contains(&0) {
            return Err(WorkspaceError::BinaryFile);
        }

        let parts = path_parts(relative)?;
        let (file_name, parents) = parts.split_last().ok_or(WorkspaceError::InvalidPath)?;
        let parent_relative = if parents.is_empty() {
            ".".to_owned()
        } else {
            parents.join("/")
        };
        let (parent, parent_before) = self.target(&parent_relative)?;
        if !parent_before.is_dir() || is_link(&parent_before) {
            return Err(WorkspaceError::NotDirectory);
        }
        let parent_identity = identity(&parent_before);
        let target = parent.join(file_name);
        let target_before = match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if is_link(&metadata) || !metadata.is_file() || !has_single_link(&metadata) {
                    return Err(WorkspaceError::NotRegularFile);
                }
                if metadata.len() > MAX_FILE_BYTES {
                    return Err(WorkspaceError::TooLarge);
                }
                Some((metadata, self.read(relative)?))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(WorkspaceError::Io),
        };

        let (before, target_identity, before_digest) = match target_before {
            Some((metadata, contents)) => {
                let after = fs::symlink_metadata(&target).map_err(|_| WorkspaceError::Changed)?;
                if is_link(&after)
                    || identity(&after) != identity(&metadata)
                    || after.len() != contents.len() as u64
                {
                    return Err(WorkspaceError::Changed);
                }
                let hash = digest(contents.as_bytes());
                (Some(contents), Some(identity(&after)), Some(hash))
            }
            None => (None, None, None),
        };

        self.check_root()?;
        let parent_after = fs::symlink_metadata(&parent).map_err(|_| WorkspaceError::Changed)?;
        if is_link(&parent_after)
            || !parent_after.is_dir()
            || identity(&parent_after) != parent_identity
        {
            return Err(WorkspaceError::Changed);
        }
        if fs::symlink_metadata(&target).is_ok() != target_identity.is_some() {
            return Err(WorkspaceError::Changed);
        }

        let proposal_id = new_proposal_id()?;
        Ok(StagedWrite {
            proposal_id: proposal_id.clone(),
            relative_path: relative.to_owned(),
            before,
            proposed: proposed.to_owned(),
            snapshot: Arc::new(WriteSnapshot {
                proposal_id,
                path_digest: digest(relative.as_bytes()),
                proposed_digest: digest(proposed.as_bytes()),
                root: self.root.clone(),
                root_identity: self.root_identity,
                private_dirs: self.private_dirs.clone(),
                parent_identity,
                target_identity,
                before_digest,
                consumed: AtomicBool::new(false),
            }),
        })
    }

    /// Apply a proposal only when the selected workspace and target still match its snapshot.
    pub fn commit_write(&self, proposal: &StagedWrite) -> Result<()> {
        let snapshot = &proposal.snapshot;
        if proposal.proposal_id != snapshot.proposal_id
            || digest(proposal.relative_path.as_bytes()) != snapshot.path_digest
            || digest(proposal.proposed.as_bytes()) != snapshot.proposed_digest
            || proposal
                .before
                .as_deref()
                .map(|text| digest(text.as_bytes()))
                != snapshot.before_digest
            || self.root != snapshot.root
            || self.root_identity != snapshot.root_identity
            || self.private_dirs != snapshot.private_dirs
        {
            return Err(WorkspaceError::Changed);
        }
        if snapshot
            .consumed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(WorkspaceError::ProposalUsed);
        }

        let parts = path_parts(&proposal.relative_path)?;
        let (file_name, parents) = parts.split_last().ok_or(WorkspaceError::InvalidPath)?;
        let parent_relative = if parents.is_empty() {
            ".".to_owned()
        } else {
            parents.join("/")
        };
        let (parent, parent_before) = self.target(&parent_relative)?;
        if !parent_before.is_dir()
            || is_link(&parent_before)
            || identity(&parent_before) != snapshot.parent_identity
        {
            return Err(WorkspaceError::Changed);
        }
        let target = parent.join(file_name);
        let permissions = match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                let Some(expected) = snapshot.target_identity else {
                    return Err(WorkspaceError::Changed);
                };
                if is_link(&metadata)
                    || !metadata.is_file()
                    || !has_single_link(&metadata)
                    || identity(&metadata) != expected
                {
                    return Err(WorkspaceError::Changed);
                }
                let current = self.read(&proposal.relative_path)?;
                if Some(digest(current.as_bytes())) != snapshot.before_digest {
                    return Err(WorkspaceError::Changed);
                }
                Some(metadata.permissions())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if snapshot.target_identity.is_some() {
                    return Err(WorkspaceError::Changed);
                }
                None
            }
            Err(_) => return Err(WorkspaceError::Io),
        };

        let temporary = parent.join(format!(".ai-worker-write-{}.tmp", proposal.proposal_id));
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| WorkspaceError::Io)?;
        let write_result = (|| {
            use std::io::Write;
            temp_file
                .write_all(proposal.proposed.as_bytes())
                .map_err(|_| WorkspaceError::Io)?;
            temp_file.sync_all().map_err(|_| WorkspaceError::Io)?;
            if let Some(permissions) = permissions {
                temp_file
                    .set_permissions(permissions)
                    .map_err(|_| WorkspaceError::Io)?;
            }

            self.check_root()?;
            let (parent_now, parent_meta) = self.target(&parent_relative)?;
            if parent_now != parent
                || is_link(&parent_meta)
                || !parent_meta.is_dir()
                || identity(&parent_meta) != snapshot.parent_identity
            {
                return Err(WorkspaceError::Changed);
            }

            match snapshot.target_identity {
                Some(expected) => {
                    let current_meta =
                        fs::symlink_metadata(&target).map_err(|_| WorkspaceError::Changed)?;
                    if is_link(&current_meta)
                        || !current_meta.is_file()
                        || !has_single_link(&current_meta)
                        || identity(&current_meta) != expected
                    {
                        return Err(WorkspaceError::Changed);
                    }
                    let current = self.read(&proposal.relative_path)?;
                    if Some(digest(current.as_bytes())) != snapshot.before_digest {
                        return Err(WorkspaceError::Changed);
                    }
                    fs::rename(&temporary, &target).map_err(|_| WorkspaceError::Io)?;
                }
                None => {
                    if fs::symlink_metadata(&target).is_ok() {
                        return Err(WorkspaceError::Changed);
                    }
                    // A hard link creates the new destination atomically without replacing a raced file.
                    fs::hard_link(&temporary, &target).map_err(|error| {
                        if error.kind() == std::io::ErrorKind::AlreadyExists {
                            WorkspaceError::Changed
                        } else {
                            WorkspaceError::Io
                        }
                    })?;
                    let _ = fs::remove_file(&temporary);
                }
            }
            Ok(())
        })();
        drop(temp_file);
        if temporary.exists() {
            let _ = fs::remove_file(temporary);
        }
        write_result
    }

    pub fn search(&self, relative: &str, query: &str) -> Result<SearchResults> {
        if query.is_empty() || query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control)
        {
            return Err(WorkspaceError::InvalidQuery);
        }
        let (root, metadata) = self.target(relative)?;
        if !metadata.is_dir() {
            return Err(WorkspaceError::NotDirectory);
        }
        let needle = query.to_lowercase();
        let mut pending = VecDeque::from([(relative.to_owned(), 0usize)]);
        let mut paths = Vec::new();
        let mut scanned_entries = 0usize;
        let mut truncated = false;

        while let Some((directory_rel, depth)) = pending.pop_front() {
            if scanned_entries >= MAX_SEARCH_ENTRIES || paths.len() >= MAX_SEARCH_RESULTS {
                truncated = true;
                break;
            }
            let listing =
                self.list_limited(&directory_rel, MAX_SEARCH_ENTRIES - scanned_entries)?;
            truncated |= listing.truncated;
            scanned_entries += listing.scanned_entries;
            for entry in listing.entries {
                if paths.len() >= MAX_SEARCH_RESULTS {
                    truncated = true;
                    break;
                }
                let name_matches = entry.path.to_lowercase().contains(&needle);
                if name_matches {
                    paths.push(entry.path.clone());
                }
                if entry.kind == EntryKind::Directory {
                    if depth < MAX_SEARCH_DEPTH {
                        pending.push_back((entry.path, depth + 1));
                    } else {
                        truncated = true;
                    }
                } else if !name_matches
                    && self
                        .read(&entry.path)
                        .is_ok_and(|contents| contents.to_lowercase().contains(&needle))
                {
                    paths.push(entry.path);
                }
            }
        }
        self.check_root()?;
        if !inside(&self.root, &root) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(SearchResults {
            paths,
            scanned_entries,
            truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "ai-worker-workspace-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn workspace(&self, private_dirs: &[PathBuf]) -> Workspace {
            Workspace::new(&self.0, private_dirs).unwrap()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_only_bounded_regular_entries_and_hides_private_names() {
        let temp = TempDir::new();
        fs::create_dir(temp.0.join("src")).unwrap();
        fs::write(temp.0.join("README.md"), "hello").unwrap();
        fs::write(temp.0.join(".env"), "secret").unwrap();
        fs::write(temp.0.join("credentials.json"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(temp.0.join("src"), temp.0.join("linked")).unwrap();

        let listed = temp.workspace(&[]).list(".").unwrap();
        assert_eq!(
            listed.entries,
            vec![
                WorkspaceEntry {
                    path: "README.md".into(),
                    kind: EntryKind::File
                },
                WorkspaceEntry {
                    path: "src".into(),
                    kind: EntryKind::Directory
                },
            ]
        );
        assert!(listed.scanned_entries >= listed.entries.len());
        assert!(!listed.truncated);
    }

    #[test]
    fn reads_text_only_and_rejects_traversal_links_private_paths_and_large_files() {
        let temp = TempDir::new();
        fs::create_dir(temp.0.join("sub")).unwrap();
        fs::write(temp.0.join("sub/note.txt"), "local note").unwrap();
        fs::write(
            temp.0.join("large.txt"),
            vec![b'x'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(temp.0.join("binary.dat"), [0, 1, 2]).unwrap();
        fs::write(temp.0.join("invalid-utf8.txt"), [0xff, 0xfe]).unwrap();
        fs::write(temp.0.join(".env"), "secret").unwrap();
        let private = TempDir::new();
        fs::write(private.0.join("private.txt"), "private").unwrap();
        fs::create_dir(temp.0.join("private-dir")).unwrap();
        fs::write(temp.0.join("private-dir/private.txt"), "private").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(private.0.join("private.txt"), temp.0.join("linked.txt"))
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&private.0, temp.0.join("linked-dir")).unwrap();

        let workspace = temp.workspace(&[temp.0.join("private-dir")]);
        assert_eq!(workspace.read("sub/note.txt").unwrap(), "local note");
        for path in [
            "../private.txt",
            "/etc/passwd",
            ".env",
            "private-dir/private.txt",
        ] {
            assert!(workspace.read(path).is_err(), "unexpectedly read {path}");
        }
        assert_eq!(workspace.read("large.txt"), Err(WorkspaceError::TooLarge));
        assert_eq!(
            workspace.read("binary.dat"),
            Err(WorkspaceError::BinaryFile)
        );
        assert_eq!(
            workspace.read("invalid-utf8.txt"),
            Err(WorkspaceError::BinaryFile)
        );
        #[cfg(unix)]
        {
            assert!(workspace.read("linked.txt").is_err());
            assert!(workspace.read("linked-dir/private.txt").is_err());
        }
    }

    #[test]
    fn staged_write_does_not_touch_disk_before_commit_and_commits_once() {
        let temp = TempDir::new();
        fs::create_dir(temp.0.join("src")).unwrap();
        fs::write(temp.0.join("src/note.txt"), "before").unwrap();
        let workspace = temp.workspace(&[]);
        let proposal = workspace.stage_write("src/note.txt", "after").unwrap();

        assert_eq!(proposal.before.as_deref(), Some("before"));
        assert_eq!(proposal.proposed, "after");
        assert_eq!(
            fs::read_to_string(temp.0.join("src/note.txt")).unwrap(),
            "before"
        );
        let serialized = serde_json::to_value(&proposal).unwrap();
        assert_eq!(serialized["relativePath"], "src/note.txt");
        assert!(serialized.get("snapshot").is_none());
        assert!(serialized.get("proposalId").is_some());

        workspace.commit_write(&proposal).unwrap();
        assert_eq!(
            fs::read_to_string(temp.0.join("src/note.txt")).unwrap(),
            "after"
        );
        assert_eq!(
            workspace.commit_write(&proposal),
            Err(WorkspaceError::ProposalUsed)
        );
    }

    #[test]
    fn staged_write_can_create_new_file_but_never_overwrite_a_raced_target() {
        let temp = TempDir::new();
        fs::create_dir(temp.0.join("src")).unwrap();
        let workspace = temp.workspace(&[]);
        let proposal = workspace
            .stage_write("src/new.txt", "new contents")
            .unwrap();
        assert_eq!(proposal.before, None);
        assert!(!temp.0.join("src/new.txt").exists());
        workspace.commit_write(&proposal).unwrap();
        assert_eq!(
            fs::read_to_string(temp.0.join("src/new.txt")).unwrap(),
            "new contents"
        );

        let raced = workspace.stage_write("src/raced.txt", "proposal").unwrap();
        fs::write(temp.0.join("src/raced.txt"), "user change").unwrap();
        assert_eq!(workspace.commit_write(&raced), Err(WorkspaceError::Changed));
        assert_eq!(
            fs::read_to_string(temp.0.join("src/raced.txt")).unwrap(),
            "user change"
        );
    }

    #[test]
    fn staged_write_rejects_stale_existing_file_and_modified_proposal() {
        let temp = TempDir::new();
        fs::write(temp.0.join("note.txt"), "before").unwrap();
        let workspace = temp.workspace(&[]);
        let proposal = workspace.stage_write("note.txt", "approved text").unwrap();
        fs::write(temp.0.join("note.txt"), "changed after review").unwrap();
        assert_eq!(
            workspace.commit_write(&proposal),
            Err(WorkspaceError::Changed)
        );
        assert_eq!(
            fs::read_to_string(temp.0.join("note.txt")).unwrap(),
            "changed after review"
        );

        let mut tampered = workspace.stage_write("note.txt", "approved text").unwrap();
        tampered.proposed = "different text".into();
        assert_eq!(
            workspace.commit_write(&tampered),
            Err(WorkspaceError::Changed)
        );
        assert_eq!(
            fs::read_to_string(temp.0.join("note.txt")).unwrap(),
            "changed after review"
        );
    }

    #[test]
    fn staged_write_is_bound_to_the_selected_root_and_private_paths() {
        let temp = TempDir::new();
        fs::create_dir(temp.0.join("private-dir")).unwrap();
        fs::write(temp.0.join("note.txt"), "before").unwrap();
        let selected = temp.workspace(&[temp.0.join("private-dir")]);
        let proposal = selected.stage_write("note.txt", "after").unwrap();
        let broader = temp.workspace(&[]);

        assert_eq!(
            broader.commit_write(&proposal),
            Err(WorkspaceError::Changed)
        );
        assert_eq!(
            fs::read_to_string(temp.0.join("note.txt")).unwrap(),
            "before"
        );
        selected.commit_write(&proposal).unwrap();
        assert_eq!(
            fs::read_to_string(temp.0.join("note.txt")).unwrap(),
            "after"
        );
    }

    #[test]
    fn staged_write_rejects_unsafe_paths_and_symlink_targets() {
        let temp = TempDir::new();
        fs::write(temp.0.join("source.txt"), "public").unwrap();
        let private = TempDir::new();
        fs::write(private.0.join("secret.txt"), "secret").unwrap();
        fs::create_dir(temp.0.join("private-dir")).unwrap();
        fs::write(temp.0.join("private-dir/note.txt"), "private").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(private.0.join("secret.txt"), temp.0.join("linked.txt"))
            .unwrap();

        let workspace = temp.workspace(&[temp.0.join("private-dir")]);
        assert_eq!(
            workspace.stage_write("../outside.txt", "bad").unwrap_err(),
            WorkspaceError::InvalidPath
        );
        assert_eq!(
            workspace.stage_write(".env", "bad").unwrap_err(),
            WorkspaceError::InvalidPath
        );
        assert_eq!(
            workspace
                .stage_write("private-dir/note.txt", "bad")
                .unwrap_err(),
            WorkspaceError::OutsideWorkspace
        );
        #[cfg(unix)]
        assert_eq!(
            workspace.stage_write("linked.txt", "bad").unwrap_err(),
            WorkspaceError::NotRegularFile
        );
    }

    #[test]
    fn search_is_bounded_and_returns_paths_not_file_contents() {
        let temp = TempDir::new();
        fs::create_dir(temp.0.join("src")).unwrap();
        fs::write(temp.0.join("src/one.txt"), "Unique Needle in text").unwrap();
        fs::write(temp.0.join("named-needle.txt"), "other").unwrap();
        fs::write(temp.0.join("unrelated.txt"), "no match").unwrap();

        let result = temp.workspace(&[]).search(".", "needle").unwrap();
        assert_eq!(result.paths, vec!["named-needle.txt", "src/one.txt"]);
        assert_eq!(result.scanned_entries, 4);
        assert!(!result.truncated);
        assert!(!serde_json::to_string(&result).unwrap().contains("Unique"));
        assert_eq!(
            temp.workspace(&[]).search(".", "").unwrap_err(),
            WorkspaceError::InvalidQuery
        );
    }

    #[test]
    fn caps_listing_and_search_work() {
        let temp = TempDir::new();
        for index in 0..MAX_LIST_ENTRIES + 2 {
            fs::write(temp.0.join(format!("entry-{index:03}")), "x").unwrap();
        }
        let workspace = temp.workspace(&[]);
        let listed = workspace.list(".").unwrap();
        assert_eq!(listed.entries.len(), MAX_LIST_ENTRIES);
        assert!(listed.truncated);
        let searched = workspace.search(".", "entry").unwrap();
        assert_eq!(searched.scanned_entries, MAX_SEARCH_ENTRIES);
        assert!(searched.truncated);
    }

    #[test]
    fn refuses_a_workspace_root_that_changes_after_selection() {
        let temp = TempDir::new();
        let moved = temp.0.with_extension("moved");
        let workspace = temp.workspace(&[]);
        fs::rename(&temp.0, &moved).unwrap();
        fs::create_dir(&temp.0).unwrap();
        assert_eq!(workspace.list("."), Err(WorkspaceError::Changed));
        fs::remove_dir_all(moved).unwrap();
    }
}
