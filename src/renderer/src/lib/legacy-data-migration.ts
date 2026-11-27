import type { ChatHistory, ChatSession, TerminalTurn } from './chat-history'
import type { LegacyDataExport } from './legacy-data-schema'

const SESSION_CAP = 50
const TURN_CAP = 512
const PAGE_CAP = 50
const encoder = new TextEncoder()

export type LegacyImportResult = {
  migrationId: string
  targetSessionIds: string[]
  sessionsAdded: number
  turnsAdded: number
}

export type LegacyRollbackResult = {
  migrationId: string
  targetSessionIds: string[]
  sessionsRemoved: number
  addedTurnsRemoved: number
}

function sameTurn(left: TerminalTurn, right: TerminalTurn): boolean {
  return left.turnId === right.turnId && left.sessionId === right.sessionId &&
    left.userText === right.userText && left.assistantText === right.assistantText &&
    left.status === right.status && left.endedAt === right.endedAt
}

async function getAllTurns(history: ChatHistory, sessionId: string): Promise<TerminalTurn[]> {
  const turns: TerminalTurn[] = []
  let cursor: { endedAt: string; turnId: string } | undefined
  do {
    const page = await history.listTurns(sessionId, { limit: PAGE_CAP, cursor })
    turns.push(...page.rows)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return turns
}

async function stableId(prefix: string, values: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(values.join('\u0000')))
  const hex = [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}-${hex}`
}

async function importSessionId(migrationId: string, sourceId: string): Promise<string> {
  return stableId('electron-session', [migrationId, sourceId])
}

async function importTurnId(migrationId: string, sourceSessionId: string, sourceTurnId: string): Promise<string> {
  return stableId('electron-turn', [migrationId, sourceSessionId, sourceTurnId])
}

function toTargetSession(source: LegacyDataExport['sessions'][number], id: string): ChatSession {
  return {
    id,
    title: source.title,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

async function toTargetTurn(
  migrationId: string,
  sourceSession: LegacyDataExport['sessions'][number],
  sourceTurn: LegacyDataExport['sessions'][number]['turns'][number],
  sessionId: string,
): Promise<TerminalTurn> {
  return {
    turnId: await importTurnId(migrationId, sourceSession.id, sourceTurn.turnId),
    sessionId,
    userText: sourceTurn.userText,
    assistantText: sourceTurn.assistantText,
    status: sourceTurn.status,
    endedAt: sourceTurn.endedAt,
  }
}

async function plansFor(data: LegacyDataExport) {
  return Promise.all(data.sessions.map(async (source) => {
    const session = toTargetSession(source, await importSessionId(data.migrationId, source.id))
    const turns = await Promise.all(source.turns.map((turn) => toTargetTurn(data.migrationId, source, turn, session.id)))
    return { session, turns }
  }))
}

/** Add imported chats under content-derived IDs so retries never overwrite Tauri sessions. */
export async function importLegacyData(history: ChatHistory, data: LegacyDataExport): Promise<LegacyImportResult> {
  const plans = await plansFor(data)
  const currentSessions = await history.listSessions()
  const currentById = new Map(currentSessions.map((session) => [session.id, session]))
  const existingTurnsBySession = new Map<string, TerminalTurn[]>()
  let currentTurnCount = 0

  // Preflight the complete archive before the first write. Existing unrelated sessions stay intact.
  for (const session of currentSessions) {
    const turns = await getAllTurns(history, session.id)
    existingTurnsBySession.set(session.id, turns)
    currentTurnCount += turns.length
  }

  let newSessions = 0
  let newTurns = 0
  for (const plan of plans) {
    const existingSession = currentById.get(plan.session.id)
    if (!existingSession) {
      newSessions += 1
      newTurns += plan.turns.length
      continue
    }
    if (existingSession.title !== plan.session.title || existingSession.createdAt !== plan.session.createdAt) {
      throw new Error('An imported chat ID conflicts with existing local history; no import was applied.')
    }
    const existingById = new Map((existingTurnsBySession.get(plan.session.id) ?? []).map((turn) => [turn.turnId, turn]))
    for (const turn of plan.turns) {
      const existing = existingById.get(turn.turnId)
      if (!existing) newTurns += 1
      else if (!sameTurn(existing, turn)) {
        throw new Error('An imported turn conflicts with existing local history; no import was applied.')
      }
    }
  }

  if (currentSessions.length + newSessions > SESSION_CAP) {
    throw new Error(`This archive needs ${newSessions} chat slots, but local history allows ${SESSION_CAP} chats. No import was applied.`)
  }
  if (currentTurnCount + newTurns > TURN_CAP) {
    throw new Error(`This archive needs ${newTurns} turn slots, but local history allows ${TURN_CAP} turns. No import was applied.`)
  }

  let sessionsAdded = 0
  let turnsAdded = 0
  for (const plan of plans) {
    if (await history.ensureSession(plan.session) === 'created') sessionsAdded += 1
    for (const turn of plan.turns) {
      if (await history.commitTerminalTurn(turn) === 'committed') turnsAdded += 1
    }
  }

  return {
    migrationId: data.migrationId,
    targetSessionIds: plans.map((plan) => plan.session.id),
    sessionsAdded,
    turnsAdded,
  }
}

/** Remove only the deterministic session IDs represented by this export. */
export async function rollbackLegacyData(history: ChatHistory, data: LegacyDataExport): Promise<LegacyRollbackResult> {
  const plans = await plansFor(data)
  const currentSessions = await history.listSessions()
  const currentById = new Map(currentSessions.map((session) => [session.id, session]))
  let addedTurnsRemoved = 0

  // Verify all target identities before deleting anything; unrelated IDs cannot be selected here.
  for (const plan of plans) {
    const existing = currentById.get(plan.session.id)
    if (!existing) continue
    if (existing.title !== plan.session.title || existing.createdAt !== plan.session.createdAt) {
      throw new Error('The selected archive does not match these imported chats; nothing was removed.')
    }
    const expectedById = new Map(plan.turns.map((turn) => [turn.turnId, turn]))
    const existingTurns = await getAllTurns(history, plan.session.id)
    for (const turn of existingTurns) {
      const expected = expectedById.get(turn.turnId)
      if (expected && !sameTurn(turn, expected)) {
        throw new Error('An imported turn changed unexpectedly; nothing was removed.')
      }
      if (!expected) addedTurnsRemoved += 1
    }
  }

  let sessionsRemoved = 0
  for (const plan of plans) {
    if (!currentById.has(plan.session.id)) continue
    await history.deleteSession(plan.session.id)
    sessionsRemoved += 1
  }

  return {
    migrationId: data.migrationId,
    targetSessionIds: plans.map((plan) => plan.session.id),
    sessionsRemoved,
    addedTurnsRemoved,
  }
}
