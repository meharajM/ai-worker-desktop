# AI-Worker desktop MCP bridge

The local stdio server offers three tools to Codex, OpenCode and Copilot CLI.

| Tool | Use |
| --- | --- |
| `get_runtime_status` | Read app availability, privacy mode and on-device model readiness from a metadata snapshot. |
| `ask_local` | Send one prompt of up to 8,000 characters for on-device inference. It does not fall back to cloud or use tools, files, chat history, memory or connected services. |
| `run_agent_task` | Delegate a task of up to 8,000 characters with bounded handoff context. Request any combination of `workspace`, `web` and `services`. |

For example, call `run_agent_task` with `{"prompt":"Find the release checklist in my workspace and summarize the steps.","capabilities":["workspace"],"workspaceRoot":"/active/project","handoffContext":{"summary":"Check the current release process.","constraints":["Read only"],"relevantFiles":["README.md"],"workingDirectory":"/active/project"}}`. OpenCode's project hook supplies its active worktree and current directory; the MCP process also defaults an omitted workspace hint to its working directory. In local-only mode, a valid hinted workspace and loaded local model let bounded reads and searches run in the background without an initial permission prompt. If no valid workspace was handed off, AI-Worker asks the user to choose one. A proposed write requires approval and staged file review showing the previous and proposed content. Review and release the final answer before it returns to the MCP host.

The planner starts with the request and approved tool descriptions. It uses a loaded WebLLM model or the configured installed model in loopback Ollama in both privacy modes. A missing model produces a recoverable error. Model acquisition is a separate user action. Tasks expire after five minutes or eight planner turns. Closing the window, cancelling at the host or in the app, or changing privacy mode ends the grant. Completed approved actions retain their effects.

## Capability scope

- Workspace access covers small UTF-8 files and bounded directory and content searches in the selected project. Paths must be relative. Hidden entries, known credential paths, links and device files are excluded. A write needs an existing parent directory. Each proposed change lives in memory until reviewed, expires with the task, and is revalidated at approval.
- Public research requires Connected mode and a checked web grant. The app shows the full public HTTPS URL or DuckDuckGo search URL before making each request. It pins a public IPv4 address, fetches at most 512 KiB with no credentials or redirects, and extracts text and links using a fresh offline Chromium context. Chromium or installed Chrome must be available. The result includes fetched source URLs.
- Connected operations require Connected mode, an already-connected MCP server, and individual tool selection. The desktop lists supported reads and edits of issues, calendar events, documents, spreadsheet rows, tasks, project records and other service objects advertised by live connections. Every invocation shows the exact server ID, tool name and arguments. The app binds approval to that connection instance. Supported operation and argument rules are defined in `src/main/services/ExternalServiceTools.ts`. Tool descriptions and annotations alone grant no authority.
- The desktop shows the complete result and source URLs before returning them. The host's own model may be remote. Local inference does not change where the host processes its copy of the request and result.

## Host setup

- [OpenCode configuration](../opencode.json) registers the local server and an agent with a three-tool allowlist. It also offers the installed `qwen3-vl:4b` through loopback Ollama for on-device tool calling during an end-to-end test. Gemma 3 4B remains suitable for AI-Worker's local planner, but this Ollama install rejects its tool calls from OpenCode.
- [Copilot custom agent](../.github/agents/ai-worker-readiness.agent.md) specifies the same tools at both agent and server level.
- For Codex, configure the following block in the user's config file and restart the host to refresh its tool catalog. Use absolute paths for the installed runtime and script.

```toml
[mcp_servers.ai_worker_local]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/scripts/ai-worker-readonly-mcp.mjs"]
enabled_tools = ["get_runtime_status", "ask_local", "run_agent_task"]
tool_timeout_sec = 315
```

The historical server and script names remain valid for existing hosts. Packaged builds copy the bridge and its runtime dependencies to application resources. Use `AI_WORKER_USER_DATA_DIR` to match a custom Electron user-data directory. The bridge reads only the owner-protected runtime snapshot and authenticates to a loopback-only ephemeral port. The desktop accepts approval IPC only from its trusted renderer. The inference-only endpoint retains its two-minute timeout.

From the project root, run `opencode mcp list` to confirm the bridge connects. For a local tool handoff, use an installed tool-capable Ollama model, such as `ollama/qwen3-vl:4b` in this configuration, and ask the primary OpenCode agent to delegate a read-only workspace task to `ai_worker_readonly`. Its workspace root follows the active OpenCode worktree. A model download or remote host model is outside AI-Worker's local-only guarantee.
