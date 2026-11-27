export type LocalChatTurn = { role: 'user' | 'assistant'; content: string }

export const MAX_LOCAL_CHAT_PROMPT_LENGTH = 8_000

const HISTORY_PREFIX = 'Earlier conversation, newest last:\n'
const CURRENT_PREFIX = '\n\nCurrent user message:\n'
const HISTORY_TURN_LIMIT = 10

function tailWithinLimit(text: string, maxLength: number) {
  let start = Math.max(0, text.length - maxLength)
  if (start > 0) {
    const first = text.charCodeAt(start)
    if (first >= 0xdc00 && first <= 0xdfff) start += 1
  }
  return text.slice(start)
}

export function buildLocalChatPrompt(messages: LocalChatTurn[], currentMessage: string) {
  const current = currentMessage.trim()
  const currentSection = `${CURRENT_PREFIX}${current}`
  let remaining = MAX_LOCAL_CHAT_PROMPT_LENGTH - HISTORY_PREFIX.length - currentSection.length
  if (messages.length === 0 || remaining <= 0) return current

  const history: string[] = []
  const recent = messages.slice(-HISTORY_TURN_LIMIT)
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index]
    const content = turn.content.trim()
    if (!content) continue

    const label = turn.role === 'user' ? 'User: ' : 'Assistant: '
    const separatorLength = history.length > 0 ? 1 : 0
    const entryLength = label.length + content.length + separatorLength
    if (entryLength <= remaining) {
      history.unshift(`${label}${content}`)
      remaining -= entryLength
      continue
    }

    const omitted = '[Earlier text omitted]\n'
    const contentLength = remaining - label.length - omitted.length - separatorLength
    if (contentLength > 0) {
      history.unshift(`${label}${omitted}${tailWithinLimit(content, contentLength)}`)
    }
    break
  }

  return history.length > 0
    ? `${HISTORY_PREFIX}${history.join('\n')}${currentSection}`
    : current
}
