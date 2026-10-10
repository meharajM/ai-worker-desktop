import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { proofGraph } from './proof-graph'
import { restoreProofHistory, serializeProofHistory } from './proof-history'
import { proofModel } from './proof-provider'
import type { ProofBridge } from './proof-transport'

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

/** One named assertion shown by the isolated proof page. */
export type ProofResult = { name: string; passed: boolean; detail: string }

function check(results: ProofResult[], name: string, condition: unknown, detail: string) {
  results.push({ name, passed: Boolean(condition), detail })
}

async function readText(stream: AsyncIterable<{ content: unknown }>) {
  let text = ''
  for await (const part of stream) {
    if (typeof part.content === 'string') text += part.content
  }
  return text
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
): Promise<ProofResult[]> {
  const results: ProofResult[] = []

  let firstTurnMessages: BaseMessage[] | undefined
  try {
    const model = proofModel(bridge, ['normal'])
    const text = await readText(await model.stream([{ role: 'user', content: 'Say the fixture greeting.' }], { callbacks: [] }))
    check(results, 'normal split UTF-8/SSE → ChatOpenAI text', text === 'café', `text=${text}`)
  } catch (error) {
    check(results, 'normal split UTF-8/SSE → ChatOpenAI text', false, String(error))
  }

  try {
    await readText(await proofModel(bridge, ['error']).stream([{ role: 'user', content: 'fail' }], { callbacks: [] }))
    check(results, 'provider errors reach LangChain caller', false, 'Expected fixture stream failure.')
  } catch (error) {
    check(results, 'provider errors reach LangChain caller', String(error).includes('fixture stream failed'), String(error))
  }

  let abortStarts = 0
  try {
    const preAborted = new AbortController()
    preAborted.abort()
    const abortBridge: ProofBridge = {
      ...bridge,
      stream: (...args) => { abortStarts++; return bridge.stream(...args) },
    }
    await readText(await proofModel(abortBridge, ['normal']).stream(
      [{ role: 'user', content: 'abort before start' }], { signal: preAborted.signal, callbacks: [] },
    ))
    check(results, 'abort before start skips native registration', false, 'Expected AbortError.')
  } catch (error) {
    check(results, 'abort before start skips native registration', abortStarts === 0 && String(error).includes('AbortError'), String(error))
  }

  let acceptedCancels = 0
  let lateChunks = 0
  let actionsAfterAbort = 0
  const abortController = new AbortController()
  const abortBridge: ProofBridge = {
    ...bridge,
    cancel: async (runId) => {
      const accepted = await bridge.cancel(runId)
      if (accepted) acceptedCancels++
      return accepted
    },
    stream: (runId, scenario, onEvent) => bridge.stream(runId, scenario, (event) => {
      if (abortController.signal.aborted && event.event === 'chunk') lateChunks++
      onEvent(event)
    }),
    action: async (action) => {
      if (abortController.signal.aborted) actionsAfterAbort++
      return bridge.action(action)
    },
  }
  try {
    await readText(await proofModel(abortBridge, ['abort'], () => abortController.abort()).stream(
      [{ role: 'user', content: 'abort after first raw bytes' }], { signal: abortController.signal, callbacks: [] },
    ))
    check(results, 'abort during stream cancels native producer', false, 'Expected AbortError.')
  } catch (error) {
    check(results, 'abort during stream cancels native producer', acceptedCancels === 1 && String(error).includes('AbortError'), String(error))
  }
  check(results, 'abort drops late bytes and prevents later tool actions', lateChunks === 0 && actionsAfterAbort === 0,
    `late chunks=${lateChunks}, actions=${actionsAfterAbort}`)

  let unsafeHistoryRejected = false
  try {
    restoreProofHistory(JSON.stringify([{
      type: 'ai',
      data: { content: '', tool_calls: [{ name: 'arbitrary_native_command', id: 'call_bad', args: { action: 'first' } }] },
    }]))
  } catch {
    unsafeHistoryRejected = true
  }
  check(results, 'restored history rejects unregistered tool calls', unsafeHistoryRejected, 'Only fixed proof_fixture_action records may be restored.')

  try {
    const nativeResults: string[] = []
    const fixtureBridge: ProofBridge = {
      ...bridge,
      action: async (action) => {
        const value = await bridge.action(action)
        nativeResults.push(`${action}:${value}`)
        return value
      },
    }
    const firstTurn = await proofGraph(fixtureBridge, ['tool_calls', 'normal']).invoke(
      [new HumanMessage('Run both fixture actions, then say café.')],
    )
    firstTurnMessages = firstTurn.messages
    const assistantCalls = firstTurn.messages.filter((message): message is AIMessage => message instanceof AIMessage)
      .flatMap((message) => message.tool_calls)
    const toolResults = firstTurn.messages.filter((message): message is ToolMessage => message instanceof ToolMessage)
    const finalText = [...firstTurn.messages].reverse().find((message) => message instanceof AIMessage)?.content
    check(results, 'two native calls/results route through graph before final text',
      assistantCalls.length === 2 && toolResults.length === 2 &&
      [...nativeResults].sort().join(',') === 'first:fixture:first,second:fixture:second' && finalText === 'café',
      `calls=${assistantCalls.length}, results=${toolResults.length}, native=${nativeResults.join(',')}, final=${String(finalText)}`)
  } catch (error) {
    check(results, 'two native calls/results route through graph before final text', false, String(error))
  }

  try {
    if (!firstTurnMessages) throw new Error('Graph turn did not complete.')
    const serialized = serializeProofHistory(firstTurnMessages)
    storage.setItem(STORAGE_KEY, serialized)
    const restored = restoreProofHistory(storage.getItem(STORAGE_KEY) ?? 'null')
    const nextTurn = await proofGraph(bridge, ['normal']).invoke([
      ...restored,
      new HumanMessage('Continue from saved history.'),
    ])
    const nextText = [...nextTurn.messages].reverse().find((message) => message instanceof AIMessage)?.content
    const restoredCalls = restored.filter((message) => message instanceof AIMessage)
      .flatMap((message) => message.tool_calls)
    const restoredResults = restored.filter((message) => message instanceof ToolMessage)
    check(results, 'bounded canonical history restores both tool results and feeds next graph turn',
      restoredCalls.length === 2 && restoredResults.length === 2 && restored.length === firstTurnMessages.length && nextText === 'café',
      `restored=${restored.length}, calls=${restoredCalls.length}, results=${restoredResults.length}, next=${String(nextText)}`)
  } catch (error) {
    check(results, 'bounded canonical history restores both tool results and feeds next graph turn', false, String(error))
  }

  return results
}
