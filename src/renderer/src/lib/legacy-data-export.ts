import type { ChatSession } from '../stores/chatStore'
import type { DisplayMode, Theme } from '../stores/settingsStore'

const MAX_SESSIONS = 50
const MAX_TURNS = 512
const MAX_TURN_TEXT_BYTES = 32 * 1024
const MAX_EXPORT_BYTES = 18 * 1024 * 1024
const ID = /^[a-zA-Z0-9_-]{1,64}$/
const encoder = new TextEncoder()

export type LegacyDataExport = {
  format: 'ai-worker-electron-export'
  schemaVersion: 1
  migrationId: string
  exportedAt: string
  sessions: Array<{
    id: string
    title: string
    createdAt: string
    updatedAt: string
    turns: Array<{
      turnId: string
      userText: string
      assistantText: string
      status: 'completed' | 'failed'
      endedAt: string
    }>
  }>
  preferences: {
    theme: Theme
    displayMode: DisplayMode
    speechLang: string
    offlineSpeech: boolean
    ttsEnabled: boolean
    ttsRate: number
    ttsPitch: number
    ttsVoice: string | null
  }
  omissions: string[]
}

type SafePreferences = LegacyDataExport['preferences']

function isoTime(value: number): string {
  if (!Number.isFinite(value)) throw new Error('A chat contains an invalid timestamp.')
  try {
    return new Date(value).toISOString()
  } catch {
    throw new Error('A chat contains an invalid timestamp.')
  }
}

async function stableTurnId(sessionId: string, messageId: string, index: number): Promise<string> {
  const input = encoder.encode(`${sessionId}\u0000${messageId}\u0000${index}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  const hex = [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `legacy-${hex}`
}

async function stableHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function safePreferences(value: {
  theme: Theme
  displayMode: DisplayMode
  speechLang: string
  offlineSpeech: boolean
  ttsEnabled: boolean
  ttsRate: number
  ttsPitch: number
  ttsVoice: string | null
}): SafePreferences {
  if (!['dark', 'light', 'system'].includes(value.theme) || !['dev', 'prod'].includes(value.displayMode) ||
      typeof value.speechLang !== 'string' || value.speechLang.length > 64 ||
      typeof value.offlineSpeech !== 'boolean' || typeof value.ttsEnabled !== 'boolean' ||
      !Number.isFinite(value.ttsRate) || value.ttsRate < 0.25 || value.ttsRate > 4 ||
      !Number.isFinite(value.ttsPitch) || value.ttsPitch < 0 || value.ttsPitch > 2 ||
      (value.ttsVoice !== null && (typeof value.ttsVoice !== 'string' || value.ttsVoice.length > 128))) {
    throw new Error('Some appearance or speech preferences are invalid; no export was created.')
  }

  return {
    theme: value.theme,
    displayMode: value.displayMode,
    speechLang: value.speechLang,
    offlineSpeech: value.offlineSpeech,
    ttsEnabled: value.ttsEnabled,
    ttsRate: value.ttsRate,
    ttsPitch: value.ttsPitch,
    ttsVoice: value.ttsVoice,
  }
}

/** Build a portable allowlist export; credentials, paths, tools and account state never enter it. */
export async function buildLegacyDataExport(
  sessions: readonly ChatSession[],
  preferences: Parameters<typeof safePreferences>[0],
  now = new Date(),
): Promise<{ json: string; sessionCount: number; turnCount: number }> {
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) {
    throw new Error(`This export supports up to ${MAX_SESSIONS} chat sessions. Nothing was exported.`)
  }

  let turnCount = 0
  const exportedSessions: LegacyDataExport['sessions'] = []

  for (const session of sessions) {
    if (!ID.test(session.id) || typeof session.title !== 'string' || session.title.length > 256 ||
        !Array.isArray(session.messages) || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)) {
      throw new Error('A chat session is invalid; no export was created.')
    }

    const ordered = session.messages
      .map((message, index) => ({ message, index }))
      .sort((left, right) => left.message.timestamp - right.message.timestamp || left.index - right.index)
    const turns: LegacyDataExport['sessions'][number]['turns'] = []
    let pending: { messageId: string; userText: string; timestamp: number; assistantText: string; lastAssistantAt?: number } | undefined

    const finishTurn = async () => {
      if (!pending) return
      const textBytes = encoder.encode(pending.userText).byteLength + encoder.encode(pending.assistantText).byteLength
      if (pending.userText.length + pending.assistantText.length > MAX_TURN_TEXT_BYTES || textBytes > MAX_TURN_TEXT_BYTES) {
        throw new Error('A chat turn is too large for the Tauri history format. Nothing was exported.')
      }
      turns.push({
        turnId: await stableTurnId(session.id, pending.messageId, turns.length),
        userText: pending.userText,
        assistantText: pending.assistantText,
        status: pending.lastAssistantAt === undefined ? 'failed' : 'completed',
        endedAt: isoTime(pending.lastAssistantAt ?? pending.timestamp),
      })
      turnCount += 1
      if (turnCount > MAX_TURNS) throw new Error(`This export supports up to ${MAX_TURNS} chat turns. Nothing was exported.`)
      pending = undefined
    }

    for (const { message, index } of ordered) {
      if (message.role === 'system') continue
      if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' ||
          !Number.isFinite(message.timestamp) || (message.id !== undefined && typeof message.id !== 'string')) {
        throw new Error('A chat message is invalid; no export was created.')
      }
      if (message.role === 'user') {
        await finishTurn()
        pending = {
          messageId: typeof message.id === 'string' ? message.id : `${message.timestamp}-${index}`,
          userText: message.content,
          timestamp: message.timestamp,
          assistantText: '',
        }
      } else if (pending) {
        pending.assistantText = pending.assistantText
          ? `${pending.assistantText}\n\n${message.content}`
          : message.content
        pending.lastAssistantAt = message.timestamp
      }
    }
    await finishTurn()

    exportedSessions.push({
      id: session.id,
      title: session.title,
      createdAt: isoTime(session.createdAt),
      updatedAt: isoTime(session.updatedAt),
      turns,
    })
  }

  const safe = safePreferences(preferences)
  const omissions = [
    'Credentials, account tokens, and connected-account state',
    'Workspace paths, grants, and write-approval settings',
    'Tool arguments/results, attachments, and file paths',
    'Internal system messages',
    'MCP server configuration and environment values',
    'Memory databases, browser profiles, WhatsApp pairing, and logs',
  ]
  const migrationId = `sha256-${await stableHash(JSON.stringify({ sessions: exportedSessions, preferences: safe, omissions }))}`
  const data: LegacyDataExport = {
    format: 'ai-worker-electron-export',
    schemaVersion: 1,
    migrationId,
    exportedAt: now.toISOString(),
    sessions: exportedSessions,
    preferences: safe,
    omissions,
  }
  const json = JSON.stringify(data, null, 2)
  if (encoder.encode(json).byteLength > MAX_EXPORT_BYTES) {
    throw new Error('This export is larger than 18 MB. Nothing was exported.')
  }
  return { json, sessionCount: exportedSessions.length, turnCount }
}
