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

The graph remains tool-free and has no persistence, MCP, journal or cloud fallback; those remain outside M14.

## Real local-model E2E evidence (2026-10-11)

- Added a minimal `LocalApp` chat caller so the M14 graph can be exercised through the actual Tauri desktop window. It sends the in-memory LangChain history, renders streamed `messages` chunks, and exposes New chat and Stop controls. This is a functional smoke surface, not the planned Assistant UI integration or durable history.
- Shared the native 32-message request ceiling with the graph and chat UI; the UI disables further input at the boundary and directs the user to New chat. The proof page checks that oversized graph history is rejected before a native request starts.
- First real run on the development 16 GiB Apple Silicon Mac used the pinned Qwen3 1.7B Q4_K_M GGUF from SSD app data and the bundled llama.cpp v0.6.0 runtime. Prompt `Reply with exactly: LOCAL CHAT WORKS.` produced exactly `LOCAL CHAT WORKS.` in the app.
- The run exposed two packaging/bridge gaps: frontend command permissions were missing from the main capability, and the macOS bundler materialized verified runtime symlinks as regular copied files. Added the two chat permissions and changed alias verification to accept only the expected relative symlink or a regular file whose hash matches the pinned payload. A focused Rust test covers valid/wrong/missing symlinks and exact/mismatched copies.
- Quit the app after the response; process inspection showed neither the Tauri host nor its owned `llama-server` still running.
- Cold startup in this single run spent roughly 1–2 minutes verifying/loading the 1.1 GB model. Treat this as a measured limitation, not a general performance result.
- Not yet verified: model stop-to-compute behavior, a follow-up turn, persistence/restart, memory pressure or profile certification. The 8 GiB profile and Windows remain unverified.
