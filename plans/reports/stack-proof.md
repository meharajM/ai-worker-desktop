# M03 LangChain/LangGraph stack proof

Date: 2026-10-10
Source: `bc197a625413b8d89ff82dcbfd1e37805363709f` (`codex/tauri-web-migration`)
Status: **M03b reviewed; M03c actual WKWebView hard gate failed/incomplete.** Do not treat framework compatibility as established.

## Host and package set

- Host: macOS 26.6.2 (25G83), Apple Silicon `arm64`; native proof ran in Apple WKWebKit `21624.5.1.11.3`.
- Rust `1.94.1 (e408947bf 2026-03-25)`, Node `v24.7.0`, npm `11.5.1`, Tauri CLI `2.12.1`, `tauri` crate `2.12.2`, Tauri API `2.12.2`, Vite `7.3.1`, React `18.3.1`, TypeScript `5.9.3`.
- Direct framework pins: `@langchain/core` `1.2.17`, `@langchain/openai` `1.6.2`, `@langchain/langgraph` `1.4.21`; Zod `4.2.1`. Resolved transitive packages include OpenAI SDK `7.32.0`, `langsmith` `0.10.11`, `@langchain/langgraph-checkpoint` `1.1.6`, and `@langchain/langgraph-sdk` `1.12.3`.
- Renderer imports: `ChatOpenAI` from `@langchain/openai`; message classes and official stored-message mappers from `@langchain/core/messages`; `tool` from `@langchain/core/tools`; `StateGraph`, `StateSchema`, `MessagesValue`, `START`, `END` from `@langchain/langgraph`; `ToolNode` from `@langchain/langgraph/prebuilt`.
- Browser support evidence: [LangGraph package metadata](https://registry.npmjs.org/@langchain/langgraph/latest) declares a browser entry; [LangChain ChatOpenAI integration](https://docs.langchain.com/oss/javascript/integrations/chat/openai) and [LangGraph workflows](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) document the used APIs. Package exports and resolved Vite graph were inspected in M03b. This metadata is not runtime compatibility evidence.

## Build artifacts

Both measurements use optimized macOS arm64 release builds from the source SHA above. The existing default release binary was dated before the M03b native source update, so it was rebuilt once with `npm exec tauri -- build --no-bundle` and copied aside before the proof build overwrote Cargo's shared output name.

| Artifact | Exact bytes | SHA-256 | Notes |
|---|---:|---|---|
| Default release binary | 8,525,360 | `1bf3241024732f5017c78453065fb17bfb056d6f110bf6c170d5b260a1794a33` | `Mach-O 64-bit executable arm64`; optimized `release`; no `proof` feature |
| Proof release binary | 8,908,384 | `091652a3479b35cc5e9ba86c15076ed176631ae1a01f9aa8cbdd5d2150acf588` | `Mach-O 64-bit executable arm64`; optimized `release`; `proof` feature |
| Proof `.app` regular files | 9,330,564 | — | 3 files; Tauri CLI reported 8.90 MiB; unsigned local proof bundle |

The actual proof JS build transformed 897 modules. Vite reported the main graph chunk as 1,591.63 kB raw / 420.56 kB gzip. Independent exact asset inventory (`gzip.compress`, level 9, `mtime=0`, each JS file compressed separately) measured:

| JS inventory | Raw bytes | Gzip bytes | Gzip KiB |
|---|---:|---:|---:|
| Default JS | 169,382 | 54,500 | 53.22 |
| Proof JS (3 files, sum of individual gzip streams) | 1,598,702 | 422,634 | 412.73 |

The proof gzip total is below the 750 KiB target. Main proof chunk SHA-256: `6bc3252e43eb1ab52e52e69757b4bfc4c47afb9d583e46c2bd15f6a74cdc7d94`. Default generated `src-tauri/static/index.html` was restored to its tracked placeholder after the build. `static-proof` remains ignored build output.

Package inspection selected LangGraph's browser `dist/web.js`; M03b found no resolved `node:async_hooks` entry or Node polyfill. A literal scan of the minified proof bundle found zero `node:async_hooks` strings, two `node:buffer` strings, one `node:util` string, and transitive LangSmith strings. The provider passes empty callbacks and uses fixed `http://proof.invalid/v1` plus the local custom Fetch adapter. The bundle contains LangSmith code through transitive dependencies; no trace was configured. No network sockets were observed on the native app or WebKit networking process during the stalled run; this does not substitute for the missing row results.

## Native WKWebView run

Built one proof `.app` using `--features proof`, the separate `tauri.proof.conf.json` assets/capability, a unique product name and bundle identifier, and an absolute private `appDirectoriesOverride`. The resulting app was copied to a fresh absolute `/tmp` path and selected through CUA by that exact path. Normal `HOME` was retained; no `dataStoreIdentifier` was set. The command and config JSON, PID, CUA state, native menu quit, and process checks are in the ignored detailed log at `.superpowers/sdd/M03c-langchain-report.md`.

**Observed result:** CUA showed the actual app window titled `AI-Worker`, page `M03 LangChain and LangGraph proof`, and the enabled `Run proof` button. After clicking it, the page stayed at **“Running native fixture scenarios…”** and the button stayed disabled for more than 90 seconds. No assertion result row appeared. A sample of the separate WebKit WebContent process showed it idle while the renderer promise remained pending. The page publishes rows only after `runM03bAssertions` returns the entire batch, and model stream awaits have no timeout. The unresolved scenario is unknown; the precise pending operation was not exposed by this UI. Do not infer that the Channel, provider, or graph succeeded.

| Named shared assertion | Native outcome |
|---|---|
| Normal split UTF-8/SSE → ChatOpenAI text | Not individually observed; batch did not return |
| Provider errors reach LangChain caller | Not individually observed; batch did not return |
| Pre-abort skips native registration | Not individually observed; batch did not return |
| Mid-stream abort awaits matching native acknowledgement/event | Not individually observed; batch did not return |
| Abort drops late bytes and prevents tool actions | Not individually observed; batch did not return |
| Abort cleanup and next native run | Not individually observed; batch did not return |
| Restored history rejects unregistered tools | Not individually observed; batch did not return |
| Two native tool calls/results route through graph before final text | Not individually observed; batch did not return |
| Canonical history restores both results and feeds next turn | Not individually observed; batch did not return |

The app was quit using its native app menu (`Quit M03c LangChain Proof …`, action `terminate:`). Owned app PID `21433` was absent immediately afterward; no process remained with its unique app executable path. No code or Tauri source/config was changed to mask the failure. This hard gate needs a fresh bounded diagnostic/fix pass before a framework decision.

## M03d bounded native diagnostic

Base checkout: `codex/tauri-web-migration`, exact pre-change HEAD `c52be7307bb2c191b319c20c1ad7ed4b52729c7b`. No native source or Tauri capability/config changed. The proof harness now exposes progress and completed rows immediately, bounds native stream silence at 5 seconds, and bounds each model/graph case at 8 seconds with an AbortSignal. A fixed-byte preflight uses the same `proofFetch` → `proof_stream` typed Channel path as the provider. The fetch adapter also accepts `Request.signal`; the OpenAI SDK source check confirmed version 7.32.0 calls configured fetch with URL plus init carrying `controller.signal`.

Context7 docs looked up current Tauri v2 Channel usage and LangChain.js `ChatOpenAI` streaming APIs. Exact installed package source was checked under `node_modules/openai/src/client.ts` and `node_modules/@langchain/openai/dist/chat_models/completions.js.map`: OpenAI SDK `fetchWithTimeout` composes an abort controller and calls the configured fetch with `(url, fetchOptions)`; LangChain awaits `completionWithRetry()` and iterates the returned OpenAI stream before yielding model chunks.

The actual proof used one final isolated optimized release `.app`: product `M03d LangChain Proof mdxjh0`, bundle ID `com.aiworker.m03dfinal2.mdxjh0`, copied to `/tmp/m03d-langchain-final2.mDXJh0/M03d LangChain Proof mDXJh0.app`. It used normal `HOME`, no `dataStoreIdentifier`, and a unique private `appDirectoriesOverride` under `/tmp/m03d-langchain-final2.mDXJh0`. The app executable is arm64 Mach-O, 8,908,384 bytes, SHA-256 `d9fd4d9e49908db6ee191ae8ec16b23d54663210dae8c09c02055a57b82d30a2`. Final proof JavaScript asset inventory before the source-only cancellation-observer correction: 1,601,521 raw bytes / 423,553 bytes gzip (per-file gzip level 9, `mtime=0`); main chunk SHA-256 `7b6f7feecc6fe73e3f01c0fea01447e878a513fd2d584d07b5403057727c20ba`.

The same built app was run once with **Run proof**. Its incremental native WKWebView results:

| Assertion | Observed result |
|---|---|
| Native Channel byte preflight reaches fixed fixture | PASS; 172 decoded bytes included split-UTF-8 `café` and `[DONE]` |
| Normal split UTF-8/SSE → ChatOpenAI text | PASS; `café` |
| Provider errors reach LangChain caller | PASS; `fixture stream failed` |
| Abort before start skips native registration | PASS |
| Mid-stream abort awaits native cancel and matching Aborted event | **FAIL in the built UI** because the observer snapshotted the cancel promise before deferred native start acknowledgement caused `proof_cancel`; same-run Aborted arrived, and instrumentation recorded exactly one cancel call and a successful `true` result. The observer now waits on a promise created before streaming; the deferred-ack covering check passes in the browser page. This source-only correction was not rerun in WKWebView. |
| Abort drops late bytes and prevents later tool actions | PASS; zero late chunks/actions |
| Abort cleans native state and next native run succeeds | PASS; follow-up `café`; second cancel returned false after producer cleanup |
| Restored history rejects unregistered tool calls | PASS |
| Two native calls/results route through graph before final text | **FAIL** after 8s deadline; no calls/results completed |
| Bounded canonical history restores both tool results and feeds next graph turn | Not reached; first graph turn did not complete |

The decisive graph trace was `tool_calls:started > tool_calls:chunk > tool_calls:invoke-returned > tool_calls:chunk > tool_calls:chunk > tool_calls:chunk > tool_calls:complete`. No `action:*` entry or second `normal` provider request occurred before the graph deadline. Thus all four native fixture SSE payloads and terminal completion arrived; the pending work is after Channel delivery and before the graph invokes the broker tool. This trace alone does not distinguish ChatOpenAI stream completion from graph node completion or routing.

Source inspection found a likely cause, not yet confirmed on the native path: installed `@langchain/openai` 1.6.2 `ChatOpenAICompletions._generate()` drains the stream and then awaits estimated prompt/output token counts. Installed `@langchain/core` 1.2.17 `dist/utils/tiktoken.js` lazily fetches `https://tiktoken.pages.dev/js/${encoding}.json` through a separate `AsyncCaller` with its default retries. That fetch bypasses the proof provider's custom Fetch, conflicts with the offline fixture, and can continue after the stream's terminal event. The graph trace is consistent with this path, but no native network request or SDK call stack was instrumented; treat this as a source-grounded hypothesis. The next focused packet should exercise official `ChatOpenAI.stream()` chunk aggregation inside the existing LangGraph node, and verify two native broker actions without adding a parser, tokenizer fetch allowance, encoding dictionary, usage override, or fallback. No framework compatibility pass is claimed, and no provider fallback or weakened assertion was added.

The built app was quit via its native menu. Exact owned PID `26514` was absent afterward. The static transport check page initially could not open through `file:`; it then passed in Brave over a disposable HTTP server bound only to `127.0.0.1:62163`. All nine checks passed, including `Request.signal`, deferred native start acknowledgement with accepted cancellation, and silent-producer deadline/cancel. Exact server PID `28413` was stopped and verified absent. Final source `npm run web:typecheck` and `npm run web:proof-build` passed after the cancellation-observer correction; Vite retained its existing >500 kB chunk warning. The generated proof JS total remains below 750 KiB. WebView2 remains unavailable on this macOS host.

Detailed command, CUA observation and change record: ignored `.superpowers/sdd/M03d-report.md`.

## Other gates and prior checks

- Actual macOS WKWebView was used; this is a failed/incomplete runtime attempt, not a pass.
- WebView2 was not run: no Windows host/hardware was available in this session.
- M03b's recorded `web:typecheck`, proof typecheck/build, default web build, six generic transport checks, Cargo fmt/check, and seven focused Rust tests were not rerun as instructed. They remain prior M03b evidence only.
- No RAM/CPU/model performance or compressed installer size is claimed. The `proof` chunk retains Vite's >500 kB raw chunk warning. No service port, model download, source fix, or production migration was performed.
