# Current implementation plan

Latest user decisions: offline local web UI inside a small Tauri app; macOS first, Windows next; CLI actions require confirmation in a selected workspace. Linux-first was superseded. The standalone operation journal and TypeScript bridge are implemented; Tauri scaffolding, React assets and an isolated LangChain/LangGraph proof harness exist. M03 passed 11/11 macOS WKWebView fixture checks; WebView2, real model and full footprint gates remain unfinished.

- [Chat-first delivery, early beta and final goal](./chat-first-delivery.md)
- [Product, architecture and footprint plan](./local-desktop-product-plan.md)
- [Custom code and open-source alternatives audit](./custom-code-alternatives-audit.md)
- [LangChain/LangGraph application decision](./langchain-langgraph-migration.md)
- [AI engineering demand research and historical alternatives](./reports/ai-layer-market-research.md)
- [Small sequential Luna implementation cards](./luna-implementation-cards.md)
- [Reusable journal integration cards](./operation-journal-integration.md)

M00–M03 and M05b are complete; M05c native ACL proof is in progress. The next clean handoff is M06a, followed by profile-scoped local chat. Candidate model/runtime artifacts, resource numbers and release support remain unverified until their recorded checks.

The [original Electron plan](./archive/electron-v1/local-desktop-product-plan.md) and [original task cards](./archive/electron-v1/luna-implementation-cards.md) are archived for history. Their T00–T36 tasks are obsolete; do not dispatch them.
