# M16a Native Resource Envelope Report

## Changes

- Added a native admission rule for the pinned developer evaluation candidate: physical RAM must meet the existing 8 GiB floor and fit `max(2 GiB, 25% of RAM)` reserve plus a conservative 3 GiB peak-load estimate. macOS RAM is read from `hw.memsize`; inability to determine it refuses startup.
- Before spawning llama-server, read `/usr/bin/memory_pressure -Q` and require estimated free memory to cover the reserve plus 3 GiB candidate peak. Subtract one percentage point from the integer CLI result to account conservatively for rounding. Poll every second until readiness and terminate the owned process group if free memory falls below the reserve. Unavailable or malformed telemetry fails startup clearly; an exact allowlist of native memory-policy errors passes through the chat adapter while unrelated failures remain generic. This is advisory telemetry, not an OOM guarantee.
- Kept all llama-server settings fixed in native code: parallel 1, context 2048, output 128, batch 128, micro-batch 64, 4 generation threads, 4 batch threads, reasoning off. Added a regression test that pins this envelope and a chat IPC test that rejects renderer-supplied context/output limits.
- Applied the existing idle preferences to the owned server: `TaskEnd` stops it after each task; `ShortIdle` retains it for 60 seconds after the last task. A new task cancels the pending unload. Cleanup only targets the owned process group.
- The existing Apple Silicon macOS debug gate remains the only candidate availability gate. No user-selectable model profile or certification claim was added.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `git diff --check`
- Focused Rust policy tests all passed: reserve math, total-RAM admission, output parsing, conservative percentage rounding, and pre-spawn/during-load pressure decisions (5 filtered test runs, 1 test each).
- Browser proof assertion added for visible native policy text and generic unrelated failures. `npm run web:proof-build` could not run because this worktree's linked SSD `node_modules` has no `vite` executable; typecheck likewise unavailable. No package installation or lockfile change made.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `git diff --check` passed.
- Build target: `/Volumes/MAC_APPS/ai-worker-desktop-artifacts/targets/ai-worker-desktop-chat-e2e` (SSD).
- Added policy tests exercise reserve math, total-RAM admission, memory-pressure output parsing and reserve decision, fixed native generation arguments, renderer tampering rejection, and idle timer cancellation/expiry. These are policy tests, not hardware certification.

## Limits and risk

- The 3 GiB peak-load estimate is conservative policy input for this fixed Qwen3 1.7B profile, not measured maximum. RAM admission and macOS free-memory percentage checks are heuristic; free memory can change between samples, and no implementation can guarantee the OS avoids OOM.
- No real 8 GiB device/model run or runtime-artifact integration run was performed. The 16 GiB development machine cannot certify 8 GiB behavior or establish behavior on other devices.
- Default `TaskEnd` unloads the model after every completed task, so later turns incur a cold model load. `ShortIdle` avoids that reload when another task arrives within 60 seconds.

## Controller audit after task review

The approved full memory policy is implemented in native candidate admission and loading. Startup remains one attempt per explicit chat task; renderer chat setup uses `maxRetries: 0`, and the native worker has no automatic startup retry loop.
