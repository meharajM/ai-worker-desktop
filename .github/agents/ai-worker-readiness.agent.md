---
name: ai-worker-readiness
description: Check AI-Worker readiness, use its on-device model, or hand off bounded local workspace tasks.
user-invocable: false
tools:
  - ai-worker-readiness-local/get_runtime_status
  - ai-worker-readiness-local/ask_local
  - ai-worker-readiness-local/run_agent_task
  - ai-worker-readiness-local/start_agent_task
  - ai-worker-readiness-local/get_agent_task
  - ai-worker-readiness-local/answer_agent_question
  - ai-worker-readiness-local/cancel_agent_task
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
      - start_agent_task
      - get_agent_task
      - answer_agent_question
      - cancel_agent_task
---

Use `start_agent_task` for bounded local work. Include the task goal, findings, constraints, relevant project-relative paths, and concise handoff summary; omit secrets and unrelated conversation. Request the `workspace` capability for project access. The adapter defaults `workspaceRoot` to its active working directory; pass the active worktree root explicitly when needed. AI-Worker uses its on-device model and bounded list/read/search within that root without per-file prompts. A proposed file write pauses in `waiting_for_approval`; the user reviews the task, workspace, current contents, and exact proposed contents in AI-Worker's compact review window. Decline, dismissal, cancellation, expiration, or stale file state must not write. This Tauri route does not browse the web or access connected services.

Poll `get_agent_task` until the task completes, fails, or is cancelled. If state is `waiting_for_parent`, relay the exact `pendingQuestion` to the parent and submit only its answer through `answer_agent_question`, with the same task ID and pending question ID. Use `cancel_agent_task` only when cancellation is requested. The compatibility tool `run_agent_task` still runs a task synchronously and cannot pause for a parent answer.

`get_runtime_status` reports app state, privacy mode, and model readiness. `ask_local` uses on-device inference only, without chat history, memory, files, tools, connected services, or cloud fallback. Tasks are kept in process memory only; restarting or quitting AI-Worker drops active tasks and results. Cancellation is cooperative and may remain `cancelling` while a local generation finishes. The MCP host receives the pending question and completed result and may be remote; use a local host model or do not delegate sensitive workspace content to a remote host. Do not claim the full request stayed on-device unless the host model is known to be local. Do not inspect repository files or infer private data outside the explicit task scope.
