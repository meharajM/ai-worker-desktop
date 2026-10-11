# Chat-first implementation ledger

Base: `94305128bfb1f28574d9fe3489df1ef31015f345` (`feat(m12): add verified local model setup`)
Branch: `codex/local-chat-e2e`

| Task | Status | Notes |
| --- | --- | --- |
| M13 — native chat transport | implemented | Pinned Qwen3 1.7B is developer evaluation only. Real-model smoke now succeeds through the Tauri app on the development Mac; no profile certification. |
| Task 111 — macOS arm64 runtime package | implemented | Commit `3603613` adds pinned b11429 preparation, Tauri resource mapping and startup flag/version check. Read-only review found loader aliases were not revalidated before spawn; follow-up now checks all nine expected relative symlinks and adds a focused test. No model download or inference. |
| M16a — resource envelope | complete | Commit `1719c04`; five focused Rust policy tests and all 21 browser proof checks pass after flushSync harness fix. 3 GiB peak estimate and macOS memory-pressure heuristic remain uncalibrated. |
| M14 — LangChain/LangGraph chat client | implemented | One model node streams through the native M13 bridge; mock proof and one real local-model response pass. No tools or persistence. |
| M15 — Assistant UI + persistence + Stop | complete | Commits `b803854`, `c38d02d`, `50803e0`: Assistant UI, bounded IndexedDB history, session switching, Stop, visible cap/persistence notices. Fresh packaged-app interaction/restart matrix remains open. |

## Existing checked-in state

- M12 import/catalog/model runtime code exists at the base commit. Pinned Qwen3 1.7B weights were cloned to SSD app-data for the real-model E2E; no weights are committed.
- Original checkout at `/Users/meharaj/Downloads/ai-worker-desktop` contains user-local dirty plan and unrelated work; leave it untouched.
- Official `v0.6.0` source tag and b11429 Apple Silicon runtime archive are pinned by Task 111. The model stays outside the repository and was placed in SSD app-data for explicit local inference.

## Evidence update (2026-10-11)

- M13 implementer raised the M12 profile-selection gap before editing. Resolution: use the single pinned candidate implicitly only in the existing developer evaluation build/target; do not add profile preferences or user-selectable/certified availability.
- Runtime audit verified the official `b11429` macOS arm64 archive (llama.cpp source tag v0.6.0, source commit `d81235049384534c167caea52b85a694f6103d14`) at SHA-256 `740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459`. Task 111 corrected the per-file hashes, configured resource mapping, and verified the built `.app` resource path. Mach-O inspection exposed a required `libggml-rpc` dependency missing from M12's expected list; task 111 added and pinned it. Report: `task-111-report.md`.
- Historical note superseded by the E2E evidence below: the model and build artifacts now live under `/Volumes/MAC_APPS/ai-worker-desktop-artifacts/`; internal build-cache space was reclaimed by moving the ignored Rust target directory to the SSD.

| M13 — native chat transport | implemented, in review | Commit `519bc023dc39f5ee0675743041fc44f6dc2a320b` (`feat(m13): add native local chat transport`). At that checkpoint, real-model smoke was blocked by missing runtime/model; the later E2E section records one successful run. |

## M13 review

- Spec: pass with gaps. Queue bound, fixed candidate gate, local endpoint/auth, native task/session ownership and cancellation, and no agent tools/journal are present.
- Important fix required: 120s response timer starts only after `ModelRuntime::chat_endpoint` resolves; move/extend the deadline to cover queue wait, runtime startup and response.
- Minor finding for final branch review: if the Channel receiver disappears while the backend stalls between frames, the worker detects closure only at a later send and can remain until timeout. Explicit cancel and window destruction are handled; decide if prompt proactive Channel-close detection is necessary.
- Actual-model startup/smoke has since been verified once; matching-profile performance and reliability remain unverified.

- M13 Important deadline finding fixed and committed in `7e1d427eea6b59711487250bece6e108af51959a`. Deadline starts at task acceptance and covers queue/startup/HTTP; expired queued tasks skip startup; model startup aborts and reaps owned process on deadline. Report records format/check and 8 focused test passes across commands. Re-review pending.
- M13 grouped-test fixture flake fixed in a follow-up commit: fake servers now consume request headers and body before replying, with no production-code changes. The `chat::` test group passed 10 consecutive runs, 6 tests each; formatting and diff checks passed. Re-review pending.
- M13 concurrency findings fixed in commit `f332786bb2f725f0c724463a6034b66212f68660`: session authorization/enqueue and replacement/invalidation now serialize with bridge-session → chat-queue lock order; active cancellation and completion choose one terminal event under the queue lock; queue cap remains one active plus ten waiting after worker pop; chat trust-boundary errors remain structured. Focused chat tests passed 8/8, bridge tests 9/9; `cargo fmt --check`, `cargo check` (no warnings), and `git diff --check` passed. Details: `task-13-concurrency-report.md`. Final M13 re-review pending.

## M14 implementation

- Added `src/renderer/src/local-chat.ts`: one LangGraph model node streams pinned `ChatOpenAI` through the M13 native bridge adapter. The adapter accepts only the fixed pseudo-endpoint and exact streaming chat-completions body, converts only text system/user/assistant messages, and never calls browser network APIs.
- Native events become SSE frames for LangChain's parser. Abort and stream teardown cancel once after start acknowledgement; early events are held until the accepted request ID is known; errors, completion and deadline settle once.
- Public `stream()` uses LangGraph `messages` mode to expose model chunks live; nested model calls retain graph-injected child callbacks while outer graph callbacks stay disabled. `streamState()` preserves access to final graph state.
- Added deterministic cases to the existing browser proof check for live graph token streaming before native completion, endpoint/body rejection, native failure, acknowledgement-race cancellation and unsupported tool/multimodal input.
- M14 checks: `npm run web:typecheck`, `npm run web:build`, `npx tsc --noEmit --project tsconfig.proof.json`, `npm run web:proof-build`, headless Chromium mock proof, and `git diff --check`.
- At the time of M14 implementation, real inference was gated because no GGUF was present. The later real E2E evidence below supersedes that checkpoint.

## Real-model E2E evidence (2026-10-11)

- On the development 16 GiB Apple Silicon Mac, the Tauri debug app ran the pinned Qwen3 1.7B Q4_K_M GGUF from SSD app-data through the bundled llama.cpp v0.6.0 runtime and the existing M14 LangGraph graph.
- Prompt `Reply with exactly: LOCAL CHAT WORKS.` returned exactly `LOCAL CHAT WORKS.` in the chat window. This proves one real UI → LangGraph → native bridge → local model → UI response.
- Fixed main-window Tauri permissions for `local_chat_start` and `local_chat_cancel`. Fixed macOS bundled runtime alias validation to allow a copied file only when its hash matches the pinned runtime library. Focused Rust test passed.
- Quit the app; process inspection confirmed both the Tauri host and owned `llama-server` exited.
- Cold start in this single run took roughly 1–2 minutes while verifying/loading the 1.1 GB GGUF. This is not a certified latency result.
- Chat requests are capped at 32 messages; the UI clearly directs users to New chat at the limit. Proof-page assertion rejects oversized graph history before native work starts.
- M16a resource policy is implemented in `1719c04`: native admission retains the 8 GiB floor, reserves `max(2 GiB, 25% RAM)`, uses a provisional 3 GiB Qwen3 load estimate, checks macOS free-memory telemetry before spawn and during load, and stops the owned server on reserve breach. Five focused Rust tests and formatting checks pass. The Luna review found no blocking defects; the estimate and telemetry remain advisory and uncalibrated.
- Historical checkpoint superseded: M15 is complete (`b803854`, `c38d02d`, `50803e0`); all 21 browser proof checks now pass after the flushSync harness fix. Fresh packaged-app session/restart/real-model Stop matrix remains unverified.
- Current remaining: M16b real-model footprint/pressure, repeated-cycle and quit-cleanup measurements per matching hardware; matching 8 GiB certification; separate Windows platform proof.


## Resolved M15/M16a proof status (2026-10-11)

- Browser proof suite passes all 21 checks after the proof harness was fixed to flush React updates with `flushSync`; earlier 20-pass/notice-assertion failure is superseded.
- M15 and M16a are complete. M16b remains open: real model/resource/cancel/repeated-cycle/quit-cleanup evidence per matching hardware, plus fresh packaged-app interaction/restart matrix. 8 GiB needs an actual 8 GiB Mac; Windows remains separate.
- One real UI→graph→native→model→UI response succeeded on the 16 GiB Apple Silicon development Mac. This is one-run E2E evidence, not repeatable/certified profile evidence. The 3 GiB peak estimate and macOS `memory_pressure` heuristic remain uncalibrated.
- Remaining order: M16b → M07 attachments + M08/M09 explicit legacy export/import → M16c chat-only beta → M17–M20 read-only/context-grounded tasks → J01/J02 + M21–M24 reviewed file-write/journal/recovery → M25–M28 confirmed CLI → M29–M31 opt-in curated MCP → M32–M34 certification → M35–M37 macOS/Windows packaging and recovery/update → M38–M41 legacy pruning/full release.
