# Luna cards: Tauri web migration

Reusable `local-operation-journal` Rust crate and portable TypeScript bridge are available locally. Use the [journal integration cards](./operation-journal-integration.md) within M13/M21–M23/M26–M27; application integration and the Tauri migration remain pending.

Revision 3, 10 October 2026. Planned work only. [Product plan](./local-desktop-product-plan.md) · [replacement audit](./custom-code-alternatives-audit.md) · [LangChain/LangGraph migration decision](./langchain-langgraph-migration.md).

The LangChain/LangGraph decision supersedes earlier AI SDK Core selections and proof instructions until the product plan is consolidated. Existing AI SDK proof code remains historical evidence only; do not extend or treat it as a passed gate.

Execution base: clean `ai-worker-desktop` history from `e56f8d2`. Archived T00–T36 Electron cards are obsolete. Current IDs are M00–M41. macOS first, Windows next; offline bundled UI; CLI confirmation required.

## Dispatch instructions

Paste this header plus **one card** into a Luna coding turn:

> Implement `<ID>` only in the ai-worker-desktop checkout. Confirm prerequisite cards are committed. Read applicable rules, named modules and callers; use Context7 for current SDK/API/CLI configuration. Use the selected Tauri/React/LangChain.js/LangGraph.js/rmcp architecture; do not add a Node/Python app server, second agent framework or second model engine. Normally change at most three production files, one focused behavioral check and a small architecture.md entry; split expanding work. Initial generated scaffolding is the stated exception. Use synthetic files and temporary profiles/workspaces. Preserve old user data and published credential sanitization. Run the card's relevant checks, web typecheck/build for changed frontend/types, and cargo fmt/check plus focused Rust checks for changed native code. Report actual outcomes and limitations; commit only related files. No clean:state/dev:clean, package-manager autoinstall at app runtime, cloud E2E, real user files, publishing or old-upstream push. Stop at a missing prerequisite or failed compatibility gate rather than widening scope silently.

Paths prefixed `src-tauri/`, `src/renderer/src/desktop-bridge.ts`, `local-agent-client.ts`, `model-fetch.ts`, `chat-storage.ts`, `vite.config.ts`, and `src/renderer/src/LocalApp.tsx` are **proposed**. Inspect existing symbols before creating them; reuse relevant equivalents. Directory names may change, but contracts/outcomes remain.

Fast checks reuse installed development tooling or Rust's standard test support. Do not create a second implementation in test fixtures or use source-substring assertions as behavioral proof. Fake providers/MCP processes must close and use temporary profiles. Native UI automation can use current Tauri/WebdriverIO tooling in a test-only build; no test driver/plugin ships in release. Browser mock success cannot certify OS permissions or process cleanup.

M17–M31 use test-injected candidate tool capabilities in isolated evaluation profiles. Production profiles stay chat-only until M32 certification. Main/native grants, approval, cancellation and output limits remain active; no production capability bypass.

Every card status begins `not started`. Track `in progress → checked → reviewed` in commit/PR notes; never mark an unperformed check passing. Normally execute sequentially.

## Phase 0 — Prove the stack

### M00 — Record baseline and adapt architecture rules

**Depends:** none. **Stories:** U1, U4.

Read package/build scripts, architecture.md and `.agents/rules/`. Record source/tool/platform baseline and proposed-vs-measured fields in `plans/reports/migration-baseline.md`. Adapt Electron-specific rules to Tauri commands/native services while preserving `IAgentClient`, one tool choke point, validation, data protection and architecture sync. Keep old Electron runnable; no functional source port yet.

**Check:** identify original app data paths/destructive scripts, existing check failures and available target machines. Do not install/download a model. Rule changes must not relax OS authority or claim architecture already migrated.

### M01 — Create a minimal Tauri core

**Depends:** M00. **Stories:** U1.

Use current stable Tauri 2 scaffold with locked compatible Rust/tool/plugin versions. Native core has one local window and a harmless version/status command; no filesystem/shell/network capability. Keep existing Electron scripts alongside distinct Tauri scripts. Generated config/entry/manifest/lockfile scaffolding is the explicit file-count exception; no service port.

**Check:** cargo build/check, release binary inventory and launch/quit with a temporary profile on macOS. Record missing Windows validation. No Node production sidecar and no broad default plugin permissions.

### M02 — Build existing web UI assets with Vite

**Depends:** M01. **Stories:** U1.

Entry: proposed Vite config, renderer HTML/entry and web-specific TypeScript config. Point Tauri at local built assets; use a minimal reused React view first. Preserve the separate Electron build until export/migration works. Production includes no Vite dev server, Electron preload or Node polyfills.

**Check:** web typecheck/build, offline packaged asset loading, asset sizes and one native invoke roundtrip. Plain browser preview reports native bridge unavailable. No replacement frontend framework.

### M03 — Prove LangChain/LangGraph + Tauri streaming before porting services

**Depends:** M02. **Stories:** U3, U4.

#### M03a — Reuse native fixture transport

Reuse the reviewed-clean native fixture transport and isolated proof configuration already present. Do not recreate its behavior. Keep the proof endpoint and capability outside default app assets; native authority and cleanup stay in the host.

#### M03b — Prove LangChain/LangGraph in the WebView

Treat the AI SDK harness from `b9d6de3` as unchecked and obsolete. Pin verified compatible exact versions of `@langchain/core`, `@langchain/openai`, and `@langchain/langgraph`; import only required public modules. Prove fake local SSE → typed Channel → bounded web stream → LangChain model output, then reuse the native fixture's sequence to make two distinct native tool calls and receive both native results through explicit LangGraph routing before final text. One call/result is insufficient. Give each new AI, bridge, fixture and proof module one clear responsibility and explicit export contract; use short module/export comments plus targeted comments for non-obvious graph, trust/limit, cancel and history invariants. See [LangChain/LangGraph migration decision](./langchain-langgraph-migration.md) for the proof packet.

**Check:** actual WKWebView is a hard gate; then WebView2 where available. Cover split UTF-8/frames, error, abort, tool history and native cleanup. Record browser support source, imported package graph, exact pins, JS gzip/native size and required adapters in `plans/reports/stack-proof.md`; initial JS gzip target remains ≤750 KiB. Document unavailable target hardware without claiming proof. No Node shims, cloud gateway/default tracing, secret in UI, custom SSE parser, automatic Rig/SDK fallback, or two agent frameworks. A compatibility/size failure requires a reviewed decision before implementation proceeds.

## Phase 1 — Lean UI and migration

### M04 — Open only local core UI

**Depends:** M03 passes. **Stories:** U1.

Entry: LocalApp/web entry, existing chat/primitives, local settings view. Reuse chat/text/sidebar/review presentation; detach eager Firebase, voice, WhatsApp, model worker and MCP initialization from the Tauri import graph. Optional panels are absent/lazy, not merely hidden after initialization. Keep hooks unconditional. Split by import family if it exceeds the packet limit.

**Check:** compiled offline boot with no optional process/network calls and working keyboard/text controls. Missing model is a setup state, not a global Node/Python dependency gate. Old Electron entry still builds.

### M05 — Define the explicit DesktopBridge and command permissions

**Depends:** M04. **Stories:** U1, U5, U7.

Entry: `desktop-bridge.ts`, native command manifest/capabilities and proposed shared DTOs. Declare a small native API, explicit availability, owner/session/request identities and errors. Configure AppManifest permissions for custom commands and narrowly select capabilities; no raw frontend fs/shell/HTTP or remote window access. Keep `electron.ts` only on the legacy path.

**Check:** malformed/oversized payload, unknown window, remote navigation and unprivileged command attempts fail. Missing bridge never returns mocked MCP success. Review boundary; update architecture map for actual commands.

### M06 — Persist preferences and bounded chat history

**Depends:** M05. **Stories:** U1, U9.

Entry: chatStore/chat-storage adapter and native preferences module. Use IndexedDB for chats and fixed-path official Tauri store for whitelisted preferences. Separate transient streaming state from terminal persistence; define schema version, bounded pages/retention/export and storage failure UX. Do not add a graph memory server or write all chats every token.

**Check:** restart, schema migration, unavailable/full storage, multiple sessions and large-history paging. Production origin remains stable; preference fields cannot grant tools or arbitrary file paths. Source data never deleted as an automatic repair.

### M07 — Replace Electron attachment/path assumptions

**Depends:** M05, M06. **Stories:** U5.

Entry: useFileDragDrop/text attachment UI and DesktopBridge. Use native selection/drop metadata only through explicit grant creation. Browser uploads are bounded bytes, not authority-bearing OS paths; remove `.path`/filename-as-path assumptions from new UI. Workspace execution remains disabled until M17 implements the native grant policy.

**Check:** duplicate names, Windows path spelling, canceled dialog, oversized upload and browser-only preview. Selection UI preserves keyboard/accessibility. No guessed path or clipboard fallback silently grants a directory.

### M08 — Add a versioned legacy Electron export

**Depends:** M06. **Stories:** U9.

Entry: existing legacy settings UI, chat/settings serialization helper and export action. Export a versioned bounded JSON snapshot of chats/non-secret settings with explicit user action. Old paths remain informational; strip credential and approval authority fields. Capture pending changes only as unapproved drafts if available, never as approved operations.

**Check:** representative synthetic legacy profiles, Unicode, malformed fields and canceled/failed export. Old profile remains intact and old Electron still starts. No raw LevelDB parsing, safeStorage decryption or credential output.

### M09 — Import/export safely in Tauri

**Depends:** M06, M08. **Stories:** U9.

Entry: native file picker/import boundary, storage adapter and settings UI. Validate export version/size/schema, preview imported counts, preserve existing chats and use a repeatable migration marker. Keep a distinct new namespace and rollback/export path. Imported workspace/auto-approval values never become live grants.

**Check:** import twice, conflict/duplicate identity, future version, partial failure, storage full and rollback. Verify exact imported messages without touching original profile. No secret import or unapproved file apply.

## Phase 2 — Local chat

### M10 — Verify runtime, GGUF and tool template artifacts

**Depends:** M03. **Stories:** U2, U3.

Deliver `plans/reports/native-runtime-proof.md` and pinned candidate manifest. Inspect complete llama-server macOS/Windows releases, required libraries/backends, provenance/license and exact model/template identity. Verify chat/stream/native tool roundtrip against the selected SDK configuration before writing broad runtime management. Real model setup is explicit and separate from mock checks.

**Check:** launch intended distribution without system runtime on actual target OS; inspect flags/version and record missing hardware. Never download from `latest`, assume one binary includes its libraries, or substitute a different template silently. Failed compatibility revises one selected profile/runtime choice.

### M11 — Own one lazy native process

**Depends:** M05, M10 passes for the active target. **Stories:** U1, U4.

Entry: proposed native runtime module, app lifecycle and pinned resource resolver. Spawn without a shell, on loopback/app-controlled port, with one slot/model, minimized environment and native-only ephemeral auth. Disable runtime UI/tools/agent/MCP proxy and unrequested network acquisition. Track PID/ownership and bounded startup/crash/quit cleanup.

**Check:** port conflict, wrong asset/digest, failed startup, crash, repeated open/quit and unrelated process. No model process at app boot and no shared/system daemon termination. Test complete library resolution, not just spawn success.

### M12 — Explicit verified model setup/import

**Depends:** M06, M11. **Stories:** U2.

Entry: native model module, small setup view and bridge methods. Show exact candidate/license/source, download and disk requirements; support explicit download or local GGUF import, progress/cancel/retry. Verify checksums/identity/template/runtime compatibility before use. Bound streaming download buffers and preserve resumable/partial state safely.

**Check:** canceled/mismatched/partial artifact, disk shortage, unsupported profile, retry and successful import. No automatic setup on launch or shell installer. Unknown identity/capability stays chat-only; first real acquisition is not an automatic unit-test dependency.

### M13 — Enforce native tasks and local model transport

**Depends:** M05, M11. **Stories:** U3, U4.

Entry: native task policy/queue and local transport command; extend the M03 bridge. Integrate journal host ownership via J01; persistent task identity does not confer a live grant. Native owns profile/limits/endpoints/auth and task/request ownership. Validate bounded chat payload, stream bytes over Channels, one active task/inference, max ten queued tasks, deadlines and cancellation. Only approved chat endpoint; no generic URL proxy. Split queue/transport if needed.

**Check:** direct IPC tampering, queued cancel, overflow, redirect/remote model rejection, backend failure, wrong owner, late frames and sender destruction. Controllers/promises/listeners released; client cannot raise limits or execute a request outside an active grant.

### M14 — Replace custom execution with one LangGraph agent client

**Depends:** M12, M13. **Stories:** U3.

Entry: proposed local-agent-client, `IAgentClient`, provider transport, graph adapter and small history boundary. Use `@langchain/openai` against the explicit native-approved local endpoint and `@langchain/langgraph` explicit graph primitives; no second custom loop. Keep modules understandable with short module/export contract comments and targeted comments for graph routing, trust boundary and cancellation ordering where the code alone is unclear. Graph may call only the in-process ToolBroker; it never owns permission approvals, replay, OS effects or durable journal state. Bound model→native ToolBroker→model cycles and persist canonical LangChain `BaseMessage` turns using the official serializer. Native operation journal remains durable side-effect source; do not add graph checkpointer/workflow DB by default. Keep `IAgentClient`, Tauri/native transport and UI contracts; old `AgentRuntime` remains on legacy build only.

**Check:** two tool calls/results, malformed calls, complete persisted/reloaded message history, empty final turn, provider error, cancellation before/during/after tool dispatch, late event suppression and native cleanup. Verify any official message deserialization path is restricted to app-owned validated storage; never load untrusted user data into class constructors. No cloud checkpointer/tracing/default network, custom protocol repair or automatic provider/framework fallback. Exact module and API usage must match M03 proof pins and current official docs.

### M15 — Connect streamed UI and actual Stop

**Depends:** M14. **Stories:** U3, U4.

Entry: useAgent/new small hook adapter, chatStore/transient streaming and message controls. Render session/request-correlated deltas with batching; persist a terminal turn once. Stop cancels provider work, native task/HTTP and future graph/tool steps. Reject late events after cancellation/navigation/unmount and clearly label partial/canceled output.

**Check:** two sessions, switching sessions, Stop before start/during/between steps, repeated Stop, failure after partial text and quit. Native compute-stop timing requires M33 real evidence; closing UI text alone is insufficient.

### M16 — Apply resource presets and idle release

**Depends:** M12, M15. **Stories:** U4.

Entry: native resource/task policy, model lifecycle and preset UI. Enforce context/output/thinking/thread settings, admission/pressure/refusal states and owned idle release. No model unload between tool turns; review waiting does not retain inference indefinitely. Low impact task-end release/Balanced short idle policy use only verified runtime controls.

**Check:** low-memory/unsupported setting, OOM/error, fake clock, active vs idle task, selection change, retained queue state and reopen. Display estimates honestly; no CPU percentage guarantee from thread count or silent model switch/download.

## Phase 3 — Files

### M17 — Issue canonical native workspace grants

**Depends:** M05, M13. **Stories:** U5, U6.

Entry: proposed native workspace module, dialog command and bridge/UI grant state. Native picker issues owner-bound root/file IDs. Canonicalize actual paths/case/junctions/nearest existing parents; reject traversal/sibling-prefix/root substitution/revoked grants. Revalidate at I/O and document residual race limitations.

**Check:** actual temp symlinks, root replacement, `../`, case and Windows junction cases on Windows. Restored/model paths cannot grant scope. Review native boundary; no broad home-directory capability.

### M18 — Register bounded native read/list tools

**Depends:** M17. **Stories:** U5, U4.

Entry: native workspace module, ToolBroker and canonical built-in schemas. Use standard async I/O, typed arguments, byte/type/count and aggregate-result limits. Allow UTF-8 txt/md/json/csv; return source/excerpt metadata. Core library dispatch runs in process with MCP-compatible tool descriptors, no separate server.

**Check:** oversized/sparse/binary/invalid UTF-8 files, huge directory, symlink escape, disappearance after stat, revoke and truncated excerpt. Verify no full huge-file allocation. Main policy applies even when bypassing SDK.

### M19 — Budget context and eligible tools

**Depends:** M14, M18. **Stories:** U4, U5.

Entry: LangChain/LangGraph prepare-step/context helper, model profile and native task policy. Compact prompt/current permitted tools; include schemas/history/results/reserved output in effective context. Trim whole older tool groups; conservative Unicode preflight and runtime usage. Keep total request/tool/error/duplicate limits natively as well as graph stop conditions.

**Check:** 4k/8k cases, long outputs/schemas, Unicode, impossible request and latest instructions. No half tool turn, extra reflection/summary model or automatic continuation.

### M20 — Complete three grounded read tasks

**Depends:** M07, M18, M19. **Stories:** U5.

Entry: existing scope/attachment/message presentation and small agent UI adapter. Show granted scope and read-only capability; demonstrate one-file summary, two-note comparison and short structured extraction. Source/excerpt facts come from tool results; model prose never proves a read.

**Check:** fake-model end-to-end plus separately documented real-model smoke in synthetic temp workspace. Unsupported actions explain limits; injected file instructions cannot expand grants, write or send data; Stop works.

### M21 — Stage immutable bounded file proposals

**Depends:** M17, M20. **Stories:** U6.

Entry: proposed native proposal module, workspace ToolBroker and FileChangeReview contract. Use J02 and journal immutable intents, not a new proposal database. Only stage create/edit proposals with target/base/proposed hashes, task/grant identity and bounded text. Ignore model/renderer auto-approval fields. Internal bookkeeping is a trusted separate operation, never an AI filename exception.

**Check:** original unchanged, expected-absence/new-parent validation, repeated proposals and fake auto-approve flag. Proposal IDs cannot substitute different contents/path; canceled tasks stop new staging.

### M22 — Apply exact approved changes with conflict protection

**Depends:** M21. **Stories:** U6.

Entry: native proposal apply/reject, review command and existing review UI. Use J03 and native-only journal approval/begin/finish calls. Bind human approval to immutable proposal; recheck grant/target/base hash/absence. Prepare durable backup/same-directory replacement metadata in immutable intent before approval, commit begin before mutation, and record verified outcome. Preserve later edits and recoverable state on errors; repeated clicks cannot execute twice.

**Check:** edited/replaced/symlink target, revoked grant, disk/permissions failure, approve/reject race and failure at prepare/replace. No unapproved write or cross-device atomicity claim. Separate boundary review.

### M23 — Recover and undo without losing user edits

**Depends:** M22. **Stories:** U6, U9.

Entry: native journal/recovery, proposal storage and review state. Use J04: prove old run/processes dead, recover only its records, reconcile uncertain effects with base/proposed/backup hashes. Never auto-apply unapproved content. Undo is a new reviewed intent and verifies the currently applied hash; missing backup or newer edits show a conflict. Retention/cleanup touches only app-owned backup/staging data and preserves idempotency history.

**Check:** injected crash at each transition, repeated recovery, missing journal/backup, stale undo and cleanup failure. Actual temp files survive failed paths; no real user profile.

### M24 — Complete reviewed create/edit workflows

**Depends:** M20, M23. **Stories:** U6.

Entry: FileChangeReview/agent presentation and capability UI. Demonstrate one report created from notes and one Markdown edit. Show staged/rejected/applied/conflict/undo states from native facts; model cannot claim apply from a staged result. Pause/end compute during human review with explicit proposal expiry.

**Check:** full approve/reject/conflict/undo flow and documented real-model smoke with temp candidate capability. Exact output bytes/source references and unchanged original until review. Production write capability remains unpromoted until M32.

## Phase 4 — CLI and MCP

### M25 — Register constrained CLI actions

**Depends:** M17. **Stories:** U7.

Entry: proposed native CLI action catalog, executable resolver and schemas. Start installed Git read operations/ripgrep search with structured arguments and per-action semantics. Pin/verify resolved executable; bound cwd/env; prevent dangerous flags, arbitrary config, pager/external helper/preprocessor escapes. Missing CLI disables that action, not the app.

**Check:** executable substitution, unsafe flag/argument, root escape, absent helper and malicious workspace/global config. Review each program's actual execution effects using current docs; executable-name allowlist alone is insufficient. No unrequested binary/package installation.

### M26 — Review exact command proposals

**Depends:** M25. **Stories:** U7.

Entry: native command proposal state, small existing dialog/card UI and separate native review command. Use journal intent/approve/cancel through J02/J03; generic TypeScript journal bridge cannot approve. Preview executable/argv/cwd/effects/env policy and deadline. Confirm or reject exact immutable proposal with expiry/revocation/single-use authority; AI tools cannot call approval methods. Shell-like rendering is display only.

**Check:** changed argv/cwd/env/identity, stale/replayed approval, double click, cancel and revoked workspace. Native execution unavailable before approval. UI states clearly that confirmation/cwd does not sandbox the process.

### M27 — Execute and clean up owned command processes

**Depends:** M26, M13. **Stories:** U7, U4.

Entry: native CLI executor, owned-process helper and task cancellation. Use J03/J04: commit journal begin before spawn, record verified exit or uncertain outcome, never automatically replay after interruption. Spawn direct executable + argv; independently drain stdout/stderr into bounded buffers/events, enforce exit/deadline/cancel, minimal env and platform group/job ownership. Recheck approved identity/scope immediately before launch.

**Check:** pipe saturation, large output, timeout, nonzero exit, stdin wait, spawn failure and descendants on macOS/Windows. No shell expressions, leaked process or later tool after Stop. Escaping/daemonizing commands stay unsupported absent confinement evidence.

### M28 — Complete confirmed CLI task flow

**Depends:** M15, M27. **Stories:** U7.

Entry: ToolBroker SDK adapter and command result UI. Expose only eligible registered actions; demonstrate Git workspace status or bounded search after confirmation. Return actual exit status, truncation, source/effect metadata and cancel state; do not turn terminal output into instructions/permissions.

**Check:** approve/reject/tamper/Stop end-to-end and missing helper UX. Model sees denied/canceled action as denied/canceled, not success. Record a real helper smoke case separately from fixtures.

### M29 — Use official rmcp for lazy local sessions

**Depends:** M13, M27. **Stories:** U8.

Entry: proposed native MCP registry, rmcp manifest features and lifecycle wiring. Use public child-process/client APIs for stdio; locked minimal Cargo features. Session begins only on explicit connection/use of an approved server. No auto-installed npx/uvx or inherited secret environment; no SDK private fields. Disable sampling/server-initiated execution by default.

**Check:** harmless fixture server initialize/list/call/error/disconnect, crash/reconnect bound, cancellation and quit with descendants. Core startup creates no MCP process. Add Streamable HTTP only in a separate justified packet when a chosen integration requires it.

### M30 — Validate tools and schemas across the broker

**Depends:** M18, M29. **Stories:** U8.

Entry: ToolBroker, MCP descriptor/schema adapter and validator integration. Cache bounded schemas with explicit invalidation; namespace tool identity; expose only native-approved tools/capabilities. Use a maintained offline JSON Schema validator for dynamic external inputs, with minimal features and a rejecting/restricted reference resolver. Cap schema size/depth/regex complexity; MCP schemas are untrusted until vetted.

**Check:** unknown/duplicate name, malformed/huge/deep schema, remote/file `$ref`, changed schema, invalid args and `readOnlyHint` lie. Validation must not fetch/read references or elevate tool authority. Deterministic built-in typed checks remain native; no second handwritten JSON Schema engine.

### M31 — Ship a small curated integration mechanism

**Depends:** M28, M30. **Stories:** U8.

Entry: catalog/settings view, native server approval/profile and connection status. Display server source/version/runtime/disk/network/effect cost; explicit enable/start/stop, no marketplace or arbitrary unreviewed command import. Built-ins stay in process; external MCP/CLI does useful work only after policy checks. Unknown/mutation-capable tools require appropriate review or remain unavailable.

**Check:** fresh/migrated profiles, refused setup, disconnected/untrusted server, changed artifact/schema and idle teardown. Use a harmless fixture integration for core tests. Reference filesystem/Git/memory servers are not assumed production-safe replacements for native approvals.

## Phase 5 — Evidence

### M32 — Certify exact task capabilities

**Depends:** M24, M31. **Stories:** U5–U8.

Deliver a reproducible 40-case synthetic suite/report: ten chat/extraction, ten file-read, ten reviewed-write and ten confirmed CLI/MCP cases. Record exact engine/GGUF/template/profile/prompt/config, valid call rate, task completion, retries, tokens and latency. Promote capabilities independently only when gates pass; preserve a lower tier on failure.

**Check:** >=98% valid calls / >=90% scoped completion initial gates with raw counts; grounding/unknown facts and mechanical unauthorized-action/Stop assertions. Separate benchmark quality from deterministic native security. New digests/configs trigger affected re-certification.

### M33 — Measure model and complete application responsiveness

**Depends:** M16, M32. **Stories:** U4.

Record cold boot/load, warm chat, read/write/CLI/MCP task, review wait, cancellation/idle/quit and 20 cycles on named macOS and Windows machines. Separate app/WebView/helper/inference memory, shared memory, pressure/swap, throughput/first token and foreground responsiveness. No heavy permanent polling.

**Check:** measured pass/fail per advertised tier; missing hardware is unverified. Tune/refuse/demote rather than hide failures or add cloud fallback. Re-run M32 if tuning changes certified settings/template/digests.

### M34 — Enforce payload and dependency budgets

**Depends:** M33. **Stories:** U1, U4.

Deliver a reproducible bundle/Cargo/npm reachability inventory and footprint report. Measure compressed app payload, JS/CSS gzip, native features, prerequisite/runtime/helper caches and total installed size. Require no Electron/Node production runtime or test driver; account for SDK gateway transitive code without invoking it. Do not treat lockfile package count as shipped bytes.

**Check:** proposed <=25 MiB app / <=750 KiB initial web assets / <=40 MiB native idle / <=200 MiB full app idle targets against real artifacts, not estimates. Attribute exceptions and identify actual expensive import/features for M40 trimming.

## Phase 6 — macOS then Windows

### M35 — Package and certify macOS Apple silicon

**Depends:** M10, M34. **Stories:** U1, U2, U9.

Entry: Tauri bundle config, verified platform resources and resource resolver. Package complete matching native runtime/libraries, notices and signing/notarization; model weights remain explicit setup/import. Test on clean machine without global runtime/Node/Python. Keep the original profile untouched; new app identity/storage namespace deliberate.

**Check:** native launch/quit, model setup/offline tasks, grants/drop, CLI Stop and import/update on actual macOS. Record signed vs development artifact honestly, minimum OS/backend and payload size. No supported Intel/universal claim from an ARM build.

### M36 — Package and certify Windows x64

**Depends:** M35, M34. **Stories:** U1, U2, U9.

Entry: Windows Tauri installer config, complete runtime/native assets and OS process cleanup. Use system Evergreen WebView2; handle explicit prerequisite bootstrap if absent. Document separate offline payload option and count its size. Verify CPU/selected GPU fallback, paths/junctions/locks/job cleanup and signing state.

**Check:** clean present/absent-WebView2 machines, no global runtime/Node/Python, update/import/offline workflows and cancellation/quit. Cross-compilation alone is not certification. No ARM/Linux support claim without actual checks.

### M37 — Prove update, recovery and rollback

**Depends:** M09, M23, M35, M36. **Stories:** U9.

Deliver migration/install/update/uninstall/rollback report using representative temp legacy/new profiles, pending proposals and model setup states. Preserve chats, user files and old data; no automatic model removal or approvals after restore. Fix only observed migration/lifecycle defects in bounded packets.

**Check:** failed update/import, interrupted apply, restart/recovery, missing model/helper and uninstall data retention. Older app/profile remains available until users explicitly remove it. No reset/clean scripts as repair.

## Phase 7 — Prune and release

### M38 — Remove unused feature families in separate commits

**Depends:** M37. **Stories:** U1, U4.

Repeat as M38a cloud/auth/OAuth, M38b voice/Vosk, M38c WhatsApp/Baileys/QR, M38d WebLLM/provider variants, M38e graph-memory/reflection/decomposition, M38f custom browser/conversion extras. One family per turn: callers/imports/tests/manifest/lockfile. Preserve selected optional integration interfaces and legacy export fixtures. Split >3-file work.

**Check per family:** web/native builds, focused core regression and before/after reachable bundle inventory. No unmeasured memory-saving claims or deletion of user data. Keep published secret sanitization.

### M39 — Remove Electron production and build paths

**Depends:** M38, M37. **Stories:** U1, U9.

Entry: package scripts/dev dependencies, legacy main/preload config and release workflow. Remove Electron/native Node build/rebuild/shim/installer code after export migration is demonstrated; preserve archived rationale and data-format fixtures. Keep Node only as development tooling for frontend builds/tests, not end-user runtime.

**Check:** from clean dev install build macOS/Windows artifacts; no Electron/main/preload import or packaged node_modules. Export/import fixtures still work; original profile/data never deleted. Split package removal from large source deletions.

### M40 — Trim measured frontend cost

**Depends:** M34, M39. **Stories:** U1, U4.

Entry: measured expensive UI imports (FormattedText, animation sites), Vite split points and assets. Replace decorative Framer Motion with CSS; plain code blocks or lazy selected syntax languages; lazy optional settings/integration panels. Keep React/Zustand/primitives and accessibility; optimize only costs identified in the report. Separate animation/highlight/asset packets if needed.

**Check:** keyboard/reduced-motion/focus/clipboard/markdown safety and streamed-message responsiveness. Measure initial asset and idle delta. No second UI framework or loading every history message into the DOM.

### M41 — Align docs and run final release gates

**Depends:** M32–M40. **Stories:** U1–U9.

Update README/metadata/issues/CI to ai-worker-desktop; document actual supported tasks/hardware, model/runtime/helper costs, offline setup, CLI/MCP trust limits, import and notices. Update architecture to shipped paths. Check sanitized source/demo assets, permissions, zero core non-loopback egress and artifact identities.

**Check:** repeat affected M32–M37 gates against final pruned artifacts/configuration; reports must describe what ships. Release binaries contain no test IPC/driver/sampling bypass. Produce reviewable installers/reports; publishing and external release changes require their own user request.

## Optional after the core

### O01 — Replace browser custom code with pinned Playwright MCP

**Depends:** M31, M32. Reuse official server; explicit Node/browser setup and one lazy dedicated browser profile. Allow only bounded read-only navigation/text tools, deny evaluate/run-code/uploads/credentials/downloads/messages and network targets outside approved scope. Disable page-supplied tools where supported. No browser core dependency.

**Check:** fixture website + actual named-platform smoke, tool injection/redirect/private-network denial, Stop/quit and separate browser/helper memory. Playwright MCP is not an OS security boundary; no broader action capability inherited from its full catalog.

### O02 — Reuse MarkItDown for optional document conversion

**Depends:** M31, M33. Explicit pinned Python/format package setup, conversion-only action under grants and bounded outputs/temp files; no automatic `uvx` installation. Keep core text workflows independent.

**Check:** synthetic supported documents, malformed/huge inputs, timeout/cancel, helper footprint and useful missing-capability states. Verify converter outputs/caches cannot escape or silently overwrite the selected workspace.

## Ready sequence

M00–M03 prove stack → M04–M09 lean UI/migration → M10–M16 local chat → M17–M24 files → M25–M31 CLI/MCP → M32–M34 evidence → M35–M37 macOS/Windows → M38–M41 prune/release. Some independent prerequisites can be prepared earlier, but each card remains a single bounded turn.

First milestone: M03 compatibility proof. First real-model demo: M15. Useful file pilot: M24 in isolated evaluation. Confirmed CLI/MCP pilot: M31. Shipping tool capabilities require M32; consumer release requires M41.
