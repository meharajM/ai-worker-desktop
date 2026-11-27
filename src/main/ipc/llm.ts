import { ipcMain } from './trustedIpc'
import { getStoredPrivacyMode } from './store'

const anthropicRequests = new Map<string, AbortController>()

export function registerLlmHandlers(): void {
    // LLM operations (placeholder - renderer handles this via fetch for now)
    ipcMain.handle('llm:chat', async (_event, messages, tools) => {
        console.log('LLM chat requested via IPC:', { messageCount: messages?.length, toolCount: tools?.length })
        return { error: 'Main process LLM not implemented yet. Use renderer LLM.' }
    })

    ipcMain.handle('llm:get-providers', async () => {
        return {
            ollama: { available: false },
            openai: { available: false },
            browser: { available: false },
        }
    })

    // Fetch OpenAI models from main process (bypasses CORS)
    ipcMain.handle('llm:fetch-openai-models', async (_event, baseUrl: string, apiKey: string) => {
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                },
            })

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            const data = await response.json()
            // Filter models that support chat completions
            const models = (data.data || [])
                .filter((m: { id: string }) => {
                    const id = m.id.toLowerCase()
                    // Include GPT models and other chat models
                    return id.includes('gpt') || id.includes('chat') || id.includes('claude') || id.includes('llama') || id.includes('perplexity')
                })
                .map((m: { id: string }) => m.id)
                .sort()

            return { success: true, models }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                models: []
            }
        }
    })

    ipcMain.handle('llm:fetch-anthropic-models', async (_event, apiKey: string) => {
        try {
            if (getStoredPrivacyMode() !== 'connected') throw new Error('Enable connected mode before contacting Anthropic.')
            if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 4096) {
                throw new Error('Invalid Anthropic API key')
            }
            const response = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2026-10-21',
                },
                redirect: 'error',
                signal: AbortSignal.timeout(8000),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) {
                throw new Error(data?.error?.message || `HTTP ${response.status}: ${response.statusText}`)
            }
            const models = Array.isArray(data.data)
                ? data.data.map((model: { id?: unknown }) => model.id).filter((id: unknown): id is string => typeof id === 'string').sort()
                : []
            return { success: true, models }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Could not fetch Anthropic models',
                models: [],
            }
        }
    })

    ipcMain.handle('llm:anthropic-chat', async (_event, requestId: string, apiKey: string, body: unknown) => {
        if (getStoredPrivacyMode() !== 'connected') return { success: false, error: 'Enable connected mode before contacting Anthropic.' }
        if (typeof requestId !== 'string' || requestId.length > 100 || !requestId) return { success: false, error: 'Invalid Anthropic request id' }
        if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 4096) return { success: false, error: 'Invalid Anthropic API key' }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { success: false, error: 'Invalid Anthropic request body' }
        const payload = body as Record<string, unknown>
        const serialized = JSON.stringify(payload)
        if (serialized.length > 15_000_000 || !Array.isArray(payload.messages) || payload.messages.length > 300 || typeof payload.model !== 'string') {
            return { success: false, error: 'Anthropic request is too large or malformed' }
        }
        if (anthropicRequests.has(requestId)) return { success: false, error: 'Duplicate Anthropic request id' }

        const controller = new AbortController()
        anthropicRequests.set(requestId, controller)
        const timeout = setTimeout(() => controller.abort(), 90_000)
        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2026-10-21',
                },
                body: serialized,
                redirect: 'error',
                signal: controller.signal,
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) return { success: false, error: data?.error?.message || `Anthropic error (${response.status}): ${response.statusText}` }
            return { success: true, data }
        } catch (error) {
            return {
                success: false,
                error: controller.signal.aborted
                    ? 'Anthropic request cancelled or timed out.'
                    : error instanceof Error ? error.message : 'Anthropic request failed',
            }
        } finally {
            clearTimeout(timeout)
            anthropicRequests.delete(requestId)
        }
    })

    ipcMain.handle('llm:anthropic-cancel', async (_event, requestId: string) => {
        anthropicRequests.get(requestId)?.abort()
        return { success: true }
    })

    // Fetch Ollama models from main process (bypasses potential CORS issues)
    ipcMain.handle('llm:fetch-ollama-models', async (_event, baseUrl: string) => {
        try {
            const response = await fetch(`${baseUrl}/api/tags`, {
                method: 'GET',
            })

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            const data = await response.json()
            const models = (data.models || []).map((m: { name: string }) => m.name)

            return { success: true, models }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Ollama not running',
                models: []
            }
        }
    })

    ipcMain.handle('llm:fetch-ollama-model-capabilities', async (_event, baseUrl: string, model: string, localOnly = false) => {
        try {
            if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || typeof model !== 'string' || model.length > 256) {
                throw new Error('Invalid Ollama model request')
            }
            const url = new URL(baseUrl)
            const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (localOnly && !loopback)) {
                throw new Error('Local-only mode requires an Ollama URL on localhost, 127.0.0.1, or [::1].')
            }

            const response = await fetch(`${url.href.replace(/\/$/, '')}/api/show`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({ model }),
            })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`)

            return {
                success: true,
                capabilities: Array.isArray(result.capabilities) ? result.capabilities : [],
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Could not inspect Ollama model capabilities',
                capabilities: [],
            }
        }
    })
}
