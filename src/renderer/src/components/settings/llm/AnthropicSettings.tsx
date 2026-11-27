import React, { useState } from 'react'
import { checkAnthropic } from '../../../lib/llm'
import { LLM_CONFIG } from '../../../lib/constants'
import { useSettingsStore } from '../../../stores/settingsStore'
import { ModelSelect } from '../../ModelSelect'
import { ProviderCard } from './ProviderCard'

interface AnthropicSettingsProps {
    available?: boolean
    models?: string[]
    error?: string
    checking?: boolean
    onRefresh: () => Promise<void>
}

export function AnthropicSettings({ available, models, error, checking, onRefresh }: AnthropicSettingsProps) {
    const settings = useSettingsStore()
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<string>()

    async function handleTest() {
        if (!settings.anthropicApiKey) {
            setTestResult('Error: Enter an API key first')
            return
        }
        setTesting(true)
        setTestResult(undefined)
        try {
            const result = await checkAnthropic({
                localOnly: false,
                anthropicApiKey: settings.anthropicApiKey,
                anthropicModel: settings.anthropicModel,
            })
            if (!result.available) throw new Error(result.error || 'Connection failed')
            setTestResult(result.modelsEndpointAvailable === false
                ? `Key saved. Model list unavailable; configured model will be used. ${result.error || ''}`.trim()
                : `Connection successful. Found ${result.models?.length || 0} model(s).`)
            await onRefresh()
        } catch (err) {
            setTestResult(`Error: ${err instanceof Error ? err.message : 'Connection failed'}`)
        } finally {
            setTesting(false)
        }
    }

    return (
        <ProviderCard
            title="Anthropic Claude"
            status={available !== undefined ? { available } : undefined}
            checking={checking}
            headerActions={
                <a
                    href="https://platform.claude.com/settings/keys"
                    onClick={(event) => {
                        if (window.electron?.shell?.openExternal) {
                            event.preventDefault()
                            void window.electron.shell.openExternal('https://platform.claude.com/settings/keys')
                        }
                    }}
                    className="px-2 py-0.5 text-[10px] bg-[var(--color-brand-teal)]/10 text-[var(--color-brand-teal)] rounded border border-[var(--color-brand-teal)]/20"
                >Get API Key</a>
            }
            testLabel="Test Connection & Fetch Models"
            testing={testing}
            testDisabled={testing || !settings.anthropicApiKey}
            onTest={handleTest}
            testResult={testResult}
        >
            <div>
                <label className="block text-xs text-[var(--color-text-muted)] mb-1">API Key</label>
                <input
                    type="password"
                    value={settings.anthropicApiKey}
                    onChange={(event) => { void settings.setAnthropicApiKey(event.target.value) }}
                    placeholder="sk-ant-..."
                    autoComplete="off"
                    className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                />
                <p className="mt-1 text-xs text-[var(--color-text-dim)]">Stored in this device’s encrypted secure storage. Used only in Connected services mode.</p>
            </div>
            <div>
                <label className="block text-xs text-[var(--color-text-muted)] mb-1">Model</label>
                <ModelSelect
                    value={settings.anthropicModel}
                    onChange={settings.setAnthropicModel}
                    models={models ?? []}
                    placeholder={LLM_CONFIG.ANTHROPIC.DEFAULT_MODEL}
                    ariaLabel="Anthropic Model Selection"
                />
                {models?.length ? <p className="mt-1 text-xs text-[var(--color-text-dim)]">{models.length} models available</p> : error ? <p className="mt-1 text-xs text-[var(--color-text-dim)]">Could not fetch models: {error}. Type model name manually.</p> : null}
            </div>
        </ProviderCard>
    )
}
