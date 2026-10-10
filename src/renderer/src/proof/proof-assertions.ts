import { isStepCount, streamText, tool } from 'ai'
import { z } from 'zod'
import { proofModel, type ProofAction, type ProofBridge, type ProofScenario } from './proof-transport'

const STORAGE_KEY = 'm03b-proof-history'
const MAX_HISTORY_BYTES = 16 * 1024

export type ProofResult = { name: string; passed: boolean; detail: string }

function check(results: ProofResult[], name: string, condition: unknown, detail: string) {
  results.push({ name, passed: Boolean(condition), detail })
}

function actions(bridge: ProofBridge) {
  return {
    proof_fixture_action: tool({
      description: 'Return fixed local proof fixture output.',
      inputSchema: z.object({ action: z.enum(['first', 'second']) }),
      execute: ({ action }: { action: ProofAction }) => bridge.action(action),
    }),
  }
}

async function readText(result: { textStream: AsyncIterable<string> }) {
  let text = ''
  for await (const part of result.textStream) text += part
  return text
}

export async function runM03bAssertions(
  bridge: ProofBridge,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): Promise<ProofResult[]> {
  const results: ProofResult[] = []

  try {
    const normal = streamText({ model: proofModel(bridge, ['normal']), prompt: 'Say the fixture greeting.' })
    check(results, 'normal split UTF-8/SSE → SDK text', await readText(normal) === 'café', 'Expected café from split UTF-8 bytes and SSE frame.')
  } catch (error) {
    check(results, 'normal split UTF-8/SSE → SDK text', false, String(error))
  }

  try {
    const failed = streamText({ model: proofModel(bridge, ['error']), prompt: 'fail' })
    await readText(failed)
    check(results, 'provider errors reach SDK caller', false, 'Expected fixture stream failure.')
  } catch (error) {
    check(results, 'provider errors reach SDK caller', String(error).includes('fixture stream failed'), String(error))
  }

  let abortCalls = 0
  try {
    const beforeStart = new AbortController()
    beforeStart.abort()
    const abortedBeforeStart = streamText({ model: proofModel({
      ...bridge,
      stream: async (...args) => { abortCalls++; return bridge.stream(...args) },
    }, ['normal']), prompt: 'abort before start', abortSignal: beforeStart.signal })
    await readText(abortedBeforeStart)
    check(results, 'abort before start skips native registration', false, 'Expected AbortError.')
  } catch (error) {
    check(results, 'abort before start skips native registration', abortCalls === 0, String(error))
  }

  let cancelAccepted = 0
  let lateBytes = 0
  let actionsAfterAbort = 0
  const abortController = new AbortController()
  const abortBridge: ProofBridge = {
    ...bridge,
    cancel: async (runId) => {
      const accepted = await bridge.cancel(runId)
      if (accepted) cancelAccepted++
      return accepted
    },
    stream: (runId, scenario, onEvent) => bridge.stream(runId, scenario, (event) => {
      if (abortController.signal.aborted && event.event === 'chunk') lateBytes++
      onEvent(event)
    }),
    action: (action) => {
      if (abortController.signal.aborted) actionsAfterAbort++
      return bridge.action(action)
    },
  }
  try {
    const during = streamText({
      model: proofModel(abortBridge, ['abort'], () => abortController.abort()),
      prompt: 'abort after first raw bytes',
      abortSignal: abortController.signal,
    })
    await readText(during)
    check(results, 'abort during stream cancels producer', false, 'Expected AbortError.')
  } catch (error) {
    check(results, 'abort during stream cancels producer', cancelAccepted > 0 && String(error).includes('AbortError'), String(error))
  }
  check(results, 'abort drops late bytes and blocks later actions', lateBytes === 0 && actionsAfterAbort === 0, `late bytes=${lateBytes}, later actions=${actionsAfterAbort}`)

  try {
    const toolResults: string[] = []
    const turn = streamText({
      model: proofModel(bridge, ['tool_calls', 'normal']),
      prompt: 'Run both fixture actions, then say café.',
      tools: actions({ ...bridge, action: async (action) => {
        const value = await bridge.action(action)
        toolResults.push(`${action}:${value}`)
        return value
      } }),
      stopWhen: isStepCount(2),
    })
    const text = await readText(turn)
    const history = await turn.responseMessages
    const toolCalls = history.flatMap((message) => message.role === 'assistant' && Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool-call') : [])
    const resultsCount = history.flatMap((message) => message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : []).length
    check(results, 'two native calls and results, then final text',
      toolCalls.length === 2 && resultsCount === 2 && toolResults.join(',') === 'first:fixture:first,second:fixture:second' && text === 'café',
      `calls=${toolCalls.length}, results=${resultsCount}, text=${text}`)

    const serialized = JSON.stringify(history)
    if (new TextEncoder().encode(serialized).byteLength > MAX_HISTORY_BYTES) throw new Error('Proof history exceeds 16 KiB')
    storage.setItem(STORAGE_KEY, serialized)
    const reloadedHistory = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    const nextTurn = streamText({
      model: proofModel(bridge, ['normal']),
      messages: [
        { role: 'user', content: 'Run both fixture actions, then say café.' },
        ...reloadedHistory,
        { role: 'user', content: 'Continue from saved history.' },
      ],
    })
    const nextText = await readText(nextTurn)
    check(results, 'bounded history survives storage read and next SDK turn', nextText === 'café' && reloadedHistory.length === history.length, `restored=${reloadedHistory.length} messages, next=${nextText}`)
  } catch (error) {
    check(results, 'two native calls and results, then final text', false, String(error))
  }

  return results
}
