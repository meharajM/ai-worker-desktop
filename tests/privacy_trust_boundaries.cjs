const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')

function load(relativePath, mocks = {}, runtimeProcess = process) {
    const filename = path.resolve(__dirname, '..', relativePath)
    const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(filename).href))
    const code = ts.transpileModule(source, { fileName: filename, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const module = { exports: {} }
    const localRequire = createRequire(filename)
    vm.runInNewContext(code, {
        module, exports: module.exports,
        require: name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name),
        console: { log() {}, info() {}, warn() {}, error() {} }, process: runtimeProcess, setTimeout, clearTimeout,
        window: { dispatchEvent() {} }, Event: class {},
    }, { filename })
    return module.exports
}

async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-trust-'))
    let adapter
    try {
        const ReactUI = require('react')
        const serverList = [
            { id: 'memory', name: 'Personal notes', command: 'internal-memory', type: 'stdio', connected: false, tools: [], args: [] },
            { id: 'filesystem', name: 'Workspace files', command: 'internal-filesystem', type: 'stdio', connected: false, tools: [], args: [] },
            { id: 'invalid-memory', name: 'remote memory', command: 'internal-memory', url: 'https://example.com/mcp', type: 'stdio', connected: false, tools: [], args: [] },
            { id: 'custom', name: 'custom', command: 'npx', type: 'stdio', connected: false, tools: [], args: [] },
            { id: 'playwright', name: 'playwright', command: 'internal-playwright', type: 'stdio', connected: false, tools: [], args: [] },
        ]
        let uiPrivacyMode = 'local-only'
        const icons = Object.fromEntries(['Plus', 'Database', 'MessageCircle', 'CheckCircle', 'XCircle', 'Loader2'].map(name => [name, () => null]))
        const { ConnectionsPanel } = load('src/renderer/src/components/ConnectionsPanel.tsx', {
            'lucide-react': icons,
            '../stores/mcpStore': { useMcpStore: () => ({ servers: serverList }) },
            '../stores/chatStore': { useChatStore: { getState: () => ({ addMessage() {} }) } },
            '../stores/whatsappStore': { useWhatsAppStore: () => ({ connectionState: { status: 'disconnected' }, openDialog() {} }) },
            '../stores/settingsStore': { useSettingsStore: selector => selector({ privacyMode: uiPrivacyMode }) },
            './mcp/McpServerCard': { McpServerCard: ({ server, showManagementActions }) => ReactUI.createElement('div', { 'data-server': server.name, 'data-management': String(showManagementActions) }, server.name) },
            './mcp/McpServerForm': { McpServerForm: () => null },
        })
        const renderConnections = () => require('react-dom/server').renderToStaticMarkup(ReactUI.createElement(ConnectionsPanel))
        const connectionsHtml = renderConnections()
        assert.match(connectionsHtml, /Local services/)
        assert.match(connectionsHtml, /on-device memory and workspace file tools/)
        assert.match(connectionsHtml, /data-server="Personal notes" data-management="false"/)
        assert.match(connectionsHtml, /data-server="Workspace files" data-management="false"/)
        assert.doesNotMatch(connectionsHtml, /data-server="remote memory"/)
        assert.doesNotMatch(connectionsHtml, /data-server="(custom|playwright)"/)
        uiPrivacyMode = 'connected'
        const connectedHtml = renderConnections()
        assert.match(connectedHtml, /data-server="custom" data-management="true"/)
        assert.doesNotMatch(connectedHtml, /data-server="playwright"/)
        assert.match(connectedHtml, /connections-whatsapp-btn/)

        const { FileSystemService } = load('src/main/services/FileSystemService.ts', {
            electron: { app: { getPath: () => temp } },
        })
        const service = FileSystemService.getInstance()
        const target = path.join(temp, 'workspace', 'document.txt')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, 'original')
        const staged = await service.callTool('fs_write_file', {
            path: target, content: 'reviewed', workspacePath: path.dirname(target),
            _sessionId: 'legacy-auto-approval', _sessionAutoApprove: true,
        })
        assert.equal(staged.result.status, 'staged')
        assert.equal(fs.readFileSync(target, 'utf8'), 'original', 'session override must never write directly')
        await service.commitChange(staged.result.changeId)
        assert.equal(fs.readFileSync(target, 'utf8'), 'reviewed')
        const internal = path.join(temp, '.ai-worker', 'system-workspace', 'scope', 'tasks.json')
        assert.equal((await service.callTool('fs_write_file', { path: internal, workspacePath: temp, content: '{}' })).result.status, 'written_internal')

        let state
        let connectCount = 0
        const stored = [
            { id: 'legacy', name: 'legacy', command: 'npx', type: 'stdio', autoConnect: true, connected: true, tools: [{ name: 'cached', inputSchema: {} }] },
            { id: 'renamed-memory', name: 'Personal notes', command: 'internal-memory', type: 'stdio', autoConnect: false, connected: true, tools: [] },
            { id: 'renamed-filesystem', name: 'Workspace files', command: 'internal-filesystem', type: 'stdio', autoConnect: false, connected: true, tools: [] },
        ]
        const { useMcpStore } = load('src/renderer/src/stores/mcpStore.ts', {
            zustand: { create: () => factory => {
                const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
                state = factory(set, () => state)
                return { getState: () => state }
            } },
            '../lib/constants': { STORAGE_KEYS: { MCP_SERVERS: 'servers' } },
            '../lib/electron': {
                store: { get: async () => stored, set: async () => true },
                mcp: { connect: async () => { connectCount++; return { success: true } }, disconnect: async () => {}, listTools: async () => ({ tools: [{ name: 'explicit', description: '', inputSchema: {} }] }) },
            },
        })
        await state.initialize()
        assert.equal(connectCount, 0, 'startup ignores legacy autoConnect flags')
        assert.equal(state.servers.filter(server => server.command === 'internal-memory').length, 1, 'renamed built-in memory is retained without a duplicate')
        assert.equal(state.servers.filter(server => server.command === 'internal-filesystem').length, 1, 'renamed built-in filesystem is retained without a duplicate')
        assert.equal(state.getAllTools().length, 0, 'cached schemas cannot expose disconnected tools')
        assert.equal(state.findServerForTool('cached'), null)
        await state.addServer({ name: 'added', command: 'uvx', type: 'stdio', description: '' })
        await state.updateServer('legacy', { command: 'node' })
        await state.syncServers([{ name: 'cloud', command: 'npx', type: 'stdio', autoConnect: true }])
        assert.equal(connectCount, 0, 'add/update/cloud sync never connect')
        assert(state.servers.filter(s => s.name !== 'legacy').every(s => s.autoConnect === false))
        await useMcpStore.getState().connectServer('legacy')
        assert.equal(connectCount, 1, 'explicit connect remains available')
        assert.equal(state.getAllTools()[0].name, 'explicit')

        const handlers = new Map()
        let mode = 'local-only'
        let initializedMemory = 0
        const localTools = { listTools: () => ({ tools: [] }), callTool: async () => ({ result: 'local' }) }
        const { registerMcpHandlers, isMemoryConnected } = load('src/main/ipc/mcp.ts', {
            '../services/ExternalServiceTools': load('src/main/services/ExternalServiceTools.ts'),
            './trustedIpc': { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
            './store': { getStoredPrivacyMode: () => mode },
            '../services/memory/MemoryServiceFactory': { MemoryServiceFactory: { getCurrentBackend: () => 'server-memory' } },
            '../services/PlaywrightService': { PlaywrightService: { getInstance: () => ({ ...localTools, initialize: async () => {} }) } },
            '../services/MemoryService': { MemoryService: { getInstance: () => ({ ...localTools, initialize: async () => { initializedMemory++ } }) } },
            '../services/FileSystemService': { FileSystemService: { getInstance: () => localTools } },
            '../services/McpProcessManager': { McpProcessManager: { getInstance: () => ({ unregisterProcess() {} }) } },
        })
        registerMcpHandlers()
        const { registerMemoryHandlers } = load('src/main/ipc/memory.ts', {
            './trustedIpc': { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
            './mcp': { isMemoryConnected },
            '../services/MemoryService': { MemoryService: { getInstance: () => ({ getStats: async () => ({ entities: 0 }) }) } },
        })
        registerMemoryHandlers()
        assert.equal((await handlers.get('memory:get-stats')({})).success, false, 'opening settings cannot initialize disconnected memory')
        const { executeToolCall } = load('src/renderer/src/lib/mcp.ts', {
            '../stores/mcpStore': { useMcpStore: { getState: () => ({ findServerForTool: () => null }) } },
            './electron': { memory: { callTool() { throw new Error('implicit memory IPC forbidden') } } },
            '../stores/whatsappStore': { useWhatsAppStore: {} },
        })
        assert.match((await executeToolCall('memory_search', {})).error, /not found/)
        const connect = config => handlers.get('mcp:connect')({}, config)
        assert.equal(initializedMemory, 0)
        for (const config of [{ id: 'browser', type: 'stdio', command: 'internal' }, { id: 'custom', type: 'stdio', command: 'npx' }, { id: 'remote', type: 'sse', url: 'https://example.com/mcp' }]) {
            assert.equal((await connect(config)).success, false)
        }
        assert.equal((await connect({ id: 'local-files', type: 'stdio', command: 'internal-filesystem' })).success, true)
        assert.equal((await connect({ id: 'playwright-named-memory', type: 'stdio', command: 'internal-memory' })).success, true)
        assert.equal(initializedMemory, 1)
        assert.equal((await handlers.get('memory:get-stats')({})).success, true)
        mode = 'connected'
        assert.equal((await connect({ id: 'browser', type: 'stdio', command: 'internal' })).success, true)
        mode = 'local-only'
        assert.match((await handlers.get('mcp:call-tool')({}, 'browser', 'navigate', {})).error, /connected mode/)
        assert.match((await handlers.get('mcp:list-tools')({}, 'browser')).error, /connected mode/)
        assert.equal((await handlers.get('mcp:call-tool')({}, 'local-files', 'fs_read_file', {})).error, undefined)

        let whatsappConnects = 0
        const { registerWhatsAppHandlers } = load('src/main/ipc/whatsapp.ts', {
            electron: { BrowserWindow: { getAllWindows: () => [] } },
            './trustedIpc': { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
            './store': { getStoredPrivacyMode: () => mode },
            '../services/WhatsAppService': { whatsappService: { on() {}, init() { throw new Error('startup init forbidden') }, connect: async () => { whatsappConnects++ } } },
        })
        registerWhatsAppHandlers()
        assert.equal(whatsappConnects, 0)
        assert.equal((await handlers.get('whatsapp:connect')({}, '1234567890')).success, false)
        mode = 'connected'
        assert.equal((await handlers.get('whatsapp:connect')({}, '1234567890')).success, true)
        assert.equal(whatsappConnects, 1)

        let speechDownloads = 0
        const { registerSpeechHandlers } = load('src/main/ipc/speech.ts', {
            './trustedIpc': { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
            '@electron-toolkit/utils': { is: { dev: true } },
            '../services/ModelManager': { ModelManager: class {
                async checkSupport() { return { modelDownloaded: true, nativeSupport: true } }
                async downloadModel() { speechDownloads++; return { success: true } }
            } },
        })
        registerSpeechHandlers()
        assert.equal((await handlers.get('speech:check-support')({}, 'vosk-model-small-en-us-0.15')).supported, false)
        assert.equal((await handlers.get('speech:download-model')({}, {
            modelId: 'en-us', modelName: 'vosk-model-small-en-us-0.15',
            url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
        })).success, false)
        assert.equal(speechDownloads, 0)
        const { useSpeechRecognition } = load('src/renderer/src/hooks/useSpeechRecognition.ts', {
            react: { useState: value => [value, () => {}], useCallback: fn => fn, useRef: value => ({ current: value }), useEffect() {} },
            '../lib/constants': { VOICE_CONFIG: {} },
            '../stores/settingsStore': { useSettingsStore: () => ({}) },
            '../lib/electron': { isElectron: () => true },
            '../lib/vosk': { voskService: {} },
            '../stores/logStore': { useLogStore: () => ({ addLog() {} }) },
            '../stores/chatStore': { useChatStore: {} },
        })
        const speech = useSpeechRecognition()
        assert.equal(speech.isSupported, false)
        assert.equal(speech.isNativeSupported, false)
        await speech.startListening() // Must return before touching downloads, microphone, or Web Speech.
        const React = require('react')
        const { VoiceButton } = load('src/renderer/src/components/input/VoiceButton.tsx', {
            '../primitives/Button': { Button: ({ children, ...props }) => React.createElement('button', props, children) },
        })
        const micHtml = require('react-dom/server').renderToStaticMarkup(React.createElement(VoiceButton, {
            sttSupported: false, unavailableReason: speech.unavailableReason,
            isListening: false, isInitializing: false, isFirstSetup: false, onClick() {},
        }))
        assert.match(micHtml, /disabled=""/)
        assert.match(micHtml, /aria-describedby=/)
        assert.match(micHtml.replace(/<[^>]*>/g, ''), /unavailable under the secure runtime/)

        // Real local MCP process: no package runner, downloads, or network setup.
        const memoryProcess = { ...process, execPath: require('electron') }
        const { ServerMemoryAdapter } = load('src/main/services/memory/adapters/ServerMemoryAdapter.ts', {}, memoryProcess)
        const memoryPath = path.join(temp, 'memory', 'memory.jsonl')
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
        const existing = JSON.stringify({ type: 'entity', name: 'Existing', entityType: 'test', observations: ['preserved'] }) + '\n'
        fs.writeFileSync(memoryPath, existing)
        adapter = new ServerMemoryAdapter({ storagePath: path.dirname(memoryPath) })
        await adapter.initialize()
        assert.equal(fs.readFileSync(memoryPath, 'utf8'), existing, 'initialization preserves existing memory bytes')
        assert((await adapter.search({ query: 'Existing' })).length > 0)
        await adapter.shutdown()
        adapter = null
        // Mirror electron-builder's unpacked layout and launch that exact entry.
        const runtimePackages = ['@modelcontextprotocol/server-memory', '@modelcontextprotocol/sdk', 'zod', 'zod-to-json-schema', 'ajv', 'ajv-formats', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse']
        const unpacked = path.join(temp, 'app.asar.unpacked', 'node_modules')
        const { build } = require('../package.json')
        for (const name of runtimePackages) {
            assert(build.asarUnpack.includes(`node_modules/${name}/**/*`), `${name} must ship unpacked`)
            fs.cpSync(path.resolve(__dirname, '..', 'node_modules', name), path.join(unpacked, name), { recursive: true })
        }
        const packedEntry = path.join(temp, 'app.asar', 'node_modules', '@modelcontextprotocol/server-memory/dist/index.js')
        const { ServerMemoryAdapter: PackagedAdapter } = load('src/main/services/memory/adapters/ServerMemoryAdapter.ts', {
            module: { createRequire: () => ({ resolve: () => packedEntry }) },
        }, memoryProcess)
        const legacyPath = path.join(temp, 'packaged-memory', 'memory.json')
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
        fs.writeFileSync(legacyPath, existing)
        adapter = new PackagedAdapter({ storagePath: path.dirname(legacyPath) })
        await adapter.initialize()
        assert.equal(fs.readFileSync(legacyPath, 'utf8'), existing)
        assert.equal(fs.existsSync(path.join(path.dirname(legacyPath), 'memory.jsonl')), false, 'legacy file must not be migrated')
        assert((await adapter.search({ query: 'Existing' })).length > 0)
        await adapter.shutdown()
        adapter = null
        const { ServerMemoryAdapter: MissingAdapter } = load('src/main/services/memory/adapters/ServerMemoryAdapter.ts', {
            module: { createRequire: () => ({ resolve: () => { throw new Error('missing') } }) },
        })
        await assert.rejects(new MissingAdapter({ storagePath: temp }).initialize(), /Local memory runtime is missing/)
        console.log('Privacy trust boundaries passed: staged writes, explicit MCP/WhatsApp, local memory dev/packaged runtime, preserved data, unavailable speech with accessible explanation.')
    } finally {
        if (adapter) await adapter.shutdown()
        fs.rmSync(temp, { recursive: true, force: true })
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
