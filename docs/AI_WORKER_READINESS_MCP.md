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
| `start_agent_task` | Starts a bounded background task and returns a task ID. Reads are automatic inside the supplied workspace; a proposed write pauses for exact-content desktop approval. |
| `get_agent_task` | Reads task state, a pending parent question, or the completed result and sources. |
| `answer_agent_question` | Answers the exact question currently pending for a task so it can continue. |
| `cancel_agent_task` | Requests cooperative cancellation for a task. |

The Tauri task route is local-only: it rejects shell/browser actions, web research, and connected services. `run_agent_task` is read only. `start_agent_task` can propose a workspace file write; it pauses in `waiting_for_approval` until the user reviews the handoff, target path, current contents, and exact proposed contents in the compact window. A decline, window dismissal, cancellation, expiry, or stale file state applies no write. Workspace reads need no per-file approval. For workspace work, include `capabilities:["workspace"]`; the adapter defaults the root to its active working directory, or the host may pass `workspaceRoot`. Reads and proposed writes are confined to that workspace. Task prompts and file contents are not saved to AI-Worker chat or memory.

Use the asynchronous lifecycle for work that may need clarification: start once, poll status, relay `pendingQuestion` when state is `waiting_for_parent`, answer with that task and question ID, then poll for a terminal result. The synchronous `run_agent_task` remains available for simple tasks but cannot pause for a parent answer. Tasks live in process memory and are lost when AI-Worker exits or restarts. Cancellation is cooperative; a task may remain `cancelling` until an in-progress local generation stops. Do not treat it as cancelled until status says `cancelled`.

AI-Worker local-only mode never falls back to a cloud provider. Model imports or explicit setup can use the network. The MCP transport uses loopback only. However, the host receives the task result and the host's own model may be remote. Configure the host model locally if workspace contents must remain on-device end to end.

## Host setup

- [OpenCode configuration](../opencode.json) defines a local Ollama provider and an `ai_worker_parent` profile that starts and manages AI-Worker tasks. The `ai_worker_readonly` name remains for compatibility. Set `AI_WORKER_OLLAMA_MODEL` to an installed completion model when the default local choice is unsuitable; test model reliability with actual task prompts before relying on it.
- [Copilot custom agent](../.github/agents/ai-worker-readiness.agent.md) allowlists all seven tools, including the task lifecycle.
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

On the current development machine, a direct stdio MCP client verified all seven tools against a source-built Tauri instance: local inference, asynchronous start/status/result, cancellation, and the backward-compatible synchronous workspace read all worked. A real model-driven parent-question round trip did not complete: one cold task timed out and a follow-up clarification request failed before publishing a question. Rust tests cover the question/answer continuation. `opencode mcp list` reports the server connected, but OpenCode's local Qwen parent did not invoke `start_agent_task` within a two-minute run, so host-driven OpenCode delegation remains unverified on this model. OpenCode may also make its own startup or update network requests independently of AI-Worker; local Ollama keeps model prompts on-device but does not disable host networking.

The MCP host receives any task question and completed result, and may be remote. Loopback transport keeps the app endpoint local; it does not control what the host does with returned text. Use a local host model or do not delegate sensitive workspace contents to a remote host. Model setup/import can also use the network when explicitly requested.

## A2A v1.0 endpoint

Tauri also exposes a loopback A2A JSON-RPC endpoint for hosts with an A2A client:

- Discover the current endpoint with `GET http://127.0.0.1:<port>/.well-known/agent-card.json`. The public card contains capabilities and the current endpoint URL, but no bearer token or workspace data.
- Send authenticated JSON-RPC 2.0 requests to the card's `/a2a` URL with the ephemeral bearer token from the owner-protected `ai-worker-mcp-status.json` runtime snapshot. The port and token rotate when AI-Worker restarts. Keep the A2A client local; do not forward the token to a remote host.
- Supported methods are `SendMessage`, `GetTask`, `ListTasks`, and `CancelTask`. `SendMessage` blocks by default until completion or an input/approval pause; set `configuration.returnImmediately: true` to receive the current task and poll with `GetTask`.
- Messages are text-only. To pass the host-selected project, include `https://ai-worker.app/extensions/workspace/v1` in `message.extensions` and put `{ "capabilities": ["workspace"], "workspaceRoot": "/absolute/project/path", "handoffContext": { ... } }` under that same key in `message.metadata`. A follow-up answer uses the same `taskId` and `contextId`; AI-Worker infers the context when the message includes only `taskId`.
- A proposed file write returns `TASK_STATE_AUTH_REQUIRED` and opens the compact review window. A2A cannot approve it. The host receives the final task artifact and source paths after completion.

Streaming, push notifications, attachments, shell actions, browser actions, web research, and connected services are not implemented in this Tauri route. Task state remains in memory and is lost when AI-Worker exits. The Rust operation journal and TypeScript bridge remain future crash-recovery work; they do not yet recover interrupted Tauri writes. The MCP stdio bridge remains the tested connection for OpenCode/Codex/Copilot; A2A hosts must support JSON-RPC v1.0 and be able to read the local runtime snapshot to obtain the current bearer token.
