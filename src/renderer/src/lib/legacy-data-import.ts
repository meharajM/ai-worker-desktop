import type { LegacyDataExport } from './legacy-data-schema'

const MAX_SESSIONS = 50
const MAX_TURNS = 512
const MAX_TURN_TEXT_BYTES = 32 * 1024
const MAX_EXPORT_BYTES = 18 * 1024 * 1024
const ID = /^[a-zA-Z0-9_-]{1,64}$/
const MIGRATION_ID = /^sha256-[a-f0-9]{64}$/
const encoder = new TextEncoder()
const OMITTIONS = [
  'Credentials, account tokens, and connected-account state',
  'Workspace paths, grants, and write-approval settings',
  'Tool arguments/results, attachments, and file paths',
  'Internal system messages',
  'MCP server configuration and environment values',
  'Memory databases, browser profiles, WhatsApp pairing, and logs',
]

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
}

function isoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function checkedPreferences(value: unknown): LegacyDataExport['preferences'] {
  if (!isRecord(value) || !exactKeys(value, [
    'theme', 'displayMode', 'speechLang', 'offlineSpeech', 'ttsEnabled', 'ttsRate', 'ttsPitch', 'ttsVoice',
  ]) ||
      (value.theme !== 'dark' && value.theme !== 'light' && value.theme !== 'system') ||
      (value.displayMode !== 'dev' && value.displayMode !== 'prod') ||
      typeof value.speechLang !== 'string' || value.speechLang.length > 64 ||
      typeof value.offlineSpeech !== 'boolean' || typeof value.ttsEnabled !== 'boolean' ||
      typeof value.ttsRate !== 'number' || !Number.isFinite(value.ttsRate) || value.ttsRate < 0.25 || value.ttsRate > 4 ||
      typeof value.ttsPitch !== 'number' || !Number.isFinite(value.ttsPitch) || value.ttsPitch < 0 || value.ttsPitch > 2 ||
      (value.ttsVoice !== null && (typeof value.ttsVoice !== 'string' || value.ttsVoice.length > 128))) {
    throw new Error('Export contains invalid or unsupported preferences.')
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

function checkedTurn(value: unknown): LegacyDataExport['sessions'][number]['turns'][number] {
  if (!isRecord(value) || !exactKeys(value, ['turnId', 'userText', 'assistantText', 'status', 'endedAt']) ||
      typeof value.turnId !== 'string' || !ID.test(value.turnId) ||
      typeof value.userText !== 'string' || typeof value.assistantText !== 'string' ||
      value.userText.length + value.assistantText.length > MAX_TURN_TEXT_BYTES ||
      encoder.encode(value.userText).byteLength + encoder.encode(value.assistantText).byteLength > MAX_TURN_TEXT_BYTES ||
      (value.status !== 'completed' && value.status !== 'failed') || !isoDate(value.endedAt)) {
    throw new Error('Export contains an invalid chat turn.')
  }

  return {
    turnId: value.turnId,
    userText: value.userText,
    assistantText: value.assistantText,
    status: value.status,
    endedAt: value.endedAt,
  }
}

function checkedSession(value: unknown): LegacyDataExport['sessions'][number] {
  if (!isRecord(value) || !exactKeys(value, ['id', 'title', 'createdAt', 'updatedAt', 'turns']) ||
      typeof value.id !== 'string' || !ID.test(value.id) ||
      typeof value.title !== 'string' || value.title.length > 256 || encoder.encode(value.title).byteLength > 256 ||
      !isoDate(value.createdAt) || !isoDate(value.updatedAt) || !Array.isArray(value.turns)) {
    throw new Error('Export contains an invalid chat session.')
  }

  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    turns: value.turns.map(checkedTurn),
  }
}

async function contentHash(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Export integrity cannot be checked in this app session.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Parse only the strict, bounded allowlist written by the Electron export action. */
export async function parseLegacyDataExport(json: string): Promise<{
  data: LegacyDataExport
  sessionCount: number
  turnCount: number
}> {
  if (typeof json !== 'string' || json.length > MAX_EXPORT_BYTES || encoder.encode(json).byteLength > MAX_EXPORT_BYTES) {
    throw new Error('Export file must be 18 MB or smaller.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Export file is not valid JSON.')
  }

  if (!isRecord(parsed) || !exactKeys(parsed, [
    'format', 'schemaVersion', 'migrationId', 'exportedAt', 'sessions', 'preferences', 'omissions',
  ]) || parsed.format !== 'ai-worker-electron-export' || parsed.schemaVersion !== 1 ||
      typeof parsed.migrationId !== 'string' || !MIGRATION_ID.test(parsed.migrationId) ||
      !isoDate(parsed.exportedAt) || !Array.isArray(parsed.sessions) || parsed.sessions.length > MAX_SESSIONS ||
      !Array.isArray(parsed.omissions) || parsed.omissions.length !== OMITTIONS.length ||
      !parsed.omissions.every((omission, index) => omission === OMITTIONS[index])) {
    throw new Error('Export format or version is unsupported.')
  }

  const sessions = parsed.sessions.map(checkedSession)
  const sessionIds = new Set<string>()
  const turnIds = new Set<string>()
  let turnCount = 0
  for (const session of sessions) {
    if (sessionIds.has(session.id)) throw new Error('Export contains duplicate chat sessions.')
    sessionIds.add(session.id)
    for (const turn of session.turns) {
      if (turnIds.has(turn.turnId)) throw new Error('Export contains duplicate chat turns.')
      turnIds.add(turn.turnId)
      turnCount += 1
      if (turnCount > MAX_TURNS) throw new Error(`Export exceeds the ${MAX_TURNS}-turn limit.`)
    }
  }

  const preferences = checkedPreferences(parsed.preferences)
  const omissions = [...OMITTIONS]
  const expectedMigrationId = `sha256-${await contentHash(JSON.stringify({ sessions, preferences, omissions }))}`
  if (parsed.migrationId !== expectedMigrationId) throw new Error('Export integrity check failed; no data was imported.')

  const data: LegacyDataExport = {
    format: 'ai-worker-electron-export',
    schemaVersion: 1,
    migrationId: parsed.migrationId,
    exportedAt: parsed.exportedAt,
    sessions,
    preferences,
    omissions,
  }
  return { data, sessionCount: sessions.length, turnCount }
}
