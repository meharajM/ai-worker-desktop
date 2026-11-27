---
name: ai-worker-readiness
description: Check AI-Worker readiness, use its on-device model, or hand off bounded workspace tasks with optional settings-gated public research.
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

Use `start_agent_task` for bounded local work. Include the task goal, findings, constraints, relevant project-relative paths, and concise handoff summary; omit secrets and unrelated conversation. Pass the host's absolute active project/worktree path as `workspaceRoot` and request the `workspace` capability for project access. Pass `handoffContext.workingDirectory` when known; otherwise the adapter defaults it to the selected workspace root. Do not rely on the MCP process working directory if the host root is available. AI-Worker uses its on-device model and bounded list/read/search within that root without per-file prompts. If the caller explicitly requests public web research, also request the `web` capability. Both that capability and the AI-Worker Settings opt-in are required. Search terms go to DuckDuckGo and requested public HTTPS URLs are fetched; fetched text and source URLs return to this MCP host, which may be remote. Keep private workspace content out of queries and URLs. Connected services remain unavailable. A proposed file write pauses in `waiting_for_approval`; the user reviews the task, workspace, current contents, and exact proposed contents in AI-Worker's compact review window. Decline, dismissal, cancellation, expiration, or stale file state must not write.

Poll `get_agent_task` until the task completes, fails, or is cancelled. If state is `waiting_for_parent`, relay the exact `pendingQuestion` to the parent and submit only its answer through `answer_agent_question`, with the same task ID and pending question ID. Use `cancel_agent_task` only when cancellation is requested. The compatibility tool `run_agent_task` still runs a task synchronously and cannot pause for a parent answer.

`get_runtime_status` reports app state, privacy mode, and model readiness. `ask_local` uses on-device inference only, without chat history, memory, files, tools, connected services, or cloud fallback. Tasks are kept in process memory only; restarting or quitting AI-Worker drops active tasks and results. Cancellation is cooperative and may remain `cancelling` while a local generation finishes. The MCP host receives the pending question and completed result and may be remote; use a local host model or do not delegate sensitive workspace content to a remote host. Do not claim the full request stayed on-device unless the host model is known to be local. Do not inspect repository files or infer private data outside the explicit task scope.
