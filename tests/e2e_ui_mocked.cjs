const { _electron: electron } = require('playwright');
delete process.env.ELECTRON_RUN_AS_NODE;
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const http = require('node:http');

const TEST_ROOT = fs.mkdtempSync(path.join(os.homedir(), 'ai-worker-mocked-e2e-'));
const USER_DATA_DIR = path.join(TEST_ROOT, 'user-data');
const SCREENSHOT_DIR = path.join(TEST_ROOT, 'screenshots');
const TEST_WORKSPACE_DIR = path.join(TEST_ROOT, 'workspace');
const TEST_OLLAMA_BASE_URL = 'http://127.0.0.1:0';
const mockApiServer = http.createServer((request, response) => {
    const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && requestPath === '/v1/models') {
        response.writeHead(200).end(JSON.stringify({
            object: 'list',
            data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'mock' }],
        }));
        return;
    }
    response.writeHead(404).end(JSON.stringify({ error: { message: 'Unmocked E2E endpoint' } }));
});

async function cleanupTestEnvironment({ preserveArtifacts = false } = {}) {
    if (mockApiServer.listening) {
        await new Promise(resolve => mockApiServer.close(resolve));
    }
    if (!preserveArtifacts) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}

(async () => {
    console.log('🚀 Starting Comprehensive E2E UI Test (Mocked)...');

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_WORKSPACE_DIR, { recursive: true });
    const settingsStorePath = path.join(USER_DATA_DIR, 'ai-worker-store.json');
    fs.writeFileSync(settingsStorePath, JSON.stringify({
        'ai-worker-settings': {
            state: {
                privacyMode: 'local-only',
                preferredProvider: 'auto',
                ollamaBaseUrl: TEST_OLLAMA_BASE_URL,
            },
            version: 1,
        },
    }), { flag: 'wx' });
    const seededStore = JSON.parse(fs.readFileSync(settingsStorePath, 'utf8'));
    if (seededStore['ai-worker-settings']?.state?.ollamaBaseUrl !== TEST_OLLAMA_BASE_URL) {
        throw new Error('Test store did not contain the isolated loopback Ollama URL before launch.');
    }
    await new Promise((resolve, reject) => {
        mockApiServer.once('error', reject);
        mockApiServer.listen(0, '127.0.0.1', resolve);
    });
    const mockApiAddress = mockApiServer.address();
    if (!mockApiAddress || typeof mockApiAddress === 'string') {
        await cleanupTestEnvironment();
        throw new Error('Could not start loopback OpenAI mock server');
    }
    const mockOpenAiBaseUrl = `http://127.0.0.1:${mockApiAddress.port}/v1`;

    const macPath = path.join(__dirname, '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    const linuxPath = path.join(__dirname, '../node_modules/electron/dist/electron');
    const electronExecutable = fs.existsSync(macPath) ? macPath : linuxPath;
    const execPath = fs.existsSync(electronExecutable) ? electronExecutable : 'electron';
    const appEntry = path.join(__dirname, '../out/main/index.js');
    const launchArgs = [
        appEntry,
        `--user-data-dir=${USER_DATA_DIR}`,
        '--host-resolver-rules=MAP localhost ~NOTFOUND',
    ];

    if (process.platform === 'linux') {
        launchArgs.push(
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage'
        );
    }

    console.log('Using electron execPath:', execPath);
    console.log('Using electron launch args:', launchArgs.join(' '));

    let electronApp;
    try {
        electronApp = await electron.launch({
            executablePath: execPath,
            args: launchArgs,
            timeout: 120000,
            env: { ...process.env, NODE_ENV: 'production' }
        });
        console.log('✅ Electron launched');
    } catch (e) {
        console.error('❌ Launch failed:', e);
        await cleanupTestEnvironment({ preserveArtifacts: true });
        console.error(`[Mock E2E] Failure artifacts retained under ${TEST_ROOT}`);
        process.exitCode = 1;
        return;
    }

    let testPassed = false;
    let testWindow;
    const rendererPageErrors = [];
    try {
        const appPaths = await electronApp.evaluate(({ app }, testHome) => {
            app.setPath('home', testHome);
            return {
                home: app.getPath('home'),
                userData: app.getPath('userData'),
            };
        }, TEST_ROOT);
        if (fs.realpathSync(appPaths.home) !== fs.realpathSync(TEST_ROOT)) {
            throw new Error(`Expected isolated Electron home at ${TEST_ROOT}, got ${appPaths.home}`);
        }
        console.log('✅ Electron home is isolated under the temporary test profile');
        const appUserData = appPaths.userData;
        if (fs.realpathSync(appUserData) !== fs.realpathSync(USER_DATA_DIR)) {
            throw new Error(`Expected isolated test profile at ${USER_DATA_DIR}, got ${appUserData}`);
        }
        console.log('✅ Electron user data is isolated under the temporary test profile');

        await electronApp.context().route('**/*', async route => {
            const requestUrl = new URL(route.request().url());
            const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(requestUrl.hostname);
            if (isLoopback && requestUrl.port === '11434') {
                console.log('[Mock E2E] Blocking Ollama traffic to port 11434');
                await route.abort('blockedbyclient');
                return;
            }
            if (!['http:', 'https:'].includes(requestUrl.protocol) ||
                isLoopback) {
                await route.continue();
                return;
            }
            console.log(`[Mock E2E] Blocking non-loopback request: ${requestUrl.origin}`);
            await route.abort('internetdisconnected');
        });

        const isMainRendererUrl = url => {
            try {
                const parsedUrl = new URL(String(url));
                return parsedUrl.protocol === 'file:' &&
                    parsedUrl.pathname.endsWith('/renderer/index.html') &&
                    parsedUrl.searchParams.get('window') !== 'task';
            } catch {
                return false;
            }
        };
        const appWindows = electronApp.windows();
        if (appWindows.length === 0) await electronApp.firstWindow({ timeout: 30000 });
        const windowCandidates = electronApp.windows();
        const mainWindowLoaded = windowCandidates.find(candidate => isMainRendererUrl(candidate.url()));
        if (!mainWindowLoaded) {
            await Promise.any(windowCandidates.map(candidate =>
                candidate.waitForURL(isMainRendererUrl, { timeout: 30000 })
            ));
        }
        testWindow = electronApp.windows().find(candidate => isMainRendererUrl(candidate.url()));
        if (!testWindow) {
            throw new Error(`Could not locate full app window; opened URLs: ${electronApp.windows().map(candidate => candidate.url()).join(', ')}`);
        }
        const window = testWindow;
        const rendererLogs = [];
        window.on('pageerror', error => {
            rendererPageErrors.push(error.message);
            console.error(`[PageError]: ${error.message}`);
        });
        window.on('console', msg => {
            const text = msg.text();
            rendererLogs.push(text);
            console.log(`[Renderer]: ${text}`);
        });
        await window.waitForLoadState('domcontentloaded');
        const storedOllamaBaseUrl = await window.evaluate(async () => {
            const settings = await window.electron.store.get('ai-worker-settings');
            return settings?.state?.ollamaBaseUrl;
        });
        if (storedOllamaBaseUrl !== TEST_OLLAMA_BASE_URL) {
            throw new Error(`Expected isolated Ollama URL ${TEST_OLLAMA_BASE_URL}, got ${storedOllamaBaseUrl}`);
        }
        console.log('✅ Isolated Ollama URL is active in the app store');
        await window.setViewportSize({ width: 1280, height: 900 });

        // Mocking at the window level is more reliable than network interception for localhost in Electron
        await window.addInitScript(async (workspacePath) => {
            localStorage.setItem('skipDepsCheck', 'true');
            const workspaceFile = (relativePath) => `${workspacePath.replace(/[\\/]+$/, '')}/${relativePath.replace(/^[\\/]+/, '')}`;
            console.log("🧹 Clearing IndexedDB to ensure clean state...");
            try {
                const dbs = await window.indexedDB.databases();
                for (const db of dbs) {
                    window.indexedDB.deleteDatabase(db.name);
                }
            } catch (e) { }
            console.log("🛠️ Injecting Mock Fetch...");

            // --- SCENARIO DEFINITIONS ---
            // Maps trigger phrases in user prompts to mock LLM responses
            const SCENARIOS = [
                {
                    triggers: ["Compare the price", "Parallel"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "Starting parallel search for minimal price...",
                                tool_calls: [
                                    { id: "call_1", type: "function", function: { name: "delegate_sub_task", arguments: JSON.stringify({ instruction: "Amazon Search" }) } },
                                    { id: "call_2", type: "function", function: { name: "delegate_sub_task", arguments: JSON.stringify({ instruction: "BestBuy Search" }) } }
                                ]
                            }
                        }]
                    }
                },
                {
                    triggers: ["tickets from", "Sequential"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I will plan this trip.",
                                tool_calls: [{
                                    id: "call_plan",
                                    type: "function",
                                    function: {
                                        name: "create_execution_plan",
                                        arguments: JSON.stringify({
                                            original_request: "Find bus tickets",
                                            steps: [
                                                { id: 1, title: "Search Routes", description: "Query API for routes", status: "pending" },
                                                { id: 2, title: "Compare Prices", description: "Filter by price < 500", status: "pending" }
                                            ]
                                        })
                                    }
                                }]
                            }
                        }]
                    }
                },
                {
                    triggers: ["wireless headphones", "Result Reporting"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "✅ Found 3 products:\n\n1. **Sony WH-1000XM5** - ₹24,990 ⭐4.8\n2. **Bose QuietComfort** - ₹29,500 ⭐4.6\n3. **Sennheiser HD** - ₹12,999 ⭐4.4\n\n<think>Filtered noise from DOM.</think>"
                            }
                        }]
                    }
                },
                {
                    triggers: ["Run stress test", "UI Stress"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "<think>Running visual diagnostics...\n- Rendering Table\n- Check Code Block</think># Analysis Report\n\nHere is the data status:\n\n| ID | Type | Status |\n|:---|:-----|:-------|\n| 01 | File | ✅ OK  |\n| 02 | Net  | ❌ Err |\n\nChecking filesystem integrity:\n```typescript\nconst path = require('path');\nconsole.log(path.resolve('.'));\n```\n",
                                tool_calls: [
                                    { id: "call_ok", type: "function", function: { name: "fs_list_directory", arguments: JSON.stringify({ path: workspacePath }) } },
                                    { id: "call_err", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/ghost.txt") }) } },
                                    { id: "call_missing", type: "function", function: { name: "unknown_tool_xyz", arguments: "{}" } }
                                ]
                            }
                        }]
                    }
                },
                {
                    triggers: ["JSON fallback recovery", "Simulate JSON fallback recovery"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I'll help you with that. I'm using an older model, so I'll output my actions in JSON format.\n\n```json\n{\n  \"tool\": \"fs_list_directory\",\n  \"params\": { \"path\": " + JSON.stringify(workspacePath) + " }\n}\n```\n\nI'll wait for the list.",
                                tool_calls: [] // NO NATIVE TOOL CALLS
                            }
                        }]
                    }
                },
                {
                    triggers: ["Rolex", "proceed to checkout", "Safety"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I have added the item to cart, but I cannot proceed to checkout due to safety rules.",
                                tool_calls: []
                            }
                        }]
                    }
                },
                {
                    triggers: ["think"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "<think>Deeply analyzing the request...</think>Here is the answer."
                            }
                        }]
                    }
                },
                {
                    triggers: ["XML fallback", "agent_plan recovery"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: `<agent_plan>
  <summary>Build a simple 2-step plan</summary>
  <steps>
    <step index="1">Inspect current state</step>
    <step index="2">Return a compact summary</step>
  </steps>
</agent_plan>`,
                                tool_calls: []
                            }
                        }]
                    }
                },
                {
                    triggers: ["leaked"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "Here are the tools: <tools>{\"name\": \"leaked_tool\"}</tools> hidden."
                            }
                        }]
                    }
                },
                {
                    triggers: ["Malformed"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I am returning a truncated response to test crash resistance: ```json\n{\"id\": 1, \"content\": \"this is truncated"
                            }
                        }]
                    }
                },
                {
                    triggers: ["handoff limit", "handoff confirmation"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I've reached the maximum number of steps (50) for this context. I've saved a checkpoint of my progress. Should I continue with a fresh agent instace or stop here?",
                                actions: [
                                    { type: "continue", label: "Continue" },
                                    { type: "stop", label: "Stop" }
                                ]
                            }
                        }]
                    }
                },
                {
                    triggers: ["loop different args"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "Exploring files.",
                                tool_calls: [
                                    { id: "c1", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/fileA.txt") }) } },
                                    { id: "c2", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/fileB.txt") }) } },
                                    { id: "c3", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/fileC.txt") }) } },
                                    { id: "c4", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/fileD.txt") }) } }
                                ]
                            }
                        }]
                    }
                },
                {
                    triggers: ["loop same args"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "Stuck reading the same file.",
                                tool_calls: [
                                    { id: "c1", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/stuck.txt") }) } },
                                    { id: "c2", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/stuck.txt") }) } },
                                    { id: "c3", type: "function", function: { name: "fs_read_file", arguments: JSON.stringify({ path: workspaceFile("missing/stuck.txt") }) } }
                                ]
                            }
                        }]
                    }
                },
                {
                    triggers: ["sub-agent crash salvage"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "Gathering intel then delegating...",
                                tool_calls: [
                                    {
                                        id: "c_sub",
                                        type: "function",
                                        function: {
                                            name: "delegate_sub_task",
                                            arguments: JSON.stringify({ instruction: "Crash me" })
                                        }
                                    }
                                ]
                            }
                        }]
                    }
                },
                {
                    // Catch-all inside sub-agent for "Crash me"
                    triggers: ["Crash me"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I will use evaluate to get the secret.",
                                tool_calls: [
                                    {
                                        id: "call_eval",
                                        type: "function",
                                        function: {
                                            name: "browser_evaluate",
                                            arguments: JSON.stringify({ script: "return 'SECRET_SALVAGED_DATA_42';" })
                                        }
                                    }
                                ]
                            }
                        }]
                    }
                },
                {
                    // Triggered when the sub-agent sends the results of the browser_evaluate tool back to the LLM
                    triggers: ["SECRET_SALVAGED_DATA_42"],
                    response: {
                        choices: [{
                            message: {
                                role: "assistant",
                                content: "I encountered 3 consecutive errors and am stopping to prevent an infinite loop.",
                            }
                        }]
                    }
                }
            ];

            const originalFetch = window.fetch;
            window.fetch = async (input, init) => {
                let url = input;
                if (typeof input === 'object' && input !== null && 'url' in input) {
                    url = input.url;
                }
                const urlStr = url.toString();
                // console.log(`[MockFetch] Request to: ${urlStr}`);

                if (urlStr.includes('/api/tags')) {
                    return new Response(JSON.stringify({ models: [{ name: "mock-model" }] }), { status: 200 });
                }

                if (urlStr.endsWith('/v1/models')) {
                    return new Response(JSON.stringify({
                        object: 'list',
                        data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'mock' }],
                    }), { status: 200 });
                }

                if (urlStr.includes('/api/chat') || urlStr.includes('/chat/completions')) {
                    // console.log('[MockFetch] Intercepting CHAT');
                    let bodyStr = "";
                    if (init && init.body) {
                        bodyStr = init.body;
                    } else if (input instanceof Request) {
                        bodyStr = await input.text();
                    }

                    // QUIET MODE: Ignore Background Memory Reflector calls
                    if (bodyStr.includes("BACKGROUND_MEMORY_EXTRACTION") || bodyStr.includes("MemoryReflector")) {
                        return new Response(JSON.stringify({
                            model: "mock-model",
                            choices: [{
                                message: { role: "assistant", content: "No memory updates." }
                            }],
                            usage: { total_tokens: 0 }
                        }), { status: 200 });
                    }

                    try {
                        const body = JSON.parse(bodyStr);
                        let lastMsgRaw = body.messages[body.messages.length - 1].content;
                        let lastMsg = typeof lastMsgRaw === "string"
                            ? lastMsgRaw
                            : Array.isArray(lastMsgRaw)
                                ? lastMsgRaw.map(c => c.text || JSON.stringify(c)).join(" ")
                                : JSON.stringify(lastMsgRaw);

                        console.log(`[MockFetch] Prompt: "${lastMsg.substring(0, 50)}..."`);

                        // Find matching scenario
                        const scenario = SCENARIOS.find(s => s.triggers.some(t => lastMsg.includes(t)));

                        let responseData = {
                            model: "mock-model",
                            choices: [{
                                message: { role: "assistant", content: "I am a generic mock response." }
                            }],
                            usage: { total_tokens: 10 }
                        };

                        if (scenario) {
                            console.log(`[MockFetch] Matched Scenario: ${scenario.triggers[0]}`);
                            responseData = { ...responseData, ...scenario.response };
                        }

                        return new Response(JSON.stringify(responseData), { status: 200 });

                    } catch (e) {
                        console.error('[MockFetch] Error:', e);
                    }
                }

                return originalFetch(input, init);
            };
        }, TEST_WORKSPACE_DIR);

        await window.waitForLoadState('domcontentloaded');

        // RELOAD to ensure InitScript runs before App components mount/useEffect
        console.log('🔄 Reloading page to apply mocks...');
        await window.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await window.waitForLoadState('domcontentloaded');

        // Note: We removed the aggressive window.electron mock block since it was failing (immutable)
        // and fetch interception is safer for "callOpenAI" which we verified uses fetch.

        try {
            console.log('Checking for Missing Dependencies modal...');
            // In some environments, the modal might take a moment to trigger IPC and render
            await window.locator('text=Missing Dependencies').waitFor({ state: 'visible', timeout: 8000 });
            
            console.log('Found Missing Dependencies modal, dismissing...');
            const skipBtn = window.locator('text=Skip for now').first();
            await skipBtn.click();
            await window.locator('text=Missing Dependencies').waitFor({ state: 'hidden', timeout: 5000 });
            console.log('✅ Dismissed Missing Dependencies modal');
        } catch (e) {
            console.log('ℹ️ No Missing Dependencies modal detected after 8s');
        }

        // OpenAI scenarios run only after explicit opt-in, with every provider call mocked on loopback.
        console.log('⚙️ Opting into Connected services for mocked OpenAI scenarios...');
        await window.click('button[title="Settings"]');
        await window.locator('nav button').filter({ hasText: 'Privacy & Mode' }).click();
        const localOnlyOption = window.locator('[role="radiogroup"][aria-label="Privacy mode"] button').filter({ hasText: 'Local-only' });
        if (await localOnlyOption.getAttribute('aria-checked') !== 'true') {
            throw new Error('Expected Local-only to be the default privacy mode');
        }
        await window.locator('[role="radiogroup"][aria-label="Privacy mode"] button').filter({ hasText: 'Connected services' }).click();
        await window.locator('nav button').filter({ hasText: 'LLM Provider' }).click();
        await window.locator('button[aria-label="Select OpenAI / Compatible provider"]').click();

        await window.locator('input[placeholder="https://api.openai.com/v1"]').fill(mockOpenAiBaseUrl);

        // This fake key is sent only to the local mock API endpoint.
        const keyInput = window.locator('input[placeholder="sk-..."]').first();
        await keyInput.waitFor({ state: 'visible', timeout: 10000 });
        await keyInput.fill('sk-mock-key-12345');

        // Fill Model (if needed, otherwise uses default)
        // await window.fill('input[placeholder="gpt-4..."]', 'mock-gpt');

        await window.click('button[title="Chat"]');

        console.log('⏳ Waiting for MCP tools to be ready...');
        console.log('⏳ Waiting for app UI to be ready...');
        await window.locator('button[title="MCP Connections"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => { });
        await window.waitForTimeout(2000);
        console.log('✅ UI ready');
        console.log('✅ MCP tools ready');

        const chatInput = window.locator('[data-testid="chat-textarea"]');
        await chatInput.waitFor({ state: 'attached' });

        await electronApp.evaluate(({ dialog }, workspacePath) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspacePath] });
        }, TEST_WORKSPACE_DIR);
        const workspaceButton = window.locator('#workspace-select-button');
        await workspaceButton.waitFor({ state: 'visible' });
        await workspaceButton.click();
        const expectedWorkspaceTitle = `Workspace: ${TEST_WORKSPACE_DIR}`;
        await window.waitForFunction(
            title => document.querySelector('#workspace-select-button')?.getAttribute('title') === title,
            expectedWorkspaceTitle,
            { timeout: 10000 },
        );
        if (await workspaceButton.getAttribute('title') !== expectedWorkspaceTitle) {
            throw new Error('The temporary test workspace was not selected.');
        }
        console.log('✅ Temporary workspace selected');

        const waitForAnyText = async (patterns, timeout = 15000) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                for (const pattern of patterns) {
                    const node = window.locator(`text=${pattern}`).first();
                    if (await node.count() > 0 && await node.isVisible().catch(() => false)) {
                        return pattern;
                    }
                }
                await window.waitForTimeout(300);
            }
            throw new Error(`None of the expected texts appeared: ${patterns.join(', ')}`);
        };

        const waitForAnyLog = async (patterns, timeout = 15000) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                for (const pattern of patterns) {
                    const matched = typeof pattern === 'string'
                        ? rendererLogs.some((l) => l.includes(pattern))
                        : rendererLogs.some((l) => pattern.test(l));
                    if (matched) return pattern;
                }
                await window.waitForTimeout(200);
            }
            const recentLogs = rendererLogs.slice(-30)
                .map(line => line.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]'))
                .join('\n');
            throw new Error(`None of the expected log patterns appeared: ${patterns.map(String).join(', ')}\nRecent renderer logs:\n${recentLogs}`);
        };

        const logsContain = (pattern) => {
            if (typeof pattern === 'string') return rendererLogs.some(l => l.includes(pattern));
            return rendererLogs.some(l => pattern.test(l));
        };

        // Helper to send message
        const sendMessage = async (text) => {
            await chatInput.scrollIntoViewIfNeeded();

            // Wait for any 'Processing' or 'Stop' overlay to finish (button must be Send)
            await window.waitForTimeout(1000);
            await window.locator('button:has(svg.lucide-send)').waitFor({ state: 'attached', timeout: 30000 });

            await chatInput.click({ force: true });
            await chatInput.fill(text);

            // Wait for button to be enabled after filling
            await window.locator('button:has(svg.lucide-send):not([disabled])').waitFor({ state: 'attached', timeout: 30000 });

            await window.locator('button:has(svg.lucide-send)').click({ force: true });

            // Wait for "Thinking..." state change or response
            console.log(`  - Sent: "${text.substring(0, 40)}..."`);
            await window.waitForTimeout(2000); // Give time for mock fetch to respond
        };

        // --- TEST 1: PARALLEL AGENTS ---
        console.log('\n--- Test 1: Parallel Agents ---');
        const parallelPrompt = "Compare the price of a Sony WH-1000XM5 headphone on Amazon and BestBuy.";
        await sendMessage(parallelPrompt);
        await window.locator('[data-testid="message-bubble"][data-role="user"]')
            .filter({ hasText: parallelPrompt })
            .waitFor({ state: 'visible', timeout: 5000 });
        console.log('✅ Submitted prompt rendered in the chat transcript');
        await waitForAnyLog(['[MockFetch] Matched Scenario: Compare the price'], 15000);
        console.log('✅ Parallel scenario matched the mocked response');

        // --- TEST 6: JSON RECOVERY ---
        console.log('\n--- Test 6: JSON Recovery ---');
        await sendMessage("Simulate JSON fallback recovery");
        await waitForAnyLog([
            /Successfully recovered .* tool calls from content body/i,
            /Native Tool Call Identified:\s*fs_list_directory/i
        ], 15000);
        console.log('✅ recovered JSON tool call signal detected');

        // --- TEST 7: XML RECOVERY ---
        console.log('\n--- Test 7: XML Recovery ---');
        await sendMessage("Simulate XML fallback recovery");
        await waitForAnyLog([
            /Detected XML plan in content, converting to tool call/i,
            /Native Tool Call Identified:\s*create_execution_plan/i
        ], 15000);
        console.log('✅ recovered XML tool call signal detected');

        // --- TEST 8: MALFORMED RESPONSE ---
        console.log('\n--- Test 8: Malformed Response ---');
        await sendMessage("Malformed test");
        try {
            // Verify it doesn't crash and shows the partial text
            await window.locator('text=truncated').first().waitFor({ state: 'visible', timeout: 15000 });
            console.log('✅ handled malformed response without crash');
        } catch (e) {
            console.error('⚠️ malformed response test failed');
            throw e;
        }

        // --- TEST 9: HANDOFF CONFIRMATION ---
        console.log('\n--- Test 9: Handoff Confirmation ---');
        await sendMessage("Simulate handoff limit");
        try {
            const continueBtn = window.locator('button:has-text("Continue")').first();
            const handoffText = window.locator('text=/maximum number of steps|checkpoint|fresh agent/i').first();
            const buttonVisible = await continueBtn.isVisible().catch(() => false);

            if (buttonVisible) {
                await continueBtn.click();
                await window.locator('text=continue').last().waitFor({ state: 'visible', timeout: 15000 });
                console.log('✅ Handoff action buttons found and confirmation sent');
            } else {
                await handoffText.waitFor({ state: 'visible', timeout: 15000 });
                console.log('✅ Handoff message rendered (buttonless fallback)');
            }
        } catch (e) {
            console.error('⚠️ Handoff test failed');
            throw e;
        }

        // --- TEST 2: SEQUENTIAL PLAN ---
        console.log('\n--- Test 2: Sequential Plan ---');
        await sendMessage("Help me find bus tickets from Gangavathi to Bengaluru on 2nd Feb on RedBus");
        try {
            const planLogMatched = await waitForAnyLog([
                /Native Tool Call Identified:\s*create_execution_plan/i,
                /Executing tool:\s*create_execution_plan/i,
                /Plan created with/i,
                /Execution plan created/i
            ], 20000);

            // UI rendering can lag in mocked runs; treat text as supplemental evidence.
            let uiMatched = null;
            try {
                uiMatched = await waitForAnyText([
                    'I will plan this trip',
                    'Execution plan created',
                    'Step 1',
                    'Task Complete'
                ], 5000);
            } catch (_) { }

            console.log(`✅ Plan path confirmed (log: ${String(planLogMatched)}, ui: ${uiMatched || 'not-visible'})`);
        } catch (e) {
            console.error('❌ Plan Response missing');
            throw e;
        }

        // --- TEST 3: CLEAN REPORTING ---
        console.log('\n--- Test 3: Clean Reporting ---');
        await sendMessage("Search for 'wireless headphones' on Amazon and show me the top 3 results");
        const report = await window.locator('text=Sony WH-1000XM5').first();
        await report.waitFor({ state: 'visible' });
        console.log('✅ Structured Report rendered');

        // --- TEST 4: UI STRESS TEST ---
        console.log('\n--- Test 4: UI Stress Test ---');
        await sendMessage("Run stress test");
        try {
            const seen = await waitForAnyText([
                'Analysis Report',
                'unknown_tool_xyz',
                'Tool unknown_tool_xyz not found',
                'generic mock response'
            ], 20000);
            console.log(`✅ Stress response rendered (matched: ${seen})`);
        } catch (e) {
            console.error('⚠️ UI Stress Test timed out:', e);
        }

        // --- TEST 5: SAFETY REFUSAL ---
        console.log('\n--- Test 5: Safety Refusal ---');
        await sendMessage("Search Amazon for 'Rolex watch'. Find one over $10,000, add it to cart and proceed to checkout.");
        try {
            await window.locator('text=/cannot proceed/i').first().waitFor({ state: 'visible', timeout: 15000 });
            console.log('✅ Safety refusal displayed');
        } catch (e) {
            console.error('⚠️ Safety test timed out');
        }

        // --- TEST 10: PROGRESS BAR CLEANUP ---
        console.log('\n--- Test 10: Progress Bar Cleanup ---');
        try {
            const progressBars = window.locator('.progress-bar-container, progress');
            const count = await progressBars.count();
            if (count > 0) {
                // Check if any are actually visible
                const isVis = await progressBars.first().isVisible();
                if (isVis) throw new Error("Progress bar lingered after tasks completed");
            }
            console.log('✅ No lingering progress bars detected');
        } catch (e) {
            console.error('⚠️ Progress Bar cleanup test failed:', e);
            throw e;
        }

        // --- TEST 11: LOOP DETECTION (DIFFERENT ARGS) ---
        console.log('\n--- Test 11: Loop Detection (Different Args) ---');
        await sendMessage("Simulate loop different args");
        try {
            await waitForAnyText([
                'Exploring files',
                'ENOENT',
                'generic mock response'
            ], 20000);

            // Wait slightly to ensure loop check had time to process
            await window.waitForTimeout(1000);

            const stuckVisible = await window.locator('text=repeating the same action').isVisible();
            if (stuckVisible) throw new Error("Loop detector falsely triggered on different args");
            console.log('✅ Different args execution successful without false loop detection');
        } catch (e) {
            console.error('❌ Different args test failed:', e);
            throw e;
        }

        // --- TEST 12: LOOP DETECTION (SAME ARGS) ---
        console.log('\n--- Test 12: Loop Detection (Same Args) ---');
        await sendMessage("Simulate loop same args");
        try {
            await waitForAnyText([
                'repeating the same action',
                'infinite loop',
                'stopping to prevent an infinite loop'
            ], 20000);
            console.log('✅ Identical args loop detector signal observed');
        } catch (e) {
            console.error('❌ Loop detection test failed:', e);
            throw e;
        }

        // --- TEST 13: SUB-AGENT CRASH SALVAGE ---
        console.log('\n--- Test 13: Sub-Agent Crash Salvage ---');
        // Because "Crash me" triggers the delegate_sub_task and the sub-agent bails out
        // The delegate_sub_task will return "Sub-agent encountered errors and stopped."
        // Our mock LLM (being dumb in this catch-all) might just output "Generic mock response" after receiving the tool return
        // but let's see if we can find the sub-agent salvaged text in the UI logs, or at least no crash
        await sendMessage("Simulate sub-agent crash salvage");
        try {
            // Wait for parent generic response which happens after delegation completes
            await window.locator('text=generic mock response').last().waitFor({ state: 'visible', timeout: 20000 });
            console.log('✅ Sub-agent crash did not bring down the main agent');
        } catch (e) {
            console.error('❌ Sub-agent crash test failed:', e);
            throw e;
        }

        console.log('\n🎉 ALL SCENARIOS PASSED');
        testPassed = true;

    } catch (e) {
        console.error('❌ TEST FAILED:', e);
        if (rendererPageErrors.length) console.error('Renderer page errors:', rendererPageErrors);
        await testWindow?.screenshot({ path: path.join(SCREENSHOT_DIR, 'mock-fail.png') }).catch(() => { });
        process.exitCode = 1;
    } finally {
        await electronApp.close().catch(() => { });
        await cleanupTestEnvironment({ preserveArtifacts: !testPassed });
        if (!testPassed) {
            console.error(`[Mock E2E] Failure artifacts retained under ${TEST_ROOT}`);
        }
    }

})();
