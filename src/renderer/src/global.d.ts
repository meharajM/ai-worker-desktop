// Global type declarations for AI-Worker
// This file ensures TypeScript recognizes window.electron

// Electron API type (matches preload/index.ts)
export interface ElectronAPI {
    externalTask: import('../../shared/external-task').ExternalTaskAPI
    platform: string

    mcp: {
        searchRegistry: (search: string) => Promise<{
            success: boolean
            error?: string
            servers?: Array<{
                name: string
                description: string
                version: string
                repositoryUrl?: string
                requirements: string[]
                configuration?: {
                    type: 'stdio' | 'sse' | 'http'
                    command?: string
                    args?: string[]
                    url?: string
                }
            }>
        }>
        connect: (serverConfig: unknown) => Promise<{ success: boolean; serverId?: string; error?: string }>
        disconnect: (serverId: string) => Promise<{ success: boolean }>
        listTools: (serverId: string) => Promise<{ tools: Array<{ name: string; description: string }> }>
        callTool: (serverId: string, toolName: string, args: unknown) => Promise<{ result: unknown }>
    }

    llm: {
        chat: (messages: unknown[], tools?: unknown[]) => Promise<unknown>
        getProviders: () => Promise<Record<string, { available: boolean }>>
        fetchOpenAIModels: (baseUrl: string, apiKey: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
        fetchAnthropicModels: (apiKey: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
        anthropicChat: (requestId: string, apiKey: string, body: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }>
        cancelAnthropicChat: (requestId: string) => Promise<{ success: boolean }>
        fetchOllamaModels: (baseUrl: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
        fetchOllamaModelCapabilities: (baseUrl: string, model: string, localOnly: boolean) => Promise<{ success: boolean; capabilities?: string[]; error?: string }>
    }

    store: {
        get: (key: string) => Promise<unknown>
        set: (key: string, value: unknown) => Promise<boolean>
        delete: (key: string) => Promise<boolean>
    }

    mcpBridge: {
        publishModelStatus: (status: { model: import('../../shared/external-task').LocalTaskModel | null }) => Promise<boolean>
        onAskLocal: (callback: (request: { requestId: string; prompt: string }) => void) => () => void
        answerLocal: (reply: {
            requestId: string
            success: boolean
            content?: string
            provider?: string
            model?: string
            error?: string
        }) => Promise<boolean>
    }

    shell: {
        openExternal: (url: string) => Promise<void>
    }

    app: {
        getVersion: () => Promise<string>
        getName: () => Promise<string>
        getHomePath: () => Promise<string>
        selectFolder: () => Promise<string | null>
        getMissingDependencies: () => Promise<any[]>
        getAllDependencies: () => Promise<any[]>
        runSetupScript: () => Promise<void>
    }

    speech: {
        checkSupport: (modelId?: string) => Promise<{
            supported: boolean
            modelDownloaded: boolean
            modelsPath: string
            error: string | null
        }>
        initialize: (options?: { modelName?: string }) => Promise<{ success: boolean; error?: string }>
        startListening: () => Promise<{ success: boolean; error?: string; message?: string }>
        stopListening: () => Promise<{ success: boolean; error?: string; message?: string }>
        processAudio: (audioData: ArrayBuffer) => Promise<{
            success: boolean
            isFinal?: boolean
            transcript?: string
            error?: string
        }>
        getFinalResult: () => Promise<{ success: boolean; transcript?: string; error?: string }>
        downloadModel: (options: { modelId: string; url: string; modelName: string }) => Promise<{
            success: boolean
            error?: string
        }>
        getPreferredModel: () => Promise<{ id: string; name: string; url: string; lang: string }>
        getModelPath: (modelName: string) => Promise<string | null>
        getStatus: (modelId?: string) => Promise<{
            isInitialized: boolean
            isListening: boolean
            error: string | null
            modelsPath: string
            modelDownloaded: boolean
        }>
        cleanup: () => Promise<{ success: boolean; error?: string }>
        onResult: (callback: (result: { text: string; final: boolean }) => void) => () => void
        onDownloadProgress: (callback: (data: { modelId: string; progress: number }) => void) => () => void
    }

    clipboard: {
        readFilePaths: () => string[]
    }

    utils: {
        getPathForFile: (file: File) => string
    }
}

// Extend the Window interface globally
declare global {
    interface Window {
        electron?: import('./env').DesktopElectronAPI
        externalTask?: import('../../shared/external-task').ExternalTaskApprovalAPI
        SpeechRecognition?: typeof SpeechRecognition
        webkitSpeechRecognition?: typeof SpeechRecognition
    }
}

export { }
