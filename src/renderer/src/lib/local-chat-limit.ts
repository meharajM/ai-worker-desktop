import { MAX_LOCAL_CHAT_MESSAGES } from '../desktop-bridge'

export function isLocalChatAtLimit(messageCount: number): boolean {
  return messageCount >= MAX_LOCAL_CHAT_MESSAGES
}

export function canSendLocalChat(modelReady: boolean, messageCount: number): boolean {
  return modelReady && !isLocalChatAtLimit(messageCount)
}
