import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './components/primitives/Button'
import { TextArea } from './components/input/TextArea'
import { DesktopBridgeError, desktopBridge, type DesktopPreferences, type ModelCatalog, type ModelImportProgress } from './desktop-bridge'

type View = 'chat' | 'settings'
type PreferencePreset = DesktopPreferences['resourcePreset']
type PreferenceLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'

function preferencesFor(resourcePreset: PreferencePreset): DesktopPreferences {
  return {
    schemaVersion: 1,
    selectedProfileId: null,
    resourcePreset,
    idlePolicy: resourcePreset === 'balanced' ? 'shortIdle' : 'taskEnd',
  }
}

function safeError(error: unknown) {
  return error instanceof DesktopBridgeError ? error.message : 'Native app request failed.'
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export function LocalApp() {
  const [view, setView] = useState<View>('chat')
  const [status, setStatus] = useState('Checking native bridge…')
  const [text, setText] = useState('')
  const [draft, setDraft] = useState('')
  const [preferenceLoadState, setPreferenceLoadState] = useState<PreferenceLoadState>('idle')
  const [preferences, setPreferences] = useState<DesktopPreferences>()
  const [selectedPreset, setSelectedPreset] = useState<PreferencePreset | ''>('')
  const [preferenceError, setPreferenceError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>()
  const [modelSetupState, setModelSetupState] = useState<'idle' | 'loading' | 'picking' | 'importing' | 'installing' | 'completed' | 'cancelled' | 'failed'>('idle')
  const [modelProgress, setModelProgress] = useState<ModelImportProgress>()
  const [modelRequestId, setModelRequestId] = useState<string>()
  const [modelOperation, setModelOperation] = useState<'import' | 'install' | null>(null)
  const [modelError, setModelError] = useState('')
  const saveBusy = useRef(false)
  const preferencesGeneration = useRef(0)
  const checkGeneration = useRef(0)
  const mounted = useRef(false)
  const modelRequestIdRef = useRef<string>()
  const modelOperationRef = useRef<'import' | 'install' | null>(null)
  const automaticInstallAttempted = useRef(false)

  const checkStatus = useCallback(async () => {
    const generation = ++checkGeneration.current
    if (!desktopBridge.isAvailable()) {
      setStatus('Native bridge unavailable in browser preview')
      return
    }

    setStatus('Checking native bridge…')
    try {
      const result = await desktopBridge.getStatus()
      if (!mounted.current || generation !== checkGeneration.current) return
      setStatus(result.available ? `Native bridge ready · v${result.appVersion}` : 'Native bridge unavailable')
    } catch (error) {
      if (!mounted.current || generation !== checkGeneration.current) return
      const message = error instanceof DesktopBridgeError ? error.message : 'Native bridge request failed.'
      setStatus(message)
    }
  }, [])

  const loadPreferences = useCallback(async () => {
    const generation = ++preferencesGeneration.current
    setPreferenceError('')
    setSaveNotice('')
    setPreferences(undefined)
    setSelectedPreset('')
    if (!desktopBridge.isAvailable()) {
      setPreferenceLoadState('unavailable')
      return
    }
    setPreferenceLoadState('loading')
    try {
      const result = await desktopBridge.getPreferences()
      if (!mounted.current || generation !== preferencesGeneration.current) return
      setPreferences(result.preferences)
      setSelectedPreset(result.preferences.resourcePreset)
      setPreferenceLoadState('ready')
    } catch (error) {
      if (!mounted.current || generation !== preferencesGeneration.current) return
      setPreferenceError(safeError(error))
      setPreferenceLoadState('error')
    }
  }, [])

  const savePreferences = useCallback(async () => {
    if (saveBusy.current || preferenceLoadState !== 'ready' || !selectedPreset) return
    saveBusy.current = true
    const generation = ++preferencesGeneration.current
    setSaving(true)
    setPreferenceError('')
    setSaveNotice('')
    try {
      const result = await desktopBridge.updatePreferences(preferencesFor(selectedPreset))
      if (!mounted.current || generation !== preferencesGeneration.current) return
      setPreferences(result.preferences)
      setSelectedPreset(result.preferences.resourcePreset)
      setSaveNotice('Preferences saved.')
    } catch (error) {
      if (!mounted.current || generation !== preferencesGeneration.current) return
      setPreferenceError(safeError(error))
    } finally {
      saveBusy.current = false
      if (mounted.current) setSaving(false)
    }
  }, [preferenceLoadState, selectedPreset])

  const loadModelCatalog = useCallback(async () => {
    if (!desktopBridge.isAvailable()) return
    setModelSetupState((current) => current === 'idle' ? 'loading' : current)
    try {
      const result = await desktopBridge.getModelCatalog()
      if (!mounted.current) return
      setModelCatalog(result)
      setModelSetupState((current) => current === 'loading' ? 'idle' : current)
    } catch (error) {
      if (!mounted.current) return
      setModelError(safeError(error))
      setModelSetupState('failed')
    }
  }, [])

  const onModelProgress = useCallback((progress: ModelImportProgress) => {
    if (modelRequestIdRef.current && progress.requestId !== modelRequestIdRef.current) return
    modelRequestIdRef.current = progress.requestId
    setModelRequestId(progress.requestId)
    setModelProgress(progress)
    if (progress.state === 'progress') {
      setModelSetupState(progress.message?.startsWith('Choose') ? 'picking' : modelOperationRef.current === 'install' ? 'installing' : 'importing')
    } else if (progress.state === 'completed') {
      setModelSetupState('completed')
      modelOperationRef.current = null
      setModelOperation(null)
      setModelError('')
      void loadModelCatalog()
    } else if (progress.state === 'cancelled') {
      setModelSetupState('cancelled')
      modelOperationRef.current = null
      setModelOperation(null)
      setModelError(progress.message ?? 'Import canceled.')
    } else if (progress.state === 'failed') {
      setModelSetupState('failed')
      modelOperationRef.current = null
      setModelOperation(null)
      setModelError(progress.message ?? 'Model import failed.')
    }
  }, [loadModelCatalog])

  const startModelInstall = useCallback(async (modelId: string) => {
    if (modelOperationRef.current) return
    modelOperationRef.current = 'install'
    setModelOperation('install')
    modelRequestIdRef.current = undefined
    setModelRequestId(undefined)
    setModelProgress(undefined)
    setModelError('')
    setModelSetupState('installing')
    try {
      const result = await desktopBridge.installModel(modelId, onModelProgress)
      if (!result.started) {
        modelOperationRef.current = null
        setModelOperation(null)
        setModelSetupState('idle')
        return
      }
      modelRequestIdRef.current = result.requestId
      setModelRequestId(result.requestId)
      setModelSetupState((current) => ['completed', 'cancelled', 'failed'].includes(current) ? current : 'installing')
    } catch (error) {
      modelOperationRef.current = null
      setModelOperation(null)
      setModelError(safeError(error))
      setModelSetupState('failed')
    }
  }, [onModelProgress])

  const importModel = useCallback(async () => {
    if (modelOperationRef.current) return
    modelOperationRef.current = 'import'
    setModelOperation('import')
    setModelError('')
    setModelProgress(undefined)
    modelRequestIdRef.current = undefined
    setModelRequestId(undefined)
    setModelSetupState('picking')
    try {
      const result = await desktopBridge.importModel(onModelProgress)
      if (!result.started) {
        modelOperationRef.current = null
        setModelOperation(null)
        setModelSetupState('idle')
        return
      }
      modelRequestIdRef.current = result.requestId
      setModelRequestId(result.requestId)
      setModelSetupState((current) => ['completed', 'cancelled', 'failed', 'picking'].includes(current) ? current : 'importing')
    } catch (error) {
      modelOperationRef.current = null
      setModelOperation(null)
      setModelError(safeError(error))
      setModelSetupState('failed')
    }
  }, [onModelProgress])

  const cancelModelOperation = useCallback(async () => {
    if (!modelRequestId) return
    try {
      if (modelOperationRef.current === 'install') await desktopBridge.cancelModelInstall(modelRequestId)
      else await desktopBridge.cancelModelImport(modelRequestId)
    } catch (error) {
      setModelError(safeError(error))
    }
  }, [modelRequestId])

  function saveDraft() {
    if (!text.trim()) return
    setDraft(text)
    setText('')
  }

  useEffect(() => {
    mounted.current = true
    void checkStatus()
    void loadModelCatalog()
    return () => {
      mounted.current = false
      checkGeneration.current += 1
    }
  }, [checkStatus, loadModelCatalog])

  useEffect(() => {
    const recommendation = modelCatalog?.recommendedModel
    if (!mounted.current || automaticInstallAttempted.current || !modelCatalog?.ollamaAvailable ||
      modelCatalog.selectedModel || !recommendation) return
    automaticInstallAttempted.current = true
    void startModelInstall(recommendation.id)
  }, [modelCatalog, startModelInstall])

  useEffect(() => {
    if (view !== 'settings') {
      preferencesGeneration.current += 1
      return
    }
    void loadPreferences()
    void loadModelCatalog()
    return () => {
      preferencesGeneration.current += 1
    }
  }, [loadModelCatalog, loadPreferences, view])

  return (
    <main className="flex min-h-screen bg-[var(--color-bg-dark)] text-[var(--color-text-primary)]">
      <nav aria-label="Main navigation" className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] p-5">
        <h1 className="mb-8 text-lg font-semibold">AI-Worker</h1>
        <div className="flex flex-col gap-2">
          {(['chat', 'settings'] as const).map((item) => (
            <Button
              key={item}
              type="button"
              variant={view === item ? 'secondary' : 'ghost'}
              className="justify-start capitalize"
              aria-current={view === item ? 'page' : undefined}
              onClick={() => setView(item)}
            >
              {item}
            </Button>
          ))}
        </div>
        <div className="mt-auto border-t border-[var(--color-border)] pt-4">
          <p className="mb-2 text-xs text-[var(--color-text-secondary)]">Native status</p>
          <p role="status" aria-live="polite" className="break-words text-xs text-[var(--color-text-primary)]">{status}</p>
          <Button variant="ghost" size="sm" className="mt-3" onClick={() => { void checkStatus(); void loadModelCatalog() }}>
            Check again
          </Button>
        </div>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col">
        {view === 'chat' ? (
          <>
            <header className="border-b border-[var(--color-border)] px-8 py-5">
              <h2 className="text-lg font-medium">Local chat</h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Your workspace stays on this device.</p>
            </header>
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 p-8">
              <div>
                <h3 className="text-xl font-semibold">Preparing this device for local AI</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  AI-Worker checks your system and can download a suitable on-device model in the background. You can keep using this window while setup runs.
                </p>
              </div>
              {modelSetupState === 'installing' && (
                <div role="status" aria-live="polite" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <p className="text-sm">{modelProgress?.message ?? 'Preparing the recommended local model…'}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">The download can take a while. Other app operations remain available.</p>
                  <progress className="mt-3 w-full" aria-label="Local model download" />
                  {modelOperation === 'install' && modelRequestId && (
                    <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => void cancelModelOperation()}>Cancel setup</Button>
                  )}
                </div>
              )}
              {draft && (
                <p className="whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm" aria-live="polite">
                  <span className="mb-2 block text-xs text-[var(--color-text-secondary)]">Local draft · not sent</span>
                  {draft}
                </p>
              )}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <label htmlFor="local-draft" className="sr-only">Write a local draft</label>
                <TextArea
                  id="local-draft"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      saveDraft()
                    }
                  }}
                  placeholder="Write a draft… (Enter saves, Shift+Enter adds a line)"
                />
                <div className="flex justify-end pt-2">
                  <Button type="button" size="sm" variant="secondary" onClick={saveDraft} disabled={!text.trim()}>
                    Save draft
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="border-b border-[var(--color-border)] px-8 py-5">
              <h2 className="text-lg font-medium">Settings</h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Local app setup</p>
            </header>
            <div className="mx-auto w-full max-w-3xl p-8">
              <section aria-labelledby="model-heading" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
                <h3 id="model-heading" className="font-semibold">On-device model setup</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  Hardware checks and model downloads run in the background. AI-Worker picks a model size from memory and available storage. Ollama downloads the model files; inference stays on this device.
                </p>
                {modelCatalog && (
                  <>
                    <dl className="mt-4 grid gap-3 rounded-lg border border-[var(--color-border)] p-4 text-xs sm:grid-cols-2">
                      <div><dt className="text-[var(--color-text-secondary)]">System</dt><dd>{modelCatalog.system.operatingSystem} · {modelCatalog.system.architecture}</dd></div>
                      <div><dt className="text-[var(--color-text-secondary)]">CPU</dt><dd>{modelCatalog.system.logicalCpuCount} logical cores</dd></div>
                      <div><dt className="text-[var(--color-text-secondary)]">Memory</dt><dd>{formatBytes(modelCatalog.system.totalMemoryBytes)} total · {formatBytes(modelCatalog.system.availableMemoryBytes)} currently available</dd></div>
                      <div><dt className="text-[var(--color-text-secondary)]">Estimated model storage</dt><dd>{modelCatalog.system.availableModelDiskBytes === null ? 'Free space unavailable' : `${formatBytes(modelCatalog.system.availableModelDiskBytes)} free`}</dd></div>
                    </dl>
                    {!modelCatalog.ollamaAvailable && (
                      <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">
                        Ollama is not running, so AI-Worker cannot download a model yet. Install and start <a className="underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama</a>, then select “Check again” below.
                      </p>
                    )}
                    {modelCatalog.selectedModel && (
                      <p role="status" className="mt-4 text-sm">Local model detected: <span className="font-medium">{modelCatalog.selectedModel}</span>. No download needed.</p>
                    )}
                    {!modelCatalog.selectedModel && modelCatalog.configuredModel && (
                      <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">
                        Configured model {modelCatalog.configuredModel} is not installed. AI-Worker will only download this configured model when it fits this device.
                      </p>
                    )}
                    {!modelCatalog.selectedModel && modelCatalog.recommendedModel && (
                      <div className="mt-4 rounded-lg border border-[var(--color-border)] p-4">
                        <h4 className="font-medium">Recommended: {modelCatalog.recommendedModel.name}</h4>
                        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                          {modelCatalog.recommendedModel.ollamaName} · {formatBytes(modelCatalog.recommendedModel.minimumMemoryBytes)} total memory · about {formatBytes(modelCatalog.recommendedModel.estimatedSizeBytes)} download · {formatBytes(modelCatalog.recommendedModel.diskRequiredBytes)} storage allowance.
                        </p>
                        {modelCatalog.ollamaAvailable && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button type="button" variant="secondary" onClick={() => void startModelInstall(modelCatalog.recommendedModel!.id)} disabled={Boolean(modelOperation) || (modelCatalog.installedModels.length > 0 && !modelCatalog.configuredModel)}>
                              {modelSetupState === 'installing' ? 'Downloading…' : modelSetupState === 'failed' || modelSetupState === 'cancelled' ? 'Retry download' : 'Install recommended model'}
                            </Button>
                            {modelRequestId && (modelSetupState === 'installing' || modelSetupState === 'picking' || modelSetupState === 'importing') && (
                              <Button type="button" variant="ghost" onClick={() => void cancelModelOperation()}>Cancel setup</Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {!modelCatalog.recommendedModel && !modelCatalog.selectedModel && !modelCatalog.configuredModel && (
                      <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">
                        No model profile fits currently available memory and storage. Close memory-heavy apps, free disk space, then check again.
                      </p>
                    )}
                    {!modelCatalog.recommendedModel && !modelCatalog.selectedModel && modelCatalog.configuredModel && (
                      <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">
                        The configured model is unsupported or does not fit currently available memory and storage. Update AI_WORKER_OLLAMA_MODEL or free resources, then check again.
                      </p>
                    )}
                    {modelError && <p role="alert" className="mt-3 text-sm text-red-300">{modelError}</p>}
                    {modelSetupState === 'loading' && <p role="status" className="mt-3 text-sm">Checking hardware and local models…</p>}
                    {modelOperation === 'install' && modelSetupState === 'installing' && (
                      <div className="mt-3" role="status" aria-live="polite">
                        <p className="text-xs">{modelProgress?.message ?? 'Downloading the local model. Other app operations remain available.'}</p>
                        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Ollama reports completion after the pull finishes; the status bar is indeterminate during transfer.</p>
                        <progress className="mt-1 w-full" aria-label="Local model download progress" />
                      </div>
                    )}
                  </>
                )}
                {!modelCatalog && modelSetupState === 'loading' && <p role="status" className="mt-3 text-sm">Checking this device…</p>}
                {!modelCatalog && modelSetupState === 'failed' && (
                  <Button type="button" variant="secondary" className="mt-3" onClick={() => void loadModelCatalog()}>Check again</Button>
                )}
                {modelCatalog?.developerCandidate && (
                  <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                    <h4 className="font-medium">{modelCatalog.developerCandidate.name}</h4>
                    <p className="mt-1 text-sm text-amber-200">{modelCatalog.developerCandidate.status}</p>
                    <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                      <div><dt className="text-[var(--color-text-secondary)]">License</dt><dd>{modelCatalog.developerCandidate.license}</dd></div>
                      <div><dt className="text-[var(--color-text-secondary)]">Artifact size</dt><dd>{modelCatalog.developerCandidate.artifactSize.toLocaleString()} bytes</dd></div>
                      <div className="sm:col-span-2"><dt className="text-[var(--color-text-secondary)]">Source (pinned revision)</dt><dd className="break-all">{modelCatalog.developerCandidate.source}</dd></div>
                      <div className="sm:col-span-2"><dt className="text-[var(--color-text-secondary)]">GGUF SHA-256</dt><dd className="break-all font-mono">{modelCatalog.developerCandidate.artifactSha256}</dd></div>
                      <div className="sm:col-span-2"><dt className="text-[var(--color-text-secondary)]">Chat template SHA-256</dt><dd className="break-all font-mono">{modelCatalog.developerCandidate.templateSha256}</dd></div>
                      <div className="sm:col-span-2"><dt className="text-[var(--color-text-secondary)]">llama-server binary SHA-256</dt><dd className="break-all font-mono">{modelCatalog.developerCandidate.runtimeSha256}</dd></div>
                      <div><dt className="text-[var(--color-text-secondary)]">Import disk space</dt><dd>{(modelCatalog.developerCandidate.diskRequired / 1_000_000_000).toFixed(2)} GB minimum</dd></div>
                      <div><dt className="text-[var(--color-text-secondary)]">Model file</dt><dd>{modelCatalog.developerCandidate.installed ? 'Present; hash is checked before use' : 'Not imported'}</dd></div>
                    </dl>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" onClick={() => void importModel()} disabled={Boolean(modelOperation)}>
                        {modelOperation === 'import' && modelSetupState === 'picking' ? 'Choose a GGUF file…' : modelOperation === 'import' && modelSetupState === 'importing' ? 'Importing…' : modelSetupState === 'failed' || modelSetupState === 'cancelled' ? 'Retry import' : modelCatalog.developerCandidate.installed ? 'Replace with verified GGUF' : 'Import and verify GGUF'}
                      </Button>
                      {modelOperation === 'import' && modelRequestId && (modelSetupState === 'picking' || modelSetupState === 'importing') && <Button type="button" variant="ghost" onClick={() => void cancelModelOperation()}>Cancel import</Button>}
                    </div>
                    {modelOperation === 'import' && modelProgress?.state === 'progress' && modelProgress.total > 0 && (
                      <div className="mt-3" role="status" aria-live="polite">
                        <p className="text-xs">{modelProgress.message ?? `Verifying and importing: ${modelProgress.copied.toLocaleString()} / ${modelProgress.total.toLocaleString()} bytes`}</p>
                        <progress className="mt-1 w-full" max={modelProgress.total} value={modelProgress.copied} aria-label="Model import progress" />
                      </div>
                    )}
                  </div>
                )}
              </section>
              <section aria-labelledby="preferences-heading" aria-busy={preferenceLoadState === 'loading' || saving} className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
                <h3 id="preferences-heading" className="font-semibold">Chat preferences</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  Choose a saved resource preference. Its paired idle policy is saved automatically; model scheduling does not use these preferences yet.
                </p>
                {preferenceLoadState === 'unavailable' && (
                  <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">Native preferences are available in the desktop app only.</p>
                )}
                {preferenceLoadState === 'loading' && (
                  <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">Loading preferences…</p>
                )}
                {preferenceLoadState === 'error' && (
                  <div className="mt-4">
                    <p role="alert" className="text-sm text-[var(--color-text-secondary)]">{preferenceError}</p>
                    <Button type="button" variant="secondary" className="mt-3" onClick={() => void loadPreferences()}>Retry</Button>
                  </div>
                )}
                {preferenceLoadState === 'ready' && preferences && (
                  <div className="mt-4">
                    <label htmlFor="resource-preset" className="block text-sm font-medium">Resource preference</label>
                    <select
                      id="resource-preset"
                      value={selectedPreset}
                      disabled={saving}
                      onChange={(event) => setSelectedPreset(event.target.value as PreferencePreset)}
                      className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-dark)] px-3 py-2 text-sm text-[var(--color-text-primary)] disabled:opacity-60"
                    >
                      <option value="lowImpact">Low impact</option>
                      <option value="balanced">Balanced</option>
                    </select>
                    <div className="mt-4 flex items-center justify-between gap-4">
                      <p className="text-sm text-[var(--color-text-secondary)]">Saved: {preferences.resourcePreset === 'balanced' ? 'Balanced' : 'Low impact'}</p>
                      <Button type="button" variant="secondary" onClick={() => void savePreferences()} disabled={saving || selectedPreset === preferences.resourcePreset}>
                        {saving ? 'Saving…' : 'Save preferences'}
                      </Button>
                    </div>
                    {preferenceError && <p role="alert" className="mt-3 text-sm text-[var(--color-text-secondary)]">{preferenceError}</p>}
                    {saveNotice && <p role="status" className="mt-3 text-sm text-[var(--color-text-secondary)]">{saveNotice}</p>}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </section>
    </main>
  )
}
