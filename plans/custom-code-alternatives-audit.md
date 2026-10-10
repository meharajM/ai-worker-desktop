# Custom code and open-source alternatives audit

Date: 10 October 2026. Static audit of the published `ai-worker-desktop` baseline `e56f8d2`. No dependency installation, runtime benchmark, or implementation performed.

Confirmed direction: offline local web UI inside a small Tauri app; macOS first, Windows next; CLI actions require confirmation in a selected workspace. The later macOS/Windows answer supersedes the earlier Linux answer.

## 1. Findings and priorities

The current app already has a React web interface. Reuse it selectively. The largest structural saving is replacing the Electron distribution and its Node service layer, then removing unused feature families. Replacing every small helper with another package would increase dependency surface without establishing a smaller application.

Measured source inventory, not runtime memory:

| Area | Files / source lines | Meaning |
| --- | --- | --- |
| Browser tool implementation | 21 files / 2,994 lines, plus 181-line PlaywrightService | Large custom layer over functionality offered by a maintained MCP server. |
| Old browser implementation | 1,813 lines | Candidate for deletion after import/reference checks; being present does not prove it runs. |
| Agent subsystem | 2,459 lines plus 1,231-line AgentRuntime and 592-line decomposer | Replace execution mechanics with one SDK; remove decomposition/reflection from the initial product. |
| Renderer MCP wrapper | 583 lines | Duplicated dispatch, path handling, logging and reconnect logic should shrink to one bridge adapter. |
| Memory adapters/privacy/migration | 8 files / 2,009 lines, plus MemoryService | A graph-memory subsystem is unnecessary for initial chat/file/CLI tasks. |
| Electron IPC / preload | 12 files / 1,256 lines; 213-line preload | Port only required commands to typed Tauri IPC; remove unused channels. |
| Filesystem service | 519 lines | Basic I/O has standard replacements; grants, reviewed writes and recovery remain product responsibilities. |
| WhatsApp service | 833 lines | Outside initial scope; remove instead of substituting another integration. |
| Package manifests | 34 production / 24 development direct dependencies; 1,256 resolved lockfile package entries | Includes development, optional and transitive packages. This is not an installed-size or memory measurement. |
| UI assets | About 0.5 MiB under renderer assets | Smaller than native runtimes; optimize after larger causes. |

Neither checkout currently has `node_modules`; there is no trustworthy installed dependency or application memory baseline from this audit.

## 2. Recommended replacements, by subsystem

Paths below identify inspected current code. Proposed replacements do not exist yet. Every removal requires caller/import and behavior checks.

| Current custom area | Decision / alternative | Remaining application code or limitation |
| --- | --- | --- |
| `main/index.ts`, `preload/index.ts`, `ipc/*`, electron-vite/build scripts | **Replace:** Tauri 2 core, typed commands and IPC Channels; plain Vite for web assets. | Small typed bridge, command ownership, capabilities and lifecycle wiring. No Node server or generic localhost bridge server. |
| Electron helpers, platform/version/window/openExternal wrappers | **Replace:** Tauri core and official opener/dialog APIs. | Validate link schemes, deny navigation/remote IPC, expose only needed methods. |
| Folder selection and drag/drop paths in `useFileDragDrop.ts` | **Replace plumbing:** official dialog and Tauri file-drop APIs. | Native picker creates a grant; browser `File.name` is never interpreted as an OS path. Bound ordinary browser uploads separately. |
| `FileSystemService` read/list operations and renderer path parsing | **Replace I/O:** Rust standard/Tokio filesystem operations behind grants. Official fs plugin is available where needed. | Native canonical paths, byte/count/type limits, symlink/junction checks and revocation. Do not expose broad frontend fs permissions. |
| File staging, review, commit and undo | **Retain a small product layer**, ported to Rust; reuse FileChangeReview UI. | Exact proposal approval, base hashes, conflict handling, journal/recovery and safe undo. A general filesystem MCP server does not provide these guarantees. |
| New CLI functionality | **Reuse:** official shell/sidecar support and Tokio process APIs; mature CLI programs for actual work. | Approved immutable executable/argv/cwd/env request, no shell interpolation, output/deadline limits, owned child cleanup. Cwd is not an OS sandbox. |
| Search / Git operations | **Reuse CLI:** ripgrep for bounded search; existing Git installation for selected read operations. | Register constrained actions, verify executable identity, disable pager/hooks/external helpers where applicable, handle missing helpers. Do not package Git by default. |
| `ipc/mcp.ts`, `_process` access, McpProcessManager, renderer reconnect/lane wrappers | **Replace protocol:** official Rust `rmcp`; use public child-process/client APIs. | Lazy connection registry, tool policy, deadline/cancellation and process-tree cleanup. No SDK private fields. |
| Built-in tool routing / name guessing / self-healing aliases | **Reduce:** one Rust ToolBroker, SDK tool schemas and typed arguments. | Explicit stable action names; one authority check before dispatch. Avoid guessing a server from strings containing “playwright”. |
| Dynamic MCP argument/schema validation | **Reuse:** Rust `jsonschema` in explicit offline mode for vetted catalog schemas; typed Serde arguments for built-ins. | Restrict references, size/depth/regex/compile work. The validator treats schemas as trusted code; do not accept arbitrary schemas from an unreviewed marketplace. [Security guidance](https://github.com/stranger6667/jsonschema/blob/master/SECURITY.md) |
| Custom browser tools, BrowserManager, stealth/humanMouse, old PlaywrightService | **Replace when browser is enabled:** official Microsoft `@playwright/mcp`. | Optional Node/browser installation, constrained tool exposure, dedicated browser profile, network policy and lifecycle. Core boot starts no browser. |
| Browser CLI alternative | **Consider later:** official Playwright CLI + skills for coding-oriented workflows. | Smaller tool context can help larger coding models, but general shell/skill interpretation is a poorer initial fit for small local models. Measure before switching. |
| `llm.ts`, provider wrappers, custom message/tool parsers | **Replace mechanics:** AI SDK Core + its OpenAI-compatible provider, talking to one local engine through Tauri. | Small bounded fetch/IPC adapter and model profile mapping. No default gateway, cloud probe or provider fallback. |
| AgentRuntime, extracted orchestration/special-tool services | **Replace:** one AI SDK bounded streaming tool loop behind existing `IAgentClient`. | Application limits, UI/session mapping, workspace/tool policy and approval stay explicit. SDK approval features alone are not native authorization. |
| Custom task decomposition, parallel sub-agents, continuation and MemoryReflector | **Remove from v1.** | One active task/inference. User starts another task explicitly after a bounded stop. No replacement framework. |
| `dcp.ts`, execution-lanes/resource-lock wrappers | **Keep only needed policy:** whole-turn context trimming; native queue/semaphore and cancellation primitives. | SDK stop conditions do not cover all elapsed-time, resource, output and cross-session limits. |
| Think-block regex repair / result reporters / plan-manager task files | **Remove from new execution path.** Use structured SDK/runtime content and real operation states. | Small UI presentation adapters; preserve existing chats containing those fields during import. |
| Vosk ModelManager/ModelServer and speech hooks/workers | **Remove from core.** | They manage speech, not LLMs. Voice can later use a separately evaluated offline engine; no voice runtime is bundled now. |
| Ollama-specific model/download wrappers, WebLLM workers | **One proposed owned engine:** pinned `llama-server` + GGUF artifact, replacing both defaults after compatibility proof. | Explicit model acquisition/import, checksum/license verification and owned lifecycle. No dual-engine implementation. |
| MemoryService/Memento/server-memory/better-sqlite3 | **Remove graph memory from core.** Chat history uses IndexedDB; settings use official Tauri store. | Versioned export/import and storage-error handling; user-saved notes may be ordinary workspace files. No embeddings/vector DB/background inference. |
| electron-store interop wrapper and store IPC | **Replace:** official Tauri store for a fixed app-owned settings file. | Whitelisted preference keys; no arbitrary store paths or model-granted permissions. |
| safeStorage/browser localStorage secret fallback | **Remove from local core.** | Runtime auth is ephemeral and native-owned. Preserve old secret files untouched; never export/decrypt them as part of migration. A later credential feature needs OS-backed storage with no plaintext fallback. |
| Firebase auth/sync, Antigravity/OAuth/provider credentials | **Remove from production local build.** | No account or cloud profile needed. Keep the published credential sanitization in history. |
| WhatsApp/Baileys/QR bridges and stores | **Remove from v1.** | Messaging would need a separate user-approved scope and integration; no new messaging package. |
| DependencyService and automatic setup scripts | **Replace:** small capability manifest with runtime/helper availability per feature. | No global Node/Python/uv/browser requirement; explicit optional installation only. |
| MarkItDown/document conversion | **Reuse optionally:** Microsoft MarkItDown CLI/MCP. | Python and format libraries cost disk/RAM; not bundled or auto-started. Initial files are UTF-8 text/Markdown/JSON/CSV. |
| `sharp`/media helpers / image conversion | **Remove unused native dependency from core.** Use browser APIs for bounded preview only if retained. | Multimodal input is separately budgeted/certified; do not preload images or vision adapters for text tasks. |
| React/Zustand/Tailwind/primitives/markdown UI | **Keep existing mature libraries.** | No UI-framework rewrite alongside Tauri. Sanitize rendered output/URLs; reuse accessible components. |
| Framer Motion and full Prism syntax highlighter import | **Reduce:** CSS transitions and plain code rendering; optionally lazy-load selected syntax languages. | Verify needed interactions/accessibility. `FormattedText.tsx` currently imports full Prism; actual shipped saving requires bundle measurement. |
| Formik/Yup/feature-flag experiments/prompt libraries | **Keep only reachable core use; otherwise remove.** | No blanket replacement with another forms/flags framework. Keep a few curated prompts and compile-time product scope. |
| Source-substring regression tests / Electron E2E launch helpers | **Replace affected checks:** Rust behavior tests, web bridge fixtures, native Tauri smoke tests. | Existing Playwright can test web UI in development. Current Tauri docs also describe WebdriverIO native support; test-only plugins must never ship. |
| Custom release/upload scripts and old repository URLs | **Replace:** Tauri packaging and a minimal macOS/Windows build workflow. | Signing/notices, clean-machine install/update, legacy-data protection; publishing remains separately authorized. |

The inventory covers application subsystems, not a claim that every helper/function was exhaustively verified. Small React utilities, prompts and domain-specific policy should remain when deleting them would require a larger replacement.

## 3. Shortlist, licenses, and stability evidence

Snapshot from official repositories/releases and registry metadata on 10 October 2026. These versions are **candidate pins**, not a tested compatible stack. A recent release or a large star count does not prove reliability.

| Candidate | Observed release/version | License / selection reason |
| --- | --- | --- |
| Tauri | `tauri-v2.12.2`, 9 October 2026 | MIT / Apache-2.0; maintained desktop bridge using system WebViews. Pin matching official plugins and a supported Rust toolchain. [Repository](https://github.com/tauri-apps/tauri), [process model](https://tauri.app/concept/process-model/) |
| Rust MCP SDK | `rmcp-v3.5.1`, 5 October 2026 | Official protocol library. Current LICENSE documents a transition from MIT to Apache-2.0; preserve notices for the exact pinned package/transitives. Select only required transports/features. [SDK](https://github.com/modelcontextprotocol/rust-sdk), [license](https://github.com/modelcontextprotocol/rust-sdk/blob/main/LICENSE) |
| AI SDK Core / OpenAI-compatible provider | npm `ai@7.0.137` / `@ai-sdk/openai-compatible@3.0.67` | Apache-2.0; reuses TypeScript UI skills and protocol/stream/tool mechanics. Browser/WebView + custom bridge compatibility is a mandatory early proof. [SDK](https://github.com/vercel/ai), [custom fetch](https://ai-sdk.dev/providers/openai-compatible-providers) |
| llama.cpp | `v0.6.0`, 5 October 2026 | MIT; native server and GGUF runtime with platform backends. Rapidly evolving: pin complete binary/library assets and exact tool template. [Repository](https://github.com/ggml-org/llama.cpp), [tool templates](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md) |
| Playwright MCP | `v0.0.83`, 28 September 2026 | Apache-2.0; replaces custom browser implementation. Pre-1.0 package: optional, pinned, regression checked. [Official server](https://github.com/microsoft/playwright-mcp) |
| ripgrep | `15.2.0`, 15 July 2026 | MIT / Unlicense; native search. Only bundle if measured size/use warrants it; otherwise detect/import explicitly. [Repository](https://github.com/BurntSushi/ripgrep) |
| MarkItDown | `v0.1.8`, 21 September 2026 | MIT; official converter. Optional due to Python/format dependencies and pre-1.0 changes. [Repository](https://github.com/microsoft/markitdown) |

**Alternative evaluated:** Rig (`v0.44.0`, MIT) supplies Rust agent/provider/MCP integrations. It is a reasonable fallback if the browser SDK proof fails or its total adapter/asset cost exceeds the budget. It moves execution into Rust and needs UI adaptation; do not implement Rig and AI SDK together. Context7 currently shows facade/agent module migrations, reinforcing the need to pin and check the exact version. [Rig](https://github.com/0xPlaygrounds/rig)

LangChain/LangGraph, Python agent servers, a Node sidecar running all existing Electron services, and a second frontend framework are not selected: their execution models introduce work or runtime prerequisites the requested small bridge does not need. This is an architecture-fit decision, not a measured speed comparison.

## 4. Why MCP everywhere is not automatically smaller

- Prefer an in-process Rust library when it provides the needed function. Core workspace tools can share one native policy implementation and MCP-compatible schemas; they need no separate local JSON-RPC server/process.
- Use `rmcp` for actual external MCP sessions. Stdio is the initial local transport; enable HTTP only for an explicitly selected integration.
- Reuse a CLI when its implementation is mature and an approved structured action can call it safely. Do not write an MCP wrapper around every command just to spawn another process.
- The official MCP server collection labels its servers as reference/educational implementations rather than production-ready solutions. Filesystem/git/memory references therefore need evaluation and are not a wholesale replacement for the app's authority layer. [Official server guidance](https://github.com/modelcontextprotocol/servers)
- A third-party MCP process runs with OS privileges of the invoking user unless separately sandboxed. Roots, tool descriptions and `readOnlyHint` are protocol information, not confinement. Native confirmation/cwd checks do not sandbox arbitrary child code.
- Playwright MCP requires Node and a browser; its own documentation says it is not a security boundary. Its footprint and network access must be included when enabled. [Requirements and security](https://github.com/microsoft/playwright-mcp)

## 5. Footprint accounting and acceptance

Report separately: (A) Tauri executable + bundled web UI; (B) system WebView prerequisites and app-attributable WebView processes; (C) optional MCP/CLI/helper binaries, packages, caches and processes; (D) inference engine/libraries, model weights, KV cache and inference process. Report total installed/download footprint and total task memory too. The user's model exclusion applies to category D, not to browsers, Node, Python, settings/history or helper processes.

Proposed targets, not observed results: compressed A <=25 MiB, initial web JS+CSS gzip <=750 KiB, native bridge idle <=40 MiB, A+B idle app memory <=200 MiB, app idle CPU <=0.5% over 60 seconds, no optional/model process at boot, usable UI <=2 seconds on named reference machines. Publish OS-specific memory metrics and attribution; do not sum shared memory twice.

Windows WebView2 may need installation. Default small installer uses an existing Evergreen WebView2 or explicit prerequisite setup; offline installation on a clean machine needs a separate larger payload. Do not hide that cost or claim that an offline-running app requires no initial downloads. [Windows installer modes](https://tauri.app/distribute/windows-installer/)

The largest expected savings are removing bundled Chromium/Node, eager optional services, duplicate browser code, unused native dependencies and repeated whole-chat persistence. Actual savings remain unmeasured; source deletion alone cannot establish them.

## 6. Migration/release constraints

Preserve the old user-data directory. Electron localStorage/LevelDB is not directly readable as Tauri localStorage: add a versioned export path before removing Electron, then import only chat/settings into the new app. Do not copy encrypted credentials or turn old path/auto-approval fields into trusted grants. Use a distinct new storage namespace until migration and rollback are demonstrated.

Keep the old implementation runnable during migration, but exclude it from the new production bundle. Remove feature families and Electron tooling only after new paths pass their checks. Update Electron-specific repository rules for Tauri during implementation; user-directed shell migration supersedes those old framework assumptions, while authority/validation/data-protection requirements remain.

Next: execute the early compatibility and footprint proof in the [revised task cards](./luna-implementation-cards.md), then follow the [current product plan](./local-desktop-product-plan.md).
