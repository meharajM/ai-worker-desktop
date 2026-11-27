use std::{
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
};

use tauri::{
    utils::config::CapabilityEntry, AppHandle, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::external_mcp::{ActivitySnapshot, ExternalMcp};

const WINDOW: &str = "task-activity";
const IDLE_CLOSE_AFTER: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct ActivityWindowState {
    generation: AtomicU64,
}

impl ActivityWindowState {
    fn mark_shown(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Acquire) == generation
    }
}

pub(crate) fn is_enabled<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
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
) -> Result<ActivitySnapshot, String> {
    if window.label() != WINDOW {
        return Err("Task activity is available only in the activity window.".into());
    }
    Ok(external_mcp.task_activity())
}

pub(crate) fn show<R: tauri::Runtime>(app: &AppHandle<R>, focus: bool) {
    app.state::<ActivityWindowState>().mark_shown();
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

pub(crate) fn close_after_idle<R: tauri::Runtime>(
    app: &AppHandle<R>,
    is_idle: impl Fn() -> bool + Send + 'static,
) {
    let generation = app
        .state::<ActivityWindowState>()
        .generation
        .load(Ordering::Acquire);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(IDLE_CLOSE_AFTER);
        if !is_idle() {
            return;
        }
        let main_thread_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let state = main_thread_app.state::<ActivityWindowState>();
            if state.is_current(generation) && is_idle() {
                if let Some(window) = main_thread_app.get_webview_window(WINDOW) {
                    if let Err(error) = window.close() {
                        eprintln!("[Task activity] Could not close idle window: {error}");
                    }
                }
            }
        }) {
            eprintln!("[Task activity] Could not schedule idle close: {error}");
        }
    });
}
