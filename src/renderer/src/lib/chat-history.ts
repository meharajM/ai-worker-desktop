/** Tauri-only, bounded terminal chat history in the browser's private IndexedDB. */

export type ChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export type TerminalTurn = {
  turnId: string
  sessionId: string
  userText: string
  assistantText: string
  status: 'completed' | 'canceled' | 'failed'
  endedAt: string
}

export type TurnCursor = Pick<TerminalTurn, 'endedAt' | 'turnId'>
export type HistoryErrorCode =
  | 'blocked'
  | 'closed'
  | 'conflict'
  | 'history_full'
  | 'invalid_input'
  | 'invalid_schema'
  | 'session_not_found'
  | 'storage_error'
  | 'storage_full'
  | 'unsupported_version'

export class HistoryError extends Error {
  constructor(readonly code: HistoryErrorCode) {
    super(code)
    this.name = 'HistoryError'
  }
}

const DATABASE = 'ai-worker-chat-history'
const VERSION = 1
const SESSION_CAP = 50
const TURN_CAP = 512
const PAGE_CAP = 50
const TURN_TEXT_CAP = 32 * 1024
const TURN_INDEX = 'bySessionEnd'
const ID = /^[a-zA-Z0-9_-]{1,64}$/
const textEncoder = new TextEncoder()

function fail(code: HistoryErrorCode): never {
  throw new HistoryError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

function isoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length <= bytes && textEncoder.encode(value).byteLength <= bytes
}

function sessionDto(value: unknown): ChatSession {
  if (!isRecord(value) || !exactKeys(value, ['id', 'title', 'createdAt', 'updatedAt']) ||
      !id(value.id) || !boundedText(value.title, 256) || !isoDate(value.createdAt) || !isoDate(value.updatedAt)) {
    fail('invalid_schema')
  }
  return { id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt }
}

function checkedTurn(value: unknown, code: 'invalid_input' | 'invalid_schema'): TerminalTurn {
  if (!isRecord(value) || !exactKeys(value, ['turnId', 'sessionId', 'userText', 'assistantText', 'status', 'endedAt']) ||
      !id(value.turnId) || !id(value.sessionId) || typeof value.userText !== 'string' ||
      typeof value.assistantText !== 'string' || value.userText.length + value.assistantText.length > TURN_TEXT_CAP ||
      textEncoder.encode(value.userText).byteLength + textEncoder.encode(value.assistantText).byteLength > TURN_TEXT_CAP ||
      (value.status !== 'completed' && value.status !== 'canceled' && value.status !== 'failed') || !isoDate(value.endedAt)) {
    fail(code)
  }
  return {
    turnId: value.turnId,
    sessionId: value.sessionId,
    userText: value.userText,
    assistantText: value.assistantText,
    status: value.status,
    endedAt: value.endedAt,
  }
}

function turnDto(value: unknown): TerminalTurn {
  return checkedTurn(value, 'invalid_schema')
}

function validateSchema(db: IDBDatabase): void {
  if (db.version !== VERSION || db.objectStoreNames.length !== 2 ||
      !db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('turns')) fail('invalid_schema')
  const tx = db.transaction(['sessions', 'turns'], 'readonly')
  const sessions = tx.objectStore('sessions')
  const turns = tx.objectStore('turns')
  const indexNames = turns.indexNames
  const index = turns.index(TURN_INDEX)
  if (sessions.keyPath !== 'id' || sessions.autoIncrement || sessions.indexNames.length !== 0 ||
      turns.keyPath !== 'turnId' || turns.autoIncrement || indexNames.length !== 1 ||
      index.keyPath.length !== 3 || index.keyPath[0] !== 'sessionId' || index.keyPath[1] !== 'endedAt' ||
      index.keyPath[2] !== 'turnId' || index.unique || index.multiEntry) {
    tx.abort()
    fail('invalid_schema')
  }
}

function errorCode(error: DOMException | null): HistoryErrorCode {
  if (error?.name === 'VersionError') return 'unsupported_version'
  if (error?.name === 'QuotaExceededError') return 'storage_full'
  return 'storage_error'
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = (event) => {
      // Existing schemas are never upgraded or reset by this bounded API.
      if (event.oldVersion !== 0) {
        request.transaction?.abort()
        return
      }
      const db = request.result
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
      const turns = db.createObjectStore('turns', { keyPath: 'turnId' })
      turns.createIndex(TURN_INDEX, ['sessionId', 'endedAt', 'turnId'])
      void sessions
    }
    request.onblocked = () => {
      // A late success after this rejection is closed in onsuccess below.
      settled = true
      reject(new HistoryError('blocked'))
    }
    request.onerror = () => {
      if (!settled) {
        settled = true
        reject(new HistoryError(errorCode(request.error)))
      }
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      try {
        validateSchema(db)
        settled = true
        resolve(db)
      } catch (error) {
        db.close()
        settled = true
        reject(error instanceof HistoryError ? error : new HistoryError('invalid_schema'))
      }
    }
  })
}

function transactionDone(tx: IDBTransaction, abortReason: () => HistoryErrorCode | null = () => null): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(new HistoryError(abortReason() ?? errorCode(tx.error)))
    tx.onerror = () => reject(new HistoryError(abortReason() ?? errorCode(tx.error)))
  })
}

function validatePageInput(sessionId: unknown, limit: unknown, cursor: unknown): asserts sessionId is string {
  if (!id(sessionId) || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > PAGE_CAP) fail('invalid_input')
  if (cursor !== undefined && (!isRecord(cursor) || !exactKeys(cursor, ['endedAt', 'turnId']) ||
      !isoDate(cursor.endedAt) || !id(cursor.turnId))) fail('invalid_input')
}

/** Open the fixed history database; callers get only bounded, validated DTO operations. */
export async function openChatHistory(): Promise<{
  createSession(title: string): Promise<ChatSession>
  listSessions(): Promise<ChatSession[]>
  listTurns(sessionId: string, options?: { limit?: number; cursor?: TurnCursor }): Promise<{ rows: TerminalTurn[]; nextCursor: TurnCursor | null }>
  commitTerminalTurn(turn: TerminalTurn): Promise<'committed' | 'already_committed'>
  deleteSession(sessionId: string): Promise<void>
  close(): void
}> {
  const db = await openDatabase()
  let closed = false
  db.onversionchange = () => {
    closed = true
    db.close()
  }
  const ensureOpen = () => { if (closed) fail('closed') }
  const api = {
    async createSession(title: string): Promise<ChatSession> {
      if (!boundedText(title, 256)) fail('invalid_input')
      ensureOpen()
      const tx = db.transaction('sessions', 'readwrite')
      let abortReason: HistoryErrorCode | null = null
      const done = transactionDone(tx, () => abortReason)
      const store = tx.objectStore('sessions')
      const now = new Date().toISOString()
      const result: ChatSession = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now }
      store.count().onsuccess = (event) => {
        const count = (event.target as IDBRequest<number>).result
        if (count >= SESSION_CAP) { abortReason = 'history_full'; tx.abort() }
        else store.add(result)
      }
      await done
      return sessionDto(result)
    },
    async listSessions(): Promise<ChatSession[]> {
      ensureOpen()
      const tx = db.transaction('sessions', 'readonly')
      let abortReason: HistoryErrorCode | null = null
      const done = transactionDone(tx, () => abortReason)
      const rows: ChatSession[] = []
      tx.objectStore('sessions').openCursor().onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
        if (cursor) {
          if (rows.length >= SESSION_CAP) { abortReason = 'invalid_schema'; tx.abort(); return }
          try { rows.push(sessionDto(cursor.value)) } catch { abortReason = 'invalid_schema'; tx.abort(); return }
          cursor.continue()
        }
      }
      await done
      return rows
    },
    async listTurns(sessionId: string, options: { limit?: number; cursor?: TurnCursor } = {}) {
      if (!isRecord(options) || !Object.keys(options).every((key) => key === 'limit' || key === 'cursor')) fail('invalid_input')
      const limit = options.limit ?? PAGE_CAP
      validatePageInput(sessionId, limit, options.cursor)
      ensureOpen()
      const tx = db.transaction(['sessions', 'turns'], 'readonly')
      let abortReason: HistoryErrorCode | null = null
      const done = transactionDone(tx, () => abortReason)
      const rows: TerminalTurn[] = []
      const sessions = tx.objectStore('sessions')
      const turns = tx.objectStore('turns')
      let sessionExists = false
      sessions.get(sessionId).onsuccess = (event) => {
        const value = (event.target as IDBRequest).result
        if (value !== undefined) {
          try { sessionDto(value); sessionExists = true } catch { abortReason = 'invalid_schema'; tx.abort() }
        }
      }
      const index = turns.index(TURN_INDEX)
      const lower: IDBValidKey = options.cursor
        ? [sessionId, options.cursor.endedAt, options.cursor.turnId]
        : [sessionId, '', '']
      const range = IDBKeyRange.bound(lower, [sessionId, '\uffff', '\uffff'], Boolean(options.cursor), false)
      index.openCursor(range, 'next').onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
        if (!cursor) return
        if (rows.length === limit + 1) return
        try { rows.push(turnDto(cursor.value)) } catch { abortReason = 'invalid_schema'; tx.abort(); return }
        cursor.continue()
      }
      try {
        await done
      } catch (error) {
        throw error
      }
      if (!sessionExists) fail('session_not_found')
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      const last = rows.at(-1)
      return { rows, nextCursor: hasMore && last ? { endedAt: last.endedAt, turnId: last.turnId } : null }
    },
    async commitTerminalTurn(input: TerminalTurn): Promise<'committed' | 'already_committed'> {
      const turn = checkedTurn(input, 'invalid_input')
      ensureOpen()
      const tx = db.transaction(['sessions', 'turns'], 'readwrite')
      let abortReason: HistoryErrorCode | null = null
      const done = transactionDone(tx, () => abortReason)
      const sessions = tx.objectStore('sessions')
      const turns = tx.objectStore('turns')
      let outcome: 'committed' | 'already_committed' = 'committed'
      turns.get(turn.turnId).onsuccess = (event) => {
        const existing = (event.target as IDBRequest).result
        if (existing !== undefined) {
          let prior: TerminalTurn
          try { prior = turnDto(existing) } catch { abortReason = 'invalid_schema'; tx.abort(); return }
          if (JSON.stringify(prior) !== JSON.stringify(turn)) { abortReason = 'conflict'; tx.abort(); return }
          outcome = 'already_committed'
          return
        }
        // Check duplicates before capacity so exact retries still succeed at the cap.
        sessions.get(turn.sessionId).onsuccess = (sessionEvent) => {
          const session = (sessionEvent.target as IDBRequest).result
          if (session === undefined) { abortReason = 'session_not_found'; tx.abort(); return }
          let currentSession: ChatSession
          try { currentSession = sessionDto(session) } catch { abortReason = 'invalid_schema'; tx.abort(); return }
          turns.count().onsuccess = (countEvent) => {
            // Admission and both writes share one transaction to prevent oversubscription.
            if ((countEvent.target as IDBRequest<number>).result >= TURN_CAP) { abortReason = 'history_full'; tx.abort(); return }
            const updatedAt = currentSession.updatedAt < turn.endedAt ? turn.endedAt : currentSession.updatedAt
            sessions.put({ ...currentSession, updatedAt })
            turns.add(turn)
          }
        }
      }
      await done
      return outcome
    },
    async deleteSession(sessionId: string): Promise<void> {
      if (!id(sessionId)) fail('invalid_input')
      ensureOpen()
      const tx = db.transaction(['sessions', 'turns'], 'readwrite')
      let abortReason: HistoryErrorCode | null = null
      const done = transactionDone(tx, () => abortReason)
      const sessions = tx.objectStore('sessions')
      const turns = tx.objectStore('turns')
      sessions.get(sessionId).onsuccess = (event) => {
        const session = (event.target as IDBRequest).result
        if (session === undefined) { abortReason = 'session_not_found'; tx.abort(); return }
        try { sessionDto(session) } catch { abortReason = 'invalid_schema'; tx.abort(); return }
        const range = IDBKeyRange.bound([sessionId, '', ''], [sessionId, '\uffff', '\uffff'])
        turns.index(TURN_INDEX).openCursor(range).onsuccess = (cursorEvent) => {
          const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result
          if (cursor) {
            try { turnDto(cursor.value) } catch { abortReason = 'invalid_schema'; tx.abort(); return }
            cursor.delete()
            cursor.continue()
          } else sessions.delete(sessionId)
        }
      }
      await done
    },
    close() {
      closed = true
      db.close()
    },
  }
  return api
}
