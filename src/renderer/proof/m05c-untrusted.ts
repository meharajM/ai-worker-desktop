import { invoke } from '@tauri-apps/api/core'

const result = document.querySelector<HTMLElement>('#result')!
const request = { protocolVersion: 1, ownerId: 'main', requestId: 'untrusted-owner-probe' }

try {
  await invoke('bridge_open_session', { request })
  result.textContent = 'FAIL: untrusted window unexpectedly opened native session'
} catch (error) {
  const message = typeof error === 'string' ? error : JSON.stringify(error)
  const passed = message.includes('unauthorized')
  result.textContent = `${passed ? 'PASS' : 'FAIL'} native untrusted-label denial: ${message}`
  result.dataset.outcome = passed ? 'pass' : 'fail'
}
