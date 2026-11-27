# AI-Worker desktop MCP bridge

The stdio MCP server connects OpenCode, Codex, and Copilot to the running Tauri app.

```text
OpenCode / Codex / Copilot
          │ local stdio MCP
          ▼
AI-Worker adapter ── authenticated loopback ──► Tauri task manager
                                                     │
                ┌────────────────────────────────────┼───────────────────┐
                ▼                                    ▼                   ▼
          local inference                    workspace reads       task question
          no cloud fallback             staged write approval       or result
                                                   │                   │
                                                   └── task ID/status ─┘
                                                       poll / answer / cancel
                compact AI-Worker window reviews exact proposed file contents
```

| Tool | What it does |
| --- | --- |
| `get_runtime_status` | Reads app availability, privacy mode, and model readiness from local metadata. |
| `ask_local` | Sends a bounded prompt to the on-device model. It does not use chat history, memory, files, or tools. |
| `run_agent_task` | Backward-compatible synchronous handoff. Optional workspace access is limited to bounded list/read/search under the root supplied by the host; this route cannot write. |
| `start_agent_task` | Starts a bounded background task and returns a task ID. Reads are automatic inside the supplied workspace; an explicitly requested public research task can use the web capability when enabled in AI-Worker Settings; a proposed write pauses for exact-content desktop approval. |
| `get_agent_task` | Reads task state, a pending parent question, or the completed result and sources, which may be relative workspace paths or public HTTPS URLs. |
| `answer_agent_question` | Answers the exact question currently pending for a task so it can continue. |
| `cancel_agent_task` | Requests cooperative cancellation for a task. |

Tauri task inference always stays on-device and never falls back to a cloud provider. `run_agent_task` is read only and cannot use web research. `start_agent_task` supports bounded workspace list/read/search and can optionally use public web research when both the host sends `capabilities:["web"]` and the user has enabled public research in AI-Worker Settings. Search terms go to DuckDuckGo and requested public HTTPS URLs are fetched as supplied, including their paths and query strings. Outbound request planning uses the host task prompt and public web results, not workspace files or handoff notes. AI-Worker does not attach saved cookies or account credentials. Keep secrets out of task prompts and URLs. Fetched page text and source URLs are returned to the MCP host, which may be remote.

Requesting `capabilities:["workspace"]` is the host's explicit workspace grant; bounded list/read/search operations then need no per-file approval. Hosts should pass the absolute active project/worktree path as `workspaceRoot`. If omitted, the adapter uses its own process working directory as a compatibility fallback. When `handoffContext.workingDirectory` is omitted, the adapter defaults it to the selected workspace root, so an explicit host root remains consistent even when the MCP process started elsewhere. Reads and proposed writes are confined to that workspace. Task prompts and file contents are not saved to AI-Worker chat or memory. A proposed write pauses in `waiting_for_approval` until the user reviews the handoff, target path, current contents, and exact proposed contents in the compact window. A decline, window dismissal, cancellation, expiry, or stale file state applies no write.

## Background worker and session windows

Starting this stdio server starts the Tauri app with `--worker-service` when no live Tauri bridge is found. Worker mode starts the local bridge and tray service without opening the full app window. Opening AI-Worker normally still opens the full app; Tauri's single-instance handler routes that launch to an existing worker process. The compact Task activity window appears when a host session connects or a task runs, then closes after 20 seconds without active work. Closing that window does not stop tasks or the bridge.

Each stdio process gets a generated host session ID. A host that multiplexes conversations through one process can pass a stable `hostSessionId` to `start_agent_task` or `run_agent_task`; each task keeps its own task ID, workspace root, and handoff context. The activity window shows host sessions separately and labels tasks with their session. The service tracks up to 16 live sessions and expires missed heartbeats after 45 seconds; the adapter heartbeats every 15 seconds. Up to four tasks may be active at once.

For development, the adapter looks for `src-tauri/target/debug/ai-worker-tauri` (or the platform executable) beside the source checkout. Packaged macOS builds are resolved beside the app's resources. Set `AI_WORKER_TAURI_EXECUTABLE` to the Tauri executable path when the installed layout differs. Set `AI_WORKER_AUTOSTART=false` only when deliberately disabling service startup, such as in tests; runtime tools then report that AI-Worker must be opened manually.

Use the asynchronous lifecycle for long or cancellable work: start once, poll status, relay `pendingQuestion` when state is `waiting_for_parent`, answer with that task and question ID, then poll for a terminal result. A completed result is returned to the MCP host without a separate release approval; the host may be remote. The synchronous read-only `run_agent_task` remains available for simple tasks but cannot pause for a parent answer or be cancelled after it starts. Tasks live in process memory and are lost when AI-Worker exits or restarts. Asynchronous cancellation is cooperative; a task may remain `cancelling` until an in-progress local generation stops. Do not treat it as cancelled until status says `cancelled`.

`get_runtime_status.networkUse` describes the freshest live app snapshot. In `local-only` mode, app inference and MCP/Tauri task inference stay on-device, with no Tauri public research. In `connected` mode, Electron chat may use its configured connected provider; MCP `ask_local` and Tauri task inference still stay on-device. Public Tauri research needs both gates above. When privacy mode is `unknown`, the app is stopped or status is stale, so current network settings cannot be confirmed. Model imports/setup can use the network when user-started. The MCP transport itself uses loopback, but the host receives task results and may run a remote model or make its own network requests. Configure the host locally if task data must remain on-device end to end.

## Host setup

- [OpenCode configuration](../opencode.json) defines a local Ollama provider and an `ai_worker_parent` profile that starts and manages AI-Worker tasks. The `ai_worker_readonly` name remains for compatibility. The host agent is instructed to pass its active project/worktree root explicitly and use public research only when requested, with both web gates satisfied. Set `AI_WORKER_OLLAMA_MODEL` to an installed completion model when the default local choice is unsuitable; test model reliability with actual task prompts before relying on it.
- [Copilot custom agent](../.github/agents/ai-worker-readiness.agent.md) allowlists all seven tools, including the task lifecycle, passes the active project/worktree root explicitly, and describes both web research gates.
- For Codex, add this block to the user's config and restart the host to refresh its tool catalog. Use absolute paths for Node and the script.

```toml
[mcp_servers.ai_worker_local]
command = "/absolute/path/to/node"
args = ["/path/to/AI-Worker.app/Contents/Resources/mcp/scripts/ai-worker-readonly-mcp.mjs"]
enabled_tools = ["get_runtime_status", "ask_local", "run_agent_task", "start_agent_task", "get_agent_task", "answer_agent_question", "cancel_agent_task"]
tool_timeout_sec = 315
```

The Tauri bundle includes the MCP adapter at `mcp/scripts/ai-worker-readonly-mcp.mjs` and its Node packages at `mcp/node_modules/` under the platform's app resource directory. On macOS, the script is under `AI-Worker.app/Contents/Resources/`; on Windows and Linux, use the installed app's Tauri resource directory. The source-checkout alternative is `scripts/ai-worker-readonly-mcp.mjs`.

Install Node.js 22.12 or newer separately and set `command` to its absolute path; AI-Worker does not bundle Node. The app also does not edit host configuration automatically, so configure each supported host with an absolute script path and restart it to refresh the tool catalog. The adapter reads an owner-protected status snapshot and authenticates to the app's ephemeral loopback port with a short-lived token. It does not expose the task prompt or workspace scope through the runtime-status tool.

Start AI-Worker, then run `opencode mcp list` from the project root to confirm the server connects. To run a local-host subagent smoke test, use:

```sh
opencode run --agent ai_worker_parent --model ollama/qwen3-vl:4b \
  "Delegate to AI-Worker and report the Rust package name and version from src-tauri/Cargo.toml."
```

Earlier machine checks verified all seven tools against a source-built Tauri instance, including local inference, task start/status/result, cancellation, and synchronous workspace reads. One earlier Codex run returned package metadata from `src-tauri/Cargo.toml`, and the Activity window showed completion; Codex used its configured remote model, so the host received the prompt, selected path, and result. A follow-up Codex run using the checkout at `358a60e` completed the MCP task lifecycle and parent-question exchange but returned a generic response without the requested metadata. A later process inspection found the shared Tauri listener was an older executable than the checkout; its subsequent local-only snapshot reported `model.available=false`. That readiness value was not observed during the Codex task, so this did not verify the current checkout's runtime. OpenCode's MCP server is connected, but its local Qwen parent did not invoke a task. Its host-driven delegation remains unverified. Do not interrupt the existing listener to retest: use a ready local model with an isolated app profile or an approved idle window. OpenCode may make its own startup or update network requests; local Ollama keeps model prompts on-device but does not disable host networking.

The MCP host receives any task question and completed result, and may be remote. Loopback transport keeps the app endpoint local; it does not control what the host does with returned text. Use a local host model or do not delegate sensitive workspace contents to a remote host. Model setup/import can also use the network when explicitly requested.

## A2A v1.0 endpoint

Tauri also exposes a loopback A2A JSON-RPC endpoint for hosts with an A2A client:

- Discover the current endpoint with `GET http://127.0.0.1:<port>/.well-known/agent-card.json`. The public card contains capabilities and the current endpoint URL, but no bearer token or workspace data.
- Send authenticated JSON-RPC 2.0 requests to the card's `/a2a` URL with the ephemeral bearer token from the owner-protected `ai-worker-mcp-status.json` runtime snapshot. The port and token rotate when AI-Worker restarts. Keep the A2A client local; do not forward the token to a remote host.
- Supported methods are `SendMessage`, `GetTask`, `ListTasks`, and `CancelTask`. `SendMessage` blocks by default until completion or an input/approval pause; set `configuration.returnImmediately: true` to receive the current task and poll with `GetTask`.
- Messages are text-only. To pass the host-selected project, include `https://ai-worker.app/extensions/workspace/v1` in `message.extensions` and put `{ "capabilities": ["workspace"], "workspaceRoot": "/absolute/project/path", "handoffContext": { ... } }` under that same key in `message.metadata`. A task may also request public research with `capabilities:["workspace","web"]`, but only when public research is enabled in AI-Worker Settings. Search terms and requested URLs leave the device; fetched text and source URLs return to the A2A host. Keep private workspace content out of queries and URLs. A follow-up answer uses the same `taskId` and `contextId`; AI-Worker infers the context when the message includes only `taskId`.
- A proposed file write returns `TASK_STATE_AUTH_REQUIRED` and opens the compact review window. A2A cannot approve it. The host receives the final task artifact and source paths after completion.

Streaming, push notifications, attachments, shell actions, browser actions, and connected services are not implemented in this Tauri route. Public web research is supported only with the web capability and Settings opt-in described above. Task state remains in memory and is lost when AI-Worker exits. The Rust operation journal and TypeScript bridge remain future crash-recovery work; they do not yet recover interrupted Tauri writes. The MCP stdio bridge remains the tested connection for OpenCode/Codex/Copilot; A2A hosts must support JSON-RPC v1.0 and be able to read the local runtime snapshot to obtain the current bearer token.
