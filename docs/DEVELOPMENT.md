# Development

Use [Developer setup](./setup.md) to install prerequisites, run Tauri locally, or build a platform installer. End users should follow [Install AI-Worker](./INSTALLATION.md).

## Main areas

- `src-tauri/` — Tauri shell, local inference runtime, MCP bridge, agent-config setup, and native commands
- `src/renderer/` — React UI
- `scripts/ai-worker-readonly-mcp.mjs` — stdio adapter used by local MCP hosts
- `scripts/prepare-tauri-runtime.mjs` — adds the matching Node runtime to the Tauri resources before dev/build
- `.github/workflows/release-tauri.yml` — cross-platform installer release workflow

Start the app from source with:

```sh
npm ci
npm run tauri:dev
```

Build the native installer for the current platform with:

```sh
npm run tauri:build
```

The current end-user app is Tauri. Electron sources and their publishing scripts remain in the repository during the migration and are not used by the Tauri installer workflow.
