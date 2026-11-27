//! Local chat IPC for the trusted Tauri main window.
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::{
    bridge::{BridgeState, StatusRequest},
    model_runtime::ModelRuntime,
};

const MAX_PROMPT_LENGTH: usize = 8_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatReply {
    protocol_version: u8,
    owner_id: String,
    session_id: String,
    request_id: String,
    content: String,
    provider: &'static str,
    model: String,
}

#[tauri::command]
pub fn chat_local(
    request: StatusRequest,
    prompt: String,
    window: WebviewWindow,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
    runtime: State<'_, ModelRuntime>,
) -> Result<LocalChatReply, String> {
    bridge
        .authorize_model_request(&window, &request)
        .map_err(|_| "local chat request rejected".to_owned())?;
    validate_prompt(&prompt).map_err(str::to_owned)?;

    let inference = runtime.infer(&app, &prompt).map_err(str::to_owned)?;
    Ok(LocalChatReply {
        protocol_version: request.protocol_version,
        owner_id: request.owner_id,
        session_id: request.session_id,
        request_id: request.request_id,
        content: inference.content,
        provider: inference.provider,
        model: inference.model,
    })
}

fn validate_prompt(prompt: &str) -> Result<(), &'static str> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt for the local model.");
    }
    if prompt.encode_utf16().count() > MAX_PROMPT_LENGTH {
        return Err("Local prompt exceeds 8000 characters. Shorten it and retry.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_prompt;

    #[test]
    fn local_chat_prompt_is_nonempty_and_bounded_by_utf16_length() {
        assert_eq!(
            validate_prompt("  "),
            Err("Enter a prompt for the local model.")
        );
        assert!(validate_prompt(&"x".repeat(8_000)).is_ok());
        assert_eq!(
            validate_prompt(&"🧪".repeat(4_001)),
            Err("Local prompt exceeds 8000 characters. Shorten it and retry.")
        );
    }
}
