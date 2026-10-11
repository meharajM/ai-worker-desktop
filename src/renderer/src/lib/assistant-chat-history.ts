import type { ThreadHistoryAdapter, ThreadMessage } from '@assistant-ui/react'
import { openChatHistory, type TerminalTurn } from './chat-history'

type ChatHistory = Awaited<ReturnType<typeof openChatHistory>>

function textOf(message: ThreadMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
}

function storedMessages(turn: TerminalTurn): ThreadMessage[] {
  const createdAt = new Date(turn.endedAt)
  return [
    { id: `user_${turn.turnId}`, createdAt, role: 'user', content: [{ type: 'text', text: turn.userText }], attachments: [], metadata: { custom: {} } },
    {
      id: turn.turnId, createdAt, role: 'assistant', content: [{ type: 'text', text: turn.assistantText }],
      status: turn.status === 'completed'
        ? { type: 'complete', reason: 'stop' }
        : { type: 'incomplete', reason: turn.status === 'canceled' ? 'cancelled' : 'other' },
      metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
    },
  ]
}

export function createChatHistoryAdapter(history: ChatHistory, sessionId: string, onPersistenceError: (messageId: string, error: unknown) => void = () => {}): ThreadHistoryAdapter {
  let pending: { id: string; text: string } | undefined
  return {
    scopeId: sessionId,
    async load() {
      const turns: TerminalTurn[] = []
      let cursor: { endedAt: string; turnId: string } | undefined
      do {
        const page = await history.listTurns(sessionId, { limit: 50, ...(cursor ? { cursor } : {}) })
        turns.push(...page.rows)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      let parentId: string | null = null
      const messages = turns.flatMap((turn) => {
        const [user, assistant] = storedMessages(turn)
        const pair = [{ message: user, parentId }, { message: assistant, parentId: user.id }]
        parentId = assistant.id
        return pair
      })
      return { messages, headId: parentId }
    },
    async append({ parentId, message }) {
      if (message.role === 'user') {
        pending = { id: message.id, text: textOf(message) }
        return
      }
      if (message.role !== 'assistant' || !pending || parentId !== pending.id) return
      const turn: TerminalTurn = {
        turnId: message.id,
        sessionId,
        userText: pending.text,
        assistantText: textOf(message),
        status: message.status.type === 'complete' ? 'completed' : message.status.type === 'incomplete' && message.status.reason === 'cancelled' ? 'canceled' : 'failed',
        endedAt: new Date().toISOString(),
      }
      try {
        await history.commitTerminalTurn(turn)
      } catch (error) {
        onPersistenceError(message.id, error)
      } finally {
        pending = undefined
      }
    },
  }
}
