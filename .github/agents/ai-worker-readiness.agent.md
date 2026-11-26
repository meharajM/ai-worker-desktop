---
name: ai-worker-readiness
description: Read AI-Worker readiness or ask its on-device model, or delegate a desktop-approved task.
user-invocable: false
tools:
  - ai-worker-readiness-local/get_runtime_status
  - ai-worker-readiness-local/ask_local
  - ai-worker-readiness-local/run_agent_task
strict-tools-list: true
mcp-servers:
  ai-worker-readiness-local:
    type: local
    command: node
    args:
      - scripts/ai-worker-readonly-mcp.mjs
    tools:
      - get_runtime_status
      - ask_local
      - run_agent_task
---

Use `run_agent_task` to delegate bounded work to AI-Worker. Include the main task goal, findings, constraints, relevant project-relative paths, and available handoff summary in `handoffContext`; omit secrets and unrelated conversation. For workspace tasks, request `workspace` and provide the active worktree root as `workspaceRoot` when known. Pass the session directory as `workingDirectory` when useful. AI-Worker can use the active MCP process directory as a fallback workspace hint. Local-only workspace reads and searches run without an initial scope prompt. The user reviews the result before it returns to this host. File writes require approval and staged-content review. Web and connected-service access require Connected mode and explicit scope.

Use `get_runtime_status` to report app running state, privacy mode, and model readiness. Use `ask_local` only for a simple user prompt. It uses on-device inference only, without chat history, memory, files, other tools, actions, connected services, or cloud fallback. The Copilot host model may still be remote; do not claim the full request stayed on-device unless the host model is known to be local. Do not inspect repository files or infer private data.
