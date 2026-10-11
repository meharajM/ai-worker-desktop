import { proofFetch, type ProofBridge, type ProofEvent } from '../src/proof/proof-transport'
import { AIMessage, AIMessageChunk, mapChatMessagesToStoredMessages, ToolMessage } from '@langchain/core/messages'
import { normalizeGraphMessage } from '../src/proof/proof-graph'
import { restoreProofHistory, serializeProofHistory } from '../src/proof/proof-history'
import { hasExpectedFixtureToolPairs } from '../src/proof/proof-assertions'
import { runM14MockAssertions } from './m14-local-chat-check'
import { runM15CancellationAssertions, runM15HistoryAssertions, runM15LimitAndPersistenceAssertions } from './m15-assistant-check'

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
  await test('M15 history adapter commits one atomic terminal turn and restores it', runM15HistoryAssertions)
  await test('M15 Stop aborts graph and preserves partial output', runM15CancellationAssertions)
  await test('M15 cap notice blocks futile sends and failed history commit is labeled unsaved', runM15LimitAndPersistenceAssertions)
  await runM14MockAssertions((result) => {
    const row = document.createElement('li')
    row.textContent = `${result.passed ? 'PASS' : 'FAIL'} — ${result.name}: ${result.detail}`
    results.append(row)
  })

  await test('shared graph predicate requires exact call/result pairs', async () => {
    const assistant = new AIMessage({ tool_calls: [
      { id: 'call_a', name: 'proof_fixture_action', args: { action: 'first' }, type: 'tool_call' },
      { id: 'call_b', name: 'proof_fixture_action', args: { action: 'second' }, type: 'tool_call' },
    ] })
    const paired = [
      new ToolMessage({ tool_call_id: 'call_b', content: 'fixture:second' }),
      new ToolMessage({ tool_call_id: 'call_a', content: 'fixture:first' }),
    ]
    assert(hasExpectedFixtureToolPairs(assistant.tool_calls, paired), 'correct pairs failed when results arrived out of order')
    assert(!hasExpectedFixtureToolPairs(assistant.tool_calls, [
      new ToolMessage({ tool_call_id: 'call_b', content: 'fixture:first' }),
      paired[1],
    ]), 'mismatched result content passed')
    assert(!hasExpectedFixtureToolPairs(assistant.tool_calls, [
      new ToolMessage({ tool_call_id: 'call_a', content: 'fixture:first' }),
      new ToolMessage({ tool_call_id: 'call_a', content: 'fixture:first' }),
    ]), 'duplicate result id passed')
  })

  await test('streamed AI message keeps canonical fields through history', async () => {
    const normalized = normalizeGraphMessage(new AIMessageChunk({
      content: '',
      id: 'fixture-response',
      name: 'fixture',
      additional_kwargs: { marker: 'kept' },
      response_metadata: { model_provider: 'openai', marker: 'kept' },
      tool_calls: [{ name: 'proof_fixture_action', args: { action: 'first' }, id: 'call_a', type: 'tool_call' }],
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }))
    const stored = mapChatMessagesToStoredMessages([normalized])[0]
    const [restored] = restoreProofHistory(serializeProofHistory([normalized]))
    assert(normalized instanceof AIMessage && stored.data !== undefined, 'official mapper omitted AI message data')
    assert(restored instanceof AIMessage && restored.id === 'fixture-response' && restored.name === 'fixture', 'message identity was lost')
    assert(restored.tool_calls?.[0]?.id === 'call_a' && restored.tool_calls?.[0]?.args.action === 'first', 'tool call was lost')
    assert(restored.additional_kwargs.marker === 'kept' && restored.response_metadata.marker === 'kept', 'message metadata was lost')
    assert(restored.usage_metadata?.total_tokens === 2, 'usage metadata was lost')
  })

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

  await test('pre-aborted Request.signal does not register native work', async () => {
    let starts = 0
    const bridge = bridgeFor(async () => { starts++ })
    const controller = new AbortController()
    controller.abort()
    try {
      await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid', { signal: controller.signal }))
      throw new Error('request unexpectedly started')
    } catch (error) {
      assert((error as DOMException).name === 'AbortError' && starts === 0, 'Request.signal did not stop native work')
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

  await test('first-byte abort waits for deferred start ack and records accepted cancel', async () => {
    let onEvent: ((event: ProofEvent) => void) | undefined
    let activeRunId = ''
    let acknowledge!: () => void
    let cancelCalls = 0
    const cancelResults: boolean[] = []
    const cancellations = () => cancelCalls
    const ack = new Promise<void>((resolve) => { acknowledge = resolve })
    const bridge = bridgeFor((runId, _scenario, callback) => {
      activeRunId = runId
      onEvent = callback
      return ack
    })
    bridge.cancel = async () => { cancelCalls++; cancelResults.push(true); return true }
    const controller = new AbortController()
    await proofFetch(bridge, ['normal'], () => controller.abort())(
      new Request('https://fixture.invalid', { signal: controller.signal }),
    )
    onEvent!({ event: 'chunk', data: { runId: activeRunId, bytes: [1] } })
    assert(cancelCalls === 0, 'cancel sent before native start acknowledgement')
    acknowledge()
    await pause()
    assert(cancellations() === 1, `expected one transport cancel, got ${cancellations()}`)
    assert(cancelResults[0] === true, 'accepted cancellation result was not observable')
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

  await test('silent native producer times out and is cancelled', async () => {
    let cancelCalls = 0
    const bridge = bridgeFor(async () => undefined)
    bridge.cancel = async () => { cancelCalls++; return true }
    const response = await proofFetch(bridge, ['normal'])(new Request('https://fixture.invalid'), {})
    const error = await response.body!.getReader().read().catch((reason: unknown) => reason)
    assert(error instanceof Error && String(error).includes('timed out after 5000ms') && cancelCalls === 1,
      `error=${String(error)}, cancels=${cancelCalls}`)
  })
}

void run().catch((error) => {
  const row = document.createElement('li')
  row.textContent = `FAIL — transport checks aborted: ${String(error)}`
  results.append(row)
})
