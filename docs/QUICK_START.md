# Quick start

## Install

No Tauri installer release has been published yet. These commands and links will work after the first tagged build completes; until then, use [Developer setup](./setup.md).

macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/meharajM/ai-worker-desktop/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/meharajM/ai-worker-desktop/main/scripts/install.ps1 | iex
```

Or download a `.dmg`, `.exe`, `.AppImage`, or `.deb` from the [Tauri releases](https://github.com/meharajM/ai-worker-desktop/releases?q=tauri-v&expanded=true).

## Connect your agent

1. Open AI-Worker and choose **Connect an AI agent**.
2. Select Codex, Claude Desktop, Claude Code, Cursor, VS Code editor MCP, GitHub Copilot CLI, OpenCode, Gemini CLI, Windsurf, or Cline (CLI or VS Code).
3. Restart the selected agent.
4. Ask it: **“Use AI-Worker's `start_agent_task` for this request. Pass the active project root as `workspaceRoot`, include `capabilities:["workspace"]`, and send my full request. Poll `get_agent_task` until it finishes. Relay any question. If it waits for approval, ask me to review AI-Worker. Return the result and source paths.”**

If no on-device model is ready, follow **Set up a local model** in AI-Worker first. MCP task inference does not use cloud fallback. Your host agent may still use a remote model, and it receives the handoff prompt and result.

ChatGPT web requires a remote HTTPS MCP endpoint, which the local installer does not expose. See the [installation guide](./INSTALLATION.md) for platform details and troubleshooting.
