#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(haystack, needle, context) {
  assert(haystack.includes(needle), `${context}: expected to include "${needle}"`);
}

function assertNotIncludes(haystack, needle, context) {
  assert(!haystack.includes(needle), `${context}: should not include "${needle}"`);
}

function testAgentRuntimeDelegateParallelism() {
  const src = read('src/renderer/src/lib/agent-runtime.ts');
  assertIncludes(src, 'const parallelDelegateBatch =', 'agent-runtime');
  assertIncludes(
    src,
    'response.toolCalls.every((call) => call.name === "delegate_sub_task")',
    'agent-runtime'
  );
  assertIncludes(
    src,
    'Promise.all(response.toolCalls.map((call) => executeToolCall(call)))',
    'agent-runtime'
  );
}

function testTaskDecomposerConditionalHeuristic() {
  const src = read('src/renderer/src/lib/task-decomposer.ts');
  assertIncludes(src, 'const SEQUENTIAL_INTENT_PATTERN =', 'task-decomposer');
  assertIncludes(
    src,
    'const CONDITIONAL_SEQUENTIAL_INTENT_PATTERN =',
    'task-decomposer'
  );
  assertNotIncludes(
    src,
    'const SEQUENTIAL_INTENT_PATTERN = /\\b(and then|then|after that|next|finally|first|second|third|before|once|if\\b|unless)\\b/i;',
    'task-decomposer'
  );
}

function testTaskDecomposerWebsiteAliasExtraction() {
  const src = read('src/renderer/src/lib/task-decomposer.ts');
  assertIncludes(src, 'const WEBSITE_CONTEXT_ALIASES:', 'task-decomposer');
  assertIncludes(src, "amazon: 'amazon'", 'task-decomposer');
  assertIncludes(src, "ebay: 'ebay'", 'task-decomposer');
  assertIncludes(src, "bestbuy: 'bestbuy'", 'task-decomposer');
  assertNotIncludes(src, "amazon: 'amazon.com'", 'task-decomposer');
  assertIncludes(src, 'for (const [alias, label] of Object.entries(WEBSITE_CONTEXT_ALIASES)) {', 'task-decomposer');
}

function testOpenRouterBackoffIsolationAndAbortability() {
  const src = read('src/renderer/src/lib/llm/openai.ts');
  assertIncludes(src, 'const openRouterBackoffUntilByKey = new Map<string, number>();', 'openai');
  assertIncludes(src, 'function getOpenRouterBackoffKey(baseUrl: string, model: string): string {', 'openai');
  assertIncludes(src, 'async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {', 'openai');
  assertIncludes(src, 'await waitForOpenRouterBackoff(isOpenRouter, model, openRouterBackoffKey, abortSignal);', 'openai');
  assertIncludes(src, 'await sleepWithAbort(delayMs, abortSignal);', 'openai');
}

function testUserEnvironmentStaysOnDevice() {
  const src = read('src/renderer/src/lib/user-environment.ts');
  assertNotIncludes(src, 'fetch(', 'user-environment');
  assertNotIncludes(src, 'get.geojs.io', 'user-environment');
  assertIncludes(src, 'resolvedOptions().timeZone', 'user-environment');
  assertIncludes(src, 'resolvedOptions().locale', 'user-environment');
}

function testFirebaseNetworkIsModeGated() {
  const firebaseSrc = read('src/renderer/src/lib/firebase/init.ts');
  assertIncludes(firebaseSrc, 'export function setFirebaseEnabled(enabled: boolean): void {', 'firebase-init');
  assertIncludes(firebaseSrc, 'firebaseModules.disableNetwork?.(firebaseFirestore)', 'firebase-init');
  assertIncludes(firebaseSrc, 'firebaseModules.enableNetwork?.(firebaseFirestore)', 'firebase-init');
  assertIncludes(firebaseSrc, 'if (!firebaseEnabled) return null', 'firebase-init');
  assertNotIncludes(firebaseSrc, "import('firebase/analytics')", 'firebase-init');
  assertNotIncludes(firebaseSrc, "import('firebase/app-check')", 'firebase-init');

  const appSrc = read('src/renderer/src/App.tsx');
  assertIncludes(appSrc, "setFirebaseEnabled(privacyMode === 'connected')", 'app');
}

function testLocalOnlyReadinessAndIntegrationGating() {
  const emptyState = read('src/renderer/src/components/chat/EmptyState.tsx');
  assertIncludes(emptyState, "label={llmReady ? 'Model ready' : 'Model setup needed'}", 'empty-state');
  assertIncludes(emptyState, 'AI-Worker needs a model before it can answer.', 'empty-state');
  assertIncludes(emptyState, 'Open model settings', 'empty-state');
  assertIncludes(emptyState, 'connectedMode && <div className="mt-8 w-full max-w-sm">', 'empty-state');

  const chatInput = read('src/renderer/src/components/input/ChatInput.tsx');
  assertIncludes(chatInput, '{connectedMode && <WhatsAppToggle disabled={disabled} />}', 'chat-input');
  assertIncludes(chatInput, 'if (connectedMode && whatsappEnabled', 'chat-input');
  assertIncludes(chatInput, 'localModelUnavailable = !connectedMode && !localModelReady', 'chat-input');
  assertIncludes(chatInput, '&& !localModelUnavailable', 'chat-input-local-readiness');
  assertIncludes(chatInput, 'disabled={disabled || localModelUnavailable}', 'chat-input-local-readiness');
  assertIncludes(chatInput, 'draft stays here until setup is complete', 'chat-input-local-readiness');

  const appSrc = read('src/renderer/src/App.tsx');
  assertIncludes(appSrc, 'const [chatDraft, setChatDraft] = useState', 'app-chat-draft');
  assertIncludes(appSrc, 'draft={chatDraft}', 'app-chat-draft');
  assertIncludes(appSrc, 'onDraftChange={setChatDraft}', 'app-chat-draft');
  assertIncludes(appSrc, 'const chatReady = privacyMode === \'local-only\' ? localModelReady : llmStatus.available', 'app-chat-readiness');

  const chatView = read('src/renderer/src/components/chat/ChatView.tsx');
  assertIncludes(chatView, 'messages.length > 0 && localOnly && !localModelReady', 'chat-view-persistent-local-readiness');
  assertIncludes(chatView, 'onClick={onOpenSettings}', 'chat-view-persistent-local-readiness');

  const connections = read('src/renderer/src/components/ConnectionsPanel.tsx');
  assertIncludes(connections, "server.command === 'internal-memory' || server.command === 'internal-filesystem'", 'connections');
  assertIncludes(connections, 'const visibleServers = connectedMode ? servers : localServers;', 'connections');
  assertIncludes(connections, 'on-device memory and workspace file tools', 'connections');
  assertIncludes(connections, 'showManagementActions={connectedMode}', 'connections');

  const serverCard = read('src/renderer/src/components/mcp/McpServerCard.tsx');
  assertIncludes(serverCard, 'showManagementActions && <Button', 'mcp-server-card');

  const mcpStore = read('src/renderer/src/stores/mcpStore.ts');
  assertIncludes(mcpStore, 'function hasDefaultServer(', 'mcp-store');
  assertIncludes(mcpStore, "server.type === 'stdio' && !server.url", 'mcp-store');
  assertIncludes(mcpStore, "server.command === defaultServer.command", 'mcp-store');

  const memorySettings = read('src/renderer/src/components/settings/MemoryPreferencesPanel.tsx');
  assertIncludes(memorySettings, 'if (result.error)', 'memory-test-write');
  assertIncludes(memorySettings, "alert('Write Success!')", 'memory-test-write');
  assertNotIncludes(memorySettings, 'result.success ?', 'memory-test-write');

  const app = read('src/renderer/src/App.tsx');
  assertIncludes(app, "setSettingsInitialSection('llm')", 'app-model-setup-navigation');
  assertIncludes(app, 'initialSection={settingsInitialSection}', 'app-settings-navigation');
  assertIncludes(app, "if (view === 'settings') setSettingsInitialSection('privacy')", 'app-settings-navigation');
}

function testOpenCodeReadOnlyMcpBridge() {
  const config = JSON.parse(read('opencode.json'));
  assert(config.mcp.ai_worker_readonly.type === 'local', 'AI-Worker MCP uses a local stdio transport');
  assert(JSON.stringify(config.mcp.ai_worker_readonly.command) === JSON.stringify(['node', 'scripts/ai-worker-readonly-mcp.mjs']), 'OpenCode starts the local AI-Worker MCP bridge');
  assert(config.agent.ai_worker_readonly.mode === 'subagent', 'OpenCode exposes a named read-only subagent');
  const agentPermissions = config.agent.ai_worker_readonly.permission;
  assert(Object.keys(agentPermissions)[0] === '*', 'subagent denies tools broadly before specific allow rules');
  assert(agentPermissions['*'] === 'deny', 'subagent denies all tools by default');
  assert(agentPermissions.ai_worker_readonly_get_runtime_status === 'allow', 'subagent allows only the AI-Worker status tool');
  assert(agentPermissions.ai_worker_readonly_ask_local === 'allow', 'subagent allows the isolated local inference tool');
  assert(!config.agent.ai_worker_readonly.tools, 'subagent uses enforced permissions instead of legacy tool visibility config');
  assert(config.mcp.whatsapp.enabled === false, 'project config disables inherited WhatsApp MCP');
  assert(config.mcp['mobile-mcp'].enabled === false, 'project config disables inherited mobile MCP');

  const server = read('scripts/ai-worker-readonly-mcp.mjs');
  assertIncludes(server, "server.registerTool('get_runtime_status'", 'ai-worker-mcp');
  assertIncludes(server, "server.registerTool('ask_local'", 'ai-worker-mcp');
  assertIncludes(server, 'readOnlyHint: true', 'ai-worker-mcp');
  assertIncludes(server, 'heartbeatAgeMs >= 0 && heartbeatAgeMs < 45_000', 'ai-worker-mcp-heartbeat-freshness');
  assertIncludes(server, 'modelStatusAgeMs >= 0 && modelStatusAgeMs < 90_000', 'ai-worker-mcp-model-freshness');
  assertIncludes(server, 'checkedAt >= startedAt', 'ai-worker-mcp-restart-freshness');
  assertIncludes(server, "modelReady: modelStatusFresh && typeof model?.available === 'boolean' ? model.available : null", 'ai-worker-mcp-stale-model');
  assertIncludes(server, "version: isLive && typeof runtime.version === 'string' ? runtime.version : null", 'ai-worker-mcp-version');
  assertIncludes(server, "dataExposed: ['app version', 'app running state', 'privacy mode', 'on-device model readiness']", 'ai-worker-mcp-disclosure');
  assertIncludes(server, "'memory content'", 'ai-worker-mcp');
  assertIncludes(server, "'workspace files'", 'ai-worker-mcp');
  assertIncludes(server, "redirect: 'error'", 'ai-worker-mcp-no-redirects');
  assertIncludes(server, 'http://127.0.0.1:${port}/ask-local', 'ai-worker-mcp-loopback-only');
  assertIncludes(server, "inputSchema: { prompt: z.string().min(1).max(MAX_PROMPT_LENGTH) }", 'ai-worker-mcp-prompt-bounds');
  assertIncludes(server, "readFileSync(snapshotPath, 'utf8')", 'ai-worker-mcp-metadata-only-read');
  assertNotIncludes(server, 'ai-worker-store.json', 'ai-worker-mcp-no-store-read');
  assertNotIncludes(server, 'memory_search', 'ai-worker-mcp');
  assertNotIncludes(server, 'fs_write_file', 'ai-worker-mcp');

  const llmStatus = read('src/renderer/src/hooks/useLLMStatus.ts');
  assertIncludes(llmStatus, 'setStatusCheckAt(Date.now())', 'ai-worker-mcp-model-heartbeat');
  assertIncludes(llmStatus, '[localTaskModel, statusCheckAt]', 'ai-worker-mcp-model-heartbeat');
  assertIncludes(llmStatus, 'getAvailableProviders({ ...settingsForLLM, localOnly: true })', 'ai-worker-mcp-local-readiness');

  const bridgeIpc = read('src/main/ipc/localMcpBridge.ts');
  assertIncludes(bridgeIpc, "ipcMain.handle('mcp-bridge:publish-model-status'", 'ai-worker-mcp-model-status-channel');
  assertIncludes(bridgeIpc, "ipcMain.handle('mcp-bridge:answer-local'", 'ai-worker-mcp-answer-channel');
  const preload = read('src/preload/index.ts');
  assertIncludes(preload, "ipcRenderer.invoke('mcp-bridge:publish-model-status', status)", 'ai-worker-mcp-preload');
  assertIncludes(preload, "ipcRenderer.on('mcp-bridge:ask-local', listener)", 'ai-worker-mcp-ask-preload');
}

function testCopilotCliReadOnlyAgent() {
  const agent = read('.github/agents/ai-worker-readiness.agent.md');
  assertIncludes(agent, 'user-invocable: false', 'copilot-cli-agent');
  assertIncludes(agent, 'strict-tools-list: true', 'copilot-cli-agent');
  assertIncludes(agent, '- ai-worker-readiness-local/get_runtime_status', 'copilot-cli-agent-tool-allowlist');
  assertIncludes(agent, '- ai-worker-readiness-local/ask_local', 'copilot-cli-agent-local-inference-allowlist');
  assertIncludes(agent, 'ai-worker-readiness-local:', 'copilot-cli-agent-mcp');
  assertIncludes(agent, 'tools:\n      - get_runtime_status', 'copilot-cli-agent-mcp-tool-filter');
  assertIncludes(agent, 'scripts/ai-worker-readonly-mcp.mjs', 'copilot-cli-agent-mcp');
  assertNotIncludes(agent, 'http://', 'copilot-cli-agent-no-network');
  assertNotIncludes(agent, 'https://', 'copilot-cli-agent-no-network');
}

function testAgentStateServiceNoGlobalSuppressor() {
  const src = read('src/renderer/src/lib/agent/AgentStateService.ts');
  assertIncludes(src, 'const memoryCreateDisabledUntilByContext = new Map<string, number>();', 'agent-state');
  assertIncludes(src, 'function canCreateStateEntity(context: string): boolean {', 'agent-state');
  assertNotIncludes(src, 'Skipping handoff entity creation (memory_create_entity temporarily disabled)', 'agent-state');
  assertIncludes(src, 'clearMemoryCreateFailure(createContext);', 'agent-state');
}

function testPhaseARuntimeWritePauseAndSessionIsolation() {
  const runtimeSrc = read('src/renderer/src/lib/agent-runtime.ts');
  assertIncludes(runtimeSrc, 'function isWriteAwaitingApproval(callName: string, resultStr: string): boolean {', 'agent-runtime');
  assertIncludes(runtimeSrc, 'File Write Paused', 'agent-runtime');
  assertIncludes(runtimeSrc, 'pending approval', 'agent-runtime');

  const chatStoreSrc = read('src/renderer/src/stores/chatStore.ts');
  assertIncludes(chatStoreSrc, 'const existing = next.get(sessionId);', 'chat-store');
  assertIncludes(chatStoreSrc, 'existing.abortController.abort();', 'chat-store');
}

function testPhaseAMemoryParsingFallbacks() {
  const src = read('src/main/services/memory/adapters/ServerMemoryAdapter.ts');
  assertIncludes(src, 'function parseEntityLikePayload(text: string): Record<string, unknown> | null {', 'server-memory-adapter');
  assertNotIncludes(src, "throw new Error('No content returned from create_entities')", 'server-memory-adapter');
  assertNotIncludes(src, "throw new Error('No text content in create_entities response')", 'server-memory-adapter');
  assertIncludes(src, "const normalizedDescription = input.description?.trim() || ''", 'server-memory-adapter');
  assertIncludes(src, "observations", 'server-memory-adapter');
}

function testPhaseACompactChecklistSemantics() {
  const src = read('src/renderer/src/components/chat/SubTaskChecklist.tsx');
  assertIncludes(src, 'const completedWithIssues = isTerminal && hasFailure', 'subtask-checklist');
  assertIncludes(src, 'Completed with issues', 'subtask-checklist');
  assertNotIncludes(src, 'const completedWithIssues = isTerminal && hasFailure && completedCount > 0', 'subtask-checklist');
}

function testImmediateReplyNoToolMode() {
  const runtimeSrc = read('src/renderer/src/lib/agent-runtime.ts');
  assertIncludes(
    runtimeSrc,
    'function hasMemoryRecallIntent(prompt: string): boolean {',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'if (hasMemoryRecallIntent(p)) return false;',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    "Memory-recall cue detected; keeping tools enabled on first turn.",
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'await this._primeMemoryContext(finalPrompt);',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'private async _primeMemoryContext(prompt: string): Promise<void> {',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'const LOCAL_PREFERENCE_MEMORY_KEY = "ai_worker_local_preferences_v1";',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'getLocalPreferenceMemoryLines()',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'function buildDeterministicPreferenceRecallAnswer(prompt: string): string | null {',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    "Using deterministic local preference recall answer.",
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'function isWeakFinalNarration(content: string): boolean {',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'function buildDelegateFallbackSummary(calls: AccumulatedToolCall[]): string | null {',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'buildDelegateFallbackSummary(accumulatedToolCalls);',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'Replaced weak terminal narration with delegate summary fallback.',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'isFinalResult: true,',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'Memory primer injected with',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'const directAnswerFirstTurn = !this.options.isSubAgent && shouldPreferDirectAnswer(finalPrompt);',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'const disableToolsThisIteration = directAnswerFirstTurn && iterationCount === 0;',
    'agent-runtime'
  );
  assertIncludes(
    runtimeSrc,
    'const shouldDirectAnswer = shouldPreferDirectAnswer(finalPrompt);',
    'agent-runtime'
  );

  const llmSrc = read('src/renderer/src/lib/llm.ts');
  assertIncludes(
    llmSrc,
    'includePlanTool = true',
    'llm'
  );
  assertIncludes(
    llmSrc,
    'if (includePlanTool) {',
    'llm'
  );

  const openaiSrc = read('src/renderer/src/lib/llm/openai.ts');
  assertIncludes(
    openaiSrc,
    'const toolRecoveryAllowed = Boolean(tools && tools.length > 0);',
    'openai'
  );
}

function testMemoryReflectorCancellationHook() {
  const reflectorSrc = read('src/renderer/src/lib/memory-reflector.ts');
  assertIncludes(reflectorSrc, "cancel(reason = 'new prompt')", 'memory-reflector');
  assertIncludes(reflectorSrc, 'this.currentAbortController?.abort();', 'memory-reflector');

  const useAgentSrc = read('src/renderer/src/hooks/useAgent.ts');
  assertIncludes(
    useAgentSrc,
    "MemoryReflector.getInstance().cancel('prompt-restart');",
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    "const shouldRunReflector =",
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'const hasShortPreferenceCue =',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'const isShortButStablePreference =',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'const isMemoryRecallQuestion =',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'isShortButStablePreference ||',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    '!isMemoryRecallQuestion &&',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'hasMemoryIntent ||',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'const LOCAL_PREFERENCE_MEMORY_KEY = "ai_worker_local_preferences_v1";',
    'useAgent'
  );
  assertIncludes(
    useAgentSrc,
    'persistLocalPreferenceHints(normalizedPrompt);',
    'useAgent'
  );
}

function testE2EAssertionsAreStrict() {
  const realSrc = read('tests/real_e2e_test.cjs');
  assertIncludes(realSrc, '!result.timedOut && actionCardsDelta <= 1 && assistantDelta >= 1', 'real-e2e');
  assertIncludes(realSrc, '!result.timedOut && (orchestratedPath || directSingleSite)', 'real-e2e');
  assertIncludes(realSrc, '!result.timedOut && hasParallelSummary', 'real-e2e');
  assertIncludes(realSrc, '!result.timedOut && checkpointLogs.length > 0', 'real-e2e');

  const mockedSrc = read('tests/e2e_ui_mocked.cjs');
  assertIncludes(mockedSrc, "console.error('⚠️ Handoff test failed');", 'mocked-e2e');
  assertIncludes(mockedSrc, "console.error('❌ Plan Response missing');", 'mocked-e2e');
  assertIncludes(mockedSrc, 'Successfully recovered .* tool calls from content body', 'mocked-e2e');
  assertIncludes(mockedSrc, 'Detected XML plan in content, converting to tool call', 'mocked-e2e');
  assertNotIncludes(mockedSrc, 'JSON recovery signal not visible in UI; continuing (non-blocking)', 'mocked-e2e');
  assertNotIncludes(mockedSrc, 'XML recovery signal not visible in UI; continuing (non-blocking)', 'mocked-e2e');
  assertIncludes(mockedSrc, "console.log('\\n🎉 ALL SCENARIOS PASSED');", 'mocked-e2e');
  assertNotIncludes(mockedSrc, 'ALL SCENARIOS PASSED (with handled warnings)', 'mocked-e2e');
}

function testEvaluateToolTopLevelReturnRecovery() {
  const advancedSrc = read('src/main/services/playwright/tools/AdvancedTools.ts');
  assertIncludes(advancedSrc, "aliases = ['browser_run_code', 'browser_evaluate'];", 'advanced-tools');
  assertIncludes(advancedSrc, "typeof args?.code === 'string' ? args.code : ''", 'advanced-tools');
  assertIncludes(advancedSrc, 'Missing required parameter: script', 'advanced-tools');
  assertIncludes(advancedSrc, "return statements are only valid inside functions", 'advanced-tools');
  assertIncludes(advancedSrc, 'const hasSyntaxLikeFailure =', 'advanced-tools');
  assertIncludes(advancedSrc, 'const genericEvaluateFailureWithReturn =', 'advanced-tools');
  assertIncludes(advancedSrc, 'const alreadyIifeWrapped =', 'advanced-tools');
  assertIncludes(advancedSrc, 'const wrappedScript = `(() => {\\n${script}\\n})()`;', 'advanced-tools');
}

function testLaneTimeoutsForPerceptionTools() {
  const lanesSrc = read('src/renderer/src/lib/execution-lanes.ts');
  assertIncludes(lanesSrc, 'BROWSER_PERCEPTION: 60_000', 'execution-lanes');
  assertIncludes(lanesSrc, "const PERCEPTION_TOOLS = [", 'execution-lanes');
  assertIncludes(lanesSrc, "'get_state'", 'execution-lanes');
  assertIncludes(lanesSrc, "'get_page_content'", 'execution-lanes');
  assertIncludes(lanesSrc, "'wait_for_navigation'", 'execution-lanes');
}

function testCloseTabLastTabNoop() {
  const tabToolsSrc = read('src/main/services/playwright/tools/TabTools.ts');
  assertIncludes(tabToolsSrc, "Skipped close_tab: last tab remains open", 'tab-tools');
  assertNotIncludes(tabToolsSrc, "return { result: null, error: 'Cannot close the last tab' };", 'tab-tools');
}

function testNavigationTimeoutRecovery() {
  const navigateSrc = read('src/main/services/playwright/tools/NavigateTool.ts');
  assertIncludes(navigateSrc, 'Navigation timed out but page appears interactive.', 'navigate-tool');
  assertIncludes(navigateSrc, 'const probe = await probeReadiness(page);', 'navigate-tool');
  assertIncludes(navigateSrc, 'const outcome = classifyNavigationError(errorStr, probe);', 'navigate-tool');
  assertIncludes(navigateSrc, "meta: { navigationOutcome: 'interactive_timeout' as NavigationOutcome }", 'navigate-tool');
  assertIncludes(navigateSrc, "safeArgs = args ?? {}", 'navigate-tool');
}

function testWaitForNavigationHeuristicFallback() {
  const miscSrc = read('src/main/services/playwright/tools/MiscTools.ts');
  assertIncludes(miscSrc, 'const perStateTimeout = Math.max(2000, Math.floor(timeout / loadStates.length));', 'misc-tools');
  assertIncludes(miscSrc, 'Navigation likely complete (heuristic).', 'misc-tools');
  assertIncludes(miscSrc, 'interactiveElements=', 'misc-tools');
}

function testGetStateNavigationRaceResilience() {
  const getStateSrc = read('src/main/services/playwright/tools/GetStateTool.ts');
  assertIncludes(getStateSrc, 'const safeArgs = args ?? {};', 'get-state');
  assertIncludes(getStateSrc, 'for (let attempt = 1; attempt <= 3; attempt++) {', 'get-state');
  assertIncludes(getStateSrc, 'const readinessProbe = await probeReadinessWithRetry(page, 2, 1200);', 'get-state');
  assertIncludes(getStateSrc, '[GetStateTool] page not usable before extraction', 'get-state');
  assertIncludes(getStateSrc, "Target page, context or browser has been closed", 'get-state');
  assertIncludes(getStateSrc, "await withNavigationRecovery(() => page.evaluate(() => {", 'get-state');
}

function testToolResultMetadataPropagation() {
  const toolBase = read('src/main/services/playwright/PlaywrightTool.ts');
  assertIncludes(toolBase, 'meta?: Record<string, unknown>;', 'playwright-tool');

  const mainMcp = read('src/main/ipc/mcp.ts');
  assertIncludes(mainMcp, "if (res.meta && typeof res.meta === 'object') wrapped.meta = res.meta", 'main-mcp');
}

function testSubAgentExtractionFirstRule() {
  const promptSrc = read('src/renderer/src/lib/llm/prompts.ts');
  assertIncludes(
    promptSrc,
    '**Extraction first**: For info-gathering tasks, prefer get_state/get_page_content/evaluate before clicking deep links.',
    'prompts'
  );
}

function testClickTextBoundedTimeoutAndFallbacks() {
  const clickTextSrc = read('src/main/services/playwright/tools/ClickTextTool.ts');
  assertIncludes(clickTextSrc, "timeout: { type: 'number', description: 'Max wait in ms (default: 8000, capped to 15000)' }", 'click-text');
  assertIncludes(clickTextSrc, 'const rawTimeout = typeof safeArgs.timeout === \'number\' ? safeArgs.timeout : 8000;', 'click-text');
  assertIncludes(clickTextSrc, 'const timeout = Math.max(1500, Math.min(15000, rawTimeout));', 'click-text');
  assertIncludes(clickTextSrc, 'const compactFallback = normalized.length > 52 ? normalized.slice(0, 52) : normalized;', 'click-text');
  assertIncludes(clickTextSrc, 'const keywordFallback = normalized', 'click-text');
}

function testRecoverySignalLogging() {
  const openaiSrc = read('src/renderer/src/lib/llm/openai.ts');
  assertIncludes(openaiSrc, "console.log('[LLM] No native tool calls found. Attempting to parse JSON from content...');", 'openai');
  assertIncludes(openaiSrc, "console.log('[LLM] Detected XML plan in content, converting to tool call');", 'openai');
}

function testRealE2EIdleGating() {
  const realSrc = read('tests/real_e2e_test.cjs');
  assertIncludes(realSrc, "const CRITICAL_SELECT_ARG = process.argv.find((arg) => arg.startsWith('--only-critical=') || arg.startsWith('--critical='));", 'real-e2e');
  assertIncludes(realSrc, 'function shouldRunCritical(id) {', 'real-e2e');
  assertIncludes(realSrc, 'if (shouldRunCritical(3)) {', 'real-e2e');
  assertIncludes(realSrc, "const INCLUDE_EXTENDED_CRITICALS = process.argv.includes('--extended-criticals') || process.env.E2E_EXTENDED_CRITICALS === '1';", 'real-e2e');
  assertIncludes(realSrc, 'if (INCLUDE_EXTENDED_CRITICALS && shouldRunCritical(6)) {', 'real-e2e');
  assertIncludes(realSrc, "Critical 6 was selected but --extended-criticals is not enabled; skipping Critical 6.", 'real-e2e');
  assertIncludes(realSrc, "const RATE_SAFE_MODE = process.argv.includes('--rate-safe') || process.env.E2E_RATE_SAFE === '1';", 'real-e2e');
  assertIncludes(realSrc, 'if (RATE_SAFE_MODE) {', 'real-e2e');
  assertIncludes(realSrc, 'async function waitForRunIdle(', 'real-e2e');
  assertIncludes(realSrc, 'button[title="Stop Generation"]', 'real-e2e');
  assertIncludes(realSrc, 'Keyword matched but run still active; continuing to wait.', 'real-e2e');
  assertIncludes(realSrc, 'function logsContainPattern(pattern, startIndex = 0) {', 'real-e2e');
  assertIncludes(realSrc, 'successLogPattern = null,', 'real-e2e');
  assertIncludes(realSrc, 'Success signal observed in logs; accepting prompt as completed.', 'real-e2e');
  assertIncludes(realSrc, 'successLogPattern: /Using deterministic local preference recall answer/i,', 'real-e2e');
}

function testWorkspaceSelectionAndInternalTaskTracking() {
  const toolbarSrc = read('src/renderer/src/components/input/InputToolbar.tsx');
  assertIncludes(toolbarSrc, 'data-testid="workspace-select-button"', 'input-toolbar');
  assertIncludes(toolbarSrc, 'data-testid="attachment-select-button"', 'input-toolbar');
  assertIncludes(toolbarSrc, 'File review required', 'input-toolbar');
  assertNotIncludes(toolbarSrc, 'workspace-auto-file-write-approval-toggle', 'input-toolbar');
  assertIncludes(toolbarSrc, 'onClick={onSelectFolder}', 'input-toolbar');
  assertIncludes(toolbarSrc, "onClick={() => fileInputRef.current?.click()}", 'input-toolbar');

  const chatInputSrc = read('src/renderer/src/components/input/ChatInput.tsx');
  assertIncludes(chatInputSrc, 'const maybeSetWorkspaceFromFiles = useCallback((files: File[]) => {', 'chat-input');
  assertIncludes(chatInputSrc, 'onSelectFolder={handleSelectFolder}', 'chat-input');
  assertIncludes(chatInputSrc, 'onSelectFiles={handleSelectFiles}', 'chat-input');

  const realSrc = read('tests/real_e2e_test.cjs');
  assertIncludes(realSrc, '[data-testid="workspace-select-button"]', 'real-e2e');
  assertIncludes(realSrc, '[data-testid="attachment-select-button"]', 'real-e2e');
  assertIncludes(realSrc, 'Critical 7: Session Auto-Approve + Workspace Controls', 'real-e2e');

  const taskManagerSrc = read('src/renderer/src/lib/task-manager.ts');
  assertIncludes(taskManagerSrc, "electron.fs.writeInternalFile(workspacePath, 'tasks.json'", 'task-manager');

  const ipcFsSrc = read('src/main/ipc/fs.ts');
  assertIncludes(ipcFsSrc, "'.ai-worker', 'system-workspace'", 'ipc-fs');
  assertIncludes(ipcFsSrc, "ipcMain.handle('fs:write-internal-file'", 'ipc-fs');
  assertIncludes(ipcFsSrc, "ipcMain.handle('fs:read-internal-file'", 'ipc-fs');

  const fileSystemServiceSrc = read('src/main/services/FileSystemService.ts');
  assertIncludes(fileSystemServiceSrc, 'private isInternalTrackingFile(filePath: string): boolean {', 'filesystem-service');
  assertIncludes(fileSystemServiceSrc, 'const change = await this.stageWrite(resolvedPath, args.content, sessionId)', 'filesystem-service');
  assertIncludes(fileSystemServiceSrc, "status: 'staged'", 'filesystem-service');
}

function testFileWriteApprovalAndSandboxHardening() {
  const useAgentSrc = read('src/renderer/src/hooks/useAgent.ts');
  assertNotIncludes(useAgentSrc, 'fileWriteAutoApprove:', 'useAgent');

  const chatStoreSrc = read('src/renderer/src/stores/chatStore.ts');
  assertNotIncludes(chatStoreSrc, 'fileWriteAutoApprove: false,', 'chat-store');

  const fsServiceSrc = read('src/main/services/FileSystemService.ts');
  assertNotIncludes(fsServiceSrc, 'normalized.includes(legacyWorkspaceMarker)', 'filesystem-service');
  assertNotIncludes(fsServiceSrc, 'const isInternalPathRequested = this.isInternalTrackingFile(rawPath)', 'filesystem-service');
  assertIncludes(fsServiceSrc, "'.ai-worker', 'system-workspace'", 'filesystem-service');
  assertIncludes(
    fsServiceSrc,
    'const resolvedPath = this.resolveWorkspaceScopedTargetPath(args?.path, args?.workspacePath, name)',
    'filesystem-service'
  );

  const mcpSrc = read('src/renderer/src/lib/mcp.ts');
  assertIncludes(mcpSrc, 'function normalizeAbsoluteFsPath(value: string): string | null {', 'mcp');
  assertIncludes(mcpSrc, 'function resolveFsPath(baseAbsolutePath: string, targetPath: string): string | null {', 'mcp');
  assertIncludes(mcpSrc, 'const resolvedTargetPath = resolveFsPath(normalizedWorkspacePath, rawTargetPath);', 'mcp');
  assertIncludes(mcpSrc, 'if (!resolvedTargetPath) {', 'mcp');

  const fileReviewSrc = read('src/renderer/src/components/FileChangeReview.tsx');
  assertIncludes(fileReviewSrc, 'const handleApprove = async (id: string) => {', 'file-change-review');
  assertIncludes(fileReviewSrc, 'const handleReject = async (id: string) => {', 'file-change-review');
  assertIncludes(fileReviewSrc, 'waiting for approval', 'file-change-review');
  assertNotIncludes(fileReviewSrc, 'autoApprove', 'file-change-review');
}

function run() {
  console.log('Running critical regression checks...');
  testAgentRuntimeDelegateParallelism();
  testTaskDecomposerConditionalHeuristic();
  testTaskDecomposerWebsiteAliasExtraction();
  testOpenRouterBackoffIsolationAndAbortability();
  testUserEnvironmentStaysOnDevice();
  testFirebaseNetworkIsModeGated();
  testLocalOnlyReadinessAndIntegrationGating();
  testOpenCodeReadOnlyMcpBridge();
  testCopilotCliReadOnlyAgent();
  testAgentStateServiceNoGlobalSuppressor();
  testPhaseARuntimeWritePauseAndSessionIsolation();
  testPhaseAMemoryParsingFallbacks();
  testPhaseACompactChecklistSemantics();
  testImmediateReplyNoToolMode();
  testMemoryReflectorCancellationHook();
  testE2EAssertionsAreStrict();
  testEvaluateToolTopLevelReturnRecovery();
  testLaneTimeoutsForPerceptionTools();
  testCloseTabLastTabNoop();
  testNavigationTimeoutRecovery();
  testWaitForNavigationHeuristicFallback();
  testGetStateNavigationRaceResilience();
  testToolResultMetadataPropagation();
  testSubAgentExtractionFirstRule();
  testClickTextBoundedTimeoutAndFallbacks();
  testRecoverySignalLogging();
  testRealE2EIdleGating();
  testWorkspaceSelectionAndInternalTaskTracking();
  testFileWriteApprovalAndSandboxHardening();
  console.log('All critical regression checks passed.');
}

try {
  run();
} catch (error) {
  console.error('Critical regression check failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
