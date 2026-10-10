# M00 — Tauri Migration Baseline

Status: checked for this host; Tauri implementation not started.

## Measured source and tool baseline

| Area | Measured |
|---|---|
| Current desktop host | Electron 40, React 18.2, TypeScript 5.3, electron-vite 5, Vite 7.3 (root `package.json`) |
| App scripts | `dev`, `build`, `typecheck`, `lint`, existing mock/real E2E commands, Electron packaging scripts |
| Host | macOS 26.6.2, Apple Silicon arm64 (`uname` reports arm64; Darwin arm64 kernel) |
| Memory | 16 GiB (`hw.memsize` = 17,179,869,184 bytes) |
| Node/npm | Node v24.7.0; npm 11.5.1 (npm reports unknown project config `playwright_skip_browser_download`) |
| Rust | rustc 1.94.1; cargo 1.94.1; installed targets `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` (cross-target presence is not host compatibility evidence) |
| Native tooling | `/usr/bin/xcodebuild` exists; no Tauri CLI found on PATH |
| Dependencies | Root `node_modules/` absent. Journal crate build cache exists. No Windows or Intel Mac host evidence was available in this checkout/session. |
| Migration state | No `src-tauri/`, Tauri config, or capabilities files found. Existing Rust operation journal and TypeScript bridge are standalone; no desktop integration. |

The checkout is at execution base `26e4845585707579b43d472a0f1812c91dfe99ae` on `codex/tauri-web-migration` before M00 edits. There are no prerequisite cards (M00 depends on none). Current app code and existing npm scripts remain Electron-specific.

## Proposed versus measured

| Topic | Measured today | Target/proposed, not yet verified |
|---|---|---|
| Desktop shell | Electron main/preload/renderer architecture runs today. | Small Tauri host with React WebView and Rust native services. |
| Native boundary | Electron preload API maps renderer calls to IPC handlers and services. | Typed frontend bridge → validated Tauri command → native service. Capabilities/scopes restrict exposed command/resource access; Rust still validates and authorizes inputs before OS access. |
| Agent seam | `IAgentClient` interface exists; current implementation is `AgentRuntime`. | Keep `IAgentClient`; frontend remains decoupled from Tauri and Rust. |
| Tool dispatch | `executeToolCall` in `src/renderer/src/lib/mcp.ts` is the current choke point, used by agent callers. | Migrate behavior into one `ToolBroker` seam. Do not create parallel tool dispatch or production capability bypass. |
| Local operation journal | Standalone MIT Rust crate and dependency-free TypeScript bridge exist. | Integration and crash recovery behavior remain future work. |
| Performance/platform scope | One 16 GiB Apple Silicon Mac measured. | Minimum release RAM, Intel Mac support, and Windows compatibility/evidence are unanswered. Do not claim support or resource targets until measured on target hardware. |

Tauri security guidance was checked using Context7 (`/tauri-apps/tauri-docs`): frontend WebViews have access only through exposed IPC; Rust application/plugin code has full host access; command permissions/capabilities and scopes gate IPC, while command implementations remain responsible for interpreting and enforcing scope. This supports keeping validation and OS authority in native services.

## Existing app data and destructive commands

Existing user data is spread across Electron `userData`, renderer `localStorage`, and a home-directory workspace. Code references include:

- Electron `userData`: `memory/` and legacy `memory.db`, WhatsApp auth, Playwright persistent profiles, filesystem staging, logs, and task fallback files.
- `~/.ai-worker/system-workspace/`: internal task/workspace files; workspace-local `.ai-worker` paths also have legacy handling.
- Renderer `localStorage`: chat sessions (`ai-worker-chat-v3`), settings/auth and MCP-related state, WhatsApp state, and development flags.
- Electron `safeStorage` encrypts allowlisted secrets when available; its documented fallback stores plaintext in `electron-store`, and the browser fallback in `src/renderer/src/lib/electron.ts` writes secrets to `localStorage` and identifies itself as insecure. Migration must preserve published credential sanitization and must not copy secrets into renderer storage as a convenience.

Do not use `npm run clean:state` or `npm run dev:clean`: `clean:state` recursively removes `~/Library/Application Support/AI-Worker`, and `dev:clean` invokes it. `clean` removes generated `out/` and `dist/`; `clean:native:build` removes selected native build caches. Build/rebuild and publish scripts also clean output paths; publishing scripts are out of scope. None were run.

## Checks run

- `cargo fmt --manifest-path crates/local-operation-journal/Cargo.toml -- --check` — passed.
- `cargo test --offline --manifest-path crates/local-operation-journal/Cargo.toml` — command passed; crate currently contains zero unit tests and zero doc tests (0 passed, 0 failed). This is compile evidence, not behavioral coverage.
- `npm run typecheck` — unavailable: `tsc: command not found` because root `node_modules/` is absent.
- `npm run lint` — unavailable: `eslint: command not found` for the same reason.
- `git diff --check` — passed before commit.

No dependencies were installed. No models were downloaded, user data touched, cloud/real-user E2E run, app published, or old upstream modified.

## Rule and architecture adaptations

- `.agents/rules/core-security.md` keeps Electron requirements for the current host and adds Tauri WebView, capability/scope, native validation, and data-protection requirements.
- `.agents/rules/process-architecture.md` keeps current Electron layering and defines the proposed Tauri command/native-service boundary without implying it exists.
- `.agents/rules/ai-agent-architecture.md` clarifies that the `IAgentClient` seam survives host migration.
- `.agents/rules/mcp-tools.md` preserves one tool choke point: current `executeToolCall`, future single `ToolBroker` seam.
- `architecture.md` records M00 status and links this measured/proposed baseline.

## Open compatibility gates

- Minimum supported RAM and release performance target are not decided/measured.
- Intel Mac target hardware is unavailable; universal/Intel behavior is not verified.
- Windows target machine/evidence is unavailable; cross-compile target presence is not a Windows compatibility result.
- No Tauri host exists yet, so native permission behavior, packaging, and parity remain unverified.
