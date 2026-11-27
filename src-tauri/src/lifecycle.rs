use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Window, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const SHOW: &str = "tray-show-main";
const QUIT: &str = "tray-quit";

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("AI-Worker requires a bundled tray icon"))?;
    let show = MenuItemBuilder::with_id(SHOW, "Show AI-Worker").build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "Quit AI-Worker").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    TrayIconBuilder::new()
        .icon(icon.clone())
        .tooltip("AI-Worker")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW => show_main(app),
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

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let result = window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus());
        if let Err(error) = result {
            eprintln!("[Lifecycle] Failed to show AI-Worker: {error}");
        }
    }
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
}
