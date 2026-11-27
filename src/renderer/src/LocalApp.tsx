import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './components/primitives/Button'
import { TextArea } from './components/input/TextArea'
import { DesktopBridgeError, desktopBridge, type DesktopPreferences, type ModelCatalog, type ModelImportProgress } from './desktop-bridge'
import { buildLocalChatPrompt, MAX_LOCAL_CHAT_PROMPT_LENGTH } from './lib/local-chat-context'

type View = 'chat' | 'settings'
type PreferencePreset = DesktopPreferences['resourcePreset']
type PreferenceLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
type LocalChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  provider?: 'Ollama (local)' | 'llama.cpp'
  model?: string
}

const LOCAL_CHAT_STORAGE_KEY = 'ai-worker.local-chat.v1'
const MAX_LOCAL_CHAT_MESSAGES = 100

function readLocalChat(): LocalChatMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_CHAT_STORAGE_KEY) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('version' in value) || value.version !== 1 ||
      !('messages' in value) || !Array.isArray(value.messages)) return []
    return value.messages.slice(-MAX_LOCAL_CHAT_MESSAGES).filter((message): message is LocalChatMessage =>
      message !== null && typeof message === 'object' && !Array.isArray(message) &&
      typeof message.id === 'string' && message.id.length <= 96 &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' && message.content.length <= 64 * 1024 &&
      (message.role === 'user' || message.provider === 'Ollama (local)' || message.provider === 'llama.cpp') &&
      (message.role === 'user' || (typeof message.model === 'string' && message.model.length <= 128)),
    )
  } catch {
    return []
  }
}

function preferencesFor(resourcePreset: PreferencePreset, allowOnlineResearch: boolean): DesktopPreferences {
  return {
    schemaVersion: 1,
    selectedProfileId: null,
    resourcePreset,
    idlePolicy: resourcePreset === 'balanced' ? 'shortIdle' : 'taskEnd',
    allowOnlineResearch,
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
  const [messages, setMessages] = useState<LocalChatMessage[]>(readLocalChat)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatStorageWarning, setChatStorageWarning] = useState('')
  const [preferenceLoadState, setPreferenceLoadState] = useState<PreferenceLoadState>('idle')
  const [preferences, setPreferences] = useState<DesktopPreferences>()
  const [selectedPreset, setSelectedPreset] = useState<PreferencePreset | ''>('')
  const [selectedAllowOnlineResearch, setSelectedAllowOnlineResearch] = useState(false)
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
    setSelectedAllowOnlineResearch(false)
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
      setSelectedAllowOnlineResearch(result.preferences.allowOnlineResearch)
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
      const result = await desktopBridge.updatePreferences(preferencesFor(selectedPreset, selectedAllowOnlineResearch))
      if (!mounted.current || generation !== preferencesGeneration.current) return
      setPreferences(result.preferences)
      setSelectedPreset(result.preferences.resourcePreset)
      setSelectedAllowOnlineResearch(result.preferences.allowOnlineResearch)
      setSaveNotice('Preferences saved.')
    } catch (error) {
      if (!mounted.current || generation !== preferencesGeneration.current) return
      setPreferenceError(safeError(error))
    } finally {
      saveBusy.current = false
      if (mounted.current) setSaving(false)
    }
  }, [preferenceLoadState, selectedAllowOnlineResearch, selectedPreset])

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

  const sendChat = useCallback(async () => {
    const prompt = text.trim()
    if (!prompt || chatBusy) return
    if (prompt.length > MAX_LOCAL_CHAT_PROMPT_LENGTH) {
      setChatError('Local prompts are limited to 8,000 characters. Shorten this message and retry.')
      return
    }
    const userMessage: LocalChatMessage = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'user',
      content: prompt,
    }
    setMessages((current) => [...current, userMessage].slice(-MAX_LOCAL_CHAT_MESSAGES))
    setText('')
    setChatError('')
    setChatBusy(true)
    try {
      const reply = await desktopBridge.sendLocalChat(buildLocalChatPrompt(messages, prompt))
      setMessages((current) => [...current, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant' as const,
        content: reply.content,
        provider: reply.provider,
        model: reply.model,
      }].slice(-MAX_LOCAL_CHAT_MESSAGES))
    } catch (error) {
      setChatError(error instanceof DesktopBridgeError && error.code === 'transport_error'
        ? 'The local model is unavailable or still loading. Check On-device model setup in Settings and retry.'
        : safeError(error))
    } finally {
      setChatBusy(false)
    }
  }, [chatBusy, messages, text])

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
    try {
      localStorage.setItem(LOCAL_CHAT_STORAGE_KEY, JSON.stringify({ version: 1, messages }))
      setChatStorageWarning('')
    } catch {
      setChatStorageWarning('This conversation is visible now but could not be saved in local app storage.')
    }
  }, [messages])

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
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">This chat always uses on-device inference and local app storage. Recent turns are included as context for the local model. Delegated tasks stay local unless public web research is enabled in Settings and explicitly requested by the host.</p>
            </header>
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 overflow-y-auto p-8">
              {!messages.length && (
                <div className="my-auto">
                  <h3 className="text-xl font-semibold">Chat with your on-device model</h3>
                  <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                    AI-Worker sends prompts to an installed local model only. It never switches to a cloud model when local inference is unavailable.
                  </p>
                </div>
              )}
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
              {modelCatalog && !modelCatalog.selectedModel && modelSetupState !== 'installing' && (
                <div role="status" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <p className="text-sm">No on-device model is ready yet. Open Settings to check compatibility and choose an install.</p>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Model downloads use the internet only after you select Install. Prompts still use local inference and never fall back to cloud.</p>
                  <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setView('settings')}>Set up local model</Button>
                </div>
              )}
              {messages.map((message) => (
                <article key={message.id} className={`rounded-xl border border-[var(--color-border)] p-4 text-sm ${message.role === 'user' ? 'ml-8 bg-[var(--color-surface)]' : 'mr-8'}`}>
                  <p className="mb-2 text-xs text-[var(--color-text-secondary)]">{message.role === 'user' ? 'You' : `AI-Worker · ${message.provider ?? 'local'}`}</p>
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  {message.role === 'assistant' && message.model && <p className="mt-3 text-xs text-[var(--color-text-secondary)]">On-device model: {message.model}</p>}
                </article>
              ))}
              {chatBusy && <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-secondary)]">Waiting for the local model… First response may take longer while the model loads.</p>}
              {chatError && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-300">{chatError} No cloud fallback was used.</p>}
              {chatStorageWarning && <p role="status" className="text-xs text-amber-200">{chatStorageWarning}</p>}
              <div className="sticky bottom-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-dark)] p-3">
                <label htmlFor="local-chat-input" className="sr-only">Message the local model</label>
                <TextArea
                  id="local-chat-input"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void sendChat()
                    }
                  }}
                  placeholder="Message your local model… (Enter sends, Shift+Enter adds a line)"
                  disabled={chatBusy}
                />
                <div className="flex justify-end pt-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => void sendChat()} disabled={!text.trim() || chatBusy || !desktopBridge.isAvailable() || !modelCatalog?.selectedModel}>
                    {chatBusy ? 'Thinking…' : 'Send locally'}
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
                  Hardware checks run locally. Ollama downloads model files only after you choose Install; inference stays on this device.
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
                <h3 id="preferences-heading" className="font-semibold">App and privacy preferences</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  Local-only is the default. On-device inference never falls back to a cloud model. Public web research is separate and remains off until enabled here; a host must also explicitly request web access for a task.
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
                    <label className="mt-5 flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-4">
                      <input
                        id="allow-online-research"
                        type="checkbox"
                        checked={selectedAllowOnlineResearch}
                        disabled={saving}
                        onChange={(event) => setSelectedAllowOnlineResearch(event.target.checked)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-sm font-medium">Allow delegated public web research</span>
                        <span className="mt-1 block text-xs text-[var(--color-text-secondary)]">When enabled and a host task requests web access, AI-Worker sends search terms to DuckDuckGo and fetches requested public HTTPS URLs. Search terms and URL paths and queries are sent as supplied. Outbound request planning excludes workspace files and handoff notes; AI-Worker does not attach saved cookies or account credentials. Do not put secrets in the task prompt or URLs. Model inference stays on this device.</span>
                      </span>
                    </label>
                    <div className="mt-4 flex items-center justify-between gap-4">
                      <p className="text-sm text-[var(--color-text-secondary)]">Saved: {preferences.resourcePreset === 'balanced' ? 'Balanced' : 'Low impact'} · web {preferences.allowOnlineResearch ? 'enabled' : 'off'}</p>
                      <Button type="button" variant="secondary" onClick={() => void savePreferences()} disabled={saving || (selectedPreset === preferences.resourcePreset && selectedAllowOnlineResearch === preferences.allowOnlineResearch)}>
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
