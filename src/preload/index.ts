import { contextBridge, ipcRenderer } from 'electron'

// IPC channels for main process communication
import type { ExternalTaskAPI, ExternalTaskApprovalAPI, TaskView } from '../shared/external-task'

const externalTaskApproval: ExternalTaskApprovalAPI = {
    chooseWorkspace: (id, step) => ipcRenderer.invoke('external-task:choose-workspace', id, step),
    current: () => ipcRenderer.invoke('external-task:current'),
    modelStatus: () => ipcRenderer.invoke('external-task:model-status'),
    onChange: callback => {
        const listener = (_event: Electron.IpcRendererEvent, view: TaskView | null) => callback(view)
        ipcRenderer.on('external-task:changed', listener)
        return () => ipcRenderer.removeListener('external-task:changed', listener)
    },
    decide: (id, step, value) => ipcRenderer.invoke('external-task:decide', id, step, value),
    cancel: id => ipcRenderer.invoke('external-task:cancel', id),
}

const externalTask: ExternalTaskAPI = {
    ...externalTaskApproval,
    onPlannerChange: callback => {
        const listener = (_event: Electron.IpcRendererEvent, view: TaskView | null) => callback(view)
        ipcRenderer.on('external-task:planner-changed', listener)
        return () => ipcRenderer.removeListener('external-task:planner-changed', listener)
    },
    modelReply: (id, step, result) => ipcRenderer.invoke('external-task:model-reply', id, step, result),
}

const electronAPI = {
    externalTask,
    // Platform info
    platform: process.platform,

    // MCP Server operations
    mcp: {
        searchRegistry: (search: string) => ipcRenderer.invoke('mcp:registry-search', search),
        connect: (serverConfig: unknown) => ipcRenderer.invoke('mcp:connect', serverConfig),
        disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
        listTools: (serverId: string) => ipcRenderer.invoke('mcp:list-tools', serverId),
        callTool: (serverId: string, toolName: string, args: unknown) =>
            ipcRenderer.invoke('mcp:call-tool', serverId, toolName, args),
    },

    // Playwright browser lifecycle
    playwright: {
        closeBrowser: () => ipcRenderer.invoke('playwright:close-browser'),
    },

    // LLM operations (for future main process LLM handling)
    llm: {
        chat: (messages: unknown[], tools?: unknown[]) =>
            ipcRenderer.invoke('llm:chat', messages, tools),
        getProviders: () => ipcRenderer.invoke('llm:get-providers'),
        fetchOpenAIModels: (baseUrl: string, apiKey: string) =>
            ipcRenderer.invoke('llm:fetch-openai-models', baseUrl, apiKey),
        fetchAnthropicModels: (apiKey: string) =>
            ipcRenderer.invoke('llm:fetch-anthropic-models', apiKey),
        anthropicChat: (requestId: string, apiKey: string, body: unknown) =>
            ipcRenderer.invoke('llm:anthropic-chat', requestId, apiKey, body),
        cancelAnthropicChat: (requestId: string) =>
            ipcRenderer.invoke('llm:anthropic-cancel', requestId),
        fetchOllamaModels: (baseUrl: string) =>
            ipcRenderer.invoke('llm:fetch-ollama-models', baseUrl),
        fetchOllamaModelCapabilities: (baseUrl: string, model: string, localOnly: boolean) =>
            ipcRenderer.invoke('llm:fetch-ollama-model-capabilities', baseUrl, model, localOnly),
    },

    // Storage operations (using electron-store in main process)
    store: {
        get: (key: string) => ipcRenderer.invoke('store:get', key),
        set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
        delete: (key: string) => ipcRenderer.invoke('store:delete', key),
    },

    // Narrow status publication and inference request path for local-only MCP use.
    mcpBridge: {
        publishModelStatus: (status: { model: import('../shared/external-task').LocalTaskModel | null }) =>
            ipcRenderer.invoke('mcp-bridge:publish-model-status', status),
        onAskLocal: (callback: (request: { requestId: string; prompt: string }) => void) => {
            const listener = (_event: any, request: unknown) => {
                if (!request || typeof request !== 'object') return
                const value = request as Record<string, unknown>
                if (typeof value.requestId !== 'string' || typeof value.prompt !== 'string') return
                callback({ requestId: value.requestId, prompt: value.prompt })
            }
            ipcRenderer.on('mcp-bridge:ask-local', listener)
            return () => ipcRenderer.removeListener('mcp-bridge:ask-local', listener)
        },
        answerLocal: (reply: {
            requestId: string
            success: boolean
            content?: string
            provider?: string
            model?: string
            error?: string
        }) => ipcRenderer.invoke('mcp-bridge:answer-local', reply),
    },

    // Shell operations
    shell: {
        openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    },

    // App info
    app: {
        getVersion: () => ipcRenderer.invoke('app:get-version'),
        getName: () => ipcRenderer.invoke('app:get-name'),
        getHomePath: () => ipcRenderer.invoke('app:get-home-path'),
        selectFolder: () => ipcRenderer.invoke('app:select-folder'),
        getMissingDependencies: () => ipcRenderer.invoke('app:get-missing-dependencies'),
        getAllDependencies: () => ipcRenderer.invoke('app:get-all-dependencies'),
        runSetupScript: () => ipcRenderer.invoke('app:run-setup-script'),
    },

    // Logging operations
    logs: {
        add: (entry: any) => ipcRenderer.invoke('logs:add', entry),
        getPath: () => ipcRenderer.invoke('logs:get-path'),
        openFolder: () => ipcRenderer.invoke('logs:open-folder'),
    },

    // Speech recognition operations (native Vosk-based)
    speech: {
        checkSupport: (modelId?: string) => ipcRenderer.invoke('speech:check-support', modelId),
        initialize: (options?: { modelId?: string }) =>
            ipcRenderer.invoke('speech:initialize', options),
        startListening: () => ipcRenderer.invoke('speech:start-listening'),
        stopListening: () => ipcRenderer.invoke('speech:stop-listening'),
        processAudio: (audioData: ArrayBuffer) =>
            ipcRenderer.send('speech:process-audio', audioData),
        downloadModel: (options: { modelId: string, url: string, modelName: string }) =>
            ipcRenderer.invoke('speech:download-model', options),
        getPreferredModel: () => ipcRenderer.invoke('speech:get-preferred-model'), // NEW
        getModelPath: (modelName: string) => ipcRenderer.invoke('speech:get-model-path', modelName),
        getStatus: (modelId?: string) => ipcRenderer.invoke('speech:get-status', modelId),
        cleanup: () => ipcRenderer.invoke('speech:cleanup'),
        onResult: (callback: (result: { text: string, final: boolean }) => void) => {
            const listener = (_event: any, result: { text: string, final: boolean }) => callback(result)
            ipcRenderer.on('speech:result', listener)
            return () => ipcRenderer.removeListener('speech:result', listener)
        },
        onDownloadProgress: (callback: (data: { modelId: string, progress: number }) => void) => {
            const listener = (_event: any, data: { modelId: string, progress: number }) => callback(data)
            ipcRenderer.on('speech:download-progress', listener)
            return () => ipcRenderer.removeListener('speech:download-progress', listener)
        },
    },
    // Secure storage operations (encrypted with OS keychain)
    secure: {
        isAvailable: () => ipcRenderer.invoke('secure:is-available'),
        set: (key: string, value: string, userId?: string) =>
            ipcRenderer.invoke('secure:set', key, value, userId),
        get: (key: string, userId?: string) =>
            ipcRenderer.invoke('secure:get', key, userId),
        delete: (key: string, userId?: string) =>
            ipcRenderer.invoke('secure:delete', key, userId),
        listKeys: (userId?: string) =>
            ipcRenderer.invoke('secure:list-keys', userId),
    },
    // Filesystem Safe Mode operations
    fs: {
        getPendingChanges: (sessionId?: string) => ipcRenderer.invoke('fs:get-pending-changes', sessionId),
        approveChange: (changeId: string) => ipcRenderer.invoke('fs:approve-change', changeId),
        rejectChange: (changeId: string) => ipcRenderer.invoke('fs:reject-change', changeId),
        writeInternalFile: (workspacePath: string | undefined, filename: string, content: string) =>
            ipcRenderer.invoke('fs:write-internal-file', workspacePath, filename, content),
        readInternalFile: (workspacePath: string | undefined, filename: string) =>
            ipcRenderer.invoke('fs:read-internal-file', workspacePath, filename),
        readFileBase64: (filePath: string) =>
            ipcRenderer.invoke('fs:read-file-base64', filePath)
    },
    // Memory operations
    memory: {
        runTests: () => ipcRenderer.invoke('memory:run-tests'),
        getStats: () => ipcRenderer.invoke('memory:get-stats'),
        exportAll: () => ipcRenderer.invoke('memory:export-all'),
        callTool: (name: string, args: any) => ipcRenderer.invoke('memory:call-tool', { name, args }),
        migrate: () => ipcRenderer.invoke('memory:migrate'),
        checkMigration: () => ipcRenderer.invoke('memory:check-migration'),
        openFileLocation: () => ipcRenderer.invoke('memory:open-file-location'),
    },
    // Antigravity OAuth operations temporarily disabled.
    // antigravity: {
    //     initialize: () => ipcRenderer.invoke('antigravity:initialize'),
    //     signIn: () => ipcRenderer.invoke('antigravity:sign-in'),
    //     getToken: () => ipcRenderer.invoke('antigravity:get-token'),
    //     signOut: () => ipcRenderer.invoke('antigravity:sign-out'),
    //     getStatus: () => ipcRenderer.invoke('antigravity:get-status'),
    //     callGateway: (url: string, headers: Record<string, string>, body: string) =>
    //         ipcRenderer.invoke('antigravity:call-gateway', url, headers, body),
    // },
    // Clipboard operations
    clipboard: {
        readFilePaths: () => {
            const { clipboard } = require('electron')
            const paths: string[] = []

            if (process.platform === 'darwin') {
                const fileUrl = clipboard.read('public.file-url')
                if (fileUrl) {
                    try {
                        // Decode URI and remove file:// prefix
                        const p = decodeURIComponent(fileUrl).replace(/^file:\/\//, '')
                        paths.push(p)
                    } catch (e) {
                        console.error('Error parsing file url from clipboard:', e)
                    }
                }
            } else {
                // Windows/Linux fallback or implementation
                // For now, on Windows, dragging generic files usually works via web API better than mac paste
                // We can add more robust logic later if needed
            }
            return paths
        }
    },
    // WhatsApp operations
    whatsapp: {
        getState: () => ipcRenderer.invoke('whatsapp:get-state'),
        connect: (phoneNumber?: string) => ipcRenderer.invoke('whatsapp:connect', phoneNumber),
        setTargetNumber: (phoneNumber: string) => ipcRenderer.invoke('whatsapp:set-target-number', phoneNumber),
        disconnect: (clearAuth?: boolean) => ipcRenderer.invoke('whatsapp:disconnect', clearAuth),
        sendMessage: (to: string, content: string) =>
            ipcRenderer.invoke('whatsapp:send-message', to, content),
        sendPresence: (to: string, state: string) =>
            ipcRenderer.invoke('whatsapp:send-presence', to, state),
        sendMediaMessage: (to: string, filePath: string, caption?: string, type?: string) =>
            ipcRenderer.invoke('whatsapp:send-media-message', to, filePath, caption, type),
        onConnectionChange: (callback: (state: unknown) => void) => {
            const listener = (_event: any, state: unknown) => callback(state)
            ipcRenderer.on('whatsapp:connection-change', listener)
            return () => ipcRenderer.removeListener('whatsapp:connection-change', listener)
        },
        onMessage: (callback: (message: unknown) => void) => {
            const listener = (_event: any, message: unknown) => callback(message)
            ipcRenderer.on('whatsapp:message', listener)
            return () => ipcRenderer.removeListener('whatsapp:message', listener)
        },
    },
    // General utils
    utils: {
        getPathForFile: (file: File): string => {
            const { webUtils } = require('electron')
            if (webUtils && webUtils.getPathForFile) {
                try {
                    const result = webUtils.getPathForFile(file)
                    // webUtils may return an empty string if it fails
                    if (result) return result
                } catch (e) {
                    console.error('webUtils.getPathForFile failed:', e)
                }
            }
            // Fallback to internal path property if webUtils isn't available
            return (file as any).path || ''
        }
    }
}

// Expose APIs to renderer
if (process.contextIsolated) {
    try {
        if (process.argv.includes('--ai-worker-task-window')) {
            contextBridge.exposeInMainWorld('externalTask', externalTaskApproval)
        } else {
            contextBridge.exposeInMainWorld('electron', electronAPI)
        }
    } catch (error) {
        console.error('Failed to expose electron API:', error)
    }
} else {
    // @ts-ignore (define in d.ts)
    window.electron = electronAPI
}

// Type declarations
export type ElectronAPI = typeof electronAPI
