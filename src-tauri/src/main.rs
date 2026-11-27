use tauri::{Manager, State, WebviewWindow};

mod a2a;
mod agent_task;
mod bridge;
mod chat;
mod external_mcp;
mod lifecycle;
mod model_runtime;
mod model_setup;
mod preferences;
mod research;
mod task_activity;
mod workspace;

#[tauri::command]
fn status() -> &'static str {
    concat!("AI-Worker ", env!("CARGO_PKG_VERSION"), ": ready")
}

#[tauri::command]
fn get_pending_write_approval(
    window: WebviewWindow,
    external_mcp: State<'_, external_mcp::ExternalMcp>,
) -> Result<Option<external_mcp::PendingWriteApproval>, String> {
    if !trusted_write_approval_window(&window) {
        return Err("Write approval is available only in the trusted review window.".into());
    }
    Ok(external_mcp.pending_write_approval())
}

#[tauri::command]
fn resolve_write_approval(
    window: WebviewWindow,
    external_mcp: State<'_, external_mcp::ExternalMcp>,
    task_id: String,
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    if !trusted_write_approval_window(&window) {
        return Err("Write approval is available only in the trusted review window.".into());
    }
    external_mcp.resolve_write_approval(&task_id, &approval_id, approved)?;
    window
        .close()
        .map_err(|_| "Could not close the write approval window.".to_owned())
}

fn trusted_write_approval_window(window: &WebviewWindow) -> bool {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let (scheme, host) = ("http", "tauri.localhost");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let (scheme, host) = ("tauri", "localhost");

    if window.label() != "write-approval" {
        return false;
    }
    let Ok(url) = window.url() else {
        return false;
    };
    url.scheme() == scheme
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
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
        .manage(external_mcp::ExternalMcp::default())
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
            lifecycle::setup(_app)?;
            _app.state::<external_mcp::ExternalMcp>()
                .start(_app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            lifecycle::on_window_event(window, event);
            if window.label() == "write-approval"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                let app = window.app_handle();
                app.state::<external_mcp::ExternalMcp>()
                    .dismiss_pending_write_approval();
            }
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
            chat::chat_local,
            model_setup::model_catalog,
            model_setup::model_import,
            model_setup::model_install,
            model_setup::model_cancel_import,
            model_setup::model_cancel_install,
            get_pending_write_approval,
            resolve_write_approval,
            task_activity::get_task_activity,
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
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = &event
            {
                if lifecycle::should_show_main_on_reopen(*has_visible_windows) {
                    lifecycle::show_main(app);
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                if let Err(error) = app
                    .state::<external_mcp::ExternalMcp>()
                    .shutdown(app, &app.state::<model_runtime::ModelRuntime>())
                {
                    eprintln!("[Local MCP] Shutdown failed: {error}");
                }
            }
        });
}
