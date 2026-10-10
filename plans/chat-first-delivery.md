# Chat-first delivery plan

**Status:** planning only; no implementation or model acquisition in this change.

**Owner/model:** all development and review turns use `gpt-6-luna`.

**Platform order:** macOS first, Windows next.

**Canonical cards:** [Luna implementation cards](./luna-implementation-cards.md); this file defines their delivery order and gates.

## Goal

Deliver one useful end-to-end local chat first. Recommend a verified model profile from the machine's detected RAM, with coverage for both 8 GiB and 16 GiB classes. Add agent capabilities in later, gated stages: read-only workspace, reviewed file changes, confirmed CLI, then optional MCP.

The first-chat release gate is not complete until both RAM profiles have evidence on actual macOS machines. The current machine is Apple silicon with 16 GiB; no physical 8 GiB machine is available. M10–M16 work is profile-scoped: complete and use the verified 16 GiB profile while 8 GiB physical evidence is pending. The 8 GiB candidate may be evaluated against its artifact and resource envelope on the 16 GiB machine, but that cannot prove 8 GiB runtime fit, responsiveness, thermal behavior, or cleanup. Do not advertise or certify 8 GiB until actual 8 GiB hardware passes M16b. Its missing evidence blocks the both-profile release gate, not 16 GiB implementation. It also does not automatically promote agent capabilities; production promotion remains gated by M32. Windows proof follows on actual Windows hardware; cross-compilation is not evidence.

## Current checkpoint

- M00–M04 complete.
- M05a reviewed clean at `5ec261f`; M05b web client is active; M05c native ACL proof is next. Do not reset or overwrite that work.
- M03 LangChain.js/LangGraph.js fixture proof passed 11/11 in macOS WKWebView, including two native tool calls, canonical history and cancellation. It proves framework/bridge compatibility only; no real model runtime or GGUF has been proven.
- The Rust operation-journal crate and TypeScript bridge exist locally but are standalone and unpublished. Keep them out of chat; integrate when agent capabilities need durable side-effect state.
- Preserve source user data. Do not read secrets or user profiles. No implementation, tests/builds, or model downloads are part of this planning change.

## Chat-first sequence

1. **Finish M05:** complete the active M05b client, then prove M05c actual native permissions/boundary on macOS. Keep the existing native contract and reviewed M05a origin fix.
2. **Add minimum chat state:** M06a fixed, whitelisted preferences, then M06b bounded chat history. Keep these small. No general storage project, graph memory server, tool grants, credentials, or arbitrary paths in preferences.
3. **Verify exact 8/16 GiB profiles:** M10 verifies exact runtime and libraries, GGUF, template, license, hashes and compatibility. Record bounded context, output, threads and idle behavior per profile. Complete 16 GiB candidate and actual-machine evidence, then continue that profile through M11–M16 while 8 GiB remains pending. Candidate/resource-envelope checks for 8 GiB on 16 GiB hardware are not physical 8 GiB proof. Do not guess model names or make performance claims from specs.
4. **Build explicit setup and native chat transport:** M11 owns one lazy process; M12 enables explicit verified download/import; M13 owns task identity, local endpoint, auth, streaming, queue, deadlines and cancellation. No model worker at boot and no automatic download. No filesystem, CLI, MCP, generic URL proxy or operation-journal integration in the chat profile.
5. **Bound resources, then connect chat:** M16a enforces verified profile limits. M14 uses the selected LangChain provider and a one-node LangGraph chat graph with no tools. M15 connects streaming, actual Stop, next-turn behavior and bounded history. Stop must end native inference, not only close the UI stream.
6. **Prove first-chat gate:** M16b records real prompt/stream, Stop-to-compute-stop, responsiveness, memory/pressure, repeated cycles and owned-process quit cleanup for both profiles on named macOS hardware. First gate sequence: offline UI opens with no optional process/network at boot → detect specs and recommend only a verified matching profile → explicit artifact setup → real prompt streams → Stop ends compute → next turn succeeds → bounded history survives restart → quit cleans up owned process. A missing tier remains an explicit evidence gap.
7. **Only after M15 works:** M07 attachment input and M08/M09 legacy export/import. These preserve data and support chat continuity; none precedes useful chat.
8. **Agent phases:** M17–M20 add read-only workspace capability with explicit native grants and grounded results; they do not use the operation journal. M21 begins the first effects phase: integrate journal host/task ownership (J01), then bind proposal intents (J02), before file proposals, user approval and journal-backed apply/recovery. M25–M28 add exact confirmed CLI actions. M29–M31 add opt-in, pinned MCP sessions. Passing the 16 GiB profile alone neither satisfies the both-profile chat release gate nor promotes agent capabilities; production promotion remains subject to M32 certification.
9. **Broader proof and release:** M32–M34 certify capabilities, measure full responsiveness and enforce budgets; M35 macOS package, M36 actual Windows package/platform proof, M37 update/recovery, then M38–M41 prune and release.

## Architecture guardrails

- Keep LangChain.js for provider/messages and LangGraph.js as the one selected agent framework. The M03 two-call tool proof is already complete; do not make tool roundtrips a prerequisite for useful chat.
- First-chat LangGraph has one model node and zero tools. No custom agent loop, generic proxy, MCP/filesystem/CLI permission, checkpointer, cloud tracing or provider fallback.
- Native host remains authority for verified profile selection, limits, endpoint, authentication, task identity, cancellation and owned process cleanup. Renderer history and model output never grant authority.
- Setup is explicit and verified. No auto-download, package-manager install, background worker launch, or optional process/network at boot.
- Keep old Electron data and app identity intact. Export/import is explicit and non-destructive; imported preferences cannot restore paths, grants, approvals or secrets.
- Keep module/export purpose comments and only targeted why-comments for invariants that code cannot show.
- Do not remove Electron until migration is demonstrated and its later card is reached.

## Small Luna packets

Use one card or subcard per `gpt-6-luna` development turn, in dependency order: M05b completion → M05c proof → M06a → M06b → M10 → M11 → M12 → M13 → M16a → M14 → M15 → M16b. M07–M09 follow the first useful chat. Keep each packet's current focused checks and report actual outcomes; no aggregate “passed” claim from mocked providers or injected specs.

After chat implementation, continue one vertical slice at a time: M17/M18 read-only grants and tools → M19/M20 grounded tasks → M21 starts with J01, then J02 and reviewed writes through M24 → M25–M28 confirmed CLI → M29–M31 optional MCP. The both-profile M16b gate is still required for first-chat release; no 16 GiB-only release or automatic agent promotion. M32 certifies exact tool capabilities for production promotion. Windows remains a separate actual-platform proof after macOS.

## Open evidence and resume point

The 8 GiB physical macOS target is unavailable on the current machine. M10 must verify a real candidate's identity, license, template and resource envelope; candidate checks on 16 GiB hardware do not certify physical 8 GiB fit or responsiveness. M11–M16 may advance for the verified 16 GiB profile while 8 GiB physical evidence remains open. M16b requires actual 8 GiB and 16 GiB machines before first-chat release. Current code work resumes at active M05b; next boundary gate is M05c. The plan's next clean handoff after M05 is M06a; runtime candidate work begins at M10.
