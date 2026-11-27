use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

const ARCHIVE_FORMAT: &str = "ai-worker-memory-export";
const ARCHIVE_SCHEMA_VERSION: u32 = 1;
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTITIES: usize = 10_000;
const MAX_RELATIONS: usize = 100_000;
const MAX_OBSERVATIONS: usize = 1_000_000;
const MAX_SEARCH_BYTES: usize = 1_024;
const MAX_SEARCH_RESULTS: usize = 50;

#[derive(Debug)]
pub enum MemoryStoreError {
    InvalidArchive(String),
    MigrationConflict,
    Storage,
}

impl std::fmt::Display for MemoryStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidArchive(reason) => write!(formatter, "Invalid memory archive: {reason}"),
            Self::MigrationConflict => formatter
                .write_str("This memory archive ID was already imported with different contents."),
            Self::Storage => formatter.write_str("Local memory storage is unavailable."),
        }
    }
}

impl std::error::Error for MemoryStoreError {}

impl From<rusqlite::Error> for MemoryStoreError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

type Result<T> = std::result::Result<T, MemoryStoreError>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryArchive {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: String,
    pub migration_id: String,
    pub content_sha256: String,
    pub entities: Vec<MemoryEntity>,
    pub relations: Vec<MemoryRelation>,
    pub metadata: MemoryExportMetadata,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEntity {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    pub description: String,
    pub observations: Vec<String>,
    pub metadata: serde_json::Map<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryRelation {
    pub id: String,
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub relation_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub metadata: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryExportMetadata {
    pub exported_at: String,
    pub version: String,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportPreview {
    pub entities: usize,
    pub relations: usize,
    pub content_sha256: String,
    pub migration_id: String,
    pub already_imported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportResult {
    pub entities_imported: usize,
    pub relations_imported: usize,
    pub already_imported: bool,
    pub content_sha256: String,
    pub migration_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMemoryEntity {
    pub id: String,
    pub source_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    pub description: String,
    pub observations: Vec<String>,
    pub metadata: serde_json::Map<String, Value>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadRef<'a> {
    entities: &'a [MemoryEntity],
    relations: &'a [MemoryRelation],
}

pub struct MemoryStore {
    connection: Mutex<Connection>,
    fts5_enabled: bool,
}

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|_| MemoryStoreError::Storage)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| MemoryStoreError::Storage)?;
            }
        }
        let connection = Connection::open(path).map_err(MemoryStoreError::from)?;
        #[cfg(unix)]
        if path != Path::new(":memory:") {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| MemoryStoreError::Storage)?;
        }
        Self::from_connection(connection)
    }

    pub fn preview(&self, archive_json: &str) -> Result<MemoryImportPreview> {
        let archive = parse_archive(archive_json)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| MemoryStoreError::Storage)?;
        let import_key = migration_key(&archive);
        let already_imported = match imported_digest(&connection, &import_key)? {
            Some(digest) if digest == archive.content_sha256 => true,
            Some(_) => return Err(MemoryStoreError::MigrationConflict),
            None => false,
        };

        Ok(MemoryImportPreview {
            entities: archive.entities.len(),
            relations: archive.relations.len(),
            content_sha256: archive.content_sha256,
            migration_id: archive.migration_id,
            already_imported,
        })
    }

    pub fn import(&self, archive_json: &str) -> Result<MemoryImportResult> {
        let archive = parse_archive(archive_json)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| MemoryStoreError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryStoreError::from)?;
        let import_key = migration_key(&archive);

        if let Some(digest) = imported_digest(&transaction, &import_key)? {
            if digest != archive.content_sha256 {
                return Err(MemoryStoreError::MigrationConflict);
            }
            return Ok(import_result(&archive, true));
        }

        transaction
            .execute(
                "INSERT INTO memory_imports (migration_id, content_sha256, exported_at, imported_at, entity_count, relation_count) \
                 VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?4, ?5)",
                params![
                    import_key,
                    archive.content_sha256,
                    archive.exported_at,
                    archive.entities.len() as i64,
                    archive.relations.len() as i64,
                ],
            )
            .map_err(MemoryStoreError::from)?;

        for entity in &archive.entities {
            let observations = serde_json::to_string(&entity.observations)
                .map_err(|_| MemoryStoreError::Storage)?;
            let metadata =
                serde_json::to_string(&entity.metadata).map_err(|_| MemoryStoreError::Storage)?;
            transaction
                .execute(
                    "INSERT INTO memory_entities \
                     (id, source_id, migration_id, name, entity_type, description, observations_json, metadata_json, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                     ON CONFLICT(id) DO UPDATE SET \
                       source_id = excluded.source_id, migration_id = excluded.migration_id, \
                       name = excluded.name, entity_type = excluded.entity_type, description = excluded.description, \
                       observations_json = excluded.observations_json, metadata_json = excluded.metadata_json, \
                       created_at = excluded.created_at",
                    params![
                        imported_id(&archive.metadata.backend, &entity.id),
                        entity.id,
                        import_key,
                        entity.name,
                        entity.entity_type,
                        entity.description,
                        observations,
                        metadata,
                        entity.created_at,
                    ],
                )
                .map_err(MemoryStoreError::from)?;
        }

        for relation in &archive.relations {
            let metadata =
                serde_json::to_string(&relation.metadata).map_err(|_| MemoryStoreError::Storage)?;
            transaction
                .execute(
                    "INSERT INTO memory_relations \
                     (id, source_id, migration_id, from_entity_id, to_entity_id, relation_type, description, metadata_json) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                     ON CONFLICT(id) DO UPDATE SET \
                       source_id = excluded.source_id, migration_id = excluded.migration_id, \
                       from_entity_id = excluded.from_entity_id, to_entity_id = excluded.to_entity_id, \
                       relation_type = excluded.relation_type, description = excluded.description, metadata_json = excluded.metadata_json",
                    params![
                        imported_id(&archive.metadata.backend, &relation.id),
                        relation.id,
                        import_key,
                        imported_id(&archive.metadata.backend, &relation.from_entity_id),
                        imported_id(&archive.metadata.backend, &relation.to_entity_id),
                        relation.relation_type,
                        relation.description,
                        metadata,
                    ],
                )
                .map_err(MemoryStoreError::from)?;
        }

        transaction.commit().map_err(MemoryStoreError::from)?;
        Ok(import_result(&archive, false))
    }

    pub fn entity_search(&self, query: &str, limit: usize) -> Result<Vec<StoredMemoryEntity>> {
        if query.trim().is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        if query.len() > MAX_SEARCH_BYTES || query.contains('\0') {
            return Err(MemoryStoreError::InvalidArchive(
                "search query exceeds the supported limit".into(),
            ));
        }
        let limit = limit.min(MAX_SEARCH_RESULTS) as i64;
        let connection = self
            .connection
            .lock()
            .map_err(|_| MemoryStoreError::Storage)?;
        if self.fts5_enabled {
            let Some(fts_query) = fts_query(query) else {
                return Ok(Vec::new());
            };
            let mut statement = connection
                .prepare(
                    "SELECT e.id, e.source_id, e.name, e.entity_type, e.description, e.observations_json, e.metadata_json, e.created_at \
                     FROM memory_entities_fts \
                     JOIN memory_entities AS e ON e.rowid = memory_entities_fts.rowid \
                     WHERE memory_entities_fts MATCH ?1 ORDER BY rank LIMIT ?2",
                )
                .map_err(MemoryStoreError::from)?;
            let rows = statement
                .query_map(params![fts_query, limit], read_entity)
                .map_err(MemoryStoreError::from)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(MemoryStoreError::from)
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT id, source_id, name, entity_type, description, observations_json, metadata_json, created_at \
                     FROM memory_entities \
                     WHERE instr(lower(name), lower(?1)) > 0 \
                        OR instr(lower(entity_type), lower(?1)) > 0 \
                        OR instr(lower(description), lower(?1)) > 0 \
                        OR instr(lower(observations_json), lower(?1)) > 0 \
                     ORDER BY name LIMIT ?2",
                )
                .map_err(MemoryStoreError::from)?;
            let rows = statement
                .query_map(params![query.trim(), limit], read_entity)
                .map_err(MemoryStoreError::from)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(MemoryStoreError::from)
        }
    }

    pub fn uses_fts5(&self) -> bool {
        self.fts5_enabled
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        connection
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS memory_imports (
                  migration_id TEXT PRIMARY KEY NOT NULL,
                  content_sha256 TEXT NOT NULL,
                  exported_at TEXT NOT NULL,
                  imported_at TEXT NOT NULL,
                  entity_count INTEGER NOT NULL,
                  relation_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memory_entities (
                  id TEXT PRIMARY KEY NOT NULL,
                  source_id TEXT NOT NULL,
                  migration_id TEXT NOT NULL REFERENCES memory_imports(migration_id),
                  name TEXT NOT NULL,
                  entity_type TEXT NOT NULL,
                  description TEXT NOT NULL,
                  observations_json TEXT NOT NULL,
                  metadata_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_entities_migration_id ON memory_entities(migration_id);
                CREATE TABLE IF NOT EXISTS memory_relations (
                  id TEXT PRIMARY KEY NOT NULL,
                  source_id TEXT NOT NULL,
                  migration_id TEXT NOT NULL REFERENCES memory_imports(migration_id),
                  from_entity_id TEXT NOT NULL REFERENCES memory_entities(id),
                  to_entity_id TEXT NOT NULL REFERENCES memory_entities(id),
                  relation_type TEXT NOT NULL,
                  description TEXT,
                  metadata_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_relations_migration_id ON memory_relations(migration_id);
                CREATE INDEX IF NOT EXISTS memory_relations_from_id ON memory_relations(from_entity_id);
                CREATE INDEX IF NOT EXISTS memory_relations_to_id ON memory_relations(to_entity_id);
                "#,
            )
            .map_err(MemoryStoreError::from)?;

        let fts5_enabled = match connection.execute_batch(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_entities_fts USING fts5(
              name, entity_type, description, observations_json,
              content='memory_entities', content_rowid='rowid'
            );
            CREATE TRIGGER IF NOT EXISTS memory_entities_fts_ai AFTER INSERT ON memory_entities BEGIN
              INSERT INTO memory_entities_fts(rowid, name, entity_type, description, observations_json)
              VALUES (new.rowid, new.name, new.entity_type, new.description, new.observations_json);
            END;
            CREATE TRIGGER IF NOT EXISTS memory_entities_fts_ad AFTER DELETE ON memory_entities BEGIN
              INSERT INTO memory_entities_fts(memory_entities_fts, rowid, name, entity_type, description, observations_json)
              VALUES ('delete', old.rowid, old.name, old.entity_type, old.description, old.observations_json);
            END;
            CREATE TRIGGER IF NOT EXISTS memory_entities_fts_au AFTER UPDATE ON memory_entities BEGIN
              INSERT INTO memory_entities_fts(memory_entities_fts, rowid, name, entity_type, description, observations_json)
              VALUES ('delete', old.rowid, old.name, old.entity_type, old.description, old.observations_json);
              INSERT INTO memory_entities_fts(rowid, name, entity_type, description, observations_json)
              VALUES (new.rowid, new.name, new.entity_type, new.description, new.observations_json);
            END;
            "#,
        ) {
            Ok(()) => true,
            Err(error) if is_fts5_unavailable(&error) => false,
            Err(_) => return Err(MemoryStoreError::Storage),
        };

        Ok(Self {
            connection: Mutex::new(connection),
            fts5_enabled,
        })
    }
}

fn parse_archive(archive_json: &str) -> Result<MemoryArchive> {
    if archive_json.len() > MAX_ARCHIVE_BYTES {
        return Err(invalid("archive exceeds the 64 MiB limit"));
    }
    let archive: MemoryArchive = serde_json::from_str(archive_json)
        .map_err(|_| invalid("JSON shape is invalid or contains unsupported fields"))?;
    validate_archive(&archive)?;
    Ok(archive)
}

fn validate_archive(archive: &MemoryArchive) -> Result<()> {
    if archive.format != ARCHIVE_FORMAT || archive.schema_version != ARCHIVE_SCHEMA_VERSION {
        return Err(invalid("format or schema version is unsupported"));
    }
    if archive.exported_at.is_empty()
        || archive.exported_at.len() > 128
        || archive.metadata.exported_at != archive.exported_at
        || archive.metadata.version.is_empty()
        || !matches!(
            archive.metadata.backend.as_str(),
            "server-memory" | "memento-mcp"
        )
    {
        return Err(invalid("export metadata is invalid"));
    }
    if archive.entities.len() > MAX_ENTITIES {
        return Err(invalid("entity count exceeds the 10,000 limit"));
    }
    if archive.relations.len() > MAX_RELATIONS {
        return Err(invalid("relation count exceeds the 100,000 limit"));
    }

    let mut entity_ids = HashSet::with_capacity(archive.entities.len());
    let mut observation_count = 0usize;
    for entity in &archive.entities {
        if !valid_label(&entity.id, 4_096)
            || !valid_label(&entity.name, 4_096)
            || !valid_label(&entity.entity_type, 1_024)
            || entity.created_at.is_empty()
            || entity.created_at.len() > 128
        {
            return Err(invalid("entity fields are invalid"));
        }
        if !entity.metadata.is_empty() {
            return Err(invalid(
                "this server-memory archive contains unsupported entity metadata",
            ));
        }
        if !entity_ids.insert(entity.id.as_str()) {
            return Err(invalid("entity IDs are duplicated"));
        }
        observation_count = observation_count
            .checked_add(entity.observations.len())
            .ok_or_else(|| invalid("observation count overflowed"))?;
        if observation_count > MAX_OBSERVATIONS {
            return Err(invalid("observation count exceeds the 1,000,000 limit"));
        }
    }

    let mut relation_ids = HashSet::with_capacity(archive.relations.len());
    for relation in &archive.relations {
        if !valid_label(&relation.id, 8_192)
            || !valid_label(&relation.from_entity_id, 4_096)
            || !valid_label(&relation.to_entity_id, 4_096)
            || !valid_label(&relation.relation_type, 1_024)
            || relation
                .description
                .as_ref()
                .is_some_and(|value| value.len() > 16_384)
        {
            return Err(invalid("relation fields are invalid"));
        }
        if !relation.metadata.is_empty() {
            return Err(invalid(
                "this server-memory archive contains unsupported relation metadata",
            ));
        }
        if !relation_ids.insert(relation.id.as_str()) {
            return Err(invalid("relation IDs are duplicated"));
        }
        if !entity_ids.contains(relation.from_entity_id.as_str())
            || !entity_ids.contains(relation.to_entity_id.as_str())
        {
            return Err(invalid(
                "a relation references an entity that is not in this archive",
            ));
        }
    }

    let expected_digest = payload_digest(archive)?;
    if archive.content_sha256 != expected_digest
        || archive.migration_id != format!("sha256-{expected_digest}")
    {
        return Err(invalid(
            "content digest or migration ID does not match the archive",
        ));
    }
    Ok(())
}

fn payload_digest(archive: &MemoryArchive) -> Result<String> {
    let payload = serde_json::to_value(PayloadRef {
        entities: &archive.entities,
        relations: &archive.relations,
    })
    .map_err(|_| invalid("payload could not be normalized"))?;
    let mut canonical = String::new();
    write_canonical_json(&payload, &mut canonical)
        .map_err(|_| invalid("payload could not be normalized"))?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn write_canonical_json(
    value: &Value,
    output: &mut String,
) -> std::result::Result<(), serde_json::Error> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                write_canonical_json(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn imported_id(source_backend: &str, source_id: &str) -> String {
    format!("import:{source_backend}:{source_id}")
}

fn migration_key(archive: &MemoryArchive) -> String {
    format!("{}:{}", archive.metadata.backend, archive.migration_id)
}

fn imported_digest(connection: &Connection, migration_id: &str) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT content_sha256 FROM memory_imports WHERE migration_id = ?1",
            [migration_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(MemoryStoreError::from)
}

fn import_result(archive: &MemoryArchive, already_imported: bool) -> MemoryImportResult {
    MemoryImportResult {
        entities_imported: if already_imported {
            0
        } else {
            archive.entities.len()
        },
        relations_imported: if already_imported {
            0
        } else {
            archive.relations.len()
        },
        already_imported,
        content_sha256: archive.content_sha256.clone(),
        migration_id: archive.migration_id.clone(),
    }
}

fn read_entity(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMemoryEntity> {
    let observations_json: String = row.get(5)?;
    let metadata_json: String = row.get(6)?;
    Ok(StoredMemoryEntity {
        id: row.get(0)?,
        source_id: row.get(1)?,
        name: row.get(2)?,
        entity_type: row.get(3)?,
        description: row.get(4)?,
        observations: serde_json::from_str(&observations_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        metadata: serde_json::from_str(&metadata_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        created_at: row.get(7)?,
    })
}

fn fts_query(query: &str) -> Option<String> {
    let terms = query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

fn valid_label(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

fn invalid(reason: &str) -> MemoryStoreError {
    MemoryStoreError::InvalidArchive(reason.to_owned())
}

fn is_fts5_unavailable(error: &rusqlite::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("no such module") && message.contains("fts5")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    fn temporary_path() -> std::path::PathBuf {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!(
                "ai-worker-memory-store-{}-{id}",
                std::process::id()
            ))
            .join("graph.sqlite")
    }

    fn make_archive() -> String {
        let entities = vec![
            MemoryEntity {
                id: "alice".into(),
                name: "Alice".into(),
                entity_type: "person".into(),
                description: "Works on local-first AI.".into(),
                observations: vec!["Prefers private tools".into()],
                metadata: serde_json::Map::new(),
                created_at: "2026-11-27T10:00:00.000Z".into(),
            },
            MemoryEntity {
                id: "project-ai".into(),
                name: "AI Worker".into(),
                entity_type: "project".into(),
                description: "Desktop assistant project.".into(),
                observations: vec!["Runs on device".into()],
                metadata: serde_json::Map::new(),
                created_at: "2026-11-27T10:00:00.000Z".into(),
            },
        ];
        let relations = vec![MemoryRelation {
            id: "alice-works_on-project-ai".into(),
            from_entity_id: "alice".into(),
            to_entity_id: "project-ai".into(),
            relation_type: "works_on".into(),
            description: None,
            metadata: serde_json::Map::new(),
        }];
        let metadata = MemoryExportMetadata {
            exported_at: "2026-11-27T10:00:00.000Z".into(),
            version: "1.0.0".into(),
            backend: "server-memory".into(),
        };
        let draft = MemoryArchive {
            format: ARCHIVE_FORMAT.into(),
            schema_version: ARCHIVE_SCHEMA_VERSION,
            exported_at: metadata.exported_at.clone(),
            migration_id: String::new(),
            content_sha256: String::new(),
            entities,
            relations,
            metadata,
        };
        let digest = payload_digest(&draft).unwrap();
        serde_json::to_string(&MemoryArchive {
            migration_id: format!("sha256-{digest}"),
            content_sha256: digest,
            ..draft
        })
        .unwrap()
    }

    fn row_count(store: &MemoryStore, table: &str) -> i64 {
        let connection = store.connection.lock().unwrap();
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn imports_are_transactional_additive_and_restart_safe() {
        let path = temporary_path();
        let archive = make_archive();
        {
            let store = MemoryStore::open(&path).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                assert_eq!(
                    std::fs::metadata(path.parent().unwrap())
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
            }
            store
                .connection
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO memory_imports VALUES ('native', 'native-digest', 'today', 'today', 1, 0)",
                    [],
                )
                .unwrap();
            store
                .connection
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO memory_entities VALUES ('native:keep', 'keep', 'native', 'Keep me', 'note', 'existing local row', '[]', '{}', 'today')",
                    [],
                )
                .unwrap();

            let result = store.import(&archive).unwrap();
            assert_eq!(result.entities_imported, 2);
            assert_eq!(result.relations_imported, 1);
            assert!(!result.already_imported);
            assert_eq!(row_count(&store, "memory_entities"), 3);
            assert_eq!(row_count(&store, "memory_relations"), 1);
            let found = store.entity_search("local-first", 10).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].source_id, "alice");
            assert!(found[0].id.starts_with("import:server-memory:"));

            let mut updated: MemoryArchive = serde_json::from_str(&archive).unwrap();
            updated.entities[0].description = "Updated local-first AI memory.".into();
            let digest = payload_digest(&updated).unwrap();
            updated.content_sha256 = digest.clone();
            updated.migration_id = format!("sha256-{digest}");
            let updated = serde_json::to_string(&updated).unwrap();
            let update_result = store.import(&updated).unwrap();
            assert!(!update_result.already_imported);
            assert_eq!(
                row_count(&store, "memory_entities"),
                3,
                "later graph export updates imported IDs without duplicates"
            );
            assert_eq!(row_count(&store, "memory_relations"), 1);
            assert_eq!(
                store
                    .entity_search("Updated local-first", 10)
                    .unwrap()
                    .len(),
                1
            );
            assert!(store
                .entity_search("Works on local-first", 10)
                .unwrap()
                .is_empty());
        }

        let reopened = MemoryStore::open(&path).unwrap();
        let preview = reopened.preview(&archive).unwrap();
        assert!(preview.already_imported);
        let retry = reopened.import(&archive).unwrap();
        assert!(retry.already_imported);
        assert_eq!(retry.entities_imported, 0);
        assert_eq!(row_count(&reopened, "memory_entities"), 3);
        assert_eq!(row_count(&reopened, "memory_relations"), 1);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn failed_row_write_rolls_back_graph_and_receipt() {
        let store = MemoryStore::open(":memory:").unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_second_entity BEFORE INSERT ON memory_entities \
                 WHEN new.source_id = 'project-ai' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
            )
            .unwrap();

        assert!(store.import(&make_archive()).is_err());
        assert_eq!(row_count(&store, "memory_imports"), 0);
        assert_eq!(row_count(&store, "memory_entities"), 0);
        assert_eq!(row_count(&store, "memory_relations"), 0);
    }

    #[test]
    fn malformed_graph_and_digest_fail_before_writes() {
        let store = MemoryStore::open(":memory:").unwrap();
        let mut archive: MemoryArchive = serde_json::from_str(&make_archive()).unwrap();
        archive.relations[0].to_entity_id = "missing".into();
        let digest = payload_digest(&archive).unwrap();
        archive.content_sha256 = digest.clone();
        archive.migration_id = format!("sha256-{digest}");
        assert!(store
            .import(&serde_json::to_string(&archive).unwrap())
            .is_err());

        archive.relations[0].to_entity_id = "project-ai".into();
        assert!(store
            .import(&serde_json::to_string(&archive).unwrap())
            .is_err());
        assert_eq!(row_count(&store, "memory_imports"), 0);
    }

    #[test]
    fn archive_limits_and_strict_fields_are_enforced() {
        let store = MemoryStore::open(":memory:").unwrap();
        assert!(matches!(
            store.preview(&" ".repeat(MAX_ARCHIVE_BYTES + 1)),
            Err(MemoryStoreError::InvalidArchive(_))
        ));
        let mut json = make_archive();
        json.pop();
        json.push_str(",\"unexpected\":true}");
        assert!(matches!(
            store.import(&json),
            Err(MemoryStoreError::InvalidArchive(_))
        ));
    }

    #[test]
    fn search_uses_fts5_when_bundled_runtime_supports_it_and_has_a_safe_fallback() {
        let store = MemoryStore::open(":memory:").unwrap();
        store.import(&make_archive()).unwrap();
        let results = store.entity_search("local-first", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_id, "alice");
        assert!(store.entity_search("\" ) OR *", 10).is_ok());
        assert!(
            store
                .entity_search("local-first", usize::MAX)
                .unwrap()
                .len()
                <= MAX_SEARCH_RESULTS
        );
        assert!(store.uses_fts5(), "bundled SQLite should enable FTS5");
        assert!(store.entity_search("privacy tools", 10).unwrap().is_empty());
    }

    #[test]
    fn same_migration_id_with_different_stored_digest_conflicts() {
        let store = MemoryStore::open(":memory:").unwrap();
        let archive_json = make_archive();
        let archive: MemoryArchive = serde_json::from_str(&archive_json).unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO memory_imports VALUES (?1, 'different-digest', ?2, ?2, 0, 0)",
                params![migration_key(&archive), archive.exported_at],
            )
            .unwrap();
        assert!(matches!(
            store.import(&archive_json),
            Err(MemoryStoreError::MigrationConflict)
        ));
    }

    #[test]
    fn export_timestamp_does_not_create_a_new_graph_migration() {
        let store = MemoryStore::open(":memory:").unwrap();
        let original = make_archive();
        store.import(&original).unwrap();

        let mut reexport: MemoryArchive = serde_json::from_str(&original).unwrap();
        reexport.exported_at = "2026-11-28T10:00:00.000Z".into();
        reexport.metadata.exported_at = reexport.exported_at.clone();
        let reexport = serde_json::to_string(&reexport).unwrap();
        let preview = store.preview(&reexport).unwrap();
        assert!(preview.already_imported);
        assert_eq!(row_count(&store, "memory_entities"), 2);
    }

    #[test]
    fn identical_graphs_from_different_backends_keep_separate_receipts_and_rows() {
        let store = MemoryStore::open(":memory:").unwrap();
        let server_memory = make_archive();
        store.import(&server_memory).unwrap();

        let mut memento: MemoryArchive = serde_json::from_str(&server_memory).unwrap();
        memento.metadata.backend = "memento-mcp".into();
        let memento = serde_json::to_string(&memento).unwrap();
        let preview = store.preview(&memento).unwrap();
        assert!(!preview.already_imported);

        let imported = store.import(&memento).unwrap();
        assert!(!imported.already_imported);
        assert_eq!(imported.migration_id, preview.migration_id);
        assert_eq!(row_count(&store, "memory_imports"), 2);
        assert_eq!(row_count(&store, "memory_entities"), 4);
        assert!(store
            .entity_search("local-first", 10)
            .unwrap()
            .iter()
            .any(|entity| entity.id.starts_with("import:memento-mcp:")));
        assert!(store.preview(&memento).unwrap().already_imported);
    }

    #[test]
    fn accepts_archive_bytes_from_the_frontend_export_fixture() {
        const ARCHIVE: &str =
            include_str!("../../tests/fixtures/memory_archive_server_memory.json");
        let store = MemoryStore::open(":memory:").unwrap();
        let preview = store.preview(ARCHIVE).unwrap();
        assert_eq!(preview.entities, 2);
        assert_eq!(preview.relations, 1);
        let result = store.import(ARCHIVE).unwrap();
        assert_eq!(result.entities_imported, 2);
        assert_eq!(result.relations_imported, 1);
    }
}
