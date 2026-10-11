import type { ReactNode } from 'react'
import { MAX_LOCAL_CHAT_MESSAGES } from '../desktop-bridge'
import { isLocalChatAtLimit } from './local-chat-limit'

export function ChatLimitNotice({ messageCount }: { messageCount: number }) {
  if (!isLocalChatAtLimit(messageCount)) return null
  return <p role="status" className="text-sm text-[var(--color-text-secondary)]">This chat reached the {MAX_LOCAL_CHAT_MESSAGES}-message context limit. Start a new chat to continue.</p>
}

export function HistoryPersistenceNotice({ error }: { error: unknown }): ReactNode {
  if (!error) return null
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  const message = code === 'history_full'
    ? 'Chat history is full. This reply was not saved and will not return after restart. Stored history has reached its capacity.'
    : 'This reply could not be saved to chat history. It is visible only in this window and will not return after restart.'
  return <p role="alert" className="mt-1 text-xs text-amber-300">{message}</p>
}
