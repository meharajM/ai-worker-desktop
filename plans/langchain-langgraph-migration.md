# LangChain.js + LangGraph.js migration decision

Decision recorded 10 October 2026; implementation checkpoint `d394789` on 11 October 2026. This plan supersedes earlier AI SDK Core selections and proof instructions. M14's one-node LangGraph graph is implemented with mocked proof. Public `stream()` emits LangGraph `messages` mode live; `streamState()` emits final `values` state. No production UI calls it yet. Real inference remains unverified because no GGUF is available and disk space is below import needs. macOS arm64 runtime packaging and alias verification are implemented; the candidate is pinned Qwen3 1.7B for development E2E, then revisit Qwen3.5. Windows and performance remain unverified.

## Decision

Use LangChain.js (`@langchain/core`, `@langchain/openai`) for model/provider and canonical message types, and LangGraph.js (`@langchain/langgraph`) for the in-process bounded tool cycle. The app remains a Tauri-hosted local web UI. Keep existing `IAgentClient`, native transport, ToolBroker, operation journal and UI contracts.

LangGraph runs in the renderer process. It is not a graph server, Node/Python application server, durable workflow engine or permission authority. Do not add a second agent framework or model engine. A provider/framework failure is a reviewed architecture decision; there is no automatic fallback to AI SDK, Rig, a cloud provider or another model endpoint.

## Boundaries and data

- Native code remains authoritative for endpoint allowlisting, credentials, task/request identity, limits, deadlines, cancellation and process cleanup. The model sees only an explicit local endpoint selected by native policy.
- LangGraph invokes registered in-process broker tools. The broker and native host validate each request; model output, graph state and restored chat history cannot grant permissions.
- Graph nodes cannot approve, replay or perform OS effects directly. Human approval, file/CLI execution, recovery and uncertain outcomes remain native journal responsibilities.
- Bound the model → broker tool execution → model cycle by native task/tool limits and explicit graph stop conditions. Stop must cancel provider work, active native transport/tool work and future graph nodes in that order; reject late events after cancellation.
- Persist canonical LangChain `BaseMessage` turns alongside the existing chat history. Use the official serializer for stored messages, preserve complete assistant tool-call and tool-result turns, and keep display formatting separate. Validate stored records before deserialization; official `load()` instantiates classes and must never receive untrusted user-supplied data.
- Native operation journal remains the only durable source for side effects. Do not add a LangGraph checkpointer, workflow database or duplicate journal by default. Do not enable cloud LangSmith tracing or any default network trace export.

## Implementation packets

### M03a — Native proof transport (existing prerequisite)

Reuse the reviewed-clean native fixture transport and isolated Tauri proof configuration. The clean native fixture portion is reusable. The AI SDK harness from commit `b9d6de3` is unchecked and obsolete; do not extend it or count it as proof. Preserve default app assets/capabilities without proof endpoint access.

### M03b — LangChain/LangGraph WebView proof (replacement)

Add only an isolated proof harness. Verify current package metadata, browser support and official public APIs before selecting exact compatible pins for `@langchain/core`, `@langchain/openai` and `@langchain/langgraph`; do not install packages or assume support as part of this planning task. Import only required modules. Keep every new AI, bridge, fixture and proof module focused on one responsibility with an explicit export contract; add short module/export comments and targeted comments for non-obvious graph routing, trust/limits, cancellation and history invariants. Avoid Node polyfills and custom SSE parsers.

Prove this real chain in actual WKWebView:

1. Synthetic local SSE response, delivered through the existing typed Tauri Channel transport, including UTF-8 split across chunks and multiple frames.
2. LangChain model receives the bounded stream and surfaces text, provider errors and abort.
3. Reuse the native fixture's two-call sequence: explicit LangGraph routing must make two distinct native tool calls and receive both native results through the graph before returning final text. Preserve both calls/results in the proof report; one call/result is insufficient.
4. Complete canonical messages survive save/reload; cancellation releases stream/controller/listener/native fixture state and suppresses late events.

Then run WebView2 when hardware is available. If unavailable, record missing hardware and leave that gate pending. Record exact package versions, imports, browser support source, imported package graph, JS gzip and native size, adapter details, and each pass/fail in `plans/reports/stack-proof.md`. Keep the initial JS gzip target at or below 750 KiB. Failed or unavailable evidence is not a pass. Continue only after a reviewed decision if compatibility or size fails.

### M14 — Tool-free chat graph adapter

Keep change focused across provider transport, graph adapter, history translation, `IAgentClient`, and the UI stream/stop adapter only where required. Use one explicit LangGraph model node with no tools for the first chat. Preserve native task/profile limits and canonical history; do not implement another hand-written agent loop.

Required for every new AI-layer, bridge, fixture and proof module from this point onward: one clear responsibility, explicit export contract, and short module/export comments. Add targeted comments only where code does not explain non-obvious graph transitions, native trust/limit boundaries, cancellation order, or canonical history invariants. Keep comments tied to why the invariant exists; avoid narrating each statement.

Implemented M14 mock proof covers graph chunk streaming, delivery before native completion, final state access, local endpoint/body rejection, native error propagation, abort before start acknowledgement, and rejection of unsupported tool/multimodal inputs. It is not real model E2E: no GGUF is available and disk space is below import needs. No production UI caller, persistence or UI Stop integration exists yet. Keep the following real-candidate checks open: real prompt/stream, history round trip, empty final output, provider failure, abort before/during streaming, late events, task identity and native cleanup. Confirm no cloud tracing/checkpointer or automatic framework/provider fallback.

### M19b — Native-broker read-tool route

After M18 native read tools and M19a context budgeting, add bounded LangGraph model → ToolBroker → model routing. Expose only current native-approved read descriptors; native policy validates every call. Preserve complete assistant call/result groups with source metadata. Check two distinct tool calls/results, malformed or duplicate calls, revoked grants, abort during dispatch and late events. Write, CLI and MCP tools remain absent until their own cards; production promotion still requires M32.

## Current documentation used

Context7 resolved the official LangChain JavaScript documentation as `/websites/langchain_oss_javascript` and LangGraph.js documentation as `/websites/langchain_oss_javascript_langgraph`. Relevant official pages:

- [LangChain messages and serialization](https://docs.langchain.com/oss/javascript/langchain/messages): `BaseMessage` JSON serialization; `load()` reconstructs classes, so input must be app-owned and validated.
- [LangGraph workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents): explicit `StateGraph`, conditional routing and `ToolNode` pattern for tool-calling cycles.

These docs establish API patterns, not browser compatibility, exact package-version compatibility, bundle size, or Tauri WebView behavior; M03b must measure those directly.
