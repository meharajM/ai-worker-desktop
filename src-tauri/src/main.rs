use tauri::Manager;

mod bridge;
mod chat;
mod model_runtime;
mod model_setup;
mod preferences;

#[tauri::command]
fn status() -> &'static str {
    concat!("AI-Worker ", env!("CARGO_PKG_VERSION"), ": ready")
}

#[cfg(feature = "history-proof")]
mod history_proof;
#[cfg(feature = "proof")]
mod native_proof;

fn main() {
    #[cfg(feature = "history-proof")]
    let history_proof = history_proof::options();
    #[cfg(feature = "history-proof")]
    let mut context = tauri::generate_context!();
    #[cfg(not(feature = "history-proof"))]
    let context = tauri::generate_context!();
    #[cfg(feature = "history-proof")]
    if let Some(options) = &history_proof {
        history_proof::configure(&mut context, options);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(bridge::BridgeState::default())
        .manage(chat::ChatState::default())
        .manage(model_runtime::ModelRuntime::default())
        .manage(model_setup::ModelSetup::default())
        .manage(preferences::PreferenceState::default())
        .setup(move |_app| {
            #[cfg(feature = "proof")]
            _app.manage(native_proof::ProofState::default());
            #[cfg(feature = "history-proof")]
            if let Some(options) = history_proof.clone() {
                _app.manage(options.state());
                history_proof::setup(_app, options)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                // A later window may reuse this label; its session must start fresh.
                window
                    .app_handle()
                    .state::<bridge::BridgeState>()
                    .owner_destroyed(window.label());
                let stop_chat = window
                    .app_handle()
                    .state::<chat::ChatState>()
                    .owner_destroyed(window.label());
                if stop_chat {
                    window
                        .app_handle()
                        .state::<model_runtime::ModelRuntime>()
                        .stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            status,
            bridge::bridge_open_session,
            bridge::bridge_get_status,
            bridge::bridge_get_preferences,
            bridge::bridge_update_preferences,
            chat::local_chat_start,
            chat::local_chat_cancel,
            model_setup::model_catalog,
            model_setup::model_import,
            model_setup::model_cancel_import,
            #[cfg(feature = "proof")]
            native_proof::proof_stream,
            #[cfg(feature = "proof")]
            native_proof::proof_cancel,
            #[cfg(feature = "proof")]
            native_proof::proof_fixture_action,
            #[cfg(feature = "history-proof")]
            history_proof::history_proof_context,
            #[cfg(feature = "history-proof")]
            history_proof::history_proof_finish
        ])
        .build(context)
        .expect("failed to build Tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<model_runtime::ModelRuntime>().stop();
            }
        });
}
