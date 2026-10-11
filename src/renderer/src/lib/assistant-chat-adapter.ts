import type { ChatModelAdapter, ThreadMessage } from '@assistant-ui/react'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { MAX_LOCAL_CHAT_MESSAGES } from '../desktop-bridge'
import { createLocalChatGraph } from '../local-chat'

type ChatGraph = ReturnType<typeof createLocalChatGraph>

function graphMessages(messages: readonly ThreadMessage[]): BaseMessage[] {
  if (messages.length > MAX_LOCAL_CHAT_MESSAGES) {
    throw new Error(`This chat reached the ${MAX_LOCAL_CHAT_MESSAGES}-message context limit. Start a new chat to continue.`)
  }
  return messages.map((message) => {
    const content = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
    if (!content) throw new Error('Local chat supports text messages only.')
    if (message.role === 'user') return new HumanMessage(content)
    if (message.role === 'assistant') return new AIMessage(content)
    return new SystemMessage(content)
  })
}

export function createAssistantChatAdapter(graph: ChatGraph = createLocalChatGraph(), active = new Set<AbortController>()): ChatModelAdapter & { abortAll(): void } {
  return {
    abortAll() { for (const controller of active) controller.abort() },
    async *run({ messages, abortSignal }) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      active.add(controller)
      abortSignal.addEventListener('abort', abort, { once: true })
      if (abortSignal.aborted) abort()
      let answer = ''
      let lastUpdate = Date.now()
      const result = () => [{ type: 'text' as const, text: answer }]
      try {
        for await (const [chunk] of await graph.stream(graphMessages(messages), controller.signal)) {
          if (controller.signal.aborted) break
          if (typeof chunk.content !== 'string' || !chunk.content) continue
          answer += chunk.content
          const now = Date.now()
          if (now - lastUpdate >= 32) {
            yield { content: result(), status: { type: 'running' } }
            lastUpdate = now
          }
        }
        if (controller.signal.aborted) {
          yield { content: result(), status: { type: 'incomplete', reason: 'cancelled' } }
        } else if (!answer) {
          throw new Error('The local model returned an empty response.')
        } else {
          yield { content: result(), status: { type: 'complete', reason: 'stop' } }
        }
      } catch {
        if (controller.signal.aborted) yield { content: result(), status: { type: 'incomplete', reason: 'cancelled' } }
        else {
          if (!answer) answer = 'Local chat failed.'
          yield { content: result(), status: { type: 'incomplete', reason: 'other' } }
        }
      } finally {
        abortSignal.removeEventListener('abort', abort)
        active.delete(controller)
      }
    },
  }
}
