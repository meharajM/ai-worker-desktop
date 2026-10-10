import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { proofGraph } from './proof-graph'
import { restoreProofHistory, serializeProofHistory } from './proof-history'
import { proofModel } from './proof-provider'
import { proofFetch, type ProofBridge } from './proof-transport'

/**
 * proof-assertions.ts — runs named LangChain and LangGraph fixture assertions.
 *
 * Responsibilities: exercise provider text/error/abort behavior, verify the full
 * two-action graph turn, and round-trip canonical message history into a next turn.
 * Design decision: this shared harness runs only against Tauri's fixed native
 * fixture; browser transport checks never count as graph or provider proof.
 * Consumed by: the isolated Tauri proof page.
 */

const STORAGE_KEY = 'm03b-proof-history'
const SCENARIO_DEADLINE_MS = 8000
// Native abort fixture waits up to 1s before emitting its terminal event.
const NATIVE_ABORT_DEADLINE_MS = 2500

/** One named assertion shown by the isolated proof page. */
export type ProofResult = { name: string; passed: boolean; detail: string }

async function readText(stream: AsyncIterable<{ content: unknown }>) {
  let text = ''
  for await (const part of stream) {
    if (typeof part.content === 'string') text += part.content
  }
  return text
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs)
    promise.then((value) => {
      clearTimeout(timeout)
      resolve(value)
    })
  })
}

async function bounded<T>(label: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error(`${label} timed out after ${SCENARIO_DEADLINE_MS}ms`))
        }, SCENARIO_DEADLINE_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function modelText(model: ReturnType<typeof proofModel>, messages: { role: 'user'; content: string }[], signal?: AbortSignal) {
  return bounded('ChatOpenAI stream', signal, async (boundedSignal) =>
    readText(await model.stream(messages, { signal: boundedSignal, callbacks: [] })))
}

async function nativeByteText(bridge: ProofBridge) {
  const response = await proofFetch(bridge, ['normal'])(new Request('http://proof.invalid/v1/chat/completions'))
  return response.text()
}

/**
 * Runs real-framework assertions using the native fixed proof commands.
 * @param bridge - Isolated Tauri proof bridge.
 * @param storage - Storage interface for bounded canonical history round trip.
 * @returns Named results for the M03c native WebView run.
 */
export async function runM03bAssertions(
  bridge: ProofBridge,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  onProgress?: (message: string, result?: ProofResult) => void,
): Promise<ProofResult[]> {
  const results: ProofResult[] = []
  const record = (name: string, condition: unknown, detail: string) => {
    const result = { name, passed: Boolean(condition), detail }
    results.push(result)
    onProgress?.(`Finished: ${name}`, result)
  }

  onProgress?.('Checking raw bytes from the native Channel…')
  try {
    const bytes = await bounded('Native Channel byte preflight', undefined, () => nativeByteText(bridge))
    record('native Channel byte preflight reaches fixed fixture', bytes.includes('"content":"café"') && bytes.includes('[DONE]'), `bytes=${bytes.length}`)
  } catch (error) {
    record('native Channel byte preflight reaches fixed fixture', false, String(error))
  }

  let firstTurnMessages: BaseMessage[] | undefined
  onProgress?.('Checking ChatOpenAI text stream…')
  try {
    const model = proofModel(bridge, ['normal'])
    const text = await modelText(model, [{ role: 'user', content: 'Say the fixture greeting.' }])
    record('normal split UTF-8/SSE → ChatOpenAI text', text === 'café', `text=${text}`)
  } catch (error) {
    record('normal split UTF-8/SSE → ChatOpenAI text', false, String(error))
  }

  onProgress?.('Checking provider error propagation…')
  try {
    await modelText(proofModel(bridge, ['error']), [{ role: 'user', content: 'fail' }])
    record('provider errors reach LangChain caller', false, 'Expected fixture stream failure.')
  } catch (error) {
    record('provider errors reach LangChain caller', String(error).includes('fixture stream failed'), String(error))
  }

  onProgress?.('Checking pre-aborted provider request…')
  let abortStarts = 0
  try {
    const preAborted = new AbortController()
    preAborted.abort()
    const abortBridge: ProofBridge = {
      ...bridge,
      stream: (...args) => { abortStarts++; return bridge.stream(...args) },
    }
    await modelText(proofModel(abortBridge, ['normal']), [{ role: 'user', content: 'abort before start' }], preAborted.signal)
    record('abort before start skips native registration', false, 'Expected AbortError.')
  } catch (error) {
    record('abort before start skips native registration', abortStarts === 0 && String(error).includes('AbortError'), String(error))
  }

  onProgress?.('Checking mid-stream abort and native acknowledgement…')
  let acceptedCancels = 0
  let cancelCalls = 0
  const cancelResults: boolean[] = []
  let lateChunks = 0
  let actionsAfterAbort = 0
  let abortRunId: string | undefined
  let resolveCancelAcknowledgement!: (accepted: boolean) => void
  // Create this before streaming: the first chunk can abort before native start ACK,
  // so the bridge cancellation call may begin after modelText has already rejected.
  const cancelAcknowledgement = new Promise<boolean>((resolve) => { resolveCancelAcknowledgement = resolve })
  let cancelAckError = ''
  let resolveAborted!: (runId: string) => void
  const nativeAborted = new Promise<string>((resolve) => { resolveAborted = resolve })
  const abortController = new AbortController()
  const abortBridge: ProofBridge = {
    ...bridge,
    cancel: (runId) => {
      cancelCalls++
      return bridge.cancel(runId).then((accepted) => {
        if (accepted) acceptedCancels++
        cancelResults.push(accepted)
        resolveCancelAcknowledgement(accepted)
        return accepted
      }, (error) => {
        cancelAckError = String(error)
        resolveCancelAcknowledgement(false)
        return false
      })
    },
    stream: (runId, scenario, onEvent) => bridge.stream(runId, scenario, (event) => {
      abortRunId = runId
      if (abortController.signal.aborted && event.event === 'chunk') lateChunks++
      if (event.event === 'aborted' && event.data.runId === runId) resolveAborted(runId)
      onEvent(event)
    }),
    action: async (action) => {
      if (abortController.signal.aborted) actionsAfterAbort++
      return bridge.action(action)
    },
  }
  let abortError = ''
  try {
    const model = proofModel(abortBridge, ['abort'], () => abortController.abort())
    await modelText(model, [{ role: 'user', content: 'abort after first raw bytes' }], abortController.signal)
    abortError = 'Expected AbortError.'
  } catch (error) {
    abortError = String(error)
  }
  const [cancelAccepted, abortedRun] = await Promise.all([
    waitFor(cancelAcknowledgement, NATIVE_ABORT_DEADLINE_MS),
    waitFor(nativeAborted, NATIVE_ABORT_DEADLINE_MS),
  ])
  if (cancelAccepted === undefined && !cancelAckError) cancelAckError = cancelCalls ? 'acknowledgement timed out' : 'cancel not called'
  record('abort during stream awaits native cancel and matching Aborted event',
    cancelAccepted && acceptedCancels === 1 && abortRunId !== undefined && abortedRun === abortRunId && abortError.includes('AbortError'),
    `accepted=${cancelAccepted}, accepted calls=${acceptedCancels}, calls=${cancelCalls}, results=${cancelResults.join(',') || 'pending'}, ack=${cancelAckError || 'settled'}, aborted run=${abortedRun ?? 'timeout'}, stream run=${abortRunId ?? 'missing'}, stream=${abortError}`)
  record('abort drops late bytes and prevents later tool actions', lateChunks === 0 && actionsAfterAbort === 0,
    `late chunks=${lateChunks}, actions=${actionsAfterAbort}`)
  let producerCleaned = false
  let nextNativeText = ''
  try {
    producerCleaned = abortRunId !== undefined && await waitFor(bridge.cancel(abortRunId), NATIVE_ABORT_DEADLINE_MS) === false
    nextNativeText = await modelText(proofModel(bridge, ['normal']), [{ role: 'user', content: 'confirm native producer cleanup' }])
  } catch {
    // The named assertion below reports cleanup or follow-up stream failure.
  }
  record('abort cleans native state and next native run succeeds', producerCleaned && nextNativeText === 'café',
    `cleanup=${producerCleaned}, next text=${nextNativeText || 'failed'}`)

  let unsafeHistoryRejected = false
  try {
    restoreProofHistory(JSON.stringify([{
      type: 'ai',
      data: { content: '', tool_calls: [{ name: 'arbitrary_native_command', id: 'call_bad', args: { action: 'first' } }] },
    }]))
  } catch {
    unsafeHistoryRejected = true
  }
  record('restored history rejects unregistered tool calls', unsafeHistoryRejected, 'Only fixed proof_fixture_action records may be restored.')

  onProgress?.('Checking two native actions through LangGraph…')
  const graphTrace: string[] = []
  try {
    const nativeResults: string[] = []
    const fixtureBridge: ProofBridge = {
      ...bridge,
      stream: (runId, scenario, onEvent) => {
        graphTrace.push(`${scenario}:started`)
        onProgress?.(`LangGraph fixture stream ${scenario} started…`)
        return bridge.stream(runId, scenario, (event) => {
          graphTrace.push(`${scenario}:${event.event}`)
          onProgress?.(`LangGraph fixture stream ${scenario}: ${event.event}…`)
          onEvent(event)
        }).then(() => { graphTrace.push(`${scenario}:invoke-returned`) }, (error) => {
          graphTrace.push(`${scenario}:invoke-failed=${String(error)}`)
          throw error
        })
      },
      action: async (action) => {
        graphTrace.push(`action:${action}:started`)
        onProgress?.(`LangGraph native action ${action} started…`)
        const value = await bridge.action(action)
        graphTrace.push(`action:${action}:returned`)
        onProgress?.(`LangGraph native action ${action} returned…`)
        nativeResults.push(`${action}:${value}`)
        return value
      },
    }
    const firstTurn = await bounded('LangGraph tool turn', undefined, (signal) => proofGraph(fixtureBridge, ['tool_calls', 'normal']).invoke(
      [new HumanMessage('Run both fixture actions, then say café.')], signal,
    ))
    firstTurnMessages = firstTurn.messages
    const assistantCalls = firstTurn.messages.filter((message): message is AIMessage => message instanceof AIMessage)
      .flatMap((message) => message.tool_calls)
    const toolResults = firstTurn.messages.filter((message): message is ToolMessage => message instanceof ToolMessage)
    const finalText = [...firstTurn.messages].reverse().find((message) => message instanceof AIMessage)?.content
    record('two native calls/results route through graph before final text',
      assistantCalls.length === 2 && toolResults.length === 2 &&
      [...nativeResults].sort().join(',') === 'first:fixture:first,second:fixture:second' && finalText === 'café',
      `calls=${assistantCalls.length}, results=${toolResults.length}, native=${nativeResults.join(',')}, final=${String(finalText)}`)
  } catch (error) {
    record('two native calls/results route through graph before final text', false, `${String(error)}; trace=${graphTrace.join(' > ') || 'none'}`)
  }

  onProgress?.('Checking saved canonical history in a new graph turn…')
  try {
    if (!firstTurnMessages) throw new Error('Graph turn did not complete.')
    const serialized = serializeProofHistory(firstTurnMessages)
    storage.setItem(STORAGE_KEY, serialized)
    const restored = restoreProofHistory(storage.getItem(STORAGE_KEY) ?? 'null')
    const nextTurn = await bounded('LangGraph history turn', undefined, (signal) => proofGraph(bridge, ['normal']).invoke([
      ...restored,
      new HumanMessage('Continue from saved history.'),
    ], signal))
    const nextText = [...nextTurn.messages].reverse().find((message) => message instanceof AIMessage)?.content
    const restoredCalls = restored.filter((message) => message instanceof AIMessage)
      .flatMap((message) => message.tool_calls)
    const restoredResults = restored.filter((message) => message instanceof ToolMessage)
    record('bounded canonical history restores both tool results and feeds next graph turn',
      restoredCalls.length === 2 && restoredResults.length === 2 && restored.length === firstTurnMessages.length && nextText === 'café',
      `restored=${restored.length}, calls=${restoredCalls.length}, results=${restoredResults.length}, next=${String(nextText)}`)
  } catch (error) {
    record('bounded canonical history restores both tool results and feeds next graph turn', false, String(error))
  }

  return results
}
