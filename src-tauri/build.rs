fn main() {
    let commands: &[&str] = if std::env::var_os("CARGO_FEATURE_PROOF").is_some() {
        &[
            "status",
            "proof_stream",
            "proof_cancel",
            "proof_fixture_action",
        ]
    } else {
        &["status"]
    };
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&commands)),
    )
    .expect("failed to build Tauri app manifest");
}
