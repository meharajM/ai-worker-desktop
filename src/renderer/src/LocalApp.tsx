import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from './components/primitives/Button'

export function LocalApp() {
  const [status, setStatus] = useState('Checking native bridge…')

  async function checkStatus() {
    setStatus('Checking native bridge…')
    try {
      setStatus(await invoke<string>('status'))
    } catch {
      setStatus('Native bridge unavailable in browser preview')
    }
  }

  useEffect(() => {
    void checkStatus()
  }, [])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-dark)] p-8 text-[var(--color-text-primary)]">
      <h1 className="text-2xl font-semibold">AI-Worker</h1>
      <p role="status" aria-live="polite">{status}</p>
      <Button variant="secondary" size="sm" onClick={() => void checkStatus()}>
        Check native status
      </Button>
    </main>
  )
}
