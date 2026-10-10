#[cfg(feature = "proof")]
use tauri::Manager;

#[tauri::command]
fn status() -> &'static str {
    concat!("AI-Worker ", env!("CARGO_PKG_VERSION"), ": ready")
}

#[cfg(feature = "proof")]
mod native_proof;

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(feature = "proof")]
            _app.manage(native_proof::ProofState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
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
