# AI-Worker

AI-Worker is a local desktop chat app built with a small Tauri native bridge and an offline web UI. The current app connects Assistant UI to a LangChain/LangGraph chat flow and a pinned Qwen3 1.7B local development candidate. Model setup is explicit; inference runs locally.

The chat keeps bounded conversation history in IndexedDB, supports Stop, and applies a native RAM reserve policy before and during model startup. The 3 GiB peak estimate and macOS `memory_pressure` heuristic are provisional and uncalibrated. One real UI-to-graph-to-native-to-model response succeeded on a 16 GiB Apple Silicon development Mac; that is one E2E run, not repeatable or certified hardware evidence. The current packaged Tauri app interaction/restart matrix remains unverified. 8 GiB Mac and Windows evidence are open.

The current Tauri app does not provide voice, cloud providers, WhatsApp, MCP, filesystem access, CLI actions, or browser tools. Those remain roadmap work or legacy Electron capabilities. Historical Electron source, data, and dependencies remain in the repository during migration.

## Develop

Prerequisites: Node.js ≥22.12, npm, Rust toolchain, and platform build tools. macOS requires Xcode Command Line Tools. Windows requires MSVC C++ build tools and WebView2. Tauri's `beforeDevCommand` and `beforeBuildCommand` run `npm run web:build`.

```sh
npm install
npm run tauri:dev
```

Key scripts:

| Script | Purpose |
| --- | --- |
| `tauri:dev` | Run Tauri desktop app in development |
| `tauri:proof` | Launch isolated proof app |
| `tauri:build` | Build Tauri app when platform llama runtime resources are staged |
| `tauri:prepare:runtime` | Prepare pinned macOS arm64 llama runtime |
| `tauri:build:mac:arm64` | Prepare verified macOS arm64 runtime and build app |
| `web:typecheck` | Typecheck Tauri web UI |
| `web:build` | Build Tauri web assets |
| `web:proof-build` | Build proof web assets |
| `test:rust:chat` | Run focused Rust chat tests |
| `test:rust:proof` | Run focused Rust proof tests |

`tauri:build` expects this checkout to already contain the target platform’s staged llama runtime resources. `tauri:build:mac:arm64` prepares the verified macOS arm64 runtime first; Windows and Linux runtime preparation is not available yet.

See [Quick Start](./docs/QUICK_START.md), [Development](./docs/DEVELOPMENT.md), and the [docs index](./docs/README.md).

## Reusable operation journal

The [MIT Rust journal](./crates/local-operation-journal/) and [TypeScript bridge](./packages/local-operation-journal-bridge/) provide immutable proposals, expiring approvals, single-use execution claims, and explicit crash reconciliation. Both packages are provisional and unpublished. The TypeScript runtime has no dependencies; Rust is independent of Tauri. App host integration is planned at M21/J01 after read-only workspace work; see [integration cards](./plans/operation-journal-integration.md).

## Roadmap and history

The [chat-first plan](./plans/chat-first-delivery.md) and [implementation cards](./plans/luna-implementation-cards.md) track current work. Next: M16b real model/resource/cancel/repeated-cycle/quit-cleanup proof per matching hardware; M07 attachments and M08/M09 explicit legacy export/import; then M16c chat-only beta. Later phases add read-only workspace tasks, reviewed file changes, confirmed CLI, optional curated MCP, and release certification.

Legacy Electron feature guides and dated research remain for migration context; they do not describe current Tauri capabilities.

Contributing: [guide](./CONTRIBUTING.md) · [issues](https://github.com/meharajM/ai-worker-desktop/issues) · [security](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md).
