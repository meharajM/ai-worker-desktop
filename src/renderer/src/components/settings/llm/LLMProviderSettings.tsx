/**
 * LLMProviderSettings — replaces the inline "LLM Provider" section in SettingsPanel.
 *
 * Owns:
 *  - Provider selector pill row
 *  - providerStatus state + checkProviders logic (moved out of SettingsPanel)
 *  - Renders the correct provider card(s) based on selection
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
    getAvailableProviders,
    checkOllama,
    checkOpenAI,
    checkAnthropic,
    checkGemini,
    checkOpenRouter,
    getWebLLMStatus,
    subscribeToWebLLMStatus,
    checkWebLLMModelCompatibility,
    checkDownloadedWebLLMModels,
    downloadWebLLMModelOnly,
    downloadBrowserModel,
    WEBLLM_MODELS,
} from '../../../lib/llm'
import { useSettingsStore, LLMProviderType } from '../../../stores/settingsStore'
import { OllamaSettings } from './OllamaSettings'
import { OpenAISettings } from './OpenAISettings'
import { AnthropicSettings } from './AnthropicSettings'
import { GeminiSettings } from './GeminiSettings'
import { ProviderCard } from './ProviderCard'
import { ModelSelect } from '../../ModelSelect'

interface SingleProviderStatus {
    available: boolean
    model?: string
    models?: string[]
    error?: string
    modelsEndpointAvailable?: boolean
}

interface ProviderStatusMap {
    ollama: SingleProviderStatus
    openai: SingleProviderStatus
    anthropic: SingleProviderStatus
    gemini: SingleProviderStatus
    openrouter: SingleProviderStatus
    browser?: SingleProviderStatus
}

const PROVIDERS: { id: LLMProviderType; label: string }[] = [
    { id: 'ollama', label: 'Ollama' },
    { id: 'openai', label: 'OpenAI / Compatible' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'gemini', label: 'Gemini' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'auto', label: 'Auto' },
    { id: 'browser', label: 'On-Device' },
]

export function LLMProviderSettings() {
    const settings = useSettingsStore()
    const [providerStatus, setProviderStatus] = useState<ProviderStatusMap | null>(null)
    const [checking, setChecking] = useState(false)
    const checkRef = useRef<Promise<void> | null>(null)
    const [browserStatus, setBrowserStatus] = useState(getWebLLMStatus)
    const [compatibility, setCompatibility] = useState<{ compatible: boolean; reasons: string[] } | null>(null)
    const [modelAction, setModelAction] = useState<'download' | 'load' | null>(null)
    const [modelError, setModelError] = useState<string | null>(null)

    useEffect(() => subscribeToWebLLMStatus(setBrowserStatus), [])
    useEffect(() => {
        let active = true
        setCompatibility(null)
        checkWebLLMModelCompatibility(settings.browserModel).then(result => {
            if (active) setCompatibility(result)
        }).catch(error => {
            if (active) setCompatibility({ compatible: false, reasons: [error instanceof Error ? error.message : 'Compatibility check failed'] })
        })
        return () => { active = false }
    }, [settings.browserModel, browserStatus.isSupported])

    async function prepareBrowserModel(action: 'download' | 'load') {
        setModelAction(action)
        setModelError(null)
        try {
            if (action === 'download') {
                await downloadWebLLMModelOnly(settings.browserModel)
                await checkDownloadedWebLLMModels()
                if (!getWebLLMStatus().downloadedModels.includes(settings.browserModel)) {
                    throw new Error(getWebLLMStatus().error || 'Download did not finish. Retry or choose a smaller model.')
                }
            } else {
                const result = await downloadBrowserModel(undefined, settings.browserModel)
                if (!result.success) throw new Error(result.error || 'Model could not load. Retry or choose a smaller model.')
            }
        } catch (error) {
            setModelError(error instanceof Error ? error.message : 'Model setup failed. Retry or use Ollama.')
        } finally {
            setModelAction(null)
        }
    }

    const checkProviders = useCallback(async () => {
        if (checkRef.current) return checkRef.current

        const settingsForLLM = {
            localOnly: settings.privacyMode === 'local-only',
            preferredProvider: settings.preferredProvider,
            ollamaModel: settings.ollamaModel,
            ollamaBaseUrl: settings.ollamaBaseUrl,
            openaiApiKey: settings.openaiApiKey,
            openaiBaseUrl: settings.openaiBaseUrl,
            openaiModel: settings.openaiModel,
            geminiApiKey: settings.geminiApiKey,
            geminiModel: settings.geminiModel,
            openrouterApiKey: settings.openrouterApiKey,
            openrouterModel: settings.openrouterModel,
            anthropicApiKey: settings.anthropicApiKey,
            anthropicModel: settings.anthropicModel,
            browserModel: settings.browserModel,
        }

        const promise = (async () => {
            setChecking(true)
            try {
                const p = settings.preferredProvider
                if (settingsForLLM.localOnly) {
                    setProviderStatus(await getAvailableProviders(settingsForLLM))
                } else if (p === 'ollama') {
                    const ollama = await checkOllama(settingsForLLM)
                    setProviderStatus({ ollama, openai: { available: false }, anthropic: { available: false }, gemini: { available: false }, openrouter: { available: false } })
                } else if (p === 'openai') {
                    const openai = await checkOpenAI(settingsForLLM)
                    setProviderStatus({ ollama: { available: false }, openai, anthropic: { available: false }, gemini: { available: false }, openrouter: { available: false } })
                } else if (p === 'anthropic') {
                    const anthropic = await checkAnthropic(settingsForLLM)
                    setProviderStatus({ ollama: { available: false }, openai: { available: false }, anthropic, gemini: { available: false }, openrouter: { available: false } })
                } else if (p === 'gemini') {
                    const gemini = await checkGemini(settingsForLLM)
                    setProviderStatus({ ollama: { available: false }, openai: { available: false }, anthropic: { available: false }, gemini, openrouter: { available: false } })
                } else if (p === 'openrouter') {
                    const openrouter = await checkOpenRouter(settingsForLLM)
                    setProviderStatus({ ollama: { available: false }, openai: { available: false }, anthropic: { available: false }, gemini: { available: false }, openrouter })
                } else {
                    const providers = await getAvailableProviders(settingsForLLM)
                    setProviderStatus({
                        ollama: providers.ollama,
                        openai: providers.openai,
                        anthropic: providers.anthropic,
                        gemini: providers.gemini,
                        openrouter: providers.openrouter,
                        browser: providers.browser,
                    })
                }
            } catch (err) {
                console.error('[LLMProviderSettings] Error checking providers:', err)
            } finally {
                setChecking(false)
                checkRef.current = null
            }
        })()

        checkRef.current = promise
        return promise
    }, [
        settings.preferredProvider,
        settings.privacyMode,
        settings.ollamaModel, settings.ollamaBaseUrl,
        settings.openaiApiKey, settings.openaiBaseUrl, settings.openaiModel,
        settings.anthropicApiKey, settings.anthropicModel,
        settings.geminiApiKey, settings.geminiModel,
        settings.openrouterApiKey, settings.openrouterModel,
        settings.browserModel,
    ])

    // Debounced auto-check when relevant settings change
    useEffect(() => {
        const t = setTimeout(() => checkProviders(), 500)
        return () => clearTimeout(t)
    }, [checkProviders])

    const p = settings.preferredProvider
    const localOnly = settings.privacyMode === 'local-only'
    const showOllama = localOnly || p === 'ollama' || p === 'auto'
    const showOpenAI = !localOnly && (p === 'openai' || p === 'auto')
    const showAnthropic = !localOnly && (p === 'anthropic' || p === 'auto')
    const showGemini = !localOnly && (p === 'gemini' || p === 'auto')
    const showOpenRouter = !localOnly && (p === 'openrouter' || p === 'auto')
    const downloaded = browserStatus.downloadedModels.includes(settings.browserModel)
    const modelBusy = !!modelAction || browserStatus.isLoading || !!browserStatus.backgroundDownload
    const progress = browserStatus.backgroundDownload?.progress ?? browserStatus.loadingProgress
    const selectedModel = WEBLLM_MODELS.find(model => model.id === settings.browserModel)

    return (
        <div>
            <h3 className="text-xl font-bold mb-6">LLM Provider</h3>
            <div className="space-y-4">

                {/* Provider pill selector */}
                <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl p-4">
                    <label className="block text-sm text-[var(--color-text-muted)] mb-3">Preferred Provider</label>
                    <div className="flex gap-2 flex-wrap">
                        {PROVIDERS.filter(({ id }) => !localOnly || ['auto', 'browser', 'ollama'].includes(id)).map(({ id, label }) => (
                            <button
                                key={id}
                                onClick={() => settings.setPreferredProvider(id)}
                                aria-label={`Select ${label} provider`}
                                className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors border ${settings.preferredProvider === id
                                        ? 'bg-[var(--color-brand-teal)]/20 text-[var(--color-brand-teal)] border-[var(--color-brand-teal)]/50'
                                        : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-transparent hover:bg-[var(--color-border)]'
                                    }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Provider cards */}
                {(localOnly || p === 'browser' || p === 'auto') && (
                    <ProviderCard title="On-Device AI" status={{ available: browserStatus.isLoaded }}>
                        <label className="block text-xs text-[var(--color-text-muted)]">Model</label>
                        <ModelSelect
                            value={settings.browserModel}
                            onChange={settings.setBrowserModel}
                            models={WEBLLM_MODELS.map(model => model.id)}
                            disabled={modelBusy}
                            ariaLabel="On-Device Model Selection"
                        />
                        <p className="text-xs text-[var(--color-text-muted)]">
                            {selectedModel ? `${selectedModel.name}: ${selectedModel.size} download, ${selectedModel.requiredRamGB}GB RAM required. ` : ''}
                            {compatibility ? (compatibility.compatible ? 'Device compatibility checks passed.' : compatibility.reasons.join('. ')) : 'Checking device compatibility...'}
                        </p>
                        <p className="text-xs text-[var(--color-text-muted)]">Download uses the internet to save model files. Load may fetch required runtime files. Once loaded, chat inference runs on this device.</p>
                        <div className="flex gap-2">
                            <button type="button" disabled={modelBusy || !compatibility?.compatible} onClick={() => { void prepareBrowserModel('download') }} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text-primary)] disabled:opacity-50">
                                {downloaded ? 'Download again' : 'Download'}
                            </button>
                            <button type="button" disabled={modelBusy || !downloaded || !compatibility?.compatible} onClick={() => { void prepareBrowserModel('load') }} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-brand-teal)]/10 text-[var(--color-brand-teal)] disabled:opacity-50">Load</button>
                        </div>
                        <p role="status" className="text-xs text-[var(--color-text-muted)]">
                            {modelBusy ? `${modelAction === 'download' || browserStatus.backgroundDownload ? 'Downloading' : 'Loading'}: ${progress.toFixed(0)}%` : browserStatus.isLoaded ? `Loaded: ${browserStatus.currentModel}` : downloaded ? 'Downloaded. Choose Load to enable on-device chat.' : 'No model ready. Choose Download, then Load, or configure Ollama below.'}
                        </p>
                        {(modelError || browserStatus.error) && <p role="alert" className="text-xs text-[var(--color-error)]">{modelError || browserStatus.error}. Retry setup or use Ollama.</p>}
                    </ProviderCard>
                )}
                {showOllama && (
                    <OllamaSettings
                        available={providerStatus?.ollama.available}
                        error={providerStatus?.ollama.error}
                        models={providerStatus?.ollama.models}
                        checking={checking}
                        onRefresh={checkProviders}
                    />
                )}
                {showOpenAI && (
                    <OpenAISettings
                        available={providerStatus?.openai.available}
                        models={providerStatus?.openai.models}
                        modelsEndpointAvailable={providerStatus?.openai.modelsEndpointAvailable}
                        error={providerStatus?.openai.error}
                        checking={checking}
                        onRefresh={checkProviders}
                    />
                )}
                {showAnthropic && (
                    <AnthropicSettings
                        available={providerStatus?.anthropic.available}
                        models={providerStatus?.anthropic.models}
                        error={providerStatus?.anthropic.error}
                        checking={checking}
                        onRefresh={checkProviders}
                    />
                )}
                {showGemini && (
                    <GeminiSettings
                        available={providerStatus?.gemini.available}
                        models={providerStatus?.gemini.models}
                        checking={checking}
                        onRefresh={checkProviders}
                    />
                )}
                {showOpenRouter && (
                    <OpenAISettings
                        isOpenRouter
                        available={providerStatus?.openrouter.available}
                        models={providerStatus?.openrouter.models}
                        error={providerStatus?.openrouter.error}
                        checking={checking}
                        onRefresh={checkProviders}
                    />
                )}
            </div>
        </div>
    )
}
