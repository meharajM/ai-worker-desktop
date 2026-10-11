# Task 111 — verified macOS arm64 runtime packaging

## Changes

- Added `scripts/prepare-llama-runtime-macos-arm64.sh`. It downloads only the pinned b11429 archive when its ignored `src-tauri/target` cache is absent, checks the archive SHA before reading it, streams only pinned files from exact archive members, checks every binary/library/license hash, and stages to `src-tauri/resources/llama-v0.6.0/bin`.
- The binary's exact `--version` and all `ModelRuntime::start_assets_at_generation` flags are checked against the staged executable using `DYLD_LIBRARY_PATH` before replacing staged files.
- Added the upstream MIT `LICENSE` under `src-tauri/resources/llama-v0.6.0/LICENSE`; staged binaries/libraries remain ignored by Git.
- Added Tauri resource mappings to `$RESOURCE/llama-v0.6.0/bin` and its sibling `LICENSE`.
- Added `tauri:prepare:runtime` and `tauri:build:mac:arm64`; existing `beforeBuildCommand` and `beforeDevCommand` frontend commands are unchanged. `tauri dev` does not trigger a download.
- Updated `SERVER_SHA256` and all runtime library hashes.

## Required runtime dependency discovered

`otool -L` showed that the pinned `llama-server` has a normal, non-weak dependency on `@rpath/libggml-rpc.0.dylib`, which was omitted from M12's library list. Without it, dyld refuses to start the process. Added the official `libggml-rpc.0.26.0.dylib` (SHA-256 `5a75e884d5feff030067ed7867925366c552c68f1b36653f03bc2b0bd87e8a56`) to runtime asset verification and staging. The archive stores versioned dylibs, while Mach-O install names use `.0.dylib`; the preparer creates and verifies only those loader symlinks, pointing at the verified versioned payloads.

## Validation

- `bash scripts/prepare-llama-runtime-macos-arm64.sh /tmp/llama-b11429-bin-macos-arm64.tar.gz` — passed; verified pinned archive SHA `740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459`, every staged payload hash, MIT license SHA `94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d`, aliases, `--version`, and every startup flag.
- `DYLD_LIBRARY_PATH=<staged bin> <staged bin>/llama-server --version` — passed: `0.6.0-dev (build 11429, commit d81235049)`.
- `npm run web:build` — passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed.
- `CARGO_INCREMENTAL=0 node_modules/.bin/tauri build --debug --no-sign --bundles app` — passed; generated a 73.62 MiB app. Verified the exact packaged path `Contents/Resources/llama-v0.6.0/bin`, all expected files/aliases, the sibling LICENSE, and launched the bundled binary with `--version` under `DYLD_LIBRARY_PATH`.
- No model was downloaded; no inference was run. The runtime remains an evaluation-only macOS arm64 package.

## Read-only review follow-up

- Review found that runtime verification hashed versioned dylib payloads but did not validate the nine unversioned loader aliases before spawning `llama-server`.
- `verify_runtime_assets` now requires every alias from `prepare-llama-runtime-macos-arm64.sh` to be a relative symlink with the exact expected target. `libllama-server-impl.dylib` has no alias and remains excluded.
- Added one focused macOS unit test covering a valid alias and wrong-target, missing, and non-symlink aliases.
- Follow-up validation: `cargo fmt --check`, focused Rust test, `cargo check`, and `git diff --check` passed. No Tauri bundle, model download, or inference was run.
