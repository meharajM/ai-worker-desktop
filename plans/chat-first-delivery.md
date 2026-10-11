# Chat-first delivery plan

**Status:** implementation in progress. M13 native chat transport and M14 mock graph proof are implemented; real model inference and Assistant UI chat are pending.

**Subagents:** implementation and review subagents use `gpt-6-luna`.

**Platform order:** macOS first, Windows next. The web UI is local/offline and hosted by Tauri; approved workspace CLI actions come later.

**Canonical cards:** [Luna implementation cards](./luna-implementation-cards.md); this file defines their delivery order and gates.

## Goal

Deliver one useful end-to-end local chat first, using Assistant UI for the React chat surface and a custom adapter into the local LangChain/LangGraph client. Recommend only a model profile certified on matching hardware. Add agent capabilities in later, gated stages: read-only workspace, reviewed file changes, confirmed CLI, then optional MCP.

The current development Mac is Apple silicon with 16 GiB; no physical 8 GiB Mac is available. M10–M16 work is profile-scoped. M10 verifies an artifact and resource candidate; M16b certifies an app profile only on matching hardware. An 8 GiB candidate may be evaluated on the 16 GiB machine, but that cannot prove 8 GiB fit, responsiveness, thermal behavior or cleanup. A certified 16 GiB profile can reach the chat-only macOS beta after migration and packaging checks; 8 GiB remains unavailable to users until physical evidence passes M16b. Agent capabilities still require M32 certification. Windows proof follows on actual Windows hardware; cross-compilation is not evidence.

## Final goal

Deliver an open-source, offline-first desktop assistant with a small bundled web UI and Tauri native bridge. On certified macOS Apple silicon and Windows x64 systems, users explicitly install or import a verified, free and openly licensed local model, chat with streaming and real Stop, read only selected text files, review exact file changes before apply, confirm registered CLI actions, and opt into a small curated MCP catalog. Native policy owns grants, limits, approvals, process cleanup and journal-backed recovery. Preserve legacy chats without importing credentials or authority. Report app, WebView, helper and inference costs separately; certify 8 GiB and 16 GiB macOS profiles on matching hardware before full release. M41 is the full consumer-release gate. The earlier 16 GiB macOS chat beta contains chat and migration only.

## Current checkpoint

- M00–M13 implemented, including M05c native permission-boundary proof (`767b016`), M06a/M06b preferences and bounded history, M12 setup, and M13 native transport.
- M12 explicit model setup is implemented with a pinned Qwen3 1.7B development candidate. Task111 bundles the verified macOS arm64 llama runtime and verifies loader aliases. Runtime packaging is verified; candidate certification is not. Windows remains unverified.
- M13 native local chat transport is implemented. M14's one-node LangChain/LangGraph graph is implemented at `d394789`; its mock proof verifies live `messages` streaming. It is not real model E2E: no GGUF is available and disk space is below import needs.
- M16a is not started. M15 Assistant UI, bounded history connection and real Stop are pending; no production UI calls the chat graph yet.
- M03 LangChain.js/LangGraph.js fixture proof passed 11/11 in macOS WKWebView, including two native tool calls, canonical history and cancellation. It proves framework/bridge compatibility only; no real model runtime or GGUF has been proven.
- The Rust operation-journal crate and TypeScript bridge exist locally but are standalone and unpublished. Keep them out of chat; integrate when agent capabilities need durable side-effect state.
- Preserve source user data. The graph proof uses mocks; no real model acquisition or inference is claimed.

## Chat-first sequence

1. **M05 complete:** M05c native permissions/boundary proof is committed. Keep the reviewed M05a origin fix and committed M05b client.
2. **Add minimum chat state:** M06a fixed, whitelisted preferences, then M06b bounded chat history. Keep these small. No general storage project, graph memory server, tool grants, credentials, or arbitrary paths in preferences.
3. **Verify exact candidates:** M10 verifies exact runtime and libraries, GGUF, template, license, hashes and compatibility. The current development E2E candidate is pinned Qwen3 1.7B; revisit Qwen3.5 after this candidate. Record bounded context, output, threads and idle behavior. No candidate is certified until real inference and matching-hardware checks pass. Do not make performance claims from specs or mocked proofs.
4. **Build explicit setup and native chat transport:** M11 owns one lazy process; M12 enables explicit verified download/import; M13 owns task identity, local endpoint, auth, streaming, queue, deadlines and cancellation. No model worker at boot and no automatic download. No filesystem, CLI, MCP, generic URL proxy or operation-journal integration in the chat profile.
5. **Bound resources, then connect chat:** M16a enforces candidate resource limits and is not started. M14 is implemented as a one-node, no-tool graph. Its public `stream()` uses LangGraph `messages` mode to deliver chunks live; `streamState()` exposes final graph state. Mock proof only; no direct UI caller yet. M15 connects Assistant UI, bounded history, actual Stop and next-turn behavior. Stop must end native inference, not only close the UI stream. Real-candidate M14 E2E remains blocked until a GGUF and sufficient import disk space are available.
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

Use one card or subcard per `gpt-6-luna` development turn, in dependency order: M05 and M06a/M06b are complete → M10–M13 are implemented → M16a → M15 → real-candidate M14 E2E and M16b per hardware profile → M07–M09 → M16c chat beta. M14's mock proof is already implemented; it does not satisfy real inference checks. Real-candidate E2E remains gated on obtaining a GGUF and import disk space. Report actual outcomes; no aggregate “passed” claim from mocked providers or injected specs.

After chat implementation, continue one vertical slice at a time: M17/M18 read-only grants and tools → M19a context budget → M19b graph routing → M20 grounded tasks → M21 starts with J01, then J02 and reviewed writes through M24 → M25–M28 confirmed CLI → M29–M31 optional MCP. The 8 GiB M16b result remains pending until matching hardware is available. M32 certifies exact tool capabilities for production promotion. Windows remains a separate actual-platform proof after macOS.

## Open evidence and resume point

No GGUF is available and disk space is below the Qwen3 1.7B import requirement, so real inference remains unverified. Use this pinned candidate for development E2E, then revisit Qwen3.5. The macOS arm64 runtime package and loader aliases are verified; this does not certify the candidate. M14 currently has mock proof only, no UI caller, and uses `stream()` with `streamMode: 'messages'` for live chunks; `streamState()` is for final state. M16a has not started; current resume point is M16a, followed by M15 Assistant UI/history/Stop. Real-candidate M14 E2E and M16b remain gated on a GGUF plus import space and must pass before claiming real chat. Keep Windows and performance unverified; macOS first, Windows next. The 8 GiB tier requires matching hardware evidence before certification.
