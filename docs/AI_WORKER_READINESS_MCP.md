# AI-Worker desktop MCP bridge

The stdio MCP server connects local MCP-capable agents to the running Tauri app. AI-Worker's **Settings → AI Agents** page detects supported clients and lets you connect Codex, Claude Desktop, Claude Code, Cursor, VS Code editor MCP, GitHub Copilot CLI, OpenCode, Gemini CLI, Windsurf, and Cline (CLI or VS Code).

```text
Local MCP host
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

`get_runtime_status.networkUse` describes the freshest live app snapshot. MCP `ask_local` and Tauri task inference stay on-device. Public Tauri research needs both gates above. When privacy mode is `unknown`, the app is stopped or status is stale, so current network settings cannot be confirmed. Model imports/setup can use the network when user-started. The MCP transport itself uses loopback, but the host receives task results and may run a remote model or make its own network requests. Configure the host locally if task data must remain on-device end to end.

## Connect an agent

1. Open **AI-Worker → Settings → AI Agents** (or choose **Connect an AI agent** on the welcome screen).
2. Select an installed agent. AI-Worker adds a local MCP entry to that host's user configuration and preserves unrelated settings.
3. Restart the agent so it loads the new tool list.
4. Ask it to use AI-Worker for the active project. It should pass the absolute workspace root and request `capabilities:["workspace"]`.

The installed app includes the MCP adapter, required Node runtime, and MCP packages under its resource directory. No Node install, source checkout, or manual path copying is required. The adapter starts or reuses the AI-Worker background service. Its local MCP transport uses loopback and an ephemeral token.

Try this prompt with a connected agent:

> Use AI-Worker for this task. Use the active project as the workspace, read only the relevant files, and report the source paths. If a change is needed, show me the proposed write in AI-Worker and wait for my approval.

For agent-specific instructions, see the [OpenCode configuration](../opencode.json) and [Copilot custom agent](../.github/agents/ai-worker-readiness.agent.md). For a different local MCP client, configure its stdio server with the bundled `mcp/runtime/node` executable and `mcp/scripts/ai-worker-readonly-mcp.mjs` adapter path. The app's **AI Agents** page supports the host config formats listed above.

ChatGPT web and other remote-only clients cannot launch a local stdio server. They need an independently configured remote HTTPS MCP endpoint; AI-Worker's installer does not expose a tunnel. The MCP host receives task questions and completed results, and may use a remote model, so use a local host model when handoff text must remain on-device end to end.

## A2A v1.0 endpoint

Tauri also exposes a loopback A2A JSON-RPC endpoint for hosts with an A2A client:

- Discover the current endpoint with `GET http://127.0.0.1:<port>/.well-known/agent-card.json`. The public card contains capabilities and the current endpoint URL, but no bearer token or workspace data.
- Send authenticated JSON-RPC 2.0 requests to the card's `/a2a` URL with the ephemeral bearer token from the owner-protected `ai-worker-mcp-status.json` runtime snapshot. The port and token rotate when AI-Worker restarts. Keep the A2A client local; do not forward the token to a remote host.
- Supported methods are `SendMessage`, `GetTask`, `ListTasks`, and `CancelTask`. `SendMessage` blocks by default until completion or an input/approval pause; set `configuration.returnImmediately: true` to receive the current task and poll with `GetTask`.
- Messages are text-only. To pass the host-selected project, include `https://ai-worker.app/extensions/workspace/v1` in `message.extensions` and put `{ "capabilities": ["workspace"], "workspaceRoot": "/absolute/project/path", "handoffContext": { ... } }` under that same key in `message.metadata`. A task may also request public research with `capabilities:["workspace","web"]`, but only when public research is enabled in AI-Worker Settings. Search terms and requested URLs leave the device; fetched text and source URLs return to the A2A host. Keep private workspace content out of queries and URLs. A follow-up answer uses the same `taskId` and `contextId`; AI-Worker infers the context when the message includes only `taskId`.
- A proposed file write returns `TASK_STATE_AUTH_REQUIRED` and opens the compact review window. A2A cannot approve it. The host receives the final task artifact and source paths after completion.

Streaming, push notifications, attachments, shell actions, browser actions, and connected services are not implemented in this Tauri route. Public web research is supported only with the web capability and Settings opt-in described above. Task state remains in memory and is lost when AI-Worker exits. The Rust operation journal and TypeScript bridge remain future crash-recovery work; they do not yet recover interrupted Tauri writes. The MCP stdio bridge remains the tested connection for OpenCode/Codex/Copilot; A2A hosts must support JSON-RPC v1.0 and be able to read the local runtime snapshot to obtain the current bearer token.
