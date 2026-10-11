# M13 runtime spawn race fix

## Change

- Recheck cancellation and the 120-second task deadline immediately after acquiring the runtime mutex.
- Recheck again directly before `command.spawn()`; remove the private auth directory if this check aborts.
- Add a behavioral test that holds the runtime mutex until the task deadline expires, then verifies the start gate returns `chat response timed out` and the modeled spawn point is not reached.
- M11's independent 60-second readiness timeout and owned-process cleanup are unchanged.

## Checks

All commands ran from `/Users/meharaj/Downloads/.worktrees/ai-worker-desktop-chat-e2e`.

- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — passed.
- `cargo test --bin ai-worker-tauri model_runtime::tests::chat_deadline_expiring_while_waiting_for_runtime_lock_does_not_start_work --manifest-path src-tauri/Cargo.toml` — passed, 1 passed.
- `cargo test --bin ai-worker-tauri model_runtime::tests:: --manifest-path src-tauri/Cargo.toml` — passed, 7 passed, 1 ignored (requires reviewed M10a artifacts).
- `cargo test --bin ai-worker-tauri chat::tests::streams_local_sse_and_rejects_backend_redirect --manifest-path src-tauri/Cargo.toml` — passed, 1 passed.
- `cargo test --bin ai-worker-tauri chat:: --manifest-path src-tauri/Cargo.toml` — attempted twice; both group runs failed at `chat::tests::streams_local_sse_and_rejects_backend_redirect` (`src/chat.rs:845`) with `chat backend failed`. The same test passes when run by itself. Failure is outside changed code and appears related to running the chat tests together; no unrelated changes made.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed, `Finished dev profile`.
- `git diff --check` — passed.

The first `cargo fmt --check` caught formatting in the new test; `cargo fmt` corrected it, and the final check passed.

## Fixture follow-up

The grouped chat test intermittently failed because each fake server performed one `read`, which can return after only the HTTP headers while the client is still writing the JSON body. The fixture now reads through the header terminator and consumes the advertised `Content-Length` before replying. Both fake servers use this test-only helper; production transport is unchanged.

- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — passed.
- `git diff --check` — passed.
- `cargo test --bin ai-worker-tauri chat:: --manifest-path src-tauri/Cargo.toml` — passed, 6 passed.
- Same grouped test command run 10 consecutive times — all passed, 6 passed each run.

## Commit

`fix(chat): abort expired startup before spawn`.
