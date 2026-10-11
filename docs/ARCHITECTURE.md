# Current Tauri Architecture

The current product is a local chat app: bundled offline web UI, Tauri native host, and one local-model chat path.

```text
Assistant UI
    ↓ custom chat adapter
LangChain / one-node LangGraph chat
    ↓ bounded task stream
Tauri bridge (Rust)
    ↓ owned local process
pinned llama runtime + local model
```

## Web UI

Vite builds static web assets for Tauri. Assistant UI owns chat presentation and renderer interaction state. Bounded IndexedDB stores conversation history. The UI does not directly own model processes or native permissions.

## Chat orchestration

LangChain/LangGraph handles the chat request and streaming. Current graph is chat-only and has no tools. The selected Qwen3 1.7B is a pinned development candidate; model profile certification remains open.

## Native host

Rust owns the local model process, task identity, streaming transport, cancellation, fixed generation bounds, RAM admission/reserve policy, and process cleanup. The current policy uses a provisional 3 GiB peak estimate and macOS `memory_pressure` heuristic; both remain uncalibrated.

## Storage and scope

Chat history is bounded and persisted in IndexedDB. Model setup is explicit. Current Tauri app has no voice, cloud providers, WhatsApp, MCP, filesystem, CLI, or browser tools. Historical Electron modules remain in the repository but are outside the Tauri runtime path.

## Evidence limits

One real UI-to-graph-to-native-to-model response succeeded on a 16 GiB Apple Silicon development Mac. This is a one-run E2E, not repeatable or certified profile evidence. Fresh packaged-app interaction/restart proof, 8 GiB Mac proof, and Windows proof remain open. See [delivery plan](../plans/chat-first-delivery.md).

---

## Historical Electron document retained for migration reference

> The following content is preserved as historical context. Commands and capabilities in it do not apply to the current Tauri app. Use the current sections above for runnable guidance.

# AI-Worker Architecture Overview

This document details the core design principles and architecture of **AI-Worker**. The application is structured around three main engineering pillars that enable local-first agentic workflows.

```
┌─────────────────────────────────────────────────────────────────┐
│                      AI-Worker Architecture                     │
├───────────────────┬──────────────────────┬──────────────────────┤
│ Prompt Engineering │ Context Engineering  │  Harness Engineering │
│                   │                      │                      │
│ ∙ System Intent   │ ∙ Semantic Memory    │ ∙ Browser Sandboxing │
│ ∙ On-Device LLMs  │ ∙ Context Pruning    │ ∙ Secure IPC Bridges │
│ ∙ Tool Validation │ ∙ MCP Server Binding │ ∙ WhatsApp Gateway   │
└───────────────────┴──────────────────────┴──────────────────────┘
```

---

## 1. Prompt Engineering

Prompt engineering in AI-Worker focuses on defining how LLMs interpret user intents and interact with local system capabilities.

* **System Instruction Alignment**: Pre-configured prompts enforce strict adherence to the Model Context Protocol (MCP) and structure tool calling schemas (JSON outputs).
* **On-Device Inference**: Out-of-the-box support for `Web-LLM` directly in the browser runtime (using WebGPU) to execute open models (like Gemini Nano or Phi) locally.
* **Dynamic Template Injection**: Appends system state, active workspace paths, local time, and preceding tool invocation results directly into the LLM context window.

---

## 2. Context Engineering

Context engineering ensures that the LLM is supplied with highly relevant, minimal data, preventing context window exhaustion and reducing token consumption.

* **Semantic Memory Core**: Uses a persistent SQLite-backed MCP server to store, index, and retrieve entities and relationships.
* **Context Pruning & Compaction**: Implements automatic truncation and formatting rules to keep chat histories compact and clean.
* **Multi-Source Fusion**: Merges filesystem watch updates, active browser contents, dragged-and-dropped files, and memory into a unified context payload.

---

## 3. Harness & Tool Engineering

Harness engineering connects the LLM's decisions safely to the physical host environment (browser, files, network).

* **Playwright Browser Harness**: Runs a local, stealth-configured Playwright instance that allows the LLM to navigate the web, fill forms, handle dropdowns, and take screenshots.
* **Secure Process Isolation**: The frontend runs in an Electron browser window with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Communication occurs over a strict IPC boundary exposed in the preload script.
* **Communication Bridges**: Integrates the WhatsApp web protocol (`Baileys` library) to allow remote task status alerts and interactive human-in-the-loop approval messages.
