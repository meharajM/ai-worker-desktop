# Current implementation plan

Latest user decisions: offline local web UI inside a small Tauri app; macOS first, Windows next; CLI actions require confirmation in a selected workspace. Linux-first was superseded. The standalone operation journal and TypeScript bridge are implemented; the Tauri application migration has not started.

- [Product, architecture and footprint plan](./local-desktop-product-plan.md)
- [Custom code and open-source alternatives audit](./custom-code-alternatives-audit.md)
- [Small sequential Luna implementation cards](./luna-implementation-cards.md)
- [Reusable journal integration cards](./operation-journal-integration.md)

Start M00–M03 to prove the selected stack before porting services. Candidate libraries/runtime are researched; compatibility, resource numbers and release support remain unverified until their recorded checks.

The [original Electron plan](./archive/electron-v1/local-desktop-product-plan.md) and [original task cards](./archive/electron-v1/luna-implementation-cards.md) are archived for history. Their T00–T36 tasks are obsolete; do not dispatch them.
