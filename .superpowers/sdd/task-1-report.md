# M16a Native Resource Envelope Report

## Changes

- Added a native 8 GiB physical-memory admission floor for the pinned developer evaluation candidate. macOS RAM is read from `hw.memsize`; inability to determine it refuses startup. Refusal uses the existing `ChatEvent::Failed` path with a clear message.
- Kept all llama-server settings fixed in native code: parallel 1, context 2048, output 128, batch 128, micro-batch 64, 4 generation threads, 4 batch threads, reasoning off. Added a regression test that pins this envelope and a chat IPC test that rejects renderer-supplied context/output limits.
- Applied the existing idle preferences to the owned server: `TaskEnd` stops it after each task; `ShortIdle` retains it for 60 seconds after the last task. A new task cancels the pending unload. Cleanup only targets the owned process group.
- The existing Apple Silicon macOS debug gate remains the only candidate availability gate. No user-selectable model profile or certification claim was added.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml`
- `git diff --check`
- `CARGO_TARGET_DIR=/Volumes/MAC_APPS/ai-worker-desktop-artifacts/targets/ai-worker-desktop-chat-e2e CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --bin ai-worker-tauri`
- Result: 35 passed, 0 failed, 1 ignored. The ignored real-runtime integration test requires reviewed M10a SSD artifacts.
- Added policy tests exercise just-below-floor refusal, exact-floor acceptance, fixed native generation arguments, renderer tampering rejection, and idle timer cancellation/expiry. These are policy tests, not hardware certification.

## Limits and risk

- The 8 GiB threshold is an evaluation admission floor only. This change makes no fit, reliability, 8 GiB certification, or Windows availability claim; no live macOS pressure telemetry was added because no source or threshold is specified.
- No real 8 GiB device/model run or new runtime-artifact integration run was performed. The 16 GiB development machine does not establish 8 GiB behavior.
- Default `TaskEnd` unloads the model after every completed task, so later turns incur a cold model load. `ShortIdle` avoids that reload when another task arrives within 60 seconds.
