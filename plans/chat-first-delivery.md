# Chat-first delivery plan

**Status (11 October 2026):** M15 Assistant UI, bounded IndexedDB history, session switching, Stop, and visible limit/persistence notices are complete. M16a native RAM reserve policy is complete; all 21 browser proof checks pass after the flushSync proof harness fix. A real UI→graph→native→model→UI response succeeded once on the 16 GiB Apple Silicon development Mac. It is not repeatable or certified profile evidence. The packaged Tauri app interaction/restart matrix remains unverified; 3 GiB peak estimate and macOS memory-pressure heuristic remain uncalibrated. 8 GiB and Windows evidence remain open.

**Subagents:** implementation and review subagents use `gpt-6-luna`.

**Platform order:** macOS first, Windows next. The web UI is local/offline and hosted by Tauri; approved workspace CLI actions come later.

**Canonical cards:** [Luna implementation cards](./luna-implementation-cards.md); this file defines their delivery order and gates.

## Goal

Deliver one useful end-to-end local chat first, using Assistant UI for the React chat surface and a custom adapter into the local LangChain/LangGraph client. Recommend only a model profile certified on matching hardware. Add agent capabilities in later, gated stages: read-only workspace, reviewed file changes, confirmed CLI, then optional MCP.

The current development Mac is Apple silicon with 16 GiB; no physical 8 GiB Mac is available. M10–M16 work is profile-scoped. M10 verifies an artifact and resource candidate; M16b certifies an app profile only on matching hardware. An 8 GiB candidate may be evaluated on the 16 GiB machine, but that cannot prove 8 GiB fit, responsiveness, thermal behavior or cleanup. A certified 16 GiB profile can reach the chat-only macOS beta after migration and packaging checks; 8 GiB remains unavailable to users until physical evidence passes M16b. Agent capabilities still require M32 certification. Windows proof follows on actual Windows hardware; cross-compilation is not evidence.

## Final goal

Deliver an open-source, offline-first desktop assistant with a small bundled web UI and Tauri native bridge. On certified macOS Apple silicon and Windows x64 systems, users explicitly install or import a verified, free and openly licensed local model, chat with streaming and real Stop, read only selected text files, review exact file changes before apply, confirm registered CLI actions, and opt into a small curated MCP catalog. Native policy owns grants, limits, approvals, process cleanup and journal-backed recovery. Preserve legacy chats without importing credentials or authority. Report app, WebView, helper and inference costs separately; certify 8 GiB and 16 GiB macOS profiles on matching hardware before full release. M41 is the full consumer-release gate. The earlier 16 GiB macOS chat beta contains chat and migration only.

## Current checkpoint

- M15 Assistant UI, bounded IndexedDB history, session switching, Stop, and notices are complete (`b803854`, `c38d02d`, `50803e0`). M16a resource policy is complete (`1719c04`); all 21 browser proof checks pass after the flushSync harness fix. Scripts/CI updates are `46ac0b8` and `2200280`.
- One real UI→graph→native→model→UI response succeeded on the 16 GiB Apple Silicon development Mac. This is one-run E2E evidence, not repeatable or certified profile evidence. The provisional 3 GiB peak estimate and macOS `memory_pressure` heuristic remain uncalibrated.
- Fresh packaged-app interaction/restart proof remains unverified. 8 GiB requires an actual 8 GiB Mac; Windows is a separate actual-platform proof.
- The standalone Rust operation-journal crate and TypeScript bridge remain unpublished and unintegrated. J01 host integration starts at M21, after read-only M17–M20 work.


## Chat-first sequence

1. **M05 complete:** M05c native permissions/boundary proof is committed. Keep the reviewed M05a origin fix and committed M05b client.
2. **Add minimum chat state:** M06a fixed, whitelisted preferences, then M06b bounded chat history. Keep these small. No general storage project, graph memory server, tool grants, credentials, or arbitrary paths in preferences.
3. **Verify exact candidates:** M10 verifies exact runtime and libraries, GGUF, template, license, hashes and compatibility. The current development E2E candidate is pinned Qwen3 1.7B; revisit Qwen3.5 after this candidate. Record bounded context, output, threads and idle behavior. No candidate is certified until real inference and matching-hardware checks pass. Do not make performance claims from specs or mocked proofs.
4. **Build explicit setup and native chat transport:** M11 owns one lazy process; M12 enables explicit verified download/import; M13 owns task identity, local endpoint, auth, streaming, queue, deadlines and cancellation. No model worker at boot and no automatic download. No filesystem, CLI, MCP, generic URL proxy or operation-journal integration in the chat profile.
5. **Chat implementation complete; certification remains:** M16a policy and M15 Assistant UI, bounded IndexedDB history, Stop, session switching, and notices are implemented. All 21 browser proof checks pass after the flushSync harness fix. The one real-model E2E response is development evidence only. Complete M16b matching-hardware proof before claiming certification.
6. **Certify chat per profile:** M16b records real prompt/stream, Stop-to-compute-stop, responsiveness, memory/pressure, repeated cycles and owned-process quit cleanup on each matching macOS machine. Gate sequence: offline UI opens with no optional process/network at boot → detect specs → explicit artifact setup → real prompt streams → Stop ends compute → next turn succeeds → bounded history survives restart → quit cleans up owned process. Promote only the profile that passes; keep the missing tier pending.
7. **Prepare the chat beta:** After M16b evidence, M07 adds attachment input and M08/M09 provide explicit legacy export/import. M16c then packages a reviewable chat-only macOS beta for the certified 16 GiB profile with clean-install, offline, migration, Stop/quit, notices and footprint evidence. Publishing needs its own request. This beta grants no agent tools.
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

Current remaining order: (1) M16b real model/resource/cancel/repeated-cycle/quit-cleanup proof per matching hardware; 8 GiB requires actual 8 GiB Mac, Windows separately. (2) M07 attachments + M08/M09 explicit legacy export/import; then M16c chat-only beta. (3) M17–M20 read-only workspace/context-grounded tasks. (4) J01/J02 + M21–M24 reviewed file-write/journal/recovery. (5) M25–M28 confirmed workspace CLI. (6) M29–M31 opt-in curated MCP. (7) M32–M34 capability/evidence/footprint certification. (8) M35–M37 macOS packaging, actual Windows build/recovery/update. (9) M38–M41 legacy pruning/full release. Keep cards sequential; distinguish mock proof, one-run E2E, packaged app proof, and hardware certification.

After chat implementation, continue one vertical slice at a time: M17/M18 read-only grants and tools → M19a context budget → M19b graph routing → M20 grounded tasks → M21 starts with J01, then J02 and reviewed writes through M24 → M25–M28 confirmed CLI → M29–M31 optional MCP. The 8 GiB M16b result remains pending until matching hardware is available. M32 certifies exact tool capabilities for production promotion. Windows remains a separate actual-platform proof after macOS.

## Open evidence and resume point

Current resume point: M16b real-model/resource/cancel/repeated-cycle/quit-cleanup proof per matching hardware. The 16 GiB Mac has one successful real E2E run, not a repeatable/certified profile; actual 8 GiB Mac and Windows evidence are still required. Fresh packaged-app interaction/restart matrix remains unverified. Next comes M07–M09, then M16c. The provisional 3 GiB peak estimate and macOS memory-pressure heuristic remain uncalibrated; macOS first, Windows next.
