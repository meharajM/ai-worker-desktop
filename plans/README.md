# Current implementation plan

Latest user decisions: local offline web UI hosted by Tauri; macOS first, Windows next; approved workspace CLI actions later. Linux-first was superseded. M13 native local chat transport is implemented; Task111 macOS arm64 llama runtime bundling and loader-alias verification are implemented; M14 adds a one-node LangChain/LangGraph chat graph with live `messages` streaming. M14 proof is mocked: no GGUF is available and disk space is below import needs, so real inference is unverified. The candidate is pinned Qwen3 1.7B for development E2E; revisit Qwen3.5 afterward. The macOS arm64 runtime package is verified, but the candidate is not certified; Windows and performance remain unverified.

- [Chat-first delivery, early beta and final goal](./chat-first-delivery.md)
- [Product, architecture and footprint plan](./local-desktop-product-plan.md)
- [Custom code and open-source alternatives audit](./custom-code-alternatives-audit.md)
- [LangChain/LangGraph application decision](./langchain-langgraph-migration.md)
- [AI engineering demand research and historical alternatives](./reports/ai-layer-market-research.md)
- [Small sequential Luna implementation cards](./luna-implementation-cards.md)
- [Reusable journal integration cards](./operation-journal-integration.md)

Branch checkpoint: `d394789` (`fix(m14): stream local chat graph messages live`), after M05c (`767b016`), M12 (`9430512`), M13 (`519bc02`), Task111 runtime bundling (`3603613`) and alias verification (`708728b`), and M14 graph implementation (`05aef10`). M00–M13 are implemented; M14 has mocked proof. M16a is not started; M15 Assistant UI/history/Stop is pending. Resume at M16a, then M15. Real Qwen3 1.7B inference and M16b certification remain gated on a GGUF and sufficient import disk space; Windows behavior and performance remain unverified.

The [original Electron plan](./archive/electron-v1/local-desktop-product-plan.md) and [original task cards](./archive/electron-v1/luna-implementation-cards.md) are archived for history. Their T00–T36 tasks are obsolete; do not dispatch them.
