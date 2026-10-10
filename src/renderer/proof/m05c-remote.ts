import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

const request = { protocolVersion: 1, ownerId: 'main', requestId: 'remote-origin-probe' }
const params = new URLSearchParams(location.search)
const nativeLabel = getCurrentWindow().label
const page = document.querySelector<HTMLElement>('#result')!
page.textContent = `REMOTE MODULE STARTED; native window=${nativeLabel}; invoking bridge_open_session`

try {
  await invoke('bridge_open_session', { request })
  location.replace('/report?outcome=unexpected-success')
} catch (error) {
  const denial = typeof error === 'string' ? error : JSON.stringify(error)
  page.textContent = `REMOTE MODULE STARTED; IPC denial: ${denial}`
  const report = new URL('/report', location.origin)
  report.searchParams.set('started', '1')
  report.searchParams.set('denial', denial)
  report.searchParams.set('label', nativeLabel)
  report.searchParams.set('rows', params.get('rows') ?? '[]')
  setTimeout(() => location.replace(report), 400)
}
