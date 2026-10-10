import { invoke } from '@tauri-apps/api/core'
import { HistoryError, openChatHistory, type TerminalTurn } from '../src/lib/chat-history'

type Context = { phase: 'seed' | 'verify'; storeId: string; storePresent: boolean }
type Result = { ok: boolean; phase: string; checks: string[]; details?: string }
const database = 'ai-worker-chat-history'
const checks: string[] = []

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function expectCode(work: () => Promise<unknown>, code: string): Promise<void> {
  try { await work() } catch (error) {
    assert(error instanceof HistoryError && error.code === code, `expected ${code}`)
    return
  }
  throw new Error(`expected ${code}`)
}

function turn(sessionId: string, turnId: string, status: TerminalTurn['status'], endedAt: string, assistantText = `answer-${turnId}`): TerminalTurn {
  return { turnId, sessionId, userText: `question-${turnId}`, assistantText, status, endedAt }
}

function rawDatabase(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(database) : indexedDB.open(database, version)
    request.onupgradeneeded = () => request.result.createObjectStore('unexpected-proof-store')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function rawGet(db: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function rawPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}

async function simulateAbort(history: Awaited<ReturnType<typeof openChatHistory>>, value: TerminalTurn): Promise<void> {
  const original = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (record: unknown, key?: IDBValidKey) {
    const request = original.call(this, record, key)
    if (this.name === 'turns') this.transaction.abort()
    return request
  }
  try {
    await expectCode(() => history.commitTerminalTurn(value), 'storage_error')
  } finally {
    IDBObjectStore.prototype.add = original
  }
}

async function seed(): Promise<Record<string, unknown>> {
  const history = await openChatHistory()
  const initial = await history.listSessions()
  assert(initial.length === 0, `private store was not empty at seed start (${initial.length} sessions)`)
  const first = await history.createSession('Primary synthetic chat')
  const second = await history.createSession('Separate synthetic chat')
  const endedAt = '2026-10-11T00:00:00.000Z'
  const completed = turn(first.id, crypto.randomUUID(), 'completed', endedAt, 'café')
  const canceled = turn(first.id, crypto.randomUUID(), 'canceled', endedAt, 'partial before Stop')
  const failed = turn(first.id, crypto.randomUUID(), 'failed', endedAt, '')
  const secondTurn = turn(second.id, crypto.randomUUID(), 'completed', endedAt, 'second chat')
  assert(await history.commitTerminalTurn(completed) === 'committed', 'completed turn did not commit')
  assert(await history.commitTerminalTurn(canceled) === 'committed', 'canceled turn did not commit')
  assert(await history.commitTerminalTurn(failed) === 'committed', 'failed turn did not commit')
  assert(await history.commitTerminalTurn(secondTurn) === 'committed', 'second session turn did not commit')
  assert(await history.commitTerminalTurn(canceled) === 'already_committed', 'exact retry was not idempotent')
  await expectCode(() => history.commitTerminalTurn({ ...canceled, assistantText: 'changed bytes' }), 'conflict')
  await expectCode(() => history.commitTerminalTurn({ ...completed, authority: true } as TerminalTurn), 'invalid_input')
  await expectCode(() => history.commitTerminalTurn({ ...completed, turnId: '../unsafe' }), 'invalid_input')
  await expectCode(() => history.commitTerminalTurn({ ...completed, endedAt: 'yesterday' }), 'invalid_input')
  await expectCode(() => history.commitTerminalTurn({ ...completed, userText: 'x'.repeat(32 * 1024 + 1), assistantText: '' }), 'invalid_input')
  await expectCode(() => history.listTurns(first.id, { limit: 0 }), 'invalid_input')
  await expectCode(() => history.listTurns(first.id, { limit: 51 }), 'invalid_input')
  await expectCode(() => history.listTurns(first.id, { limit: 1, extra: true } as never), 'invalid_input')
  checks.push('strict DTOs, UTF-8 text bound, statuses, exact retry, changed-byte conflict, and input rejection')

  const beforeAbort = (await history.listTurns(first.id, { limit: 10 })).rows.length
  await simulateAbort(history, turn(first.id, crypto.randomUUID(), 'failed', endedAt, 'aborted request'))
  assert((await history.listTurns(first.id, { limit: 10 })).rows.length === beforeAbort, 'aborted transaction changed prior rows')
  checks.push('real IndexedDB transaction abort preserved earlier rows (simulated failure boundary)')

  const allIds = [completed.turnId, canceled.turnId, failed.turnId]
  for (let i = 0; i < 508; i++) {
    const item = turn(first.id, crypto.randomUUID(), 'completed', endedAt, `synthetic-${i}`)
    await history.commitTerminalTurn(item)
    allIds.push(item.turnId)
  }
  await expectCode(() => history.commitTerminalTurn(turn(first.id, crypto.randomUUID(), 'completed', endedAt)), 'history_full')
  assert(await history.commitTerminalTurn(completed) === 'already_committed', 'duplicate at capacity was not checked first')
  await expectCode(() => history.commitTerminalTurn({ ...completed, userText: 'conflict at capacity' }), 'conflict')
  assert((await history.listTurns(first.id, { limit: 10 })).rows.length === 10, 'capacity failure lost earlier rows')
  checks.push('512-turn total cap, no eviction, duplicate check before capacity refusal')

  for (let i = 0; i < 48; i++) await history.createSession(`Synthetic session ${i}`)
  await expectCode(() => history.createSession('one too many'), 'history_full')
  assert((await history.listSessions()).length === 50, 'session cap changed existing sessions')
  checks.push('50-session cap and no eviction')

  const expectedIds = allIds.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  const paged: string[] = []
  let cursor: { endedAt: string; turnId: string } | undefined
  do {
    const page = await history.listTurns(first.id, { limit: 17, ...(cursor ? { cursor } : {}) })
    paged.push(...page.rows.map((row) => row.turnId))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert(paged.length === 511 && paged.join('|') === expectedIds.join('|'), 'stable 17-row cursor pages differed')
  assert((await history.listTurns(second.id, { limit: 50 })).rows.length === 1, 'session cursor crossed session boundary')
  checks.push('bounded 17-row pages, tied timestamps ordered by turnId, sessions stay isolated')

  history.close()
  const corruptDb = await rawDatabase()
  const original = await rawGet(corruptDb, 'turns', paged[0]) as TerminalTurn
  await rawPut(corruptDb, 'turns', { ...original, authority: { granted: true } })
  corruptDb.close()
  const strictReader = await openChatHistory()
  await expectCode(() => strictReader.listTurns(first.id, { limit: 50 }), 'invalid_schema')
  strictReader.close()
  const restoreDb = await rawDatabase()
  await rawPut(restoreDb, 'turns', original)
  restoreDb.close()
  checks.push('unknown stored authority field rejected on read and synthetic row restored byte-for-byte')

  const deleter = await openChatHistory()
  const beforeDelete = (await deleter.listTurns(first.id, { limit: 1 })).rows[0]
  await deleter.deleteSession(second.id)
  assert((await deleter.listTurns(first.id, { limit: 1 })).rows[0].turnId === beforeDelete.turnId, 'deleting second session touched first')
  await expectCode(() => deleter.listTurns(second.id), 'session_not_found')
  deleter.close()
  await expectCode(() => deleter.listSessions(), 'closed')
  checks.push('explicit deletion removed only selected session; close rejects future operations')

  return { checks, firstSessionId: first.id, secondSessionId: second.id, persistedTurnCount: 511, persistedSessionCount: 49, persistedTurnIds: allIds }
}

async function verify(): Promise<Record<string, unknown>> {
  const history = await openChatHistory()
  const sessions = await history.listSessions()
  assert(sessions.length === 49, `expected 49 persisted sessions, received ${sessions.length}`)
  const firstId = sessions.find((session) => session.title === 'Primary synthetic chat')?.id
  assert(firstId, 'primary session missing after native restart')
  const page = await history.listTurns(firstId, { limit: 50 })
  assert(page.rows.length === 50 && page.nextCursor, 'persisted first page was not bounded')
  let total = page.rows.length
  let canceledPartialFound = page.rows.some((row) => row.status === 'canceled' && row.assistantText === 'partial before Stop')
  let emptyFailedFound = page.rows.some((row) => row.status === 'failed' && row.assistantText === '')
  let cursor = page.nextCursor ?? undefined
  while (cursor) {
    const next = await history.listTurns(firstId, { limit: 50, cursor })
    total += next.rows.length
    canceledPartialFound ||= next.rows.some((row) => row.status === 'canceled' && row.assistantText === 'partial before Stop')
    emptyFailedFound ||= next.rows.some((row) => row.status === 'failed' && row.assistantText === '')
    if (!next.nextCursor) break
    cursor = next.nextCursor
  }
  assert(total === 511, `expected 511 turns after restart, received ${total}`)
  assert(canceledPartialFound, 'canceled partial text missing')
  assert(emptyFailedFound, 'empty failed turn missing')
  checks.push('same private WKWebView store survived separate native launch; exact completed/canceled/failed rows paged')

  const firstTurn = page.rows.find((row) => row.status === 'completed')!
  history.close()
  const upgraded = await rawDatabase(2)
  const originalRow = await new Promise<unknown>((resolve, reject) => {
    const request = upgraded.transaction('turns').objectStore('turns').get(firstTurn.turnId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  upgraded.close()
  await expectCode(() => openChatHistory(), 'unsupported_version')
  const preserved = await rawDatabase()
  const preservedRow = await new Promise<unknown>((resolve, reject) => {
    const request = preserved.transaction('turns').objectStore('turns').get(firstTurn.turnId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  assert(JSON.stringify(originalRow) === JSON.stringify(preservedRow), 'future-version refusal changed an existing turn')
  preserved.close()
  checks.push('future version rejected without changing existing turn bytes')
  return { checks, persistedTurnCount: total, persistedSessionCount: sessions.length }
}

async function run(): Promise<void> {
  const context = await invoke<Context>('history_proof_context')
  let result: Result
  try {
    assert(context.storePresent, `native WKWebView did not report isolated store ${context.storeId}`)
    const outcome = context.phase === 'seed' ? await seed() : await verify()
    result = { ok: true, phase: context.phase, checks: ['native WKWebView reports expected isolated store UUID', ...(outcome.checks as string[])], ...outcome }
  } catch (error) {
    result = { ok: false, phase: context.phase, checks, details: error instanceof Error ? error.message : String(error) }
  }
  document.querySelector('#proof')!.textContent = result.ok ? `PASS ${context.phase}: ${result.checks.join('; ')}` : `FAIL ${context.phase}: ${result.details}`
  await invoke('history_proof_finish', { result: JSON.stringify({ ...result, storeId: context.storeId }) })
}

void run()
