# Install AI-Worker

The Tauri release workflow builds installers for macOS, Windows, and Linux. No Tauri installer release has been published yet; until the first tagged build completes, use the source instructions below. The release bundle includes the MCP adapter and Node runtime, so end users will not need Git, Node.js, Rust, Python, or `uv`.

## Install from a terminal

After the first Tauri release is published, macOS or Linux users can run:

```sh
curl -fsSL https://raw.githubusercontent.com/meharajM/ai-worker-desktop/main/scripts/install.sh | bash
```

After the first Tauri release is published, Windows users can run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/meharajM/ai-worker-desktop/main/scripts/install.ps1 | iex
```

The script detects your operating system and CPU, downloads the matching current Tauri installer, checks its SHA-256 file, and installs it. macOS installs to `/Applications` when writable or `~/Applications`; Linux installs the AppImage under `~/.local/bin`; Windows starts the per-user installer.

## Download an installer

Once published, use the [AI-Worker Tauri releases](https://github.com/meharajM/ai-worker-desktop/releases?q=tauri-v&expanded=true) to download an installer directly:

| Platform | Installer |
| --- | --- |
| macOS Apple silicon | `.dmg` |
| macOS Intel | `.dmg` |
| Windows x64 | per-user `.exe` setup |
| Linux x64 or ARM64 | `.AppImage` or `.deb` |

The workflow publishes Tauri builds on a separate prerelease channel while the repository completes its Electron-to-Tauri transition. That keeps the existing public release channel intact.

## First launch

1. Open AI-Worker.
2. Install or start Ollama, then choose **Set up a local model** if needed. Current release builds use Ollama for local inference and do not fall back to a cloud model.
3. Choose **Connect an AI agent** on the welcome screen, or open **Settings → AI Agents**.
4. Connect one or more installed agents, then restart each agent.
5. In the agent, ask it to use AI-Worker for a bounded task in the active project. For workspace access, the host must grant the project root. A proposed file write pauses for your review in AI-Worker.

The one-click setup detects supported clients and lets you add AI-Worker to Codex, Claude Desktop, Claude Code, Cursor, VS Code editor MCP, GitHub Copilot CLI, OpenCode, Gemini CLI, Windsurf, and Cline (CLI or VS Code). It adds only an AI-Worker MCP entry to the selected host's user configuration. ChatGPT web needs a remote HTTPS MCP endpoint; this installer does not create or expose a tunnel.

## Troubleshooting

- **The agent does not show AI-Worker tools:** restart the agent after connecting it; check that its config path is writable.
- **The app reports that no local model is ready:** install or start Ollama, then use Settings to install a compatible Ollama model. AI-Worker starts model downloads only after you request them.
- **Linux reports a FUSE error:** install your distribution's AppImage/FUSE support or use the matching `.deb` package.
- **The first launch is blocked by macOS or Windows:** the release needs platform signing and notarization credentials to remove operating-system publisher warnings. If a build is unsigned, use the OS's explicit open/run confirmation; do not disable its security checks globally.

Developers building from source should follow [Development](./DEVELOPMENT.md). The separate [MCP guide](./AI_WORKER_READINESS_MCP.md) covers host behavior and manual setup.
