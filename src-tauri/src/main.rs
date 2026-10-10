use tauri::Manager;

mod bridge;
mod preferences;

#[tauri::command]
fn status() -> &'static str {
    concat!("AI-Worker ", env!("CARGO_PKG_VERSION"), ": ready")
}

#[cfg(feature = "proof")]
mod native_proof;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(bridge::BridgeState::default())
        .manage(preferences::PreferenceState::default())
        .setup(|_app| {
            #[cfg(feature = "proof")]
            _app.manage(native_proof::ProofState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                // A later window may reuse this label; its session must start fresh.
                window
                    .app_handle()
                    .state::<bridge::BridgeState>()
                    .owner_destroyed(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            status,
            bridge::bridge_open_session,
            bridge::bridge_get_status,
            bridge::bridge_get_preferences,
            bridge::bridge_update_preferences,
            #[cfg(feature = "proof")]
            native_proof::proof_stream,
            #[cfg(feature = "proof")]
            native_proof::proof_cancel,
            #[cfg(feature = "proof")]
            native_proof::proof_fixture_action
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
