import { useEffect, useMemo } from 'react'
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, type MessageState } from '@assistant-ui/react'
import { createAssistantChatAdapter } from './lib/assistant-chat-adapter'
import { createChatHistoryAdapter } from './lib/assistant-chat-history'
import type { openChatHistory } from './lib/chat-history'

type ChatHistory = Awaited<ReturnType<typeof openChatHistory>>

export function LocalAssistantChat({ history, sessionId, modelReady }: { history: ChatHistory; sessionId: string; modelReady: boolean }) {
  return <LocalAssistantRuntime key={sessionId} history={history} sessionId={sessionId} modelReady={modelReady} />
}

function LocalAssistantRuntime({ history, sessionId, modelReady }: { history: ChatHistory; sessionId: string; modelReady: boolean }) {
  const adapter = useMemo(() => createAssistantChatAdapter(), [])
  const historyAdapter = useMemo(() => createChatHistoryAdapter(history, sessionId), [history, sessionId])
  const assistantRuntime = useLocalRuntime(adapter, { adapters: { history: historyAdapter } })
  useEffect(() => () => adapter.abortAll(), [adapter])
  return (
    <AssistantRuntimeProvider runtime={assistantRuntime}>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            {modelReady ? 'Ready · local model' : 'Import the developer model from Settings to start chatting.'}
          </p>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" role="log" aria-live="polite" aria-label="Conversation">
          <ThreadPrimitive.Messages>{({ message }: { message: MessageState }) => (
            <article key={message.id} className="whitespace-pre-wrap text-sm">
              <p className="mb-1 text-xs font-medium capitalize text-[var(--color-text-secondary)]">
                {message.role}{message.role === 'assistant' && message.status.type === 'running' ? ' · generating' : ''}
              </p>
              {message.content.map((part, index) => part.type === 'text' && <p key={index}>{part.text || (message.role === 'assistant' && message.status.type === 'running' ? 'Starting local model…' : '')}</p>)}
              {message.role === 'assistant' && message.status.type === 'incomplete' && (
                <p role="status" className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {message.status.reason === 'cancelled' ? 'Response stopped. Partial output is shown.' : 'Response failed. Partial output is shown.'}
                </p>
              )}
            </article>
          )}</ThreadPrimitive.Messages>
        </div>
        <Composer modelReady={modelReady} />
      </div>
    </AssistantRuntimeProvider>
  )
}

function Composer({ modelReady }: { modelReady: boolean }) {
  const isRunning = useAuiState((state) => state.thread.isRunning)
  return (
    <ComposerPrimitive.Root className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <ComposerPrimitive.Input aria-label="Message the local model" disabled={!modelReady} placeholder="Message the local model… (Enter sends, Shift+Enter adds a line)" className="w-full resize-y bg-transparent text-sm outline-none disabled:opacity-60" />
      <div className="flex justify-end gap-2 pt-2">
        <ComposerPrimitive.Cancel type="button" disabled={!isRunning} className="rounded px-3 py-1 text-sm disabled:opacity-50">Stop</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send type="submit" disabled={!modelReady} className="rounded bg-[var(--color-accent)] px-3 py-1 text-sm disabled:opacity-50">Send</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}
