# Current implementation plan

Latest status (11 October 2026): Tauri local chat app uses an offline bundled web UI, small Rust bridge, Assistant UI, LangChain/LangGraph, bounded IndexedDB history, Stop, and native RAM reserve policy. M15 is complete (`b803854`, `c38d02d`, `50803e0`); M16a is complete (`1719c04`). All 21 browser proof checks pass after the proof harness flushSync fix. Scripts/CI updated (`46ac0b8`, `2200280`). One real UI→graph→native→model→UI response succeeded on the 16 GiB Apple Silicon development Mac; it is one-run E2E evidence, not a repeatable or certified profile. The provisional 3 GiB peak estimate and macOS `memory_pressure` heuristic remain uncalibrated. Packaged-app interaction/restart matrix, 8 GiB Mac evidence, and Windows evidence remain open.

- [Chat-first delivery, early beta and final goal](./chat-first-delivery.md)
- [Product, architecture and footprint plan](./local-desktop-product-plan.md)
- [Custom code and open-source alternatives audit](./custom-code-alternatives-audit.md)
- [LangChain/LangGraph application decision](./langchain-langgraph-migration.md)
- [AI engineering demand research and historical alternatives](./reports/ai-layer-market-research.md)
- [Small sequential Luna implementation cards](./luna-implementation-cards.md)
- [Reusable journal integration cards](./operation-journal-integration.md)

Completed checkpoints: M15 (`b803854`, `c38d02d`, `50803e0`), M16a (`1719c04`), scripts/CI (`46ac0b8`, `2200280`). Resume with M16b real model/resource/cancel/repeated-cycle/quit-cleanup proof per matching hardware; then M07 attachments and M08/M09 explicit legacy export/import; then M16c chat-only beta. Do not treat single-run E2E or 21 browser proof checks as packaged-app or hardware certification.

The [original Electron plan](./archive/electron-v1/local-desktop-product-plan.md) and [original task cards](./archive/electron-v1/luna-implementation-cards.md) are archived for history. Their T00–T36 tasks are obsolete; do not dispatch them.
