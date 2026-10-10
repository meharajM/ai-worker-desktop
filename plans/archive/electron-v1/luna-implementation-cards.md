> Archived Electron-first draft. Superseded by the [current Tauri plan](../../local-desktop-product-plan.md). Preserved for rationale/history; do not dispatch these cards.

# Luna task cards: AI-Worker Desktop

Companion: [product plan](./local-desktop-product-plan.md). Status: draft; every card below is planned work, not completed work.

Repository base: `meharajM/ai-worker-desktop`, `main` at `e56f8d2`. Use this clean history. The old `ai-worker.app` checkout is not the execution base. Keep the published OAuth/test credential sanitization.

## How to dispatch a card

Paste the following header plus **one** card into a Luna coding turn. Do not paste the full architecture document or all these cards.

> Implement card `<ID>` only in the ai-worker-desktop checkout. Read applicable instructions, the named entry points, and their callers before editing. Confirm prerequisite cards are committed. Keep the existing Electron/React/IAgentClient structure. Normally change at most three production files plus one focused test and the relevant small architecture.md entry; split the task if it expands. Treat proposed paths below as proposed, not existing modules. Use current Context7 docs for any library/API configuration. Preserve data and credential sanitization; use temporary user-data/workspace directories in tests. Verify behavior, not copied logic or source-string matches. Run the listed focused check and `npm run typecheck` where source/types change. Do not run clean:state/dev:clean, cloud E2E suites, publish installers, or push to the old upstream. Report changed files, actual check results, remaining limits, and the next ready card. Commit only this card's files using a normal descriptive message. Stop and report a missing dependency/failed check without silently upgrading packages, changing runtimes, or broadening scope.

Each card's test filename is a proposed focused test. Extend an existing relevant test if it covers actual behavior. T00 establishes the minimal loader/harness using installed tooling; no extra test framework is required. Test commands must be made real when their cards are implemented.

Maintain card status in the implementation PR/commit notes: `not started → in progress → checks passed → reviewed`. Nothing in this document is pre-approved as passed. Give risky IPC/filesystem/runtime packets a separate review before release. Normally execute sequentially; the cards frequently share source files.

T21–T28 test tools before production certification. Inject candidate capability profiles only through the isolated test/evaluation harness, with synthetic files and temporary user-data/workspace grants; keep all main-process safety checks active. The shipping catalog stays chat-only until T29 passes. This avoids a dependency cycle between implementing tools and certifying them without adding a production bypass.

## Phase 0 — Lean local boot

### T00 — Capture a runnable, isolated baseline

**Depends on:** none. **Stories:** U1, U8.

**Read:** package scripts, existing Electron E2E launch setup, `.agents/rules/`, `App.tsx`, `main/index.ts`.

**Deliver:** `plans/reports/baseline.md` with exact commit/OS/tool versions, dependency/install issues, typecheck/build results, and current startup behavior. Establish a small `tests/helpers/local-harness.cjs` that launches the compiled app with a unique temporary user-data directory and a fake loopback server, and always disposes both. Use existing TypeScript tooling for service tests; do not copy implementation into fixtures.

**Check:** lockfile installation, `npm run typecheck`, `npm run build`, one isolated launch/quit. Capture existing failures accurately; do not fix unrelated ones in this card. Never run data-clean scripts. No real model, credentials, or user's saved profile.

### T01 — Add local defaults and preserve existing settings

**Depends on:** T00. **Stories:** U1, U8.

**Entry points:** `stores/settingsStore.ts`, `lib/constants.ts`, `lib/types.ts`.

**Change:** add explicit local execution mode and resource-preset setting; make new profiles local/Balanced by default. Version the stored settings migration; retain chats and old credential/settings fields without using them. Do not change application data directories/appId or auto-download a model. Keep mode separate from the existing provider picker during migration.

**Check:** `tests/local-settings.test.cjs` loads an empty profile and representative old persisted profiles, saves/reloads them, and proves no data loss. Invalid preset values fall back safely. Typecheck.

### T02 — Enforce local routing in the existing LLM caller

**Depends on:** T01. **Stories:** U1, U3.

**Entry points:** `lib/llm.ts`, `hooks/useLLMStatus.ts`, local-mode settings contract.

**Change:** local mode selects/checks only the selected local provider. Never invoke cloud health checks or fallback from local to cloud when Ollama is down. Avoid repeating provider/model enumeration on each agent iteration; cache local discovery with explicit invalidation. Handle invalid/unavailable local selection with a useful setup state.

**Check:** fake local HTTP responses plus spies on all cloud adapters prove zero cloud calls, even with old saved keys/auto settings. Unavailable daemon produces an actionable local error. Status UI and actual dispatch agree.

### T03 — Stop account and sync work during local boot

**Depends on:** T01. **Stories:** U1, U8.

**Entry points:** `hooks/useAuthPersistence.ts`, `hooks/useSettingsSync.ts`, `stores/authStore.ts`.

**Change:** local mode never initializes Firebase auth or cloud profile synchronization. Keep React hooks unconditional; guard effects/service calls internally or move optional features into a lazy component. Preserve old local data and account metadata; signing out must not be used as a destructive migration shortcut. Confirm static Firebase initialization does not still run through eager imports; split this card if import removal requires a separate small packet.

**Check:** isolated offline start and mode migration; no auth listener, remote hydration, or settings upload. Existing saved chats remain visible.

### T04 — Keep voice and WhatsApp asleep

**Depends on:** T01, T03. **Stories:** U1, U4.

**Entry points:** `App.tsx`, `hooks/useWhatsAppBridge.ts`, `components/VoiceInput.tsx` and its text-input child.

**Change:** core local boot uses the existing text input and Stop controls without loading recognition models, speech workers, WhatsApp UI, or connection listeners. Preserve accessibility, keyboard submission, attachments, and cancellation. Do not conditionally call hooks. Optional feature modules can remain in source until the pruning cards.

**Check:** launch/send/cancel/quit with no speech/WhatsApp child process or listener. Text entry and attachments work. Repeated mounts do not accumulate listeners.

### T05 — Make optional MCP startup explicit

**Depends on:** T01. **Stories:** U1, U4.

**Entry points:** `stores/mcpStore.ts`, `main/ipc/mcp.ts`, `lib/agent/AgentStateService.ts`.

**Change:** local startup does not autoconnect Playwright, memory reflection/backend services, MarkItDown, or user-defined stdio servers. Cached `autoConnect` values from older profiles must not bypass local mode. Built-in file tools are available after a workspace grant; agent state initialization must tolerate deferred optional memory. Do not spawn subprocesses just to enumerate capabilities.

**Check:** fake spawn/service spies on fresh and migrated profiles show no optional startup. Opening chat still works without external memory or browser. Optional service connection is only an explicit supported action.

### T06 — Replace the all-or-nothing dependency gate

**Depends on:** T04, T05. **Stories:** U1, U2.

**Entry points:** `main/services/DependencyService.ts`, `components/MissingDependenciesScreen.tsx`, `App.tsx`.

**Change:** core use checks only the local inference runtime when that capability is requested. Node/Python/uv/browser installs do not block typing into chat/settings. Show setup inside the local model flow; distinguish missing runtime from missing optional document/browser capability. Do not invoke setup-dependencies scripts automatically or require administrator privileges.

**Check:** simulated missing Node/Python/uv/browser installations still reach the core UI. Missing runtime gives a specific setup action; optional dependencies stay isolated. Typecheck.

### T07 — Restore the Electron security boundary

**Depends on:** T04, T06. **Stories:** U1, U5, U6.

**Entry points:** `main/index.ts`, renderer CSP entry (`src/renderer/index.html`), existing navigation/app IPC handlers.

**Change:** enable `webSecurity` and sandbox, preserve context isolation/no Node integration, remove obsolete experimental speech/file-access switches, deny unnecessary permissions, validate exact URL host/scheme and navigation, and close unsafe popup routes. If a remaining capability needs an exception, document its concrete reason and narrow mitigation; do not turn broad security off to repair a fetch.

**Check:** compiled-app smoke test exercises preload, links, denied navigation/popups/device permissions, and text input with secure defaults. Review this packet. Tests must assert behavior/configuration actually used at runtime.

## Phase 1 — Local streaming chat

### T08 — Settle typed IPC and request ownership

**Depends on:** T02, T07. **Stories:** U3.

**Entry points:** proposed `src/shared/local-llm.ts`, `preload/index.ts`, `main/ipc/llm.ts`.

**Change:** define LocalChatRequest/LocalChatEvent and shared channel constants; expose start, cancel, status, and unsubscribe-capable event mapping. Main validates request shape/size, trusted sender/frame, and owner before accepting work. Callbacks stay in renderer/preload, not serialized payloads. Add thin service delegation; no inference implementation in IPC handlers.

**Check:** unknown sender, malformed DTO, oversized body, duplicate request ID, and cancellation of another sender's request are rejected. Valid request and event identities survive the bridge. Typecheck.

### T09 — Implement the main local transport service

**Depends on:** T08. **Stories:** U3.

**Entry points:** proposed `main/services/LocalLlmService.ts`, `main/ipc/llm.ts`, renderer `lib/llm/ollama.ts`.

**Change:** put native Ollama HTTP in the service with injectable fetch for tests, a request-scoped AbortController, bounded timeouts, loopback IP validation, and redirect rejection. Resolve endpoint/settings in trusted main configuration. Make the renderer adapter delegate through preload instead of direct fetch. Begin with a final response before adding streaming. Do not import renderer types from main.

**Check:** fake server proves request dispatch, provider errors, daemon absence, remote URL/redirect rejection, and clean request disposal. No cloud call occurs on failures. Typecheck.

### T10 — Correct native message and tool translation

**Depends on:** T09. **Stories:** U3, U5.

**Entry points:** LocalLlmService, proposed small `main/services/ollama-protocol.ts`, existing shared/renderer message translation boundary.

**Change:** preserve assistant native `tool_calls`, complete function arguments, and named `tool_name` tool results. Keep visible content separate from any thinking. Normalize complete calls into stable `requestId:index` identities; two calls in one response must not collide. Retain protocol data through chat persistence/context trimming. No prose regex or invented JSON tool execution fallback.

**Check:** two native calls → two tool results → final reply reaches the fake server with exact structure and distinct IDs. Test Unicode, zero calls, malformed args, missing names, and prior assistant/tool messages. Typecheck.

### T11 — Decode streaming responses safely

**Depends on:** T10. **Stories:** U3.

**Entry points:** LocalLlmService, proposed protocol module.

**Change:** enable native streaming and parse NDJSON across arbitrary byte boundaries with a streaming UTF-8 decoder. Accumulate partial visible text and structured tool calls; emit exactly one terminal event with usage/timings. Never execute a partial tool call. Cap frame/aggregate size and handle runtime errors, malformed frames, EOF, and missing completion.

**Check:** `tests/local-llm-stream.test.cjs` sends split Unicode, several frames per chunk, split JSON, tool fragments, errors, and truncated streams. Done/error occurs once; malformed streams cause no tool execution.

### T12 — Render correlated, batched streaming text

**Depends on:** T11. **Stories:** U3, U4.

**Entry points:** `lib/agent/types.ts`, `hooks/useAgent.ts`, `stores/chatStore.ts` plus existing message rendering only if required.

**Change:** thread a local progress/delta callback through the existing agent interface/options; update one provisional assistant message by request/session identity. Batch UI updates; persist terminal output rather than the whole session every token. Never concatenate an inactive session's response into the current one. Dispose event subscriptions on finish, error, and unmount.

**Check:** streamed UI in two sessions, navigation during output, empty final message, and failure after partial output. Final assistant content is committed once and matches accumulated text. Typecheck.

### T13 — Make Stop cancel the actual request

**Depends on:** T12. **Stories:** U3, U4.

**Entry points:** LocalLlmService, `lib/agent-runtime.ts`, `hooks/useAgent.ts`/chat-store abort bridge.

**Change:** connect existing session Stop to the main request controller. Abort both HTTP and further agent work; reject late events/tool calls by terminal request state. Cancellation is idempotent. Destroying the window cancels owned requests. A runtime that continues compute after abort is a measured blocker for the owned-runtime release, not assumed stopped.

**Check:** cancel before start, during text, between tool turns, repeated cancel, server failure after cancel, and quit during inference. No further tool execution or file proposal occurs after Stop. Test timing against the target later on real hardware.

### T14 — Serialize inference across sessions

**Depends on:** T13. **Stories:** U3, U4.

**Entry points:** LocalLlmService, shared event contract, existing status/progress UI.

**Change:** use one application-wide active request and a bounded FIFO queue, preserving each session's history/owner. Queued items can be canceled without reaching the backend. Clear processing state on success, failure, abort, and sender destruction. Report queue position/busy state without spawning sub-agents.

**Check:** concurrent requests from two sessions never overlap at the fake server; canceling a queued item sends no HTTP; errors advance the queue; eleven additional queued requests are bounded/rejected according to policy. No leaked promise/controller/listener.

## Phase 2 — Models and resource controls

### T15 — Discover curated local models and record identity

**Depends on:** T14. **Stories:** U2, U7.

**Entry points:** proposed `shared/local-models.ts`, proposed `main/services/LocalModelService.ts`, `main/ipc/llm.ts`.

**Change:** define the small model catalog and ModelProfile contract. Read native tags/show metadata, installed digest, capability metadata, actual artifact details, and runtime compatibility. Validate local-only identity; reject cloud models/remote endpoints. Unknown models are chat-only. Advertised tool/vision support does not grant a certified task capability. Pin exact candidate artifacts before setup/evaluation; freeze recommended shipping profiles only after certification and measurement.

**Check:** local/unknown/cloud/incompatible models, changed digests, missing metadata, and discovery timeouts. No model download from discovery. Store no credentials or model output in diagnostic metadata.

### T16 — Add a simple model setup flow

**Depends on:** T15, T06. **Stories:** U2.

**Entry points:** LocalModelService, a small existing settings/onboarding view, typed preload model operations.

**Change:** show recommended candidate, license/source, artifact size, disk requirement, runtime state, and explicit Download action. Implement bounded native pull progress/cancel/retry and verify the finished installed identity before enabling chat. Reuse existing primitives. Interrupted setup stays recoverable; do not mark it installed because a partial blob exists. Do not pull `latest` or download on ordinary app launch.

**Check:** fake progress, interruption, disk shortage, mismatch, unavailable runtime, retry, and clear success state. A real small pull is a separate user-approved/manual setup check, not a routine unit test.

### T17 — Apply calibrated resource presets

**Depends on:** T15. **Stories:** U4.

**Entry points:** LocalLlmService, LocalModelService, local preset setting/UI.

**Change:** resolve Low impact/Balanced into trusted context/output/thinking/thread controls. Check available memory/model estimate before load and expose resource refusal/recommendation states. Include model/template/tool/schema budgets. Detect pressure without a high-frequency expensive polling loop. Thread count is a control to measure, not a CPU-percent guarantee. Do not silently switch/download models after a failure.

**Check:** low-memory refusal, valid admission, resource-setting tampering, unsupported thinking option, and bounded output/context. A shared external daemon's global controls must be labeled unenforced. Typecheck.

### T18 — Control model residency without disrupting other apps

**Depends on:** T17. **Stories:** U4.

**Entry points:** LocalLlmService, LocalModelService, preset/status UI.

**Change:** keep a model available during a bounded task; low-impact task completion and Balanced idle timeout follow ownership-aware policy. Model switch requires explicit selection and serialized loading. Do not unload between each tool iteration, kill an external daemon, or stop another client's model. Provide a visible Release memory action with its scope stated.

**Check:** fake clock, active task versus idle, repeated selection, app quit, and shared runtime refusal to claim ownership. Verify real residency in T30/T32; record external-daemon limitations rather than hiding them.

## Phase 3 — Bounded file reading

### T19 — Use one short, bounded local agent

**Depends on:** T14, T17. **Stories:** U4, U5.

**Entry points:** `agent-runtime.ts`, `lib/agent/types.ts`, `hooks/useAgent.ts`.

**Change:** apply local TaskPolicy to loop turns/tool calls/time/consecutive errors. Skip automatic task decomposition, parallel/continuation sub-agents, and MemoryReflector in local mode. Preserve existing duplicate/error handling and IAgentClient. Plain chat does not require a planning/tool roundtrip. Return progress and a user-visible bounded stop state without an automatic new context/agent.

**Check:** long prompt still creates one agent; reflection/decomposer spies remain unused; repeated errors/tool loops/time limit stop; explicit fresh user request can start again. Typecheck.

### T20 — Budget context while preserving native turns

**Depends on:** T10, T19. **Stories:** U4, U5.

**Entry points:** `agent-runtime.ts`, `lib/dcp.ts`, `lib/llm/prompts.ts`.

**Change:** replace the local 100k heuristic with the selected effective profile limit, including system prompt, tool schemas, results, history, and reserved output. Use a compact local prompt and only current tools. Trim complete old tool-turn groups; retain current user instructions and proposal state. For Unicode/unknown token counts, use conservative preflight accounting and available runtime usage. No extra reflection/summary call on every overflow.

**Check:** 4k/8k fixtures, long tool outputs, Unicode, paired tool calls/results, impossible request, and retained latest instructions. Fake server sees a bounded valid history; broad source-string checks are insufficient.

### T21 — Enforce capability and task tool allowlists

**Depends on:** T15, T19. **Stories:** U5, U7.

**Entry points:** `_getAvailableTools`/ToolExecutionService, `main/ipc/mcp.ts`, main local policy/grant state.

**Change:** expose only currently allowed built-in file schemas; default unknown model capabilities to chat. Main revalidates every execution, argument shape, counts, and grant. Reject unknown tools, eval, shell, WhatsApp, arbitrary custom MCP, and model-supplied approval/limit flags. Tool support metadata is a necessary input, never the entire authorization decision.

**Check:** malicious calls omitted from the prompt and attempted directly via IPC are denied. Injection in file text cannot create a grant. An isolated evaluation profile performs a permitted file-read action while an unknown production profile stays chat-only. Typecheck and boundary review.

### T22 — Make workspace grants canonical and main-owned

**Depends on:** T07, T21. **Stories:** U5, U6.

**Entry points:** FileSystemService path resolution, `main/ipc/fs.ts`, preload workspace selection mapping.

**Change:** record user-selected folder/file grants in main; resolve grants from IDs instead of trusting renderer/model `workspacePath`. Canonicalize existing paths, preserve platform case behavior, and validate the nearest real parent for non-existing targets. Deny traversal, symlink/junction escape, unrelated root substitution, and revoked grants. Revalidate targets immediately before I/O; document residual filesystem race limitations.

**Check:** actual temporary directories/symlinks, platform-specific case/junction cases, `../`, prefix sibling names, root replacement, and revoked grants. Windows cases require Windows execution, not simulated passing claims. Review this packet.

### T23 — Bound reads before allocating large content

**Depends on:** T22. **Stories:** U5, U4.

**Entry points:** FileSystemService read/list tools, their schemas, main tool policy.

**Change:** limit file bytes, listing count, types, per-result size, and aggregate task budget before reading. Start with UTF-8 text/Markdown/JSON/CSV. Expose explicit excerpt/truncation metadata and source identity; do not silently return an apparently complete truncated document. Never recurse across the entire home/workspace or follow out-of-grant links.

**Check:** huge/sparse/binary/invalid UTF-8 inputs, oversized directory, disappearance after stat, revocation, excerpt correctness, and useful error messages. Observe allocations for an oversized fixture without loading the full file.

### T24 — Finish the read-only user workflow

**Depends on:** T20, T23. **Stories:** U5, U7.

**Entry points:** existing workspace/attachment UI, `hooks/useAgent.ts`, existing message rendering.

**Change:** show selected scope and Read-only capability, pass the main-issued grant to the task, and render source references/excerpt limitations. Demo summarization of one file, comparison of two selected notes, and extraction of fields. Do not invent citation IDs or claim a model's generated answer proves file access. Unsupported tasks explain the capability/resource limit.

**Check:** deterministic fake-model Electron flow plus a separately recorded real-model smoke case. No writes, hidden grants, cloud requests, or reflection. Stop remains usable during a read task.

## Phase 4 — Reviewed writes

### T25 — Stage exact proposals and remove approval bypasses

**Depends on:** T22, T24. **Stories:** U6.

**Entry points:** FileSystemService staging/callTool, main file policy, existing FileChangeReview data contract.

**Change:** local write calls can only stage a proposal with target, workspace/session, base state/hash, and proposed content/hash. Ignore renderer/model `_sessionAutoApprove` and similar privilege fields. No direct write path for user files in initial local mode. Internal app bookkeeping uses a separate trusted operation, not an AI-accessible filename exception. Reject oversized proposals and unsafe/new target parents.

**Check:** create/edit proposal leaves original bytes unchanged; fake approval flags and internal tracking paths cannot bypass policy; repeated proposals coalesce only when their exact state permits it. Typecheck.

### T26 — Apply approved proposals with conflict checks

**Depends on:** T25. **Stories:** U6.

**Entry points:** FileSystemService commit/reject, `main/ipc/fs.ts`, FileChangeReview component.

**Change:** user approval refers to the exact staged proposal, not an arbitrary pathname. Revalidate scope/real target and base hash/expected absence at apply. Preserve newer edits on conflict. Prepare same-directory replacement/backup using platform-safe primitives; no cross-device atomicity promise. Repeated approve/reject clicks are idempotent, and a failed apply retains recoverable proposal data.

**Check:** external edit, replacement by symlink, created-since-staging target, revocation, repeated buttons, permissions/disk failure, and approve-versus-reject race. Original/newer bytes survive every failed path. Boundary review required.

### T27 — Recover proposals and support safe undo

**Depends on:** T26. **Stories:** U6, U8.

**Entry points:** FileSystemService persistence/recovery, existing local store wrapper, proposal review UI.

**Change:** journal pending/prepared/applied states and necessary hashes/backups. Recover consistently after crashes at each apply transition; never auto-apply an unapproved proposal. Undo checks that the target still equals the applied version; preserve later edits. Bound backup retention and provide an explicit cleanup action that only touches app-owned staging/backup files.

**Check:** inject failures at journal/backup/replace/cleanup boundaries, restart, repeated recovery, stale undo, and missing backup. Test actual temporary files; never use production userData. No lost user content or double apply.

### T28 — Finish two complete write tasks

**Depends on:** T24, T27. **Stories:** U6, U7.

**Entry points:** existing agent/tool presentation, FileChangeReview, local capability status UI.

**Change:** implement reviewed-write capability for an eligible profile; exercise it with isolated evaluation profiles until T29 certifies production access. Demo creating a short report from selected notes and modifying one selected Markdown file. Clearly distinguish staged/approved/applied/conflicted states. A model must not announce that a write is completed merely because it proposed content or got a staged result. No batch move/delete features.

**Check:** fake-model full approve/reject/conflict/undo flows, then documented real-model smoke examples. Confirm unchanged original until approval, exact final bytes, source references, and Stop behavior while awaiting review.

## Phase 5 — Real model and hardware evidence

### T29 — Certify model task capabilities

**Depends on:** T28. **Stories:** U7.

**Entry points:** proposed `tests/local-capability-eval.cjs`, synthetic fixtures, ModelProfile catalog.

**Change:** evaluate the plan's 30-case initial suite on exact installed candidate digests and resource configurations. Record valid tool-call rate, grounded completion, latency/tokens, retries, and safety assertions independently. Keep deterministic policy regressions separate from model-quality scoring. Certify chat/read/reviewed-write independently; failure retains a lower capability. Do not use a different prompt/template than the shipping app.

**Check:** reproducible report per model/config under `plans/reports/`; re-run one fixture to verify the harness records real outputs. No credentials, cloud models, or real documents. A 30-case success does not justify broad reliability claims.

### T30 — Measure responsiveness and choose supported tiers

**Depends on:** T18, T29. **Stories:** U4, U7.

**Entry points:** proposed `scripts/local-performance.cjs`, main local metrics/events, report files.

**Change:** measure named reference hardware at cold boot, cold model load, warm chat, read/write task, cancellation, idle expiry, and 20 repeat cycles. Record all app-owned processes, runtime/backend memory separately, OS pressure/swap, warm first token, throughput, and UI behavior. Avoid expensive permanent monitoring; report measurement methodology. Freeze candidates/configs only when budgets pass.

**Check:** actual reports and pass/fail table on each claimed platform/tier. Missing hardware is unverified. Demote an oversized/slow profile or raise documented hardware requirements; do not silently increase defaults or add cloud fallback. If tuning changes a model/runtime digest, prompt/template, or certified resource configuration, rerun affected T29 checks before freezing the catalog.

## Phase 6 — Consumer runtime and release

### T31 — Prove a complete distributable runtime

**Depends on:** T30. **Stories:** U1, U2, U8.

**Deliver:** `plans/reports/runtime-distribution.md`, pinned artifact manifest, license/notice inventory. Inspect official Ollama distributions for each intended OS/architecture: executable, required native/GPU libraries, CPU fallback, signatures/hashes, expected installed size, offline behavior, and redistribution terms. A single executable without its required libraries is not a proof. Do not build a second runtime here.

**Check:** launch from the extracted intended distribution on clean/reference machines without a system installation. Verify native tool/stream protocol and resource controls. If the proof fails the release constraints, request one reviewed runtime decision and revise affected cards before implementation. Consumer v1 is blocked on this evidence.

### T32 — Manage one owned runtime process

**Depends on:** T31 passes. **Stories:** U1, U4.

**Entry points:** proposed `main/services/LocalRuntimeService.ts`, local services integration, existing before-quit lifecycle.

**Change:** lazily spawn the pinned native process without a shell, on loopback with an app-controlled port/model directory, required OS environment, cloud disabled, one loaded model and one inference slot. Track ownership/PID, bounded startup health checks, crash state, and child cleanup. Dispose it on quit; bounded retries do not become an infinite crash loop. Keep an external-daemon pilot mode visibly distinct.

**Check:** startup failure, port conflict, crash during stream, repeated open/quit, descendant cleanup, wrong binary identity, and cancel escalation. Never terminate a system/shared daemon. Real platform checks complement injected process tests.

### T33 — Package the native runtime for each platform

**Depends on:** T32. **Stories:** U1, U2, U8.

**Entry points:** package build resources, existing bundle-integrity script, minimal runtime path resolver.

**Change:** package complete verified native resources for the specific OS/architecture; resolve them from development versus packaged resources. Keep model weights out of the installer and only acquire them through setup. Handle macOS signing/notarization, Windows executable/native libraries, and Linux permissions/CPU fallback. Prefer separate certified architecture builds until universal packaging is verified.

**Check:** build + bundle-integrity + launch on a clean target machine without global runtime/Node/Python. Record package size and exact artifact paths. Do not call a build supported simply because it cross-compiled.

### T34 — Remove unused production feature families, one at a time

**Depends on:** T28, T33. **Stories:** U1, U4.

**Repeat as separate small cards/commits:** T34a WebLLM, T34b voice/Vosk, T34c WhatsApp, T34d Firebase/cloud provider paths, T34e unused external MCP/document extras. Each invocation removes only one family and its default initialization/import edges plus corresponding manifest/lockfile entries. Preserve local history/migrations and any explicitly retained optional feature. Inspect actual import/build graphs: declared dependencies alone do not prove idle CPU/RAM use.

**Check per family:** typecheck/build/compiled offline boot, relevant local task regression, bundle inventory before/after. If import cleanup exceeds three production files, split it first. Do not delete small libraries without a product or measured packaging benefit.

### T35 — Align metadata, setup, and model notices

**Depends on:** T33, T34 completed families. **Stories:** U1, U2, U8.

**Entry points:** README/setup docs, package metadata, existing release workflow/scripts.

**Change:** document actual local tasks, supported hardware, explicit model/runtime setup, limitations, offline behavior, and licenses. Point repo/issue/CI links to ai-worker-desktop. Remove obsolete voice/cloud claims and unrelated installer prerequisites. Audit old release/upload domains before running any publishing script. Do not change appId/data namespace without a written compatibility migration. Preserve app MIT plus separate model/runtime notices.

**Check:** fresh-reader setup walkthrough against the packaged build, link/notice inventory, and unchanged user-data location. Publishing is a separate explicitly requested action, not part of this card.

### T36 — Run the release gate and preserve user data

**Depends on:** T29–T35. **Stories:** U1–U8.

**Deliver:** a release report with clean install, update from a representative old local profile, offline chat/read/reviewed-write, Stop/quit, low-memory/disk failure, proposal recovery, and uninstall behavior on every advertised target. Run a repo secret scan and inspect retained screenshots/demo assets. Verify no non-loopback egress during core tasks, no hidden runtime installation, and no user-file/chat deletion.

**Check:** the plan's resource/task/safety gates all have evidence. Mark unsupported/unmeasured platforms honestly. Remaining blockers prevent a consumer v1 label. Produce reviewable artifacts; do not publish or change external release services as a hidden final step.

## Later optional browser slices

### B01 — Explicit, lazy browser connection

**Depends on:** T07, T21, T30. **Story:** U9.

Reuse PlaywrightService/BrowserManager and existing connection UI. Start one browser/tab only after the user enables browser research; explain website network access. Never make browser bundles a core startup dependency. Close owned sessions on Stop/quit and enforce the same per-task policy in main. Verify an offline core boot still creates no browser process; verify explicit connection/start/cleanup on a named platform.

### B02 — Read-only text browser research

**Depends on:** B01. **Story:** U9.

Expose only bounded navigation and text extraction in one task/tab. Exclude arbitrary evaluate/run-code, uploads, credentials, downloads, purchases, and messaging. Validate URLs, avoid local/private-network targets absent an explicit grant, limit response/context sizes, and treat page instructions as untrusted. Verify source links, injection denial, redirects, errors, Stop, and a deterministic local fixture website before any live website smoke case.

### B03 — Certify browser tasks before broader actions

**Depends on:** B02, T29. **Story:** U9.

Add a small research suite for exact model/runtime/hardware profiles and measure browser-plus-model memory separately. Certify read-only research first. Screenshot/vision, form submission, and desktop control require their own scope, authority design, and quality/performance evidence; do not enable them because the model catalog says vision/tools. Keep initial user-visible browser tasks limited to those actually measured.

## Ready-to-start sequence

1. T00 captures runnable baseline; then T01–T07 deliver lean offline boot.
2. T08–T14 deliver local streaming chat with reliable Stop and a global queue.
3. T15–T18 deliver explicit model setup and controls.
4. T19–T24 deliver grounded read-only file tasks.
5. T25–T28 deliver reviewed writes with conflict/recovery handling.
6. T29–T30 establish model/hardware evidence; T31–T36 close the consumer-release gaps.

First completion milestone: Phase 1 working end to end. First useful file-assistant milestone: Phase 3. Reviewed-write pilot: Phase 4. Consumer v1 requires Phase 6 evidence. Browser research is separately gated.
