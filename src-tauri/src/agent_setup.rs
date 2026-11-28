use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use toml_edit::{value, Array, DocumentMut, Item, Table};

const SERVER_KEY: &str = "ai-worker-desktop";
const TOOLS: &[&str] = &[
    "get_runtime_status",
    "ask_local",
    "run_agent_task",
    "start_agent_task",
    "get_agent_task",
    "answer_agent_question",
    "cancel_agent_task",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClientStatus {
    id: String,
    name: String,
    installed: bool,
    connected: bool,
    config_path: String,
}

#[derive(Clone, Copy)]
enum ConfigFormat {
    CodexToml,
    McpServersJson,
    VsCodeJson,
    OpenCodeJson,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenCodeLayout {
    LegacyV1,
    CurrentV2,
}

struct ClientProfile {
    id: &'static str,
    name: &'static str,
    executable: &'static str,
    config_path: PathBuf,
    format: ConfigFormat,
}

fn config_root(home: &Path) -> PathBuf {
    if let Some(path) = env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = env::var_os("APPDATA") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    {
        return home.join("Library").join("Application Support");
    }
    #[cfg(not(target_os = "macos"))]
    home.join(".config")
}

fn profiles(home: &Path) -> Vec<ClientProfile> {
    let config_root = config_root(home);
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let copilot_home = env::var_os("COPILOT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".copilot"));
    let cline_settings = env::var_os("CLINE_MCP_SETTINGS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cline/data/settings/cline_mcp_settings.json"));
    let opencode_dir = config_root.join("opencode");
    let opencode_config = if opencode_dir.join("opencode.jsonc").exists() {
        opencode_dir.join("opencode.jsonc")
    } else if opencode_dir.join("opencode.json").exists() {
        opencode_dir.join("opencode.json")
    } else {
        opencode_dir.join("opencode.jsonc")
    };
    let vscode_user = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Code/User")
    } else if cfg!(target_os = "windows") {
        config_root.join("Code/User")
    } else {
        config_root.join("Code/User")
    };
    let cline_user =
        vscode_user.join("globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");

    vec![
        ClientProfile {
            id: "codex",
            name: "Codex",
            executable: "codex",
            config_path: codex_home.join("config.toml"),
            format: ConfigFormat::CodexToml,
        },
        ClientProfile {
            id: "claude-code",
            name: "Claude Code",
            executable: "claude",
            config_path: home.join(".claude.json"),
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "claude-desktop",
            name: "Claude Desktop",
            executable: "claude",
            config_path: config_root.join("Claude/claude_desktop_config.json"),
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "cursor",
            name: "Cursor",
            executable: "cursor",
            config_path: home.join(".cursor/mcp.json"),
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "vscode",
            name: "VS Code (editor MCP)",
            executable: "code",
            config_path: vscode_user.join("mcp.json"),
            format: ConfigFormat::VsCodeJson,
        },
        ClientProfile {
            id: "copilot",
            name: "GitHub Copilot CLI",
            executable: "copilot",
            config_path: copilot_home.join("mcp-config.json"),
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "opencode",
            name: "OpenCode",
            executable: "opencode",
            config_path: opencode_config,
            format: ConfigFormat::OpenCodeJson,
        },
        ClientProfile {
            id: "gemini-cli",
            name: "Gemini CLI",
            executable: "gemini",
            config_path: home.join(".gemini/settings.json"),
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "windsurf",
            name: "Windsurf",
            executable: "windsurf",
            config_path: home.join(".codeium/windsurf/mcp_config.json"),
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "cline-cli",
            name: "Cline CLI",
            executable: "cline",
            config_path: cline_settings,
            format: ConfigFormat::McpServersJson,
        },
        ClientProfile {
            id: "cline-vscode",
            name: "Cline for VS Code",
            executable: "code",
            config_path: cline_user,
            format: ConfigFormat::McpServersJson,
        },
    ]
}

fn client_id(profile: &ClientProfile) -> String {
    profile.id.to_owned()
}

fn profile_by_id<'a>(profiles: &'a [ClientProfile], id: &str) -> Result<&'a ClientProfile, String> {
    profiles
        .iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "That AI agent is not supported by this setup screen.".to_owned())
}

fn path_has_executable(path: &Path, executable: &str) -> bool {
    let candidate = path.join(executable);
    if candidate.is_file() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        ["exe", "cmd", "bat"]
            .iter()
            .any(|extension| candidate.with_extension(extension).is_file())
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn command_is_available(executable: &str) -> bool {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .any(|path| path_has_executable(&path, executable))
}

fn client_is_installed(profile: &ClientProfile) -> bool {
    if profile.config_path.exists() {
        return true;
    }
    if profile.id == "cursor" && profile.config_path.parent().is_some_and(Path::exists) {
        return true;
    }
    if profile.id == "windsurf" && profile.config_path.parent().is_some_and(Path::exists) {
        return true;
    }
    if profile.id != "cline-vscode"
        && profile.id != "claude-desktop"
        && command_is_available(profile.executable)
    {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        let app_name = match profile.id {
            "claude-desktop" => "Claude.app",
            "cursor" => "Cursor.app",
            "vscode" | "cline-vscode" => "Visual Studio Code.app",
            "windsurf" => "Windsurf.app",
            _ => return false,
        };
        return [
            PathBuf::from("/Applications").join(app_name),
            PathBuf::from("/Applications")
                .join("Utilities")
                .join(app_name),
            env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("Applications")
                .join(app_name),
        ]
        .iter()
        .any(|path| path.exists());
    }
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        let install = match profile.id {
            "claude-desktop" => local.join("Programs/Claude/Claude.exe"),
            "cursor" => local.join("Programs/Cursor/Cursor.exe"),
            "vscode" | "cline-vscode" => local.join("Programs/Microsoft VS Code/Code.exe"),
            "windsurf" => local.join("Programs/Windsurf/Windsurf.exe"),
            _ => return false,
        };
        return install.exists();
    }
    #[cfg(target_os = "linux")]
    {
        false
    }
}

fn bundled_paths<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), String> {
    let node_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let resource_root = app.path().resource_dir().ok();
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let roots = [resource_root, Some(manifest_root.join(".."))];
    for root in roots.into_iter().flatten() {
        let runtime = if root.ends_with("Resources") || root.ends_with("resources") {
            root.join("mcp/runtime").join(node_name)
        } else {
            root.join(".build/tauri-runtime").join(node_name)
        };
        let adapter = if root.ends_with("Resources") || root.ends_with("resources") {
            root.join("mcp/scripts/ai-worker-readonly-mcp.mjs")
        } else {
            root.join("scripts/ai-worker-readonly-mcp.mjs")
        };
        if runtime.is_file() && adapter.is_file() {
            return Ok((runtime, adapter));
        }
    }
    Err("AI-Worker's local MCP runtime is missing. Reinstall the app or run `npm run tauri:prepare-runtime` in the source checkout.".into())
}

fn json_entry(
    profile: &ClientProfile,
    node: &str,
    adapter: &str,
    opencode_layout: OpenCodeLayout,
) -> Value {
    match profile.format {
        ConfigFormat::OpenCodeJson => match opencode_layout {
            OpenCodeLayout::LegacyV1 => json!({
                "type": "local",
                "command": [node, adapter],
                "enabled": true,
                "timeout": 315000
            }),
            OpenCodeLayout::CurrentV2 => json!({
                "type": "local",
                "command": [node, adapter],
                "timeout": { "catalog": 315000, "execution": 315000 }
            }),
        },
        ConfigFormat::McpServersJson if profile.id == "copilot" => json!({
            "type": "local",
            "command": node,
            "args": [adapter]
        }),
        ConfigFormat::VsCodeJson => json!({
            "type": "stdio",
            "command": node,
            "args": [adapter]
        }),
        _ => json!({
            "command": node,
            "args": [adapter]
        }),
    }
}

fn detect_opencode_layout(root: &Value) -> OpenCodeLayout {
    let Some(mcp) = root.get("mcp").and_then(Value::as_object) else {
        return OpenCodeLayout::CurrentV2;
    };
    if mcp.get("servers").and_then(Value::as_object).is_some() {
        OpenCodeLayout::CurrentV2
    } else if mcp.keys().any(|key| key != "servers") {
        OpenCodeLayout::LegacyV1
    } else {
        // OpenCode V2 is the default for a new or empty config. Existing V1 entries
        // keep their layout so this app does not rewrite a user's host configuration.
        OpenCodeLayout::CurrentV2
    }
}

fn opencode_entry(root: &Value) -> Result<Option<(OpenCodeLayout, Value)>, String> {
    let Some(mcp) = root.get("mcp").and_then(Value::as_object) else {
        return Ok(None);
    };
    let legacy = mcp.get(SERVER_KEY).cloned();
    let current = mcp
        .get("servers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(SERVER_KEY))
        .cloned();
    match (legacy, current) {
        (Some(_), Some(_)) => Err("The OpenCode config has AI-Worker entries in both V1 and V2 locations. It was left unchanged.".into()),
        (Some(entry), None) => Ok(Some((OpenCodeLayout::LegacyV1, entry))),
        (None, Some(entry)) => Ok(Some((OpenCodeLayout::CurrentV2, entry))),
        (None, None) => Ok(None),
    }
}

fn opencode_layout_for_update(root: &Value) -> Result<OpenCodeLayout, String> {
    Ok(opencode_entry(root)?
        .map(|(layout, _)| layout)
        .unwrap_or_else(|| detect_opencode_layout(root)))
}

fn json_config_root_mut<'a>(
    root: &'a mut Value,
    profile: &ClientProfile,
    opencode_layout: OpenCodeLayout,
) -> Result<&'a mut Map<String, Value>, String> {
    let root = root.as_object_mut().ok_or_else(|| {
        "The existing agent configuration must be a JSON object. It was left unchanged.".to_owned()
    })?;
    if matches!(profile.format, ConfigFormat::OpenCodeJson) {
        let mcp = root.entry("mcp").or_insert_with(|| json!({}));
        let mcp = mcp.as_object_mut().ok_or_else(|| {
            "The existing OpenCode `mcp` setting is not an object. It was left unchanged."
                .to_owned()
        })?;
        match opencode_layout {
            OpenCodeLayout::LegacyV1 => Ok(mcp),
            OpenCodeLayout::CurrentV2 => mcp
                .entry("servers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| {
                    "The existing OpenCode `mcp.servers` setting is not an object. It was left unchanged."
                        .to_owned()
                }),
        }
    } else {
        let key = if matches!(profile.format, ConfigFormat::VsCodeJson) {
            "servers"
        } else {
            "mcpServers"
        };
        root.entry(key)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| {
                "The existing MCP server setting is not an object. It was left unchanged."
                    .to_owned()
            })
    }
}

fn json_is_connected(profile: &ClientProfile, path: &Path, node: &str, adapter: &str) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&contents) else {
        return false;
    };
    if matches!(profile.format, ConfigFormat::OpenCodeJson) {
        let Ok(Some((layout, entry))) = opencode_entry(&root) else {
            return false;
        };
        return entry == json_entry(profile, node, adapter, layout);
    }
    let layout = OpenCodeLayout::CurrentV2;
    let Some(servers) = root
        .get(if matches!(profile.format, ConfigFormat::VsCodeJson) {
            "servers"
        } else {
            "mcpServers"
        })
        .and_then(Value::as_object)
    else {
        return false;
    };
    servers
        .get(SERVER_KEY)
        .is_some_and(|entry| entry == &json_entry(profile, node, adapter, layout))
}

fn toml_is_connected(path: &Path, node: &str, adapter: &str) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(document) = contents.parse::<DocumentMut>() else {
        return false;
    };
    document
        .get("mcp_servers")
        .and_then(Item::as_table)
        .and_then(|servers| servers.get(SERVER_KEY))
        .and_then(Item::as_table)
        .is_some_and(|server| {
            server.get("command").and_then(Item::as_str) == Some(node)
                && server
                    .get("args")
                    .and_then(Item::as_array)
                    .is_some_and(|args| args.iter().any(|arg| arg.as_str() == Some(adapter)))
        })
}

fn is_connected(profile: &ClientProfile, node: &str, adapter: &str) -> bool {
    if !profile.config_path.exists() {
        return false;
    }
    match profile.format {
        ConfigFormat::CodexToml => toml_is_connected(&profile.config_path, node, adapter),
        _ => json_is_connected(profile, &profile.config_path, node, adapter),
    }
}

fn status(profile: &ClientProfile, node: &str, adapter: &str) -> AgentClientStatus {
    AgentClientStatus {
        id: client_id(profile),
        name: profile.name.to_owned(),
        installed: client_is_installed(profile),
        connected: is_connected(profile, node, adapter),
        config_path: profile.config_path.to_string_lossy().into_owned(),
    }
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent config path has no parent folder.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create agent config folder: {error}"))?;
    let existing = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(
                "The existing agent config is not a regular file. It was left unchanged.".into(),
            );
        }
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not inspect the agent config: {error}")),
    };
    #[cfg(unix)]
    let file_mode = {
        use std::os::unix::fs::PermissionsExt;
        existing
            .as_ref()
            .map(|metadata| metadata.permissions().mode() & 0o777)
            .unwrap_or(0o600)
    };
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let temporary = parent.join(format!(".{file_name}.ai-worker-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(file_mode);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Could not prepare agent config update: {error}"))?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not save agent config update: {error}"));
    }
    drop(file);

    #[cfg(windows)]
    if existing.is_some() {
        let backup = parent.join(format!(".{file_name}.ai-worker-{}.bak", std::process::id()));
        fs::rename(path, &backup).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("Could not replace the agent config safely: {error}")
        })?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(&backup, path);
            let _ = fs::remove_file(&temporary);
            return Err(format!("Could not save the agent config update: {error}"));
        }
        let _ = fs::remove_file(backup);
        return Ok(());
    }

    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Could not save the agent config update: {error}")
    })
}

fn update_json(profile: &ClientProfile, node: &str, adapter: &str) -> Result<(), String> {
    let mut root = if profile.config_path.exists() {
        let contents = fs::read_to_string(&profile.config_path).map_err(|error| {
            format!("Could not read {}: {error}", profile.config_path.display())
        })?;
        serde_json::from_str::<Value>(&contents).map_err(|_| {
            format!("{} is not plain JSON or contains comments. AI-Worker left it unchanged; use the manual setup guide for this agent.", profile.config_path.display())
        })?
    } else {
        json!({})
    };
    let layout = if matches!(profile.format, ConfigFormat::OpenCodeJson) {
        opencode_layout_for_update(&root)?
    } else {
        OpenCodeLayout::CurrentV2
    };
    let servers = json_config_root_mut(&mut root, profile, layout)?;
    if let Some(existing) = servers.get(SERVER_KEY) {
        if existing == &json_entry(profile, node, adapter, layout) {
            return Ok(());
        }
        return Err(format!("{} already contains an MCP entry named `{SERVER_KEY}`. AI-Worker left it unchanged; rename that entry before connecting.", profile.config_path.display()));
    }
    servers.insert(
        SERVER_KEY.to_owned(),
        json_entry(profile, node, adapter, layout),
    );
    let contents = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())? + "\n";
    write_atomic(&profile.config_path, &contents)
}

fn update_codex(profile: &ClientProfile, node: &str, adapter: &str) -> Result<(), String> {
    let mut document = if profile.config_path.exists() {
        let contents = fs::read_to_string(&profile.config_path).map_err(|error| {
            format!("Could not read {}: {error}", profile.config_path.display())
        })?;
        contents
            .parse::<DocumentMut>()
            .map_err(|error| format!("Could not parse Codex config: {error}"))?
    } else {
        DocumentMut::new()
    };
    let servers = document
        .entry("mcp_servers")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| {
            "Codex `mcp_servers` must be a TOML table. AI-Worker left the config unchanged."
                .to_owned()
        })?;
    if let Some(existing) = servers.get(SERVER_KEY) {
        if existing.as_table().is_some_and(|server| {
            server.get("command").and_then(Item::as_str) == Some(node)
                && server
                    .get("args")
                    .and_then(Item::as_array)
                    .is_some_and(|args| args.iter().any(|arg| arg.as_str() == Some(adapter)))
        }) {
            return Ok(());
        }
        return Err(format!("{} already contains an MCP entry named `{SERVER_KEY}`. AI-Worker left it unchanged; rename that entry before connecting.", profile.config_path.display()));
    }

    let mut server = Table::new();
    server["command"] = value(node);
    server["args"] = value(Array::from_iter([adapter]));
    server["enabled_tools"] = value(Array::from_iter(TOOLS.iter().copied()));
    server["tool_timeout_sec"] = value(315);
    servers.insert(SERVER_KEY, Item::Table(server));
    write_atomic(&profile.config_path, &document.to_string())
}

fn remove_json(profile: &ClientProfile, node: &str, adapter: &str) -> Result<(), String> {
    let contents = fs::read_to_string(&profile.config_path)
        .map_err(|error| format!("Could not read {}: {error}", profile.config_path.display()))?;
    let mut root = serde_json::from_str::<Value>(&contents).map_err(|_| {
        "This agent config is not plain JSON, so AI-Worker left it unchanged.".to_owned()
    })?;
    let layout = if matches!(profile.format, ConfigFormat::OpenCodeJson) {
        opencode_layout_for_update(&root)?
    } else {
        OpenCodeLayout::CurrentV2
    };
    let servers = json_config_root_mut(&mut root, profile, layout)?;
    let Some(existing) = servers.get(SERVER_KEY) else {
        return Ok(());
    };
    if existing != &json_entry(profile, node, adapter, layout) {
        return Err("The existing AI-Worker-named MCP entry differs from this installation. It was left unchanged.".into());
    }
    servers.remove(SERVER_KEY);
    let contents = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())? + "\n";
    write_atomic(&profile.config_path, &contents)
}

fn remove_codex(profile: &ClientProfile, node: &str, adapter: &str) -> Result<(), String> {
    let contents = fs::read_to_string(&profile.config_path)
        .map_err(|error| format!("Could not read {}: {error}", profile.config_path.display()))?;
    let mut document = contents
        .parse::<DocumentMut>()
        .map_err(|error| format!("Could not parse Codex config: {error}"))?;
    let servers = document
        .get_mut("mcp_servers")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| {
            "Codex `mcp_servers` must be a TOML table. AI-Worker left the config unchanged."
                .to_owned()
        })?;
    let Some(existing) = servers.get(SERVER_KEY) else {
        return Ok(());
    };
    let ours = existing.as_table().is_some_and(|server| {
        server.get("command").and_then(Item::as_str) == Some(node)
            && server
                .get("args")
                .and_then(Item::as_array)
                .is_some_and(|args| args.iter().any(|arg| arg.as_str() == Some(adapter)))
    });
    if !ours {
        return Err("The existing AI-Worker-named MCP entry differs from this installation. It was left unchanged.".into());
    }
    servers.remove(SERVER_KEY);
    write_atomic(&profile.config_path, &document.to_string())
}

#[tauri::command]
pub fn list_agent_clients(app: AppHandle) -> Result<Vec<AgentClientStatus>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the user home folder: {error}"))?;
    let clients = profiles(&home);
    let (node, adapter) = bundled_paths(&app)?;
    let node = node.to_string_lossy();
    let adapter = adapter.to_string_lossy();
    Ok(clients
        .iter()
        .map(|profile| status(profile, &node, &adapter))
        .collect())
}

#[tauri::command]
pub fn connect_agent_client(
    app: AppHandle,
    client_id: String,
) -> Result<AgentClientStatus, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the user home folder: {error}"))?;
    let clients = profiles(&home);
    let profile = profile_by_id(&clients, &client_id)?;
    let (node, adapter) = bundled_paths(&app)?;
    let node = node.to_string_lossy().into_owned();
    let adapter = adapter.to_string_lossy().into_owned();
    match profile.format {
        ConfigFormat::CodexToml => update_codex(profile, &node, &adapter)?,
        _ => update_json(profile, &node, &adapter)?,
    }
    Ok(status(profile, &node, &adapter))
}

#[tauri::command]
pub fn disconnect_agent_client(
    app: AppHandle,
    client_id: String,
) -> Result<AgentClientStatus, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the user home folder: {error}"))?;
    let clients = profiles(&home);
    let profile = profile_by_id(&clients, &client_id)?;
    let (node, adapter) = bundled_paths(&app)?;
    let node = node.to_string_lossy().into_owned();
    let adapter = adapter.to_string_lossy().into_owned();
    if profile.config_path.exists() {
        match profile.format {
            ConfigFormat::CodexToml => remove_codex(profile, &node, &adapter)?,
            _ => remove_json(profile, &node, &adapter)?,
        }
    }
    Ok(status(profile, &node, &adapter))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "ai-worker-agent-setup-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn profile(directory: &TestDirectory, id: &'static str, format: ConfigFormat) -> ClientProfile {
        ClientProfile {
            id,
            name: "Test agent",
            executable: "test-agent",
            config_path: directory.0.join("config.json"),
            format,
        }
    }

    #[test]
    fn opencode_v1_round_trips_and_preserves_other_servers() {
        let directory = TestDirectory::new();
        let profile = profile(&directory, "opencode", ConfigFormat::OpenCodeJson);
        fs::write(
            &profile.config_path,
            r#"{"mcp":{"docs":{"type":"local","command":["docs-mcp"],"enabled":true,"timeout":1000}},"other":true}"#,
        )
        .unwrap();

        update_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap();
        let updated: Value =
            serde_json::from_slice(&fs::read(&profile.config_path).unwrap()).unwrap();
        assert_eq!(updated["other"], true);
        assert_eq!(updated["mcp"]["docs"]["command"][0], "docs-mcp");
        assert_eq!(updated["mcp"][SERVER_KEY]["timeout"], 315000);
        assert!(updated["mcp"]["servers"].is_null());
        assert!(json_is_connected(
            &profile,
            &profile.config_path,
            "/usr/bin/node",
            "/opt/ai-worker/adapter.mjs"
        ));

        remove_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap();
        let removed: Value =
            serde_json::from_slice(&fs::read(&profile.config_path).unwrap()).unwrap();
        assert!(removed["mcp"][SERVER_KEY].is_null());
        assert_eq!(removed["mcp"]["docs"]["command"][0], "docs-mcp");
    }

    #[test]
    fn opencode_v2_uses_servers_for_new_configuration() {
        let directory = TestDirectory::new();
        let profile = profile(&directory, "opencode", ConfigFormat::OpenCodeJson);

        update_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap();
        let updated: Value =
            serde_json::from_slice(&fs::read(&profile.config_path).unwrap()).unwrap();
        assert_eq!(
            updated["mcp"]["servers"][SERVER_KEY]["timeout"]["execution"],
            315000
        );
        assert!(updated["mcp"][SERVER_KEY].is_null());

        remove_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap();
    }

    #[test]
    fn copilot_cli_uses_its_native_local_server_format() {
        let directory = TestDirectory::new();
        let profile = profile(&directory, "copilot", ConfigFormat::McpServersJson);

        update_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap();
        let updated: Value =
            serde_json::from_slice(&fs::read(&profile.config_path).unwrap()).unwrap();
        assert_eq!(updated["mcpServers"][SERVER_KEY]["type"], "local");
        assert_eq!(
            updated["mcpServers"][SERVER_KEY]["command"],
            "/usr/bin/node"
        );
        assert_eq!(
            updated["mcpServers"][SERVER_KEY]["args"][0],
            "/opt/ai-worker/adapter.mjs"
        );
    }

    #[test]
    fn commented_opencode_jsonc_is_left_unchanged() {
        let directory = TestDirectory::new();
        let profile = profile(&directory, "opencode", ConfigFormat::OpenCodeJson);
        let original =
            "{\n  \"mcp\": {\n    // Keep this user comment.\n    \"servers\": {}\n  }\n}\n";
        fs::write(&profile.config_path, original).unwrap();

        let error =
            update_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap_err();

        assert!(error.contains("left it unchanged"));
        assert_eq!(fs::read_to_string(&profile.config_path).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn json_update_preserves_existing_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let profile = profile(&directory, "cursor", ConfigFormat::McpServersJson);
        fs::write(&profile.config_path, "{}\n").unwrap();
        fs::set_permissions(&profile.config_path, fs::Permissions::from_mode(0o640)).unwrap();

        update_json(&profile, "/usr/bin/node", "/opt/ai-worker/adapter.mjs").unwrap();

        assert_eq!(
            fs::metadata(&profile.config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}
