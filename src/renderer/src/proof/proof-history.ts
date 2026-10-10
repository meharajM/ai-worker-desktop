import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
} from '@langchain/core/messages'

/**
 * proof-history.ts — stores validated canonical LangChain message DTOs.
 *
 * Responsibilities: bound serialized history and validate its JSON shape before
 * the official mapper reconstructs BaseMessage instances.
 * Design decision: restored history is untrusted input; validating first keeps
 * malformed tool calls from becoming graph state or gaining native authority.
 * Consumed by: proof-assertions.ts.
 */

const MAX_HISTORY_BYTES = 16 * 1024
const MESSAGE_TYPES = new Set(['ai', 'human', 'system', 'tool', 'function', 'chat'])

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 32 && value.every((item) => isJsonValue(item, depth + 1))
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  const entries = Object.entries(value)
  return entries.length <= 32 && entries.every(([key, item]) => key !== '__proto__' && isJsonValue(item, depth + 1))
}

function validStoredMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (!MESSAGE_TYPES.has(String(message.type)) || !message.data || typeof message.data !== 'object' || Array.isArray(message.data)) return false
  const data = message.data as Record<string, unknown>
  if (typeof data.content !== 'string' && !Array.isArray(data.content)) return false
  if (typeof data.content === 'string' && new TextEncoder().encode(data.content).byteLength > 8192) return false
  if (!isJsonValue(data)) return false
  if (message.type === 'ai' && data.tool_calls !== undefined) {
    if (!Array.isArray(data.tool_calls) || data.tool_calls.length > 4) return false
    if (!data.tool_calls.every((call) => {
      if (!call || typeof call !== 'object') return false
      const item = call as Record<string, unknown>
      const args = item.args as Record<string, unknown> | undefined
      return item.name === 'proof_fixture_action' && typeof item.id === 'string' &&
        args !== undefined && (args.action === 'first' || args.action === 'second')
    })) return false
  }
  return true
}

/**
 * Serializes complete LangChain turns and rejects histories over 16 KiB.
 * @param messages - Canonical messages returned by LangChain or LangGraph.
 * @returns JSON containing official stored-message DTOs.
 * @throws Error when the encoded history exceeds the proof storage bound.
 */
export function serializeProofHistory(messages: BaseMessage[]): string {
  const serialized = JSON.stringify(mapChatMessagesToStoredMessages(messages))
  if (new TextEncoder().encode(serialized).byteLength > MAX_HISTORY_BYTES) throw new Error('Proof history exceeds 16 KiB')
  return serialized
}

/**
 * Validates stored DTOs before mapping them back to LangChain message classes.
 * @param serialized - JSON text read from proof storage.
 * @returns Reconstructed canonical BaseMessage instances.
 * @throws Error for invalid JSON, excessive size, or invalid message records.
 */
export function restoreProofHistory(serialized: string): BaseMessage[] {
  if (new TextEncoder().encode(serialized).byteLength > MAX_HISTORY_BYTES) throw new Error('Proof history exceeds 16 KiB')
  const parsed: unknown = JSON.parse(serialized)
  if (!Array.isArray(parsed) || parsed.length > 32 || !parsed.every(validStoredMessage)) {
    throw new Error('Proof history contains invalid stored messages')
  }
  return mapStoredMessagesToChatMessages(parsed)
}
