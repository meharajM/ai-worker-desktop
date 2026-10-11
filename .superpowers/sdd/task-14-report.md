# M14 — LangChain/LangGraph local chat

## Delivered

- Added a one-node LangGraph chat graph backed by the pinned `ChatOpenAI` integration. The node calls `model.stream()` and folds `AIMessageChunk` values into a canonical `AIMessage`; LangChain handles SSE parsing and LangGraph owns graph state.
- Added a custom Fetch adapter over `desktopBridge.startLocalChat` and `cancelLocalChat`. It accepts only `http://local-chat.invalid/v1/chat/completions`, POST, and the exact streaming `{ model, messages, stream }` request shape. It converts only simple text system/user/assistant messages and rejects tool calls, extra fields, structured content and multimodal content.
- Adapter sends no browser network request. It correlates buffered pre-ack events only after native start returns the accepted request ID; abort, timeout and stream cancellation request native cancellation once. Native failure, completion and cancellation settle the SSE stream once.
- Public `stream()` uses LangGraph `messages` mode and emits `[messageChunk, metadata]` while the model node runs. The nested model receives LangGraph's injected callback config; empty callbacks are set only at the outer graph boundary to keep tracing disabled. `streamState()` exposes the final graph state when needed.
- Added deterministic mock proof cases to the existing browser transport check, including a gated native completion that is released only after the graph token is observed. No model weights were downloaded; no runtime packages or Task 111 docs were changed.

## Checks

- `npm run web:typecheck` — passed.
- `npm run web:build` — passed.
- `npx tsc --noEmit --project tsconfig.proof.json` — passed.
- `npm run web:proof-build` — passed.
- Existing proof check page in headless Chromium — passed six M14 cases covering graph token streaming, token delivery before native completion, final state access, local endpoint/body rejection, native error propagation, abort before start acknowledgement, and unsupported tool/multimodal rejection. Existing transport checks also passed.
- `git diff --check` — passed.

## Limits

Real-model inference remains gated because no GGUF is present and available disk capacity is below the candidate import requirement. The graph has no tools, UI, persistence, MCP, journal or cloud fallback; those remain outside M14.
