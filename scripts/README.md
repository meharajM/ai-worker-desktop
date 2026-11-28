# Installer and build scripts

## User installers

- `install.sh` downloads the latest Tauri installer for macOS or Linux, verifies its SHA-256 sidecar, installs it, and launches AI-Worker.
- `install.ps1` does the same for the per-user Windows installer.
- `install-mac.sh`, `install-linux.sh`, and `install-windows.ps1` are platform-specific aliases for those two scripts.
- `prepare-tauri-runtime.mjs` adds the matching Node.js executable and license to the Tauri app resources. Cross-target macOS builds download the matching official Node archive and verify its published SHA-256 before bundling.

Developer install commands:

```sh
curl -fsSL https://raw.githubusercontent.com/meharajM/ai-worker-desktop/main/scripts/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/meharajM/ai-worker-desktop/main/scripts/install.ps1 | iex
```

The app's **Settings → AI Agents** page configures supported local MCP hosts. Neither installer requires Node.js, Python, or `uv` on the end user's machine.

## Package locally

Install Node.js 22.12+ and Rust 1.90+, then:

```sh
npm ci
npm run tauri:dev
npm run tauri:build
```

Tauri's build hooks prepare the bundled MCP runtime and build the frontend. Release builds run in [release-tauri.yml](../.github/workflows/release-tauri.yml) on macOS, Windows, Linux x64, and Linux ARM64 runners. Create and push `tauri-v<package-version>` to start a Tauri prerelease build.

The older Electron build and Cloudflare publication scripts remain for the in-progress migration; they are not the user installer path documented here.
