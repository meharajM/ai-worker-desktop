import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import '../src/index.css'
import { LocalApp } from '../src/LocalApp'
import { desktopBridge } from '../src/desktop-bridge'

type Row = { name: string; outcome: 'PASS' | 'FAIL'; evidence: string }

function errorText(error: unknown): string {
  return typeof error === 'string' ? error : JSON.stringify(error)
}

async function denied<T>(name: string, expected: RegExp, action: () => Promise<T>): Promise<Row> {
  try {
    await action()
    return { name, outcome: 'FAIL', evidence: 'unexpected success' }
  } catch (error) {
    const evidence = errorText(error)
    return { name, outcome: expected.test(evidence) ? 'PASS' : 'FAIL', evidence }
  }
}

async function runRows(): Promise<Row[]> {
  const rows: Row[] = []
  try {
    const status = await desktopBridge.getStatus()
    rows.push({
      name: 'Production desktopBridge happy status',
      outcome: status.available && status.protocolVersion === 1 && status.ownerId === 'main' && !!status.sessionId && !!status.requestId ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(status),
    })
  } catch (error) {
    rows.push({ name: 'Production desktopBridge happy status', outcome: 'FAIL', evidence: errorText(error) })
  }

  rows.push(await denied('Unknown DTO field rejected by IPC', /unknown field|invalid args|invalid_request/i, () =>
    invoke('bridge_open_session', { request: { protocolVersion: 1, ownerId: 'main', requestId: 'unknown-field', unexpected: true } })))
  rows.push(await denied('Unsupported protocol version rejected', /invalid_request/i, () =>
    invoke('bridge_open_session', { request: { protocolVersion: 2, ownerId: 'main', requestId: 'bad-protocol' } })))
  rows.push(await denied('Oversized request ID rejected', /invalid_request/i, () =>
    invoke('bridge_open_session', { request: { protocolVersion: 1, ownerId: 'main', requestId: 'x'.repeat(2048) } })))
  rows.push(await denied('Forged owner claim rejected', /unauthorized/i, () =>
    invoke('bridge_open_session', { request: { protocolVersion: 1, ownerId: 'forged', requestId: 'forged-owner' } })))

  try {
    const first = await invoke<{ sessionId: string }>('bridge_open_session', {
      request: { protocolVersion: 1, ownerId: 'main', requestId: 'stale-open-one' },
    })
    await invoke('bridge_open_session', { request: { protocolVersion: 1, ownerId: 'main', requestId: 'stale-open-two' } })
    rows.push(await denied('Replaced session rejected as stale', /stale_session/i, () =>
      invoke('bridge_get_status', { request: { protocolVersion: 1, ownerId: 'main', sessionId: first.sessionId, requestId: 'stale-status' } })))
  } catch (error) {
    rows.push({ name: 'Replaced session rejected as stale', outcome: 'FAIL', evidence: errorText(error) })
  }

  rows.push(await denied('Registered unprivileged proof action denied by ACL', /not allowed|permission denied|capability|denied/i, () =>
    invoke('proof_fixture_action', { action: 'first' })))
  return rows
}

function Harness() {
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [remoteStarted, setRemoteStarted] = useState(false)

  async function run() {
    if (running) return
    setRunning(true)
    const results = await runRows()
    setRows(results)
    const remote = new URLSearchParams(location.search).get('remote')
    if (!remote) return
    setRemoteStarted(true)
    const remoteUrl = new URL(remote)
    remoteUrl.searchParams.set('rows', JSON.stringify(results))
    setTimeout(() => location.assign(remoteUrl), 1200)
  }

  return (
    <>
      <LocalApp />
      <aside style={{ position: 'fixed', top: 12, right: 12, zIndex: 10, width: 390, maxHeight: '45vh', overflow: 'auto', background: 'white', color: 'black', border: '2px solid #333', padding: 12, font: '12px monospace' }}>
        <h2>M05c native boundary checks</h2>
        <button type="button" disabled={running} onClick={() => void run()}>
          Run native boundary checks
        </button>
        <ul aria-live="polite">
          {rows.map((row) => <li key={row.name}><b>{row.outcome}</b> {row.name}: {row.evidence}</li>)}
        </ul>
        {remoteStarted && <p id="remote-started">Local checks passed; remote origin probe starting.</p>}
      </aside>
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />)
