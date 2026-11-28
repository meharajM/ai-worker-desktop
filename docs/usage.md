# Use AI-Worker from an AI agent

AI-Worker is a local MCP worker for coding agents. Connect it once from **AI-Worker → Settings → AI Agents**, then restart the host agent. The app bundles the MCP adapter and Node runtime, so the host config does not need Node or a source checkout.

One-click host setup detects supported clients and lets you connect Codex, Claude Desktop, Claude Code, Cursor, VS Code editor MCP, GitHub Copilot CLI, OpenCode, Gemini CLI, Windsurf, and Cline (CLI or VS Code). For manual setup or another local MCP client, use the [MCP host guide](./AI_WORKER_READINESS_MCP.md). ChatGPT web requires a remote HTTPS MCP endpoint; AI-Worker's local installer does not expose one.

## Ask the host agent to delegate

Try this prompt in your coding agent:

> Use AI-Worker's `start_agent_task` for this request. Pass the active project root as `workspaceRoot`, include `capabilities:["workspace"]`, and send my full request. Poll `get_agent_task` until it finishes. Relay any question. If it waits for approval, ask me to review AI-Worker. Return the result and source paths.

The host must pass the active project's absolute root and request workspace capability. The MCP guide describes the full asynchronous flow for starting a task, answering follow-up questions, polling status, and cancellation.

## Local model setup

MCP task inference uses a local Ollama model in release builds and never falls back to a cloud model. Apple Silicon development builds expose an experimental pinned llama.cpp candidate. If no local model is ready, choose **Set up a local model** in AI-Worker and follow the on-screen steps. Model downloads happen only when requested.

The connected host receives the task prompt and completed result. If the host uses a remote model, it can process that text remotely even though AI-Worker's inference is local. Use a local host model for end-to-end local processing.

## Review changes

Workspace reads are scoped to the root chosen by the host. A proposed write pauses in the AI-Worker desktop window and shows the target path, existing contents, and exact proposed contents. The file is written only after you approve it.
