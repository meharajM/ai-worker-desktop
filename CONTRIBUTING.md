# Contributing

The current app is a Tauri desktop chat with a bundled offline web UI and Rust native bridge. Electron source remains for migration history; target Tauri/web paths unless a task explicitly names legacy Electron.

## Code of conduct and issues

Contributors follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Report bugs or propose changes through the [GitHub issues](https://github.com/meharajM/ai-worker-desktop/issues). Include reproduction steps, expected and actual behavior, OS/version, and relevant logs or screenshots.

## Prerequisites

- Node.js ≥22.12 and npm
- Rust toolchain
- macOS: Xcode Command Line Tools
- Windows: MSVC C++ build tools and WebView2

Tauri's `beforeDevCommand` and `beforeBuildCommand` require `npm run web:build`.

## Development checks

```sh
npm install
npm run web:typecheck
npm run web:build
npm run test:rust:chat
npm run test:rust:proof
npm run tauri:dev
```

Use `npm run tauri:proof` and `npm run web:proof-build` for the isolated proof harness. `npm run tauri:build` builds the current platform bundle; `npm run tauri:build:mac:arm64` prepares the pinned macOS arm64 runtime first.

## Pull requests and commits

1. Create a focused branch and keep the diff scoped to one change.
2. Run relevant checks above and report their results and limits in the PR.
3. Link related issues and describe user-visible behavior.
4. Use a concise imperative commit subject, preferably `type(scope): description` (for example, `docs: update Tauri setup guide`).
5. Address review feedback before merge; maintainers review and merge approved changes.

## Code guidance

Follow surrounding style, use clear names, keep functions focused, and comment only non-obvious invariants. Keep native authority, process ownership, resource bounds, and cancellation in Rust; renderer state does not grant native permissions. Preserve user data and credential boundaries.

The current Tauri chat has bounded IndexedDB history and Stop. Voice, cloud providers, WhatsApp, MCP, filesystem, CLI, and browser tools are not current app capabilities. Do not describe legacy Electron behavior as shipped Tauri behavior.

See [Development](./docs/DEVELOPMENT.md) and the [delivery plan](./plans/chat-first-delivery.md).
