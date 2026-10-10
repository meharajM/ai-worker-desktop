fn main() {
    const BASE: &[&str] = &[
        "status",
        "bridge_open_session",
        "bridge_get_status",
        "bridge_get_preferences",
        "bridge_update_preferences",
    ];
    const WITH_PROOF: &[&str] = &[
        "status",
        "bridge_open_session",
        "bridge_get_status",
        "bridge_get_preferences",
        "bridge_update_preferences",
        "proof_stream",
        "proof_cancel",
        "proof_fixture_action",
    ];
    const WITH_HISTORY: &[&str] = &[
        "status",
        "bridge_open_session",
        "bridge_get_status",
        "bridge_get_preferences",
        "bridge_update_preferences",
        "history_proof_context",
        "history_proof_finish",
    ];
    const ALL: &[&str] = &[
        "status",
        "bridge_open_session",
        "bridge_get_status",
        "bridge_get_preferences",
        "bridge_update_preferences",
        "proof_stream",
        "proof_cancel",
        "proof_fixture_action",
        "history_proof_context",
        "history_proof_finish",
    ];
    let proof = std::env::var_os("CARGO_FEATURE_PROOF").is_some();
    let history = std::env::var_os("CARGO_FEATURE_HISTORY_PROOF").is_some();
    let commands = match (proof, history) {
        (true, true) => ALL,
        (true, false) => WITH_PROOF,
        (false, true) => WITH_HISTORY,
        (false, false) => BASE,
    };
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&commands)),
    )
    .expect("failed to build Tauri app manifest");
}
