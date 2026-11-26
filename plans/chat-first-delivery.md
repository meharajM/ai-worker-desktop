# Chat-first delivery plan

**Status:** planning only; no implementation or model acquisition in this change.

**Owner/model:** all development and review turns use `gpt-6-luna`.

**Platform order:** macOS first, Windows next.

**Canonical cards:** [Luna implementation cards](./luna-implementation-cards.md); this file defines their delivery order and gates.

## Goal

Deliver one useful end-to-end local chat first, using Assistant UI for the React chat surface and a custom adapter into the local LangChain/LangGraph client. Recommend only a model profile certified on matching hardware. Add agent capabilities in later, gated stages: read-only workspace, reviewed file changes, confirmed CLI, then optional MCP.

The current development Mac is Apple silicon with 16 GiB; no physical 8 GiB Mac is available. M10–M16 work is profile-scoped. M10 verifies an artifact and resource candidate; M16b certifies an app profile only on matching hardware. An 8 GiB candidate may be evaluated on the 16 GiB machine, but that cannot prove 8 GiB fit, responsiveness, thermal behavior or cleanup. A certified 16 GiB profile can reach the chat-only macOS beta after migration and packaging checks; 8 GiB remains unavailable to users until physical evidence passes M16b. Agent capabilities still require M32 certification. Windows proof follows on actual Windows hardware; cross-compilation is not evidence.

## Final goal

Deliver an open-source, offline-first desktop assistant with a small bundled web UI and Tauri native bridge. On certified macOS Apple silicon and Windows x64 systems, users explicitly install or import a verified, free and openly licensed local model, chat with streaming and real Stop, read only selected text files, review exact file changes before apply, confirm registered CLI actions, and opt into a small curated MCP catalog. Native policy owns grants, limits, approvals, process cleanup and journal-backed recovery. Preserve legacy chats without importing credentials or authority. Report app, WebView, helper and inference costs separately; certify 8 GiB and 16 GiB macOS profiles on matching hardware before full release. M41 is the full consumer-release gate. The earlier 16 GiB macOS chat beta contains chat and migration only.

## Current checkpoint

- M00–M04 complete.
- M05a reviewed clean at `5ec261f`; M05b web client is committed at `da8b2aa`; M05c native ACL proof is in progress. This checkpoint is a 10 October 2026 snapshot; use commit history for later status.
- M03 LangChain.js/LangGraph.js fixture proof passed 11/11 in macOS WKWebView, including two native tool calls, canonical history and cancellation. It proves framework/bridge compatibility only; no real model runtime or GGUF has been proven.
- The Rust operation-journal crate and TypeScript bridge exist locally but are standalone and unpublished. Keep them out of chat; integrate when agent capabilities need durable side-effect state.
- Preserve source user data. Do not read secrets or user profiles. No implementation, tests/builds, or model downloads are part of this planning change.

## Chat-first sequence

1. **Finish M05:** prove M05c actual native permissions/boundary on macOS. Keep the committed M05b client and reviewed M05a origin fix.
2. **Add minimum chat state:** M06a fixed, whitelisted preferences, then M06b bounded chat history. Keep these small. No general storage project, graph memory server, tool grants, credentials, or arbitrary paths in preferences.
3. **Verify exact 8/16 GiB candidates:** M10 verifies exact runtime and libraries, GGUF, template, license, hashes and compatibility. Record bounded context, output, threads and idle behavior per candidate. Complete 16 GiB candidate verification, then continue that profile through M11–M16b on the actual machine. An 8 GiB candidate tested on 16 GiB hardware remains internal evaluation evidence, not a user recommendation. Do not guess model names or make performance claims from specs.
4. **Build explicit setup and native chat transport:** M11 owns one lazy process; M12 enables explicit verified download/import; M13 owns task identity, local endpoint, auth, streaming, queue, deadlines and cancellation. No model worker at boot and no automatic download. No filesystem, CLI, MCP, generic URL proxy or operation-journal integration in the chat profile.
5. **Bound resources, then connect chat:** M16a enforces verified profile limits. M14 uses the selected LangChain provider and a one-node LangGraph chat graph with no tools. M15 connects streaming, actual Stop, next-turn behavior and bounded history. Stop must end native inference, not only close the UI stream.
6. **Certify chat per profile:** M16b records real prompt/stream, Stop-to-compute-stop, responsiveness, memory/pressure, repeated cycles and owned-process quit cleanup on each matching macOS machine. Gate sequence: offline UI opens with no optional process/network at boot → detect specs → explicit artifact setup → real prompt streams → Stop ends compute → next turn succeeds → bounded history survives restart → quit cleans up owned process. Promote only the profile that passes; keep the missing tier pending.
7. **Prepare the chat beta:** Only after M15 works, M07 adds attachment input and M08/M09 provide explicit legacy export/import. M16c then packages a reviewable chat-only macOS beta for the certified 16 GiB profile with clean-install, offline, migration, Stop/quit, notices and footprint evidence. Publishing needs its own request. This beta grants no agent tools.
8. **Agent phases:** M17–M20 add read-only workspace capability with explicit native grants, M19b graph-to-ToolBroker routing and grounded results; they do not use the operation journal. M21 begins the first effects phase: integrate journal host/task ownership (J01), then bind proposal intents (J02), before file proposals, user approval and journal-backed apply/recovery. M25–M28 add exact confirmed CLI actions. M29–M31 add opt-in, pinned MCP sessions. Production tool promotion remains subject to M32 certification.
9. **Broader proof and full release:** M32–M34 certify capabilities, measure full responsiveness and enforce budgets; M35 packages the full macOS app, M36 proves the Windows package/platform, M37 checks update/recovery, then M38–M41 prune and complete final release gates. Certify 8 GiB on an actual 8 GiB Mac before advertising that tier.

## Architecture guardrails

- Keep LangChain.js for provider/messages and LangGraph.js as the one selected agent framework. The M03 two-call tool proof is already complete; do not make tool roundtrips a prerequisite for useful chat.
- Use `@assistant-ui/react` for the chat runtime/components with a custom `ChatModelAdapter` into the existing `IAgentClient`. Assistant UI owns presentation and renderer interaction state; LangChain/LangGraph owns model orchestration, and the Tauri host remains the authority for process, profile, limits and cancellation. Do not add the AI SDK transport package, Assistant Cloud, a web server, or a second persistence store.
- Keep bounded IndexedDB history as the single durable chat source. Connect it through Assistant UI's supported local persistence/runtime adapter and verify completed, canceled and partial turns across restart. Measure the complete production UI bundle against the existing 750 KiB gzip target before promoting Assistant UI to the chat runtime.
- First-chat LangGraph has one model node and zero tools. No custom agent loop, generic proxy, MCP/filesystem/CLI permission, checkpointer, cloud tracing or provider fallback.
- Native host remains authority for verified profile selection, limits, endpoint, authentication, task identity, cancellation and owned process cleanup. Renderer history and model output never grant authority.
- Setup is explicit and verified. No auto-download, package-manager install, background worker launch, or optional process/network at boot.
- Keep old Electron data and app identity intact. Export/import is explicit and non-destructive; imported preferences cannot restore paths, grants, approvals or secrets.
- Keep module/export purpose comments and only targeted why-comments for invariants that code cannot show.
- Do not remove Electron until migration is demonstrated and its later card is reached.

## Small Luna packets

Use one card or subcard per `gpt-6-luna` development turn, in dependency order: M05c proof → M06a → M06b → M10 → M11 → M12 → M13 → M16a → M14 → M15 → M16b for the 16 GiB profile → M07–M09 → M16c chat beta. Keep each packet's current focused checks and report actual outcomes; no aggregate “passed” claim from mocked providers or injected specs.

After chat implementation, continue one vertical slice at a time: M17/M18 read-only grants and tools → M19a context budget → M19b graph routing → M20 grounded tasks → M21 starts with J01, then J02 and reviewed writes through M24 → M25–M28 confirmed CLI → M29–M31 optional MCP. The 8 GiB M16b result remains pending until matching hardware is available. M32 certifies exact tool capabilities for production promotion. Windows remains a separate actual-platform proof after macOS.

## Open evidence and resume point

The 8 GiB physical macOS target is unavailable on the current machine. M10 must verify a real candidate's identity, license, template and resource envelope; candidate checks on 16 GiB hardware do not certify physical 8 GiB fit or responsiveness. M11–M16 may advance for the 16 GiB candidate in isolated evaluation, and its M16b result can authorize the 16 GiB chat beta after M08/M09 and M16c. The 8 GiB profile remains unavailable to users until its own M16b check on matching hardware. Current code work resumes at M05c native boundary proof; the next clean handoff after M05 is M06a, and runtime candidate work begins at M10.
