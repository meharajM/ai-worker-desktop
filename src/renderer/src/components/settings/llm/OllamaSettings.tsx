/**
 * OllamaSettings — self-contained Ollama provider config card.
 * Extracted from SettingsPanel.tsx.
 */
import React, { useState } from 'react'
import { useSettingsStore } from '../../../stores/settingsStore'
import { testOllamaConnection } from '../../../lib/llm'
import { ModelSelect } from '../../ModelSelect'
import { ProviderCard } from './ProviderCard'

interface OllamaSettingsProps {
    available?: boolean
    error?: string
    models?: string[]
    checking?: boolean
    onRefresh: () => Promise<void>
}

export function OllamaSettings({ available, error, models, checking, onRefresh }: OllamaSettingsProps) {
    const settings = useSettingsStore()
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<string | undefined>()

    async function handleTest() {
        setTesting(true)
        setTestResult(undefined)
        try {
            const result = await testOllamaConnection(
                settings.ollamaBaseUrl || 'http://localhost:11434',
                settings.ollamaModel || 'qwen2.5:3b',
                settings.privacyMode === 'local-only'
            )
            if (result.success) {
                setTestResult(result.capabilities?.includes('tools')
                    ? 'Ollama is reachable. This model supports tool calling.'
                    : 'Ollama is reachable. This model can generate text, but cannot call AI-Worker integrations.')
                void onRefresh().catch((refreshError) => {
                    console.warn('[OllamaSettings] Provider status refresh failed:', refreshError)
                })
            } else {
                setTestResult(`Error: ${result.error}`)
            }
        } catch (err) {
            setTestResult(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
        } finally {
            setTesting(false)
        }
    }

    return (
        <ProviderCard
            title="Ollama"
            status={available !== undefined ? { available, error } : undefined}
            checking={checking}
            headerActions={
                <>
                    <a
                        href="https://ollama.com/"
                        onClick={(event) => {
                            if (window.electron?.shell?.openExternal) {
                                event.preventDefault()
                                void window.electron.shell.openExternal('https://ollama.com/')
                            }
                        }}
                        className="px-2 py-0.5 text-[10px] bg-[var(--color-brand-teal)]/10 text-[var(--color-brand-teal)] rounded border border-[var(--color-brand-teal)]/20 hover:bg-[var(--color-brand-teal)]/20 transition-colors"
                    >
                        Install Ollama
                    </a>
                    <button
                        onClick={onRefresh}
                        className="px-2 py-1 text-xs bg-[var(--color-surface)] hover:bg-[var(--color-border)] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                        title="Refresh connection status"
                    >
                        ↻
                    </button>
                </>
            }
            testing={testing}
            onTest={handleTest}
            testResult={testResult}
        >
            {error && <p role="status" className="text-xs text-[var(--color-error)]">{error}</p>}
            {/* Base URL */}
            <div>
                <label className="block text-xs text-[var(--color-text-muted)] mb-1">Base URL</label>
                <input
                    type="text"
                    value={settings.ollamaBaseUrl || 'http://localhost:11434'}
                    onChange={(e) => settings.setOllamaBaseUrl(e.target.value)}
                    placeholder="http://localhost:11434"
                    className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--color-text-dim)] text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                />
            </div>

            {/* Model */}
            <div>
                <label className="block text-xs text-[var(--color-text-muted)] mb-1">Model</label>
                <ModelSelect
                    value={settings.ollamaModel}
                    onChange={(value) => settings.setOllamaModel(value)}
                    models={models ?? []}
                    placeholder="qwen2.5:3b"
                    ariaLabel="Ollama Model Selection"
                />
                {models && models.length > 0 && (
                    <p className="text-xs text-[var(--color-text-dim)] mt-1">{models.length} model(s) available</p>
                )}
            </div>
        </ProviderCard>
    )
}
