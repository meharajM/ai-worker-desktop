#[tauri::command]
fn status() -> &'static str {
    concat!("AI-Worker ", env!("CARGO_PKG_VERSION"), ": ready")
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![status])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
