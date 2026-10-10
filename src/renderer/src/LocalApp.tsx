import { useCallback, useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { Button } from './components/primitives/Button'

type View = 'chat' | 'settings'

export function LocalApp() {
  const [view, setView] = useState<View>('chat')
  const [status, setStatus] = useState('Checking native bridge…')
  const [text, setText] = useState('')
  const [draft, setDraft] = useState('')

  const checkStatus = useCallback(async () => {
    if (!isTauri()) {
      setStatus('Native bridge unavailable in browser preview')
      return
    }

    setStatus('Checking native bridge…')
    try {
      setStatus(await invoke<string>('status'))
    } catch (error) {
      setStatus(`Native status check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  function saveDraft() {
    if (!text.trim()) return
    setDraft(text)
    setText('')
  }

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

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
          <Button variant="ghost" size="sm" className="mt-3" onClick={() => void checkStatus()}>
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
                <h3 className="text-xl font-semibold">Set up a local model to start chatting</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  No model is configured yet. You can write a draft now; it will stay in this window and will not be sent.
                </p>
              </div>
              {draft && (
                <p className="whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm" aria-live="polite">
                  <span className="mb-2 block text-xs text-[var(--color-text-secondary)]">Local draft · not sent</span>
                  {draft}
                </p>
              )}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <label htmlFor="local-draft" className="sr-only">Write a local draft</label>
                <textarea
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
                  rows={3}
                  className="w-full resize-y bg-transparent p-2 text-sm outline-none placeholder:text-[var(--color-text-dim)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
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
                <h3 id="model-heading" className="font-semibold">Local model</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">Not configured</p>
                <p className="mt-3 text-sm text-[var(--color-text-secondary)]">
                  Model selection and setup will appear here when local inference support is available.
                </p>
              </section>
            </div>
          </>
        )}
      </section>
    </main>
  )
}
