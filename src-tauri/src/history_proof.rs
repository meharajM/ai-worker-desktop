//! Private M06b persistence and cleanup runner; excluded from default builds.

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, State};

#[derive(Clone, Debug)]
pub struct Options {
    phase: Phase,
    store_id: [u8; 16],
    store_hex: String,
    output_dir: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Seed,
    Verify,
    Cleanup,
}

#[derive(Clone)]
pub struct HistoryProofState {
    phase: Phase,
    store_id: [u8; 16],
    store_hex: String,
    output_dir: PathBuf,
}

impl Options {
    pub fn state(&self) -> HistoryProofState {
        HistoryProofState {
            phase: self.phase,
            store_id: self.store_id,
            store_hex: self.store_hex.clone(),
            output_dir: self.output_dir.clone(),
        }
    }
}

pub fn options() -> Option<Options> {
    let args: Vec<String> = std::env::args().collect();
    let value = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].clone())
    };
    let phase = value("--m06b-phase")?;
    let store_hex = value("--m06b-store")?;
    let output_dir = value("--m06b-output")?;
    assert_eq!(
        store_hex.len(),
        32,
        "M06b store UUID must be 32 hex characters"
    );
    let mut store_id = [0u8; 16];
    for (index, pair) in store_hex.as_bytes().chunks_exact(2).enumerate() {
        let byte = std::str::from_utf8(pair).unwrap();
        store_id[index] =
            u8::from_str_radix(byte, 16).expect("M06b store UUID must be hexadecimal");
    }
    let phase = match phase.as_str() {
        "seed" => Phase::Seed,
        "verify" => Phase::Verify,
        "cleanup" => Phase::Cleanup,
        _ => panic!("unknown M06b phase"),
    };
    Some(Options {
        phase,
        store_id,
        store_hex: store_hex.to_ascii_lowercase(),
        output_dir: output_dir.into(),
    })
}

pub fn configure(context: &mut tauri::Context<tauri::Wry>, options: &Options) {
    let window = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
        .expect("M06b proof config must define main window");
    window.create = false;
    window.data_store_identifier = None;
    if options.phase == Phase::Cleanup {
        window.url = tauri::WebviewUrl::App("m06b-blank.html".into());
        window.visible = false;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserContext {
    phase: String,
    store_id: String,
    store_present: bool,
}

#[tauri::command]
pub async fn history_proof_context(
    app: AppHandle,
    state: State<'_, HistoryProofState>,
) -> Result<BrowserContext, String> {
    let phase = match state.phase {
        Phase::Seed => "seed".to_owned(),
        Phase::Verify => "verify".to_owned(),
        Phase::Cleanup => return Err("wrong_phase".into()),
    };
    let identifiers = app
        .fetch_data_store_identifiers()
        .await
        .map_err(|_| "store_identifier_query_failed")?;
    Ok(BrowserContext {
        phase,
        store_id: state.store_hex.clone(),
        store_present: identifiers.contains(&state.store_id),
    })
}

#[tauri::command]
pub fn history_proof_finish(
    app: AppHandle,
    state: State<'_, HistoryProofState>,
    result: String,
) -> Result<(), String> {
    if state.phase == Phase::Cleanup {
        return Err("wrong_phase".into());
    }
    let value: Value = serde_json::from_str(&result).map_err(|_| "invalid_result")?;
    write_result(&state, phase_name(state.phase), &value)?;
    app.exit(if value.get("ok").and_then(Value::as_bool) == Some(true) {
        0
    } else {
        1
    });
    Ok(())
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Seed => "seed",
        Phase::Verify => "verify",
        Phase::Cleanup => "cleanup",
    }
}

fn write_result(state: &HistoryProofState, name: &str, value: &Value) -> Result<(), String> {
    let path = state.output_dir.join(format!("{name}.json"));
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "serialize_result")?;
    fs::write(path, bytes).map_err(|_| "write_result".to_owned())
}

pub fn setup(
    app: &mut tauri::App<tauri::Wry>,
    options: Options,
) -> Result<(), Box<dyn std::error::Error>> {
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("M06b proof config must define main window");
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, window_config)?;
    if options.phase != Phase::Cleanup {
        // WindowConfig conversion in the pinned Tauri version omits this
        // field, so set the public builder attribute explicitly.
        builder = builder.data_store_identifier(options.store_id);
    }
    builder.build()?;

    if options.phase == Phase::Cleanup {
        let handle = app.handle().clone();
        let state = options.state();
        tauri::async_runtime::spawn(async move {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let result = cleanup_store(&handle, state.store_id).await;
            let output = match result {
                Ok(()) => {
                    serde_json::json!({"ok": true, "phase": "cleanup", "removedStoreId": state.store_hex, "presentAfter": false})
                }
                Err(error) => {
                    serde_json::json!({"ok": false, "phase": "cleanup", "removedStoreId": state.store_hex, "error": error.to_string()})
                }
            };
            let succeeded = output.get("ok").and_then(Value::as_bool) == Some(true);
            if let Err(error) = write_result(&state, "cleanup", &output) {
                eprintln!("M06b cleanup evidence failed: {error}");
                handle.exit(1);
            } else {
                handle.exit(if succeeded { 0 } else { 1 });
            }
        });
    }
    Ok(())
}

#[cfg(target_vendor = "apple")]
async fn cleanup_store(app: &AppHandle, store_id: [u8; 16]) -> Result<(), tauri::Error> {
    let ids = app.fetch_data_store_identifiers().await?;
    if !ids.contains(&store_id) {
        return Err(tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "owned data store absent before cleanup",
        )));
    }
    app.remove_data_store(store_id).await?;
    let ids = app.fetch_data_store_identifiers().await?;
    if ids.contains(&store_id) {
        return Err(tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "owned data store remained after cleanup",
        )));
    }
    Ok(())
}

#[cfg(not(target_vendor = "apple"))]
async fn cleanup_store(_: &AppHandle, _: [u8; 16]) -> Result<(), tauri::Error> {
    Err(tauri::Error::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "M06b cleanup proof requires Apple WebKit",
    )))
}
