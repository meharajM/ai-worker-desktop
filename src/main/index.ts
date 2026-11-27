import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initEnv, __dirname } from './utils/env'
import { setupIpcHandlers } from './ipc'
import { McpProcessManager } from './services/McpProcessManager'
import { trustRenderer, isTrustedRendererUrl } from './ipc/trustedIpc'
import { getExternalServiceChoices } from './ipc/mcp'
import { getStoredPrivacyMode } from './ipc/store'
import { cancelExternalTask, startLocalMcpBridge, stopLocalMcpBridge } from './services/LocalMcpBridge'
import { MemoryServiceFactory } from './services/memory/MemoryServiceFactory'

// Initialize environment (fix PATH, etc.)
initEnv()

// Force ws to use pure-JS fallbacks in packaged builds.
// In some bundled production paths, optional native peer deps (bufferutil /
// utf-8-validate) can resolve to interop stubs and crash at runtime
// ("bufferUtil$1.mask is not a function"). Disabling native fast-paths keeps
// connection logic stable across dev + installed universal builds.
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'

// PRODUCTION: Inject Google API Keys if available
// These are required for Web Speech API to work in built/packaged apps
// You must provide them via environment variables
if (process.env.GOOGLE_API_KEY) {
    process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY
}
if (process.env.GOOGLE_DEFAULT_CLIENT_ID) {
    process.env.GOOGLE_DEFAULT_CLIENT_ID = process.env.GOOGLE_DEFAULT_CLIENT_ID
}
if (process.env.GOOGLE_DEFAULT_CLIENT_SECRET) {
    process.env.GOOGLE_DEFAULT_CLIENT_SECRET = process.env.GOOGLE_DEFAULT_CLIENT_SECRET
}

let mainWindow: BrowserWindow | null = null
let taskWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let taskWindowReady = false
let taskWindowShouldShow = false

function rendererEntryUrl(rendererPath: string): string {
    if (!is.dev || !process.env['ELECTRON_RENDERER_URL']) return pathToFileURL(rendererPath).href
    const base = new URL(process.env['ELECTRON_RENDERER_URL'])
    base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
    return new URL(basename(rendererPath), base).href
}

function protectWindow(window: BrowserWindow, rendererPath: string, query?: Record<string, string>): void {
    const contents = window.webContents
    const rendererUrl = rendererEntryUrl(rendererPath)
    const route = new URL(rendererUrl)
    if (query) Object.entries(query).forEach(([key, value]) => route.searchParams.set(key, value))
    trustRenderer(contents, rendererUrl)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
        if (!isTrustedRendererUrl(contents, url)) event.preventDefault()
    })
    contents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame || !isTrustedRendererUrl(contents, event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
        if (!isTrustedRendererUrl(contents, url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) window.loadURL(route.href)
    else window.loadFile(rendererPath, { query })
}

function createWindow(): BrowserWindow {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    const window = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 15, y: 15 },
        backgroundColor: '#0f1115',
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            webviewTag: false,
        }
    })

    mainWindow = window
    window.on('ready-to-show', () => {
        window.show()
        if (is.dev) {
            window.webContents.openDevTools()
        }
    })
    const rendererPath = join(__dirname, '../renderer/index.html')
    protectWindow(window, rendererPath)
    window.on('close', event => {
        if (isQuitting) return
        event.preventDefault()
        window.hide()
        if (process.platform === 'darwin') app.dock?.hide()
    })
    window.on('closed', () => { if (mainWindow === window) mainWindow = null })
    return window
}

function createTaskWindow(): BrowserWindow {
    if (taskWindow && !taskWindow.isDestroyed()) return taskWindow
    taskWindowReady = false
    const window = new BrowserWindow({
        width: 480,
        height: 560,
        minWidth: 420,
        minHeight: 420,
        maxWidth: 560,
        maxHeight: 760,
        resizable: true,
        show: false,
        autoHideMenuBar: true,
        title: 'AI-Worker task approval',
        backgroundColor: '#0f1115',
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            additionalArguments: ['--ai-worker-task-window'],
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            webviewTag: false,
        }
    })
    taskWindow = window
    window.on('ready-to-show', () => {
        taskWindowReady = true
        if (taskWindowShouldShow) { window.show(); window.focus() }
    })
    window.on('close', event => {
        if (isQuitting) return
        event.preventDefault()
        cancelExternalTask('Task approval window closed.')
        hideTaskWindow()
    })
    window.on('closed', () => {
        if (taskWindow === window) taskWindow = null
        taskWindowReady = false
        taskWindowShouldShow = false
    })
    protectWindow(window, join(__dirname, '../renderer/index.html'), { window: 'task' })
    return window
}

function showHub(): void {
    const window = createWindow()
    if (process.platform === 'darwin') app.dock?.show()
    window.show()
    window.focus()
}

function showTaskWindow(): void {
    taskWindowShouldShow = true
    if (taskWindowReady && taskWindow && !taskWindow.isDestroyed()) {
        taskWindow.show()
        taskWindow.focus()
    }
}

function hideTaskWindow(): void {
    taskWindowShouldShow = false
    if (taskWindow && !taskWindow.isDestroyed()) taskWindow.hide()
}

function createTray(): void {
    const iconPath = app.isPackaged
        ? join(process.resourcesPath, 'tray-icon.png')
        : join(process.cwd(), 'build/icon.png')
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
    if (process.platform === 'darwin') icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('AI-Worker is running')
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show AI-Worker', click: showHub },
        { type: 'separator' },
        { label: 'Quit AI-Worker', click: () => app.quit() },
    ]))
    tray.on('click', showHub)
}

function configureAudioPermission(): void {
    const session = mainWindow!.webContents.session
    session.setPermissionCheckHandler((webContents, permission, _origin, details) => {
        return Boolean(webContents && BrowserWindow.fromWebContents(webContents) === mainWindow) && permission === 'media' &&
            details.mediaType === 'audio' && details.isMainFrame &&
            isTrustedRendererUrl(webContents, details.requestingUrl || '')
    })
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
        callback(Boolean(webContents && BrowserWindow.fromWebContents(webContents) === mainWindow) && permission === 'media' &&
            details.isMainFrame && isTrustedRendererUrl(webContents, details.requestingUrl) &&
            mediaTypes?.length === 1 && mediaTypes[0] === 'audio')
    })
}

function rendererLoaded(window: BrowserWindow): Promise<void> {
    if (window.webContents.getURL() && !window.webContents.isLoadingMainFrame()) return Promise.resolve()
    return new Promise(resolve => window.webContents.once('did-finish-load', () => resolve()))
}

async function runStandaloneMemoryVerification(): Promise<void> {
    let result: { results: string[]; passed: boolean }
    try {
        const backend = MemoryServiceFactory.getCurrentBackend()
        if (backend !== 'server-memory') {
            throw new Error(`Memory verification only runs against on-device server-memory. Configured backend: ${backend}.`)
        }
        const { MemoryTestRunner } = await import('./tests/MemoryTestRunner')
        result = await new MemoryTestRunner().runTests()
    } catch (error) {
        result = {
            results: [`❌ ${error instanceof Error ? error.message : String(error)}`],
            passed: false,
        }
    }

    process.exitCode = result.passed ? 0 : 1
    process.stdout.write(`AI_WORKER_MEMORY_VERIFICATION_RESULT=${JSON.stringify(result)}\n`, () => app.quit())
}

const isMemoryVerification = process.argv.includes('--ai-worker-run-memory-verification')
const hasSingleInstance = app.requestSingleInstanceLock()
if (!hasSingleInstance) {
    if (isMemoryVerification) {
        process.stdout.write(
            'AI_WORKER_MEMORY_VERIFICATION_RESULT={"results":["❌ AI-Worker is already running. Close it before running standalone memory verification."],"passed":false}\n',
            () => app.exit(1),
        )
    } else {
        app.quit()
    }
} else {
    app.on('second-instance', (_event, commandLine) => {
        if (!commandLine.includes('--ai-worker-run-memory-verification')) showHub()
    })
    app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.aiworker.app')

    if (isMemoryVerification) {
        await runStandaloneMemoryVerification()
        return
    }

    // Verify environment and paths
    setupIpcHandlers()

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })

    createWindow()
    createTaskWindow()
    configureAudioPermission()
    createTray()

    await Promise.all([rendererLoaded(mainWindow!), rendererLoaded(taskWindow!)])

    try {
        await startLocalMcpBridge({
            userDataDirectory: app.getPath('userData'),
            appVersion: app.getVersion(),
            getPrivacyMode: getStoredPrivacyMode,
            getServiceChoices: getExternalServiceChoices,
            getInferenceWindow: () => mainWindow,
            getPlannerWindow: () => mainWindow,
            getTaskWindow: () => taskWindow,
            showTaskWindow,
            hideTaskWindow,
        })
    } catch (error) {
        console.error('[Local MCP] Could not start local inference bridge:', error)
    }

    app.on('activate', showHub)
    })
}

app.on('before-quit', async (event) => {
    if (isQuitting) return
    
    // Prevent default quit, cleanup, then quit
    event.preventDefault()
    isQuitting = true

    await stopLocalMcpBridge()
    
    await McpProcessManager.getInstance().teardownAll()
    tray?.destroy()
    tray = null
    
    app.quit()
})
