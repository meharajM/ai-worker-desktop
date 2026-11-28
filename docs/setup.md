# Developer setup

End users should use the [installer](./INSTALLATION.md) after the first Tauri release is published. No Tauri installer release is available yet; this page is for developers running AI-Worker from source.

## Prerequisites

- Node.js 22.12 or newer and npm
- Rust 1.90 or newer
- The platform-specific Tauri prerequisites for [macOS, Windows, or Linux](https://v2.tauri.app/start/prerequisites/)

Python, `uv`, and a separate Node install are not needed by an installed user. A source build includes the local MCP adapter and prepares a matching Node runtime under `.build/tauri-runtime/`.

## Run locally

```sh
git clone https://github.com/meharajM/ai-worker-desktop.git
cd ai-worker-desktop
npm ci
npm run tauri:dev
```

Tauri's dev hook prepares the MCP runtime and builds the frontend. Install or start Ollama and use Settings to install a compatible model when requested. Model downloads are network activity. Apple Silicon development builds also expose an experimental pinned llama.cpp candidate; release builds currently use Ollama.

## Build a local installer

```sh
npm run tauri:build
```

The platform installer is written under `src-tauri/target/release/bundle/`. Tauri release builds run from `tauri-v<package-version>` tags using [.github/workflows/release-tauri.yml](../.github/workflows/release-tauri.yml). It publishes `.dmg` files for both Mac architectures, a Windows x64 `.exe`, and Linux x64/ARM64 `.AppImage` packages. Linux builds also create `.deb` files.

## Connect local agents

Open **Settings → AI Agents** in the app to add or remove AI-Worker from Codex, Claude Desktop, Claude Code, Cursor, VS Code editor MCP, GitHub Copilot CLI, OpenCode, Gemini CLI, Windsurf, or Cline (CLI or VS Code). Restart a host after changing its configuration. The app modifies only its own MCP entry and leaves other entries alone.
