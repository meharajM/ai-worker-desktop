# Chat-first implementation ledger

Base: `94305128bfb1f28574d9fe3489df1ef31015f345` (`feat(m12): add verified local model setup`)
Branch: `codex/local-chat-e2e`

| Task | Status | Notes |
| --- | --- | --- |
| M13 — native chat transport | implemented | Fresh review is clear. Pinned Qwen3 1.7B candidate is developer evaluation only; real-model smoke remains gated on a local GGUF. |
| Task 111 — macOS arm64 runtime package | implemented | Commit `3603613` adds pinned b11429 preparation, Tauri resource mapping and startup flag/version check. Read-only review found loader aliases were not revalidated before spawn; follow-up now checks all nine expected relative symlinks and adds a focused test. No model download or inference. |
| M16a — resource envelope | not started | Use exact candidate controls in native policy; no certification claims. |
| M14 — LangChain/LangGraph chat client | implemented | One model node streams ChatOpenAI through the native M13 bridge; deterministic mock proof passes. No tools, persistence or UI. |
| M15 — Assistant UI + persistence + Stop | not started | UI functional integration only; no visual polish. |

## Existing checked-in state

- M12 import/catalog/model runtime code exists at the base commit.
- Original checkout at `/Users/meharaj/Downloads/ai-worker-desktop` contains user-local dirty plan and unrelated work; leave it untouched.
- Official `v0.6.0` source tag and b11429 Apple Silicon runtime archive are now pinned by Task 111. The model weights remain external and must be explicitly imported before real inference.

## Evidence update (2026-10-11)

- M13 implementer raised the M12 profile-selection gap before editing. Resolution: use the single pinned candidate implicitly only in the existing developer evaluation build/target; do not add profile preferences or user-selectable/certified availability.
- Runtime audit verified the official `b11429` macOS arm64 archive (llama.cpp source tag v0.6.0, source commit `d81235049384534c167caea52b85a694f6103d14`) at SHA-256 `740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459`. Task 111 corrected the per-file hashes, configured resource mapping, and verified the built `.app` resource path. Mach-O inspection exposed a required `libggml-rpc` dependency missing from M12's expected list; task 111 added and pinned it. Report: `task-111-report.md`.
- The connected `/Volumes/SSD` has no model files and the machine has about 1.3 GiB free; a real GGUF import requires about 2.2 GB per current candidate policy. Avoid downloading the model into this disk. Real-model smoke remains gated on user-provided space/model artifact.

| M13 — native chat transport | implemented, in review | Commit `519bc023dc39f5ee0675743041fc44f6dc2a320b` (`feat(m13): add native local chat transport`). Implementer reports Rust format/check, 23 tests passed (1 ignored), web typecheck, and diff check passed. Real model remains blocked by missing runtime package/model. |

## M13 review

- Spec: pass with gaps. Queue bound, fixed candidate gate, local endpoint/auth, native task/session ownership and cancellation, and no agent tools/journal are present.
- Important fix required: 120s response timer starts only after `ModelRuntime::chat_endpoint` resolves; move/extend the deadline to cover queue wait, runtime startup and response.
- Minor finding for final branch review: if the Channel receiver disappears while the backend stalls between frames, the worker detects closure only at a later send and can remain until timeout. Explicit cancel and window destruction are handled; decide if prompt proactive Channel-close detection is necessary.
- Actual-model startup/smoke remains unverified until runtime resources and GGUF are available.

- M13 Important deadline finding fixed and committed in `7e1d427eea6b59711487250bece6e108af51959a`. Deadline starts at task acceptance and covers queue/startup/HTTP; expired queued tasks skip startup; model startup aborts and reaps owned process on deadline. Report records format/check and 8 focused test passes across commands. Re-review pending.
- M13 grouped-test fixture flake fixed in a follow-up commit: fake servers now consume request headers and body before replying, with no production-code changes. The `chat::` test group passed 10 consecutive runs, 6 tests each; formatting and diff checks passed. Re-review pending.
- M13 concurrency findings fixed in commit `f332786bb2f725f0c724463a6034b66212f68660`: session authorization/enqueue and replacement/invalidation now serialize with bridge-session → chat-queue lock order; active cancellation and completion choose one terminal event under the queue lock; queue cap remains one active plus ten waiting after worker pop; chat trust-boundary errors remain structured. Focused chat tests passed 8/8, bridge tests 9/9; `cargo fmt --check`, `cargo check` (no warnings), and `git diff --check` passed. Details: `task-13-concurrency-report.md`. Final M13 re-review pending.

## M14 implementation

- Added `src/renderer/src/local-chat.ts`: one LangGraph model node streams pinned `ChatOpenAI` through the M13 native bridge adapter. The adapter accepts only the fixed pseudo-endpoint and exact streaming chat-completions body, converts only text system/user/assistant messages, and never calls browser network APIs.
- Native events become SSE frames for LangChain's parser. Abort and stream teardown cancel once after start acknowledgement; early events are held until the accepted request ID is known; errors, completion and deadline settle once.
- Public `stream()` uses LangGraph `messages` mode to expose model chunks live; nested model calls retain graph-injected child callbacks while outer graph callbacks stay disabled. `streamState()` preserves access to final graph state.
- Added deterministic cases to the existing browser proof check for live graph token streaming before native completion, endpoint/body rejection, native failure, acknowledgement-race cancellation and unsupported tool/multimodal input.
- M14 checks: `npm run web:typecheck`, `npm run web:build`, `npx tsc --noEmit --project tsconfig.proof.json`, `npm run web:proof-build`, headless Chromium mock proof, and `git diff --check`.
- Real model inference remains gated: no GGUF is present, and available disk capacity is below the candidate import requirement. No model was downloaded.
