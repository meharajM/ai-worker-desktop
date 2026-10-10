use std::{
    fs::{self, OpenOptions},
    io::Read,
    path::PathBuf,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::{Store, StoreBuilder};

const STORE_FILE: &str = "preferences.json";
const STORE_KEY: &str = "preferences";
const MAX_STORE_BYTES: u64 = 4 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourcePreset {
    LowImpact,
    Balanced,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdlePolicy {
    TaskEnd,
    ShortIdle,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub schema_version: u8,
    pub selected_profile_id: Option<String>,
    pub resource_preset: ResourcePreset,
    pub idle_policy: IdlePolicy,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            selected_profile_id: None,
            resource_preset: ResourcePreset::LowImpact,
            idle_policy: IdlePolicy::TaskEnd,
        }
    }
}

impl Preferences {
    pub fn validate(&self) -> Result<(), PreferenceError> {
        if self.schema_version != 1
            || self.selected_profile_id.is_some()
            || !matches!(
                (self.resource_preset, self.idle_policy),
                (ResourcePreset::LowImpact, IdlePolicy::TaskEnd)
                    | (ResourcePreset::Balanced, IdlePolicy::ShortIdle)
            )
        {
            return Err(PreferenceError);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PreferenceError;

#[derive(Default)]
pub struct PreferenceState(pub Mutex<()>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginFile {
    preferences: Preferences,
}

fn file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, PreferenceError> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STORE_FILE))
        .map_err(|_| PreferenceError)
}

fn preflight(path: &PathBuf) -> Result<Option<Preferences>, PreferenceError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(PreferenceError),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PreferenceError);
    }

    let mut bytes = Vec::with_capacity((MAX_STORE_BYTES + 1) as usize);
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| PreferenceError)?
        .take(MAX_STORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PreferenceError)?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(PreferenceError);
    }

    let PluginFile { preferences } = serde_json::from_slice(&bytes).map_err(|_| PreferenceError)?;
    preferences.validate()?;
    Ok(Some(preferences))
}

fn close_after<R: Runtime, T>(
    store: &Store<R>,
    result: Result<T, PreferenceError>,
) -> Result<T, PreferenceError> {
    store.close_resource();
    result
}

pub fn get<R: Runtime>(app: &AppHandle<R>) -> Result<Preferences, PreferenceError> {
    let path = file_path(app)?;
    let Some(expected) = preflight(&path)? else {
        return Ok(Preferences::default());
    };
    let store = StoreBuilder::new(app, STORE_FILE)
        .disable_auto_save()
        .build()
        .map_err(|_| PreferenceError)?;
    let result = store
        .get(STORE_KEY)
        .ok_or(PreferenceError)
        .and_then(|value| serde_json::from_value::<Preferences>(value).map_err(|_| PreferenceError))
        .and_then(|preferences| {
            preferences.validate()?;
            if preferences != expected {
                return Err(PreferenceError);
            }
            Ok(preferences)
        });
    close_after(&store, result)
}

pub fn update<R: Runtime>(
    app: &AppHandle<R>,
    preferences: &Preferences,
) -> Result<(), PreferenceError> {
    preferences.validate()?;
    let path = file_path(app)?;
    preflight(&path)?;
    let store = StoreBuilder::new(app, STORE_FILE)
        .disable_auto_save()
        .build()
        .map_err(|_| PreferenceError)?;
    let result = serde_json::to_value(preferences)
        .map_err(|_| PreferenceError)
        .and_then(|value| {
            store.set(STORE_KEY, value);
            store.save().map_err(|_| PreferenceError)
        });
    close_after(&store, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{
        test::{mock_builder, mock_context, noop_assets},
        Manager,
    };
    use tauri_plugin_store::StoreExt;

    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn app() -> (tauri::App<tauri::test::MockRuntime>, TestDirectory) {
        let directory = TestDirectory(std::env::temp_dir().join(format!(
            "ai-worker-preferences-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        )));
        fs::create_dir(&directory.0).unwrap();
        let mut context = mock_context(noop_assets());
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(directory.0.clone()),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(context)
            .unwrap();
        (app, directory)
    }

    fn store_path(app: &tauri::App<tauri::test::MockRuntime>) -> PathBuf {
        app.path().app_data_dir().unwrap().join(STORE_FILE)
    }

    #[test]
    fn missing_preferences_read_returns_defaults_without_registering_or_writing_store() {
        let (app, _directory) = app();
        let path = store_path(&app);

        assert!(!path.exists());
        assert_eq!(get(app.handle()).unwrap(), Preferences::default());
        assert!(
            !path.exists(),
            "a read must not create the preferences file"
        );
        assert!(app.handle().get_store(STORE_FILE).is_none());
    }

    #[test]
    fn official_store_defaults_reload_and_reject_bad_source_without_rewrite() {
        let (app, _directory) = app();
        assert_eq!(get(app.handle()).unwrap(), Preferences::default());
        assert!(app.handle().get_store(STORE_FILE).is_none());
        assert!(!store_path(&app).exists());

        let balanced = Preferences {
            resource_preset: ResourcePreset::Balanced,
            idle_policy: IdlePolicy::ShortIdle,
            ..Preferences::default()
        };
        update(app.handle(), &Preferences::default()).unwrap();
        assert!(app.handle().get_store(STORE_FILE).is_none());
        assert_eq!(get(app.handle()).unwrap(), Preferences::default());
        assert!(app.handle().get_store(STORE_FILE).is_none());
        update(app.handle(), &balanced).unwrap();
        assert!(app.handle().get_store(STORE_FILE).is_none());
        assert_eq!(get(app.handle()).unwrap(), balanced);
        assert!(app.handle().get_store(STORE_FILE).is_none());
        let bytes = fs::read(store_path(&app)).unwrap();
        assert!(bytes.len() <= MAX_STORE_BYTES as usize);
        let mut invalid = balanced.clone();
        invalid.selected_profile_id = Some("unverified".into());
        assert!(update(app.handle(), &invalid).is_err());
        assert!(app.handle().get_store(STORE_FILE).is_none());
        assert_eq!(fs::read(store_path(&app)).unwrap(), bytes);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = store_path(&app);
            let original = fs::metadata(&path).unwrap().permissions();
            let mut unreadable = original.clone();
            unreadable.set_mode(0);
            fs::set_permissions(&path, unreadable).unwrap();
            assert!(get(app.handle()).is_err());
            assert!(app.handle().get_store(STORE_FILE).is_none());
            fs::set_permissions(&path, original).unwrap();

            let original = fs::metadata(&path).unwrap().permissions();
            let mut unwritable = original.clone();
            unwritable.set_mode(0o444);
            fs::set_permissions(&path, unwritable).unwrap();
            assert!(update(app.handle(), &Preferences::default()).is_err());
            assert!(app.handle().get_store(STORE_FILE).is_none());
            fs::set_permissions(&path, original).unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(get(app.handle()).unwrap(), balanced);
            assert!(app.handle().get_store(STORE_FILE).is_none());
        }

        for source in [
            br#"{"preferences":{"schemaVersion":0,"selectedProfileId":null,"resourcePreset":"lowImpact","idlePolicy":"taskEnd"}}"#.as_slice(),
            br#"{"preferences":{"schemaVersion":1,"selectedProfileId":"profile-x","resourcePreset":"lowImpact","idlePolicy":"taskEnd"}}"#.as_slice(),
            br#"{"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"balanced","idlePolicy":"taskEnd"}}"#.as_slice(),
            br#"{"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"unknown","idlePolicy":"taskEnd"}}"#.as_slice(),
            br#"{"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"lowImpact","idlePolicy":"taskEnd","path":"/tmp"}}"#.as_slice(),
            br#"{"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"lowImpact","idlePolicy":"taskEnd"},"extra":true}"#.as_slice(),
            br#"{"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"lowImpact","idlePolicy":"taskEnd"},"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"lowImpact","idlePolicy":"taskEnd"}}"#.as_slice(),
            b"{ malformed",
        ] {
            fs::write(store_path(&app), source).unwrap();
            assert!(get(app.handle()).is_err());
            assert!(app.handle().get_store(STORE_FILE).is_none());
            assert!(update(app.handle(), &Preferences::default()).is_err());
            assert!(app.handle().get_store(STORE_FILE).is_none());
            assert_eq!(fs::read(store_path(&app)).unwrap(), source);
        }

        let too_large = vec![b' '; MAX_STORE_BYTES as usize + 1];
        fs::write(store_path(&app), &too_large).unwrap();
        assert!(get(app.handle()).is_err());
        assert!(app.handle().get_store(STORE_FILE).is_none());
        assert!(update(app.handle(), &Preferences::default()).is_err());
        assert!(app.handle().get_store(STORE_FILE).is_none());
        assert_eq!(fs::read(store_path(&app)).unwrap(), too_large);

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let path = store_path(&app);
            fs::remove_file(&path).unwrap();
            let source = _directory.0.join("source.json");
            fs::write(&source, b"source bytes").unwrap();
            symlink(&source, &path).unwrap();
            assert!(get(app.handle()).is_err());
            assert!(app.handle().get_store(STORE_FILE).is_none());
            assert!(update(app.handle(), &Preferences::default()).is_err());
            assert!(app.handle().get_store(STORE_FILE).is_none());
            assert_eq!(fs::read(source).unwrap(), b"source bytes");
        }
    }
}
