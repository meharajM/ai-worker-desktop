//! Minimal A2A v1.0 JSON-RPC wire primitives for the local workspace agent.
//!
//! Keep transport/authentication in external_mcp; this module validates A2A
//! messages and builds protocol-shaped JSON values. It deliberately supports
//! text user messages and the bounded workspace/task-scope extension only.

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::agent_task::{HandoffContext, TaskRequest};

pub(crate) const WORKSPACE_EXTENSION: &str = "https://ai-worker.app/extensions/workspace/v1";
const MAX_RPC_ID_CHARS: usize = 128;
const MAX_IDENTIFIER_CHARS: usize = 256;
const MAX_PROMPT_UTF16: usize = 4_000;

/// Supported A2A v1.0 JSON-RPC methods. Unknown methods remain parseable so the
/// transport can return the JSON-RPC Method not found error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
    SendMessage,
    GetTask,
    ListTasks,
    CancelTask,
}

impl Method {
    /// Parse an exact A2A v1.0 JSON-RPC method name.
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "SendMessage" => Some(Self::SendMessage),
            "GetTask" => Some(Self::GetTask),
            "ListTasks" => Some(Self::ListTasks),
            "CancelTask" => Some(Self::CancelTask),
            _ => None,
        }
    }
}

/// A validated JSON-RPC 2.0 request. Its ID is a bounded string or integer,
/// and params is guaranteed to be an object.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RpcRequest {
    pub(crate) id: Value,
    pub(crate) method: String,
    pub(crate) params: Map<String, Value>,
}

/// Parsing error details for JSON-RPC -32600 and -32602 responses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParseError {
    pub(crate) kind: ParseErrorKind,
    pub(crate) message: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParseErrorKind {
    ParseError,
    InvalidRequest,
    InvalidParams,
}

/// Validated SendMessage input, normalized to the existing bounded local task
/// request. The transport owns task/context ID lookup and lifecycle semantics.
#[derive(Clone, Debug)]
pub(crate) struct SendMessage {
    pub(crate) message_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) context_id: Option<String>,
    pub(crate) task: TaskRequest,
    pub(crate) return_immediately: bool,
}

/// Parse a JSON-RPC 2.0 request with a string or integer ID and object params.
/// Unknown top-level members are rejected to keep the accepted wire shape small.
pub(crate) fn parse_request(bytes: &[u8]) -> Result<RpcRequest, ParseError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RawRequest {
        jsonrpc: String,
        id: Value,
        method: String,
        params: Value,
    }

    let value: Value = serde_json::from_slice(bytes).map_err(|_| ParseError {
        kind: ParseErrorKind::ParseError,
        message: "Invalid JSON payload.",
    })?;
    let raw: RawRequest = serde_json::from_value(value).map_err(|_| invalid_request())?;
    if raw.jsonrpc != "2.0"
        || !valid_rpc_id(&raw.id)
        || raw.method.is_empty()
        || raw.method.chars().count() > 128
        || raw.method.chars().any(char::is_control)
    {
        return Err(invalid_request());
    }
    let params = raw
        .params
        .as_object()
        .cloned()
        .ok_or_else(invalid_request)?;
    Ok(RpcRequest {
        id: raw.id,
        method: raw.method,
        params,
    })
}

/// Parse SendMessage params. Only configuration.returnImmediately is supported;
/// push configuration, attachments, unsupported modes, and unknown fields fail.
/// Workspace metadata is passed through as a strict local task request.
pub(crate) fn parse_send_message(params: &Map<String, Value>) -> Result<SendMessage, ParseError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawParams {
        message: RawMessage,
        #[serde(default)]
        configuration: Option<RawConfiguration>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawConfiguration {
        #[serde(default)]
        return_immediately: bool,
        #[serde(default)]
        accepted_output_modes: Vec<String>,
        #[serde(default)]
        history_length: Option<usize>,
        #[serde(default)]
        task_push_notification_config: Option<Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawMessage {
        message_id: String,
        role: String,
        parts: Vec<Value>,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        context_id: Option<String>,
        #[serde(default)]
        metadata: Option<Map<String, Value>>,
        #[serde(default)]
        extensions: Option<Vec<String>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawTextPart {
        text: String,
        #[serde(default)]
        media_type: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawWorkspaceExtension {
        capabilities: Vec<String>,
        workspace_root: PathBuf,
        #[serde(default)]
        handoff_context: Option<HandoffContext>,
    }

    let raw: RawParams =
        serde_json::from_value(Value::Object(params.clone())).map_err(|_| invalid_params())?;
    let message = raw.message;
    if message.role != "ROLE_USER"
        || !valid_identifier(&message.message_id)
        || message
            .task_id
            .as_ref()
            .is_some_and(|id| !valid_identifier(id))
        || message
            .context_id
            .as_ref()
            .is_some_and(|id| !valid_identifier(id))
    {
        return Err(invalid_params());
    }

    let [part] = message.parts.as_slice() else {
        return Err(invalid_params());
    };
    let part: RawTextPart = serde_json::from_value(part.clone()).map_err(|_| invalid_params())?;
    if part
        .media_type
        .as_deref()
        .is_some_and(|media_type| media_type != "text/plain")
        || part.text.trim().is_empty()
        || part.text.encode_utf16().count() > MAX_PROMPT_UTF16
    {
        return Err(invalid_params());
    }

    let extensions = message.extensions.unwrap_or_default();
    if extensions.len() > 1 || extensions.iter().any(|uri| uri != WORKSPACE_EXTENSION) {
        return Err(invalid_params());
    }
    let mut metadata = message.metadata.unwrap_or_default();
    let workspace_value = metadata.remove(WORKSPACE_EXTENSION);
    if !metadata.is_empty() {
        return Err(invalid_params());
    }
    let extension_declared = extensions.iter().any(|uri| uri == WORKSPACE_EXTENSION);
    if extension_declared != workspace_value.is_some() {
        return Err(invalid_params());
    }

    let (capabilities, workspace_root, handoff_context) = if let Some(value) = workspace_value {
        let extension: RawWorkspaceExtension =
            serde_json::from_value(value).map_err(|_| invalid_params())?;
        let unique = extension
            .capabilities
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if !unique.contains("workspace")
            || unique.len() != extension.capabilities.len()
            || extension.capabilities.len() > 2
            || extension
                .capabilities
                .iter()
                .any(|capability| !matches!(capability.as_str(), "workspace" | "web"))
        {
            return Err(invalid_params());
        }
        (
            extension.capabilities,
            Some(extension.workspace_root),
            extension.handoff_context,
        )
    } else {
        (Vec::new(), None, None)
    };

    if raw.configuration.as_ref().is_some_and(|configuration| {
        configuration
            .accepted_output_modes
            .iter()
            .any(|mode| mode != "text/plain")
            || configuration
                .history_length
                .is_some_and(|length| length > 1_000)
            || configuration.task_push_notification_config.is_some()
    }) {
        return Err(invalid_params());
    }

    Ok(SendMessage {
        message_id: message.message_id,
        task_id: message.task_id,
        context_id: message.context_id,
        task: TaskRequest {
            prompt: part.text,
            capabilities,
            workspace_root,
            handoff_context,
        },
        return_immediately: raw
            .configuration
            .is_some_and(|configuration| configuration.return_immediately),
    })
}

/// Build a minimal A2A v1.0 Agent Card for the authenticated local bridge.
/// url must be the loopback JSON-RPC endpoint currently owned by the app.
pub(crate) fn agent_card(url: impl Into<String>, version: impl Into<String>) -> Value {
    let url = url.into();
    let version = version.into();
    json!({
        "name": "AI-Worker",
        "description": "On-device sub-agent for bounded workspace reading and user-approved file writes; optional public web research is separately enabled in AI-Worker settings.",
        "supportedInterfaces": [{
            "url": url,
            "protocolBinding": "JSONRPC",
            "protocolVersion": "1.0"
        }],
        "version": version,
        "capabilities": {
            "streaming": false,
            "pushNotifications": false,
            "extensions": [{
                "uri": WORKSPACE_EXTENSION,
                "description": "Pass a host-selected workspace and bounded handoff context.",
                "required": false
            }]
        },
        "securitySchemes": {
            "localBearer": {
                "httpAuthSecurityScheme": {
                    "scheme": "Bearer",
                    "description": "Ephemeral bearer token read from the owner-protected local runtime status file."
                }
            }
        },
        "securityRequirements": [{ "schemes": { "localBearer": { "list": [] } } }],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [{
            "id": "local-workspace",
            "name": "Local workspace task",
            "description": "Read and search the host-selected workspace; propose writes for user approval. Tasks may request public web research when enabled in AI-Worker settings.",
            "tags": ["local", "workspace", "research"]
        }]
    })
}

/// Build a JSON-RPC 2.0 success envelope.
pub(crate) fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Build a JSON-RPC 2.0 error envelope with the A2A v1.0 ErrorInfo data shape.
pub(crate) fn error(
    id: Option<Value>,
    code: i64,
    message: &str,
    reason: &str,
    metadata: BTreeMap<String, Value>,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message,
            "data": [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": reason,
                "domain": "a2a-protocol.org",
                "metadata": metadata
            }]
        }
    })
}

fn valid_rpc_id(value: &Value) -> bool {
    match value {
        Value::String(value) => {
            !value.is_empty()
                && value.chars().count() <= MAX_RPC_ID_CHARS
                && !value.chars().any(char::is_control)
        }
        Value::Number(value) => value.as_i64().is_some() || value.as_u64().is_some(),
        _ => false,
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && !value.chars().any(char::is_control)
}

fn invalid_request() -> ParseError {
    ParseError {
        kind: ParseErrorKind::InvalidRequest,
        message: "Invalid JSON-RPC 2.0 request.",
    }
}

fn invalid_params() -> ParseError {
    ParseError {
        kind: ParseErrorKind::InvalidParams,
        message: "Invalid A2A method parameters.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(message: Value) -> Map<String, Value> {
        json!({ "message": message }).as_object().unwrap().clone()
    }

    fn basic_message() -> Value {
        json!({
            "messageId": "msg-1",
            "role": "ROLE_USER",
            "parts": [{ "text": "Read README" }]
        })
    }

    fn workspace_message() -> Value {
        json!({
            "messageId": "msg-2",
            "role": "ROLE_USER",
            "parts": [{ "text": "Inspect the project", "mediaType": "text/plain" }],
            "extensions": [WORKSPACE_EXTENSION],
            "metadata": {
                (WORKSPACE_EXTENSION): {
                    "capabilities": ["workspace"],
                    "workspaceRoot": "/tmp/project",
                    "handoffContext": {
                        "summary": "Review local changes",
                        "constraints": [],
                        "relevantFiles": ["README.md"],
                        "sourceAgent": "Codex",
                        "workingDirectory": "/tmp/project"
                    }
                }
            }
        })
    }

    #[test]
    fn accepts_only_json_rpc_2_with_bounded_string_or_integer_id_and_object_params() {
        let request =
            parse_request(br#"{"jsonrpc":"2.0","id":7,"method":"SendMessage","params":{}}"#)
                .unwrap();
        assert_eq!(request.id, json!(7));
        assert_eq!(Method::parse(&request.method), Some(Method::SendMessage));
        assert!(
            parse_request(br#"{"jsonrpc":"1.0","id":"x","method":"GetTask","params":{}}"#).is_err()
        );
        assert!(
            parse_request(br#"{"jsonrpc":"2.0","id":1.5,"method":"GetTask","params":{}}"#).is_err()
        );
        assert!(
            parse_request(br#"{"jsonrpc":"2.0","id":null,"method":"GetTask","params":{}}"#)
                .is_err()
        );
        assert!(
            parse_request(br#"{"jsonrpc":"2.0","id":"x","method":"GetTask","params":[]}"#).is_err()
        );
        assert_eq!(
            parse_request(b"{broken"),
            Err(ParseError {
                kind: ParseErrorKind::ParseError,
                message: "Invalid JSON payload.",
            })
        );
        assert_eq!(Method::parse("message/send"), None);
        assert_eq!(Method::parse("GetTask"), Some(Method::GetTask));
    }

    #[test]
    fn parses_text_only_user_message_and_immediate_return_flag() {
        let mut request = params(basic_message());
        request.insert("configuration".into(), json!({ "returnImmediately": true }));
        let parsed = parse_send_message(&request).unwrap();
        assert_eq!(parsed.message_id, "msg-1");
        assert_eq!(parsed.task.prompt, "Read README");
        assert!(parsed.return_immediately);
        assert!(parsed.task.capabilities.is_empty());
    }

    #[test]
    fn parses_namespaced_workspace_extension_into_existing_task_request() {
        let parsed = parse_send_message(&params(workspace_message())).unwrap();
        assert_eq!(parsed.task.capabilities, vec!["workspace".to_owned()]);
        assert_eq!(
            parsed.task.workspace_root,
            Some(PathBuf::from("/tmp/project"))
        );
        assert_eq!(
            parsed
                .task
                .handoff_context
                .as_ref()
                .unwrap()
                .source_agent
                .as_deref(),
            Some("Codex")
        );

        let mut message = workspace_message();
        message["metadata"][WORKSPACE_EXTENSION]["capabilities"] = json!(["workspace", "web"]);
        let parsed_online = parse_send_message(&params(message)).unwrap();
        assert_eq!(parsed_online.task.capabilities, vec!["workspace", "web"]);
    }

    #[test]
    fn validates_followup_identifiers_and_allows_context_inference_from_task() {
        let mut message = basic_message();
        message["taskId"] = json!("task-1");
        let parsed_without_context = parse_send_message(&params(message.clone())).unwrap();
        assert_eq!(parsed_without_context.task_id.as_deref(), Some("task-1"));
        assert_eq!(parsed_without_context.context_id, None);
        message["contextId"] = json!("context-1");
        let parsed = parse_send_message(&params(message)).unwrap();
        assert_eq!(parsed.task_id.as_deref(), Some("task-1"));
        assert_eq!(parsed.context_id.as_deref(), Some("context-1"));
        let mut too_long = basic_message();
        too_long["messageId"] = json!("x".repeat(MAX_IDENTIFIER_CHARS + 1));
        assert!(parse_send_message(&params(too_long)).is_err());
    }

    #[test]
    fn rejects_non_user_messages_attachments_unknown_extensions_and_capabilities() {
        let mut message = basic_message();
        message["role"] = json!("ROLE_AGENT");
        assert!(parse_send_message(&params(message)).is_err());

        let mut message = basic_message();
        message["parts"] = json!([{ "url": "https://example.test/data.txt" }]);
        assert!(parse_send_message(&params(message)).is_err());

        let mut message = basic_message();
        message["extensions"] = json!(["https://example.test/unknown/v1"]);
        assert!(parse_send_message(&params(message)).is_err());

        let mut message = workspace_message();
        message["metadata"][WORKSPACE_EXTENSION]["capabilities"] = json!(["workspace", "services"]);
        assert!(parse_send_message(&params(message)).is_err());

        let mut message = workspace_message();
        message["metadata"][WORKSPACE_EXTENSION]["capabilities"] =
            json!(["workspace", "workspace"]);
        assert!(parse_send_message(&params(message)).is_err());
    }

    #[test]
    fn rejects_unpaired_extension_metadata_and_push_or_unsupported_configuration() {
        let mut message = workspace_message();
        message.as_object_mut().unwrap().remove("extensions");
        assert!(parse_send_message(&params(message)).is_err());

        for config in [
            json!({ "taskPushNotificationConfig": {} }),
            json!({ "acceptedOutputModes": ["application/json"] }),
        ] {
            let mut request = params(basic_message());
            request.insert("configuration".into(), config);
            assert!(parse_send_message(&request).is_err());
        }

        let mut request = params(basic_message());
        request.insert(
            "configuration".into(),
            json!({ "historyLength": 5, "acceptedOutputModes": ["text/plain"] }),
        );
        assert!(parse_send_message(&request).is_ok());
    }

    #[test]
    fn builds_current_agent_card_fields_and_local_bearer_security() {
        let card = agent_card("http://127.0.0.1:43210/a2a", "0.1.2");
        assert_eq!(card["version"], "0.1.2");
        assert_eq!(card["supportedInterfaces"][0]["protocolVersion"], "1.0");
        assert_eq!(card["supportedInterfaces"][0]["protocolBinding"], "JSONRPC");
        assert_eq!(
            card["securitySchemes"]["localBearer"]["httpAuthSecurityScheme"]["scheme"],
            "Bearer"
        );
        assert_eq!(
            card["securityRequirements"][0]["schemes"]["localBearer"]["list"],
            json!([])
        );
        assert_eq!(card["capabilities"]["pushNotifications"], false);
        assert_eq!(
            card["capabilities"]["extensions"][0]["uri"],
            WORKSPACE_EXTENSION
        );
    }

    #[test]
    fn creates_json_rpc_success_and_a2a_v1_error_envelopes() {
        let ok = success(json!("req-1"), json!({ "message": "done" }));
        assert_eq!(ok["jsonrpc"], "2.0");
        assert_eq!(ok["id"], "req-1");

        let err = error(
            Some(json!(9)),
            -32001,
            "Task not found",
            "TASK_NOT_FOUND",
            BTreeMap::from([("taskId".to_owned(), json!("missing"))]),
        );
        assert_eq!(err["error"]["code"], -32001);
        assert_eq!(
            err["error"]["data"][0]["@type"],
            "type.googleapis.com/google.rpc.ErrorInfo"
        );
        assert_eq!(err["error"]["data"][0]["domain"], "a2a-protocol.org");
        assert_eq!(err["error"]["data"][0]["metadata"]["taskId"], "missing");
    }
}
