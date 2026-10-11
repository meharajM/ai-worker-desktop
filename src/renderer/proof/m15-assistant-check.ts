import type { ThreadHistoryAdapter } from '@assistant-ui/react'
import { AIMessageChunk } from '@langchain/core/messages'
import { createAssistantChatAdapter } from '../src/lib/assistant-chat-adapter'
import { createChatHistoryAdapter } from '../src/lib/assistant-chat-history'
import type { TerminalTurn } from '../src/lib/chat-history'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export async function runM15HistoryAssertions(): Promise<void> {
  const committed: TerminalTurn[] = []
  const history = {
    async listTurns() { return { rows: committed, nextCursor: null } },
    async commitTerminalTurn(turn: TerminalTurn) { committed.push(turn); return 'committed' as const },
  }
  const adapter: ThreadHistoryAdapter = createChatHistoryAdapter(history as never, 'session_1')
  const restored = await adapter.load()
  assert(restored.messages.length === 0, 'new session should restore empty history')
  const now = new Date('2026-01-01T00:00:00.000Z')
  await adapter.append({ parentId: null, message: {
    id: 'user_1', role: 'user', createdAt: now, content: [{ type: 'text', text: 'question' }], attachments: [],
    metadata: { custom: {} },
  } })
  assert(Number(committed.length) === 0, 'user message must not commit an incomplete turn')
  await adapter.append({ parentId: 'user_1', message: {
    id: 'assistant_1', role: 'assistant', createdAt: now, content: [{ type: 'text', text: 'partial' }],
    status: { type: 'incomplete', reason: 'cancelled' },
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
  } })
  assert(committed.length === 1, 'assistant terminal message should commit one turn')
  assert(committed[0].userText === 'question' && committed[0].assistantText === 'partial' && committed[0].status === 'canceled', 'canceled partial turn should persist intact')
  const restoredTurn = await adapter.load()
  assert(restoredTurn.messages.length === 2 && restoredTurn.headId === 'assistant_1', 'persisted turn should restore as a linked message pair')
}

export async function runM15CancellationAssertions(): Promise<void> {
  let nativeSignal: AbortSignal | undefined
  const graph = {
    async *stream(_messages: unknown[], signal?: AbortSignal) {
      nativeSignal = signal
      yield [new AIMessageChunk({ content: 'partial' }), {}] as const
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    },
  }
  const adapter = createAssistantChatAdapter(graph as never)
  const controller = new AbortController()
  const updates: { content?: readonly { type: string; text?: string }[]; status?: { type: string; reason?: string } }[] = []
  const run = (async () => {
    const result = adapter.run({
      messages: [{ id: 'user_1', role: 'user', createdAt: new Date(), content: [{ type: 'text', text: 'question' }], attachments: [], metadata: { custom: {} } }],
      runConfig: {}, context: {}, abortSignal: controller.signal, unstable_getMessage: () => ({} as never),
    })
    if (Symbol.asyncIterator in result) {
      for await (const update of result) updates.push(update)
    } else updates.push(await result)
  })()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await run
  assert(nativeSignal?.aborted, 'cancel must reach graph execution signal')
  assert(updates.some((update) => update.status?.type === 'incomplete' && update.status.reason === 'cancelled'), 'cancel should terminate as incomplete')
  assert(updates.at(-1)?.content?.[0]?.text === 'partial', 'canceled partial text should remain visible')
}
