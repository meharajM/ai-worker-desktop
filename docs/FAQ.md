# FAQ

### What is AI-Worker today?

A local Tauri desktop chat app with an offline web UI, small Rust native bridge, Assistant UI, and a LangChain/LangGraph chat path.

### Does chat use a cloud provider?

The current Tauri chat path targets a local model. The pinned Qwen3 1.7B is a development candidate, not a certified profile. Cloud providers are not available in this app.

### What is stored locally?

Bounded chat history is stored in IndexedDB. Model setup is explicit. The native host owns model process lifecycle and RAM reserve checks.

### Does the app support voice, WhatsApp, MCP, files, CLI, or browser automation?

No. Those capabilities appear in legacy Electron source and older docs, or in future roadmap plans; they are not available in the current Tauri app.

### Is the model profile certified?

No. One real UI-to-graph-to-native-to-model response succeeded on a 16 GiB Apple Silicon development Mac. That single run is not repeatable or certified profile evidence. The packaged-app interaction/restart matrix remains unverified; 8 GiB Mac and Windows evidence remain open.

### What are the RAM policy limits?

The native host applies an 8 GiB RAM floor and reserves `max(2 GiB, 25% of RAM)`. It currently uses a provisional 3 GiB model peak-load estimate and macOS `memory_pressure` heuristic; neither is calibrated or an OOM guarantee.

### What do I need to build it?

Node.js ≥22.12, npm, Rust, and platform tools: Xcode Command Line Tools on macOS; MSVC C++ build tools and WebView2 on Windows. Tauri runs `npm run web:build` before dev/build.

---

## Historical Electron document retained for migration reference

> The following content is preserved as historical context. Commands and capabilities in it do not apply to the current Tauri app. Use the current sections above for runnable guidance.

# Frequently Asked Questions

## General Questions

### What is AI-Worker?
AI-Worker is a free, MIT-licensed open-source desktop workspace that lets you use voice commands and text to control local tools, edit local files, perform web automation, and run LLM workflows locally or via cloud APIs.

### Is AI-Worker private?
Yes. AI-Worker is built with a local-first architecture. Your API keys are stored securely using your system's native keychain, your configuration files remain on your disk, and no third-party telemetry or usage tracking is included.

### Do I need to pay to use it?
No. AI-Worker is entirely free and open-source under the MIT license. You only pay for your own cloud LLM API usage (if using providers like OpenAI or Gemini). If you run local models via Ollama or Web-LLM, it is 100% free to run.

---

## Technical & Installation

### What LLM providers are supported?
Out of the box, AI-Worker supports:
1. **Ollama**: For local models like `qwen2.5:3b` or `llama3`.
2. **OpenAI**: GPT-4o, GPT-4o-mini, etc.
3. **Google Gemini**: Models with native tool-calling.
4. **OpenRouter**: Access to hundreds of models.
5. **Web-LLM**: WebGPU accelerated models running directly in your browser.

### How do voice commands work?
AI-Worker uses `Vosk-browser` locally for offline, zero-latency speech-to-text. When you talk to the app, it converts your voice input to text on your machine and routes it as an instructions payload to the selected LLM.

### What is the Model Context Protocol (MCP)?
MCP is an open standard that allows LLMs to connect safely to data sources and tools. AI-Worker acts as an MCP client. You can connect it to built-in servers (Filesystem, Memory, MarkItDown, Playwright) or configure your own stdio/SSE servers.

### Can I run it completely offline?
Yes! Select **Ollama** or **Web-LLM** as your LLM provider and enable **Offline Vosk** in the voice settings. Under this configuration, zero data leaves your local computer.
