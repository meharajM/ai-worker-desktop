//! Small protocol-v1 identity boundary for the local main WebView.
use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Url, WebviewWindow};

use crate::preferences::{self, PreferenceState, Preferences};

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: usize = 256;
const MAX_REQUEST_ID_BYTES: usize = 64;
const MAX_SESSION_ID_BYTES: usize = 64;

#[cfg(any(target_os = "windows", target_os = "android"))]
const APP_SCHEME: &str = "http";
#[cfg(any(target_os = "windows", target_os = "android"))]
const APP_HOST: &str = "tauri.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
const APP_SCHEME: &str = "tauri";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
const APP_HOST: &str = "localhost";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeErrorCode {
    InvalidRequest,
    Unauthorized,
    StaleSession,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: &'static str,
}

impl BridgeError {
    fn invalid() -> Self {
        Self {
            code: BridgeErrorCode::InvalidRequest,
            message: "Invalid bridge request.",
        }
    }

    fn unauthorized() -> Self {
        Self {
            code: BridgeErrorCode::Unauthorized,
            message: "Bridge caller is not authorized.",
        }
    }

    fn stale_session() -> Self {
        Self {
            code: BridgeErrorCode::StaleSession,
            message: "Bridge session is no longer active.",
        }
    }

    fn internal() -> Self {
        Self {
            code: BridgeErrorCode::Internal,
            message: "Native bridge is unavailable.",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenSessionRequest {
    pub protocol_version: u8,
    pub owner_id: String,
    pub request_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusRequest {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetPreferencesRequest {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePreferencesRequest {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
    pub preferences: Preferences,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionReply {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
    pub app_version: &'static str,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesReply {
    pub protocol_version: u8,
    pub owner_id: String,
    pub session_id: String,
    pub request_id: String,
    pub preferences: Preferences,
}

#[derive(Default)]
pub struct BridgeState {
    inner: Mutex<BridgeSessions>,
}

#[derive(Default)]
struct BridgeSessions {
    next_session: u64,
    by_owner: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Caller {
    owner_id: String,
    url: Url,
}

impl Caller {
    fn from_window(window: &WebviewWindow) -> Result<Self, BridgeError> {
        let url = window.url().map_err(|_| BridgeError::unauthorized())?;
        Ok(Self {
            owner_id: window.label().to_owned(),
            url,
        })
    }
}

fn trusted_caller(caller: &Caller, claimed_owner: &str) -> Result<(), BridgeError> {
    let url = &caller.url;
    if caller.owner_id != "main"
        || claimed_owner != caller.owner_id
        || url.scheme() != APP_SCHEME
        || url.host_str() != Some(APP_HOST)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(BridgeError::unauthorized());
    }
    Ok(())
}

fn validate_id(id: &str, max_bytes: usize) -> bool {
    !id.is_empty()
        && id.len() <= max_bytes
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn validate_request(payload_bytes: usize) -> Result<(), BridgeError> {
    if payload_bytes > MAX_REQUEST_BYTES {
        return Err(BridgeError::invalid());
    }
    Ok(())
}

impl BridgeState {
    pub(crate) fn authorize_model_request(
        &self,
        window: &WebviewWindow,
        request: &StatusRequest,
    ) -> Result<(), BridgeError> {
        let caller = Caller::from_window(window)?;
        self.authorize(
            &caller,
            &request.owner_id,
            &request.session_id,
            &request.request_id,
            serde_json::to_vec(request)
                .map_err(|_| BridgeError::invalid())?
                .len(),
            request.protocol_version,
        )
    }

    fn open(
        &self,
        caller: &Caller,
        request: OpenSessionRequest,
    ) -> Result<OpenSessionReply, BridgeError> {
        validate_request(49 + request.owner_id.len() + request.request_id.len())?;
        if request.protocol_version != PROTOCOL_VERSION
            || !validate_id(&request.request_id, MAX_REQUEST_ID_BYTES)
            || !validate_id(&request.owner_id, 32)
        {
            return Err(BridgeError::invalid());
        }
        trusted_caller(caller, &request.owner_id)?;

        let mut sessions = self.inner.lock().map_err(|_| BridgeError::internal())?;
        sessions.next_session = sessions
            .next_session
            .checked_add(1)
            .ok_or_else(BridgeError::internal)?;
        let session_id = format!("s-{}", sessions.next_session);
        sessions
            .by_owner
            .insert(caller.owner_id.clone(), session_id.clone());
        Ok(OpenSessionReply {
            protocol_version: PROTOCOL_VERSION,
            owner_id: caller.owner_id.clone(),
            session_id,
            request_id: request.request_id,
        })
    }

    fn status(&self, caller: &Caller, request: StatusRequest) -> Result<NativeStatus, BridgeError> {
        self.authorize(
            caller,
            &request.owner_id,
            &request.session_id,
            &request.request_id,
            serde_json::to_vec(&request)
                .map_err(|_| BridgeError::invalid())?
                .len(),
            request.protocol_version,
        )?;
        Ok(NativeStatus {
            protocol_version: PROTOCOL_VERSION,
            owner_id: caller.owner_id.clone(),
            session_id: request.session_id,
            request_id: request.request_id,
            app_version: env!("CARGO_PKG_VERSION"),
            available: true,
        })
    }

    fn authorize(
        &self,
        caller: &Caller,
        owner_id: &str,
        session_id: &str,
        request_id: &str,
        payload_bytes: usize,
        protocol_version: u8,
    ) -> Result<(), BridgeError> {
        validate_request(payload_bytes)?;
        if protocol_version != PROTOCOL_VERSION
            || !validate_id(request_id, MAX_REQUEST_ID_BYTES)
            || !validate_id(session_id, MAX_SESSION_ID_BYTES)
            || !validate_id(owner_id, 32)
        {
            return Err(BridgeError::invalid());
        }
        trusted_caller(caller, owner_id)?;
        let sessions = self.inner.lock().map_err(|_| BridgeError::internal())?;
        if sessions.by_owner.get(&caller.owner_id).map(String::as_str) != Some(session_id) {
            return Err(BridgeError::stale_session());
        }
        Ok(())
    }

    fn get_preferences(
        &self,
        caller: &Caller,
        request: GetPreferencesRequest,
        app: &AppHandle,
        preferences_state: &PreferenceState,
    ) -> Result<PreferencesReply, BridgeError> {
        self.authorize(
            caller,
            &request.owner_id,
            &request.session_id,
            &request.request_id,
            serde_json::to_vec(&request)
                .map_err(|_| BridgeError::invalid())?
                .len(),
            request.protocol_version,
        )?;
        let _guard = preferences_state
            .0
            .lock()
            .map_err(|_| BridgeError::internal())?;
        let preferences = preferences::get(app).map_err(|_| BridgeError::internal())?;
        Ok(PreferencesReply {
            protocol_version: PROTOCOL_VERSION,
            owner_id: caller.owner_id.clone(),
            session_id: request.session_id,
            request_id: request.request_id,
            preferences,
        })
    }

    fn update_preferences(
        &self,
        caller: &Caller,
        request: UpdatePreferencesRequest,
        app: &AppHandle,
        preferences_state: &PreferenceState,
    ) -> Result<PreferencesReply, BridgeError> {
        self.authorize(
            caller,
            &request.owner_id,
            &request.session_id,
            &request.request_id,
            serde_json::to_vec(&request)
                .map_err(|_| BridgeError::invalid())?
                .len(),
            request.protocol_version,
        )?;
        request
            .preferences
            .validate()
            .map_err(|_| BridgeError::invalid())?;
        let _guard = preferences_state
            .0
            .lock()
            .map_err(|_| BridgeError::internal())?;
        preferences::update(app, &request.preferences).map_err(|_| BridgeError::internal())?;
        Ok(PreferencesReply {
            protocol_version: PROTOCOL_VERSION,
            owner_id: caller.owner_id.clone(),
            session_id: request.session_id,
            request_id: request.request_id,
            preferences: request.preferences,
        })
    }

    pub fn owner_destroyed(&self, owner_id: &str) {
        if let Ok(mut sessions) = self.inner.lock() {
            sessions.by_owner.remove(owner_id);
        }
    }
}

#[tauri::command]
pub fn bridge_open_session(
    request: OpenSessionRequest,
    window: WebviewWindow,
    state: State<'_, BridgeState>,
    chat: State<'_, crate::chat::ChatState>,
    runtime: State<'_, crate::model_runtime::ModelRuntime>,
) -> Result<OpenSessionReply, BridgeError> {
    let caller = Caller::from_window(&window)?;
    let reply = state.open(&caller, request)?;
    if chat.invalidate_sessions(&reply.owner_id, &reply.session_id) {
        runtime.stop();
    }
    Ok(reply)
}

#[tauri::command]
pub fn bridge_get_status(
    request: StatusRequest,
    window: WebviewWindow,
    state: State<'_, BridgeState>,
) -> Result<NativeStatus, BridgeError> {
    let caller = Caller::from_window(&window)?;
    state.status(&caller, request)
}

#[tauri::command]
pub fn bridge_get_preferences(
    request: GetPreferencesRequest,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BridgeState>,
    preferences_state: State<'_, PreferenceState>,
) -> Result<PreferencesReply, BridgeError> {
    let caller = Caller::from_window(&window)?;
    state.get_preferences(&caller, request, &app, &preferences_state)
}

#[tauri::command]
pub fn bridge_update_preferences(
    request: UpdatePreferencesRequest,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BridgeState>,
    preferences_state: State<'_, PreferenceState>,
) -> Result<PreferencesReply, BridgeError> {
    let caller = Caller::from_window(&window)?;
    state.update_preferences(&caller, request, &app, &preferences_state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(owner_id: &str, url: &str) -> Caller {
        Caller {
            owner_id: owner_id.into(),
            url: Url::parse(url).unwrap(),
        }
    }

    fn app_url() -> &'static str {
        #[cfg(any(target_os = "windows", target_os = "android"))]
        {
            "http://tauri.localhost/"
        }
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        {
            "tauri://localhost"
        }
    }

    fn open_request(owner_id: &str, request_id: &str) -> OpenSessionRequest {
        OpenSessionRequest {
            protocol_version: PROTOCOL_VERSION,
            owner_id: owner_id.into(),
            request_id: request_id.into(),
        }
    }

    fn status_request(owner_id: &str, session_id: &str, request_id: &str) -> StatusRequest {
        StatusRequest {
            protocol_version: PROTOCOL_VERSION,
            owner_id: owner_id.into(),
            session_id: session_id.into(),
            request_id: request_id.into(),
        }
    }

    #[test]
    fn main_local_caller_opens_and_reads_correlated_status() {
        let state = BridgeState::default();
        let caller = caller("main", app_url());
        let opened = state.open(&caller, open_request("main", "req-1")).unwrap();
        let status = state
            .status(&caller, status_request("main", &opened.session_id, "req-2"))
            .unwrap();
        assert_eq!(opened.owner_id, "main");
        assert_eq!(status.request_id, "req-2");
        assert!(status.available);
    }

    #[test]
    fn rejects_malformed_oversized_and_unknown_fields() {
        let state = BridgeState::default();
        let caller = caller("main", app_url());
        assert_eq!(
            state
                .open(&caller, open_request("main", " "))
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
        assert_eq!(
            state
                .open(&caller, open_request("main", &"r".repeat(200)))
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
        assert_eq!(
            state
                .status(&caller, status_request("main", &"s".repeat(100), "r1"))
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
        assert!(serde_json::from_str::<OpenSessionRequest>(
            r#"{"protocolVersion":1,"ownerId":"main","requestId":"x","extra":true}"#
        )
        .is_err());
    }

    #[test]
    fn payload_size_accounting_matches_serialized_envelopes() {
        let open = open_request("main", "req-1");
        assert_eq!(
            49 + open.owner_id.len() + open.request_id.len(),
            serde_json::to_vec(&open).unwrap().len()
        );
        let status = status_request("main", "s-1", "req-2");
        assert_eq!(
            64 + status.owner_id.len() + status.session_id.len() + status.request_id.len(),
            serde_json::to_vec(&status).unwrap().len()
        );
    }

    #[test]
    fn rejects_forged_owner_unknown_window_and_remote_origin() {
        let state = BridgeState::default();
        assert_eq!(
            state
                .open(&caller("main", app_url()), open_request("other", "r1"))
                .unwrap_err()
                .code,
            BridgeErrorCode::Unauthorized
        );
        let session = state
            .open(&caller("main", app_url()), open_request("main", "r1"))
            .unwrap();
        assert_eq!(
            state
                .status(
                    &caller("main", app_url()),
                    status_request("other", &session.session_id, "r2"),
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::Unauthorized
        );
        assert_eq!(
            state
                .status(
                    &caller("main", app_url()),
                    status_request("main", "forged", "r3"),
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::StaleSession
        );
        assert_eq!(
            state
                .open(&caller("popup", app_url()), open_request("popup", "r1"))
                .unwrap_err()
                .code,
            BridgeErrorCode::Unauthorized
        );
        assert_eq!(
            state
                .open(
                    &caller("main", "https://example.com"),
                    open_request("main", "r1")
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::Unauthorized
        );
        for url in [
            "https://tauri.localhost/",
            "tauri://other-host",
            "tauri://localhost:8080",
            "http://tauri.localhost:8080/",
            "tauri://user@localhost",
            "data:text/plain,opaque",
            "custom://localhost",
        ] {
            assert_eq!(
                state
                    .open(&caller("main", url), open_request("main", "r1"))
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Unauthorized,
                "unexpectedly trusted {url}"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        assert_eq!(
            state
                .open(
                    &caller("main", "http://tauri.localhost/"),
                    open_request("main", "r1")
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::Unauthorized
        );
        #[cfg(any(target_os = "windows", target_os = "android"))]
        assert_eq!(
            state
                .open(
                    &caller("main", "tauri://localhost"),
                    open_request("main", "r1")
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::Unauthorized
        );
    }

    #[test]
    fn accepts_the_configured_platform_url_as_a_parsed_url() {
        let parsed = Url::parse(app_url()).unwrap();
        assert_eq!(parsed.scheme(), APP_SCHEME);
        assert_eq!(parsed.host_str(), Some(APP_HOST));
        assert!(trusted_caller(&caller("main", app_url()), "main").is_ok());
        let decorated_url = format!("{}/path?q=1#section", app_url().trim_end_matches('/'));
        assert!(trusted_caller(&caller("main", &decorated_url), "main").is_ok());
    }

    #[test]
    fn replacement_and_owner_destruction_invalidate_old_session() {
        let state = BridgeState::default();
        let caller = caller("main", app_url());
        let first = state.open(&caller, open_request("main", "r1")).unwrap();
        let second = state.open(&caller, open_request("main", "r2")).unwrap();
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(
            state
                .status(&caller, status_request("main", &first.session_id, "r3"))
                .unwrap_err()
                .code,
            BridgeErrorCode::StaleSession
        );
        state.owner_destroyed("main");
        assert_eq!(
            state
                .status(&caller, status_request("main", &second.session_id, "r4"))
                .unwrap_err()
                .code,
            BridgeErrorCode::StaleSession
        );
    }

    #[test]
    fn error_text_is_static_and_does_not_echo_request_data() {
        let error = BridgeState::default()
            .open(
                &caller("main", app_url()),
                open_request("secret-token", "secret-key"),
            )
            .unwrap_err();
        let json = serde_json::to_string(&error).unwrap();
        assert_eq!(error.code, BridgeErrorCode::Unauthorized);
        assert!(!json.contains("secret"));
    }

    #[test]
    fn preferences_requests_are_fixed_bounded_and_use_active_session() {
        let state = BridgeState::default();
        let caller = caller("main", app_url());
        let opened = state.open(&caller, open_request("main", "open-1")).unwrap();
        let request = GetPreferencesRequest {
            protocol_version: PROTOCOL_VERSION,
            owner_id: "main".into(),
            session_id: opened.session_id.clone(),
            request_id: "prefs-1".into(),
        };
        let size = serde_json::to_vec(&request).unwrap().len();
        assert!(state
            .authorize(&caller, "main", &opened.session_id, "prefs-1", size, 1)
            .is_ok());
        assert_eq!(
            state
                .authorize(&caller, "main", "stale", "prefs-1", size, 1)
                .unwrap_err()
                .code,
            BridgeErrorCode::StaleSession
        );
        assert_eq!(
            state
                .authorize(
                    &caller,
                    "main",
                    &opened.session_id,
                    "prefs-1",
                    MAX_REQUEST_BYTES + 1,
                    1
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
        assert!(serde_json::from_str::<GetPreferencesRequest>(
            r#"{"protocolVersion":1,"ownerId":"main","sessionId":"s-1","requestId":"r1","path":"/tmp"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<UpdatePreferencesRequest>(
            r#"{"protocolVersion":1,"ownerId":"main","sessionId":"s-1","requestId":"r1","preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"lowImpact","idlePolicy":"taskEnd","grant":true}}"#
        )
        .is_err());
    }
}
