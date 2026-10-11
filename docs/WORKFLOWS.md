# Current and Planned Workflows

## Available now: local chat

1. Open the Tauri app and start a conversation.
2. Send a text prompt to the explicitly configured local model.
3. Stop an active response when needed.
4. Return to bounded local conversation history or start a new chat at the limit.

The pinned Qwen3 1.7B profile is a development candidate. One successful real-model E2E on a 16 GiB Apple Silicon development Mac does not certify a hardware profile. See [FAQ](./FAQ.md).

## Not available in current Tauri app

Voice, cloud providers, WhatsApp, MCP, filesystem access, CLI execution, browser automation, and attachment processing are legacy Electron capabilities or roadmap work.

## Roadmap order

After M16b matching-hardware real-model/resource/cancel/repeated-cycle/quit-cleanup proof, M07 adds attachments and M08/M09 add explicit legacy export/import migration; M16c is the chat-only beta. Later milestones add read-only workspace/context-grounded tasks, reviewed file changes and operation journal recovery, confirmed workspace CLI, optional curated MCP, certification, packaging, and release gates. See [chat-first delivery plan](../plans/chat-first-delivery.md).

---

## Historical Electron document retained for migration reference

> The following content is preserved as historical context. Commands and capabilities in it do not apply to the current Tauri app. Use the current sections above for runnable guidance.

# Common Workflows in AI-Worker

This guide outlines common tasks and workflows you can perform using **AI-Worker**.

---

## 1. Local File Extraction & Research

This workflow allows you to drop research PDFs or spreadsheets into the workspace, extract contents, and compile structured notes using an LLM.

### Steps:
1. Drag and drop your files into the **Hub Chat** input area.
2. Ensure the `filesystem` and `MarkItDown` MCP servers are active in **MCP Connections**.
3. Type or speak your prompt:
   > "Extract all key metrics from the attached sales PDF, format it into a clean Markdown table, and save it to a new file called sales_summary.md."
4. The agent will read the file context, run the MarkItDown converter, format the table, and write the file back to your designated directory.

---

## 2. Stealth Browser Automation

Use this workflow to perform web research, take screenshots, or fill out web forms automatically.

### Steps:
1. Ensure the `playwright` MCP server is connected.
2. In the chat, issue a command:
   > "Search Google for the latest stock price of Apple, extract the price value, take a screenshot of the search page, and save it in my workspace."
3. The Playwright harness will launch an isolated browser session, navigate to Google, extract the target text, capture the screenshot, and save the file.

---

## 3. Remote WhatsApp Approval Loops

This workflow sets up a mobile communication link, allowing the agent to ask you for permission before executing a critical tool.

### Steps:
1. Go to **Hub Settings** and toggle **WhatsApp Integration** (if enabled/flagged).
2. Scan the generated QR code with your WhatsApp app to authenticate the session.
3. Start a long-running research or automation workflow on your desktop.
4. When the agent reaches a step requiring explicit approval, it sends a WhatsApp message to your phone:
   > *"The browser agent wants to submit the form at google.com. Do you approve? Reply YES or NO."*
5. Replying `YES` from your phone prompts the desktop client to proceed automatically.
