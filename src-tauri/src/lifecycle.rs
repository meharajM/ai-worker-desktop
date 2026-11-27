use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, WebviewWindowBuilder, Window, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const SHOW: &str = "tray-show-main";
const ACTIVITY: &str = "tray-task-activity";
const QUIT: &str = "tray-quit";
pub(crate) const WORKER_IDLE_EXIT_AFTER: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct MainWindowCreateState(Arc<AtomicBool>);

#[derive(Clone, Copy)]
pub(crate) struct WorkerServiceMode(pub(crate) bool);

pub(crate) fn is_worker_service<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<WorkerServiceMode>().0
}

pub(crate) fn should_prevent_worker_exit(
    worker_service_mode: bool,
    has_active_work: bool,
    exit_code: Option<i32>,
) -> bool {
    worker_service_mode && has_active_work && exit_code.is_none()
}

pub(crate) fn should_exit_worker_service(
    worker_service_mode: bool,
    main_window_exists: bool,
    has_active_work: bool,
    idle_for: Duration,
) -> bool {
    worker_service_mode
        && !main_window_exists
        && !has_active_work
        && idle_for >= WORKER_IDLE_EXIT_AFTER
}

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("AI-Worker requires a bundled tray icon"))?;
    let show = MenuItemBuilder::with_id(SHOW, "Show AI-Worker").build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "Quit AI-Worker").build(app)?;
    let mut menu = MenuBuilder::new(app).item(&show);
    if crate::task_activity::is_enabled(app.handle()) {
        menu = menu.text(ACTIVITY, "Task activity");
    }
    let menu = menu.item(&quit).build()?;

    TrayIconBuilder::new()
        .icon(icon.clone())
        .tooltip("AI-Worker")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW => show_main(app),
            ACTIVITY => crate::task_activity::show(app, true),
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if is_show_click(&event) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() == MAIN_WINDOW {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("[Lifecycle] Failed to hide AI-Worker: {error}");
            }
        }
    }
}

pub(crate) fn show_main<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let result = window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus());
        if let Err(error) = result {
            eprintln!("[Lifecycle] Failed to show AI-Worker: {error}");
        }
        return;
    }

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
    else {
        eprintln!("[Lifecycle] Main window configuration is unavailable.");
        return;
    };
    let creating = Arc::clone(&app.state::<MainWindowCreateState>().0);
    if creating
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = WebviewWindowBuilder::from_config(&app, &config)
            .and_then(|builder| builder.build().map(|_| ()))
        {
            creating.store(false, Ordering::Release);
            eprintln!("[Lifecycle] Failed to create AI-Worker: {error}");
        }
    });
}

pub(crate) fn should_show_main_on_reopen(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

fn is_show_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_window_on_left_button_release_only() {
        let click = |button, button_state| TrayIconEvent::Click {
            id: "test-tray".into(),
            position: (0.0, 0.0).into(),
            rect: Default::default(),
            button,
            button_state,
        };

        assert!(is_show_click(&click(
            MouseButton::Left,
            MouseButtonState::Up
        )));
        assert!(!is_show_click(&click(
            MouseButton::Left,
            MouseButtonState::Down
        )));
        assert!(!is_show_click(&click(
            MouseButton::Right,
            MouseButtonState::Up
        )));
        assert!(!is_show_click(&click(
            MouseButton::Middle,
            MouseButtonState::Up
        )));
    }

    #[test]
    fn reopens_main_window_only_when_no_window_is_visible() {
        assert!(should_show_main_on_reopen(false));
        assert!(!should_show_main_on_reopen(true));
    }

    #[test]
    fn only_keeps_the_headless_worker_alive_while_a_host_or_task_is_active() {
        assert!(should_prevent_worker_exit(true, true, None));
        assert!(!should_prevent_worker_exit(true, false, None));
        assert!(!should_prevent_worker_exit(false, true, None));
        assert!(!should_prevent_worker_exit(false, false, None));
        assert!(!should_prevent_worker_exit(true, true, Some(0)));
    }

    #[test]
    fn headless_worker_sleeps_only_after_idle_without_a_full_app_window() {
        assert!(!should_exit_worker_service(
            true,
            false,
            false,
            WORKER_IDLE_EXIT_AFTER - Duration::from_secs(1)
        ));
        assert!(should_exit_worker_service(
            true,
            false,
            false,
            WORKER_IDLE_EXIT_AFTER
        ));
        assert!(!should_exit_worker_service(
            true,
            false,
            true,
            WORKER_IDLE_EXIT_AFTER
        ));
        assert!(!should_exit_worker_service(
            true,
            true,
            false,
            WORKER_IDLE_EXIT_AFTER
        ));
        assert!(!should_exit_worker_service(
            false,
            false,
            false,
            WORKER_IDLE_EXIT_AFTER
        ));
    }
}
