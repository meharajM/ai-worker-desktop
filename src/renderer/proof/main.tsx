import React from 'react'
import ReactDOM from 'react-dom/client'
import { isTauri } from '@tauri-apps/api/core'
import { nativeProofBridge } from '../src/proof/proof-transport'
import { runM03bAssertions, type ProofResult } from '../src/proof/proof-assertions'

function ProofApp() {
  const [running, setRunning] = React.useState(false)
  const [results, setResults] = React.useState<ProofResult[]>([])
  const [message, setMessage] = React.useState('Ready. Run proof in a Tauri proof build.')

  async function run() {
    setRunning(true)
    setResults([])
    setMessage('Running native fixture scenarios…')
    try {
      if (!isTauri()) {
        setMessage('Native bridge unavailable in browser preview.')
        return
      }
      const next = await runM03bAssertions(nativeProofBridge, localStorage, (progress, result) => {
        setMessage(progress)
        if (result) setResults((current) => [...current, result])
      })
      setMessage(next.every((result) => result.passed) ? 'All shared proof assertions passed.' : 'Some proof assertions failed.')
    } catch (error) {
      setMessage(`Proof bridge unavailable: ${String(error)}`)
    } finally {
      setRunning(false)
    }
  }

  return <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: 760, padding: '0 1rem' }}>
    <h1>M03 LangChain and LangGraph proof</h1>
    <p>Runs fixed local fixtures. No network or credentials.</p>
    <button type="button" onClick={() => void run()} disabled={running} aria-describedby="proof-status">
      {running ? 'Running proof…' : 'Run proof'}
    </button>
    <p id="proof-status" role="status" aria-live="polite">{message}</p>
    {results.length > 0 && <section aria-label="Proof results">
      <h2>Results</h2>
      <ul>{results.map((result) => <li key={result.name}>
        <strong>{result.passed ? 'PASS' : 'FAIL'} — {result.name}</strong>: {result.detail}
      </li>)}</ul>
    </section>}
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<ProofApp />)
