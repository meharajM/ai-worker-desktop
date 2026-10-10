import { proofFetch, type ProofBridge, type ProofEvent } from '../src/proof/proof-transport'

const results = document.querySelector<HTMLUListElement>('#results')!
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function bridgeFor(stream: ProofBridge['stream']): ProofBridge {
  return { stream, cancel: async () => true, action: async () => 'fixture:first' }
}

async function test(name: string, run: () => Promise<void>) {
  const row = document.createElement('li')
  results.append(row)
  try {
    await run()
    row.textContent = `PASS — ${name}`
  } catch (error) {
    row.textContent = `FAIL — ${name}: ${String(error)}`
  }
}

async function run() {
  await test('Channel byte fragments stay intact through Response stream', async () => {
    const bridge = bridgeFor(async (runId, _scenario, onEvent) => {
      onEvent({ event: 'chunk', data: { runId, bytes: [0xc3] } })
      onEvent({ event: 'chunk', data: { runId, bytes: [0xa9] } })
      onEvent({ event: 'complete', data: { runId } })
    })
    const response = await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid'), {})
    assert(response.headers.get('content-type') === 'text/event-stream', 'unexpected content type')
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert(bytes.length === 2 && bytes[0] === 0xc3 && bytes[1] === 0xa9, `unexpected bytes: ${Array.from(bytes)}`)
  })

  await test('pre-aborted request does not register native work', async () => {
    let starts = 0
    const bridge = bridgeFor(async () => { starts++ })
    const controller = new AbortController()
    controller.abort()
    try {
      await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid'), { signal: controller.signal })
      throw new Error('request unexpectedly started')
    } catch (error) {
      assert((error as DOMException).name === 'AbortError' && starts === 0, 'pre-abort registered native work')
    }
  })

  await test('abort before start acknowledgement cancels once after ack and ignores late events', async () => {
    let onEvent: ((event: ProofEvent) => void) | undefined
    let activeRunId = ''
    let acknowledge!: () => void
    let cancelCalls = 0
    const cancellations = () => cancelCalls
    const ack = new Promise<void>((resolve) => { acknowledge = resolve })
    const bridge = bridgeFor((runId, _scenario, callback) => {
      activeRunId = runId
      onEvent = callback
      return ack
    })
    bridge.cancel = async () => { cancelCalls++; return true }
    const controller = new AbortController()
    const response = await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid'), { signal: controller.signal })
    const reader = response.body!.getReader()
    const read = reader.read().catch((error: unknown) => error)
    controller.abort()
    assert(cancellations() === 0, 'cancel sent before native start acknowledgement')
    acknowledge()
    await pause()
    assert(cancellations() === 1, `expected one cancellation, got ${cancellations()}`)
    const error = await read
    assert(error instanceof DOMException && error.name === 'AbortError', 'read did not reject as AbortError')
    onEvent!({ event: 'chunk', data: { runId: activeRunId, bytes: [1] } })
    assert(cancellations() === 1, 'late event caused another cancellation')
  })

  await test('reader cancellation releases native producer once and drops late bytes', async () => {
    let onEvent: ((event: ProofEvent) => void) | undefined
    let activeRunId = ''
    let cancelCalls = 0
    const cancellations = () => cancelCalls
    const bridge = bridgeFor((runId, _scenario, callback) => {
      activeRunId = runId
      onEvent = callback
      return Promise.resolve()
    })
    bridge.cancel = async () => { cancelCalls++; return true }
    const response = await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid'), {})
    const reader = response.body!.getReader()
    await pause()
    onEvent!({ event: 'chunk', data: { runId: activeRunId, bytes: [7] } })
    assert((await reader.read()).value?.[0] === 7, 'first chunk missing')
    await reader.cancel()
    onEvent!({ event: 'chunk', data: { runId: activeRunId, bytes: [8] } })
    await pause()
    assert(cancellations() === 1 && (await reader.read()).done, `cancel calls=${cancellations()}`)
  })

  await test('native failure errors Response stream', async () => {
    const bridge = bridgeFor(async (runId, _scenario, onEvent) => {
      onEvent({ event: 'failed', data: { runId, message: 'fixture stream failed' } })
    })
    const response = await proofFetch(bridge, ['error'])(new Request('https://fixture.invalid'), {})
    const error = await response.body!.getReader().read().catch((reason: unknown) => reason)
    assert(error instanceof Error && String(error).includes('fixture stream failed'), String(error))
  })

  await test('oversized proof bytes fail and request producer cancellation', async () => {
    let cancelCalls = 0
    const cancellations = () => cancelCalls
    const bridge = bridgeFor(async (runId, _scenario, onEvent) => {
      onEvent({ event: 'chunk', data: { runId, bytes: Array(4097).fill(0) } })
    })
    bridge.cancel = async () => { cancelCalls++; return true }
    const response = await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid'), {})
    const error = await response.body!.getReader().read().catch((reason: unknown) => reason)
    await pause()
    assert(error instanceof Error && String(error).includes('exceeded 4 KiB') && cancellations() === 1, String(error))
  })
}

void run().catch((error) => {
  const row = document.createElement('li')
  row.textContent = `FAIL — transport checks aborted: ${String(error)}`
  results.append(row)
})
