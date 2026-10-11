# M13 — Native chat transport report

## Delivered

- Added `src-tauri/src/chat.rs` with one native worker and a FIFO queue: one in-flight task plus up to ten waiting tasks. Queued cancellation removes the task immediately; active cancellation stops the owned runtime to interrupt startup or streaming. Duplicate IDs, overflow, stale sessions, and wrong-owner cancellation fail closed.
- Added the `local_chat_start` and `local_chat_cancel` Tauri commands. Chat startup reuses the verified M12 `ModelRuntime`, including its owned process and private bearer token. Only fixed loopback `POST /v1/chat/completions` is reachable; no endpoint, model, tools, or limits are accepted from IPC.
- Bound the transport to the pinned Qwen3 developer candidate behind the existing Apple Silicon macOS debug-build gate. Model identity and generation controls stay native. No preference schema or selection UI changed; profile is implicit and developer-only.
- Extended bridge-session replacement and window destruction handling to cancel the owning chat tasks. Stream events carry task/request IDs; late or mismatched events are ignored by the renderer bridge. A dropped Channel receiver terminates the stream path.
- Added renderer bridge methods with matching message limits and typed Channel event filtering. No LangChain graph/client or chat UI was added; those are M14/M15 scope.

## Security and bounds

- Each request has 1–32 messages, each at most 8 KiB UTF-8, with 32 KiB total content. Roles are limited to `system`, `user`, and `assistant`; unknown message fields and NUL content are rejected.
- Request/task identity is validated by the existing active-session bridge. Cancellation requires matching owner and session.
- Requests go only to `127.0.0.1` using the runtime-owned auth token. HTTP redirects and non-200 backend responses are rejected. SSE/chunked input has a 120-second deadline and 1 MiB response cap.
- Runtime process ownership and cleanup remain in `ModelRuntime`. Chat does not use the operation journal, external tools, files, or generic network access.

## Checks

- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml` — 23 passed, 1 ignored. Added checks cover payload tampering/limits, queue capacity/cancel, wrong owner, session/window invalidation, cancellation late frames, dropped sender, chunked SSE, backend errors, and redirect rejection.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed.
- `npm run web:typecheck` — passed using the existing TypeScript installation from `/Users/meharaj/Downloads/ai-worker-desktop/node_modules`; temporary worktree symlink removed afterward.
- `git diff --check` — passed.
- Context7 consulted for Tauri Channel, LangChain OpenAI chat completions, and llama.cpp server request format.

## Limits

The worktree has no bundled `llama-server` runtime or model assets at the expected runtime resource path, so an actual-model smoke test could not run. This candidate remains developer evaluation only; no certification or platform support claim is made. The existing ignored runtime integration test also requires unavailable M10a artifacts.
