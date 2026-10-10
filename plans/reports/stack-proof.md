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

## Other gates and prior checks

- Actual macOS WKWebView was used; this is a failed/incomplete runtime attempt, not a pass.
- WebView2 was not run: no Windows host/hardware was available in this session.
- M03b's recorded `web:typecheck`, proof typecheck/build, default web build, six generic transport checks, Cargo fmt/check, and seven focused Rust tests were not rerun as instructed. They remain prior M03b evidence only.
- No RAM/CPU/model performance or compressed installer size is claimed. The `proof` chunk retains Vite's >500 kB raw chunk warning. No service port, model download, source fix, or production migration was performed.
