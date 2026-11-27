use tauri::{
    utils::config::CapabilityEntry, AppHandle, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::external_mcp::{ActivityTask, ExternalMcp};

const WINDOW: &str = "task-activity";

pub(crate) fn is_enabled(app: &AppHandle) -> bool {
    let capabilities = &app.config().app.security.capabilities;
    capabilities.is_empty()
        || capabilities.iter().any(|entry| match entry {
            CapabilityEntry::Reference(id) => id == WINDOW,
            CapabilityEntry::Inlined(capability) => capability.identifier == WINDOW,
        })
}

#[tauri::command]
pub(crate) fn get_task_activity(
    window: WebviewWindow,
    external_mcp: State<'_, ExternalMcp>,
) -> Result<Vec<ActivityTask>, String> {
    if window.label() != WINDOW {
        return Err("Task activity is available only in the activity window.".into());
    }
    Ok(external_mcp.task_activity())
}

pub(crate) fn show(app: &AppHandle, focus: bool) {
    if !is_enabled(app) {
        return;
    }
    let main_thread_app = app.clone();
    let queued = app.run_on_main_thread(move || {
        let result = if let Some(window) = main_thread_app.get_webview_window(WINDOW) {
            window
                .unminimize()
                .and_then(|()| window.show())
                .and_then(|()| if focus { window.set_focus() } else { Ok(()) })
        } else {
            WebviewWindowBuilder::new(
                &main_thread_app,
                WINDOW,
                WebviewUrl::App("index.html?surface=task-activity".into()),
            )
            .title("Task activity · AI-Worker")
            .inner_size(420.0, 390.0)
            .min_inner_size(340.0, 280.0)
            .center()
            .focused(focus)
            .build()
            .map(|_| ())
        };
        if let Err(error) = result {
            eprintln!("[Task activity] Could not show window: {error}");
        }
    });
    if let Err(error) = queued {
        eprintln!("[Task activity] Could not schedule window: {error}");
    }
}
