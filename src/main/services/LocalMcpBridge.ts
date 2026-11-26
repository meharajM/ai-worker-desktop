import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { ExternalAgentTask, parseTask } from './ExternalAgentTask'
import { research } from './ExternalResearch'
import type { getExternalServiceChoices } from '../ipc/mcp'
import type { AddressInfo } from 'node:net'
import { isTrustedRendererUrl } from '../ipc/trustedIpc'
import type { LocalTaskModel, LocalTaskModelStatus } from '../../shared/external-task'

// JSON escapes may take six bytes per UTF-16 code unit. Both tools accept 8,000 units.
const MAX_REQUEST_BYTES = 52 * 1024
const MAX_PROMPT_LENGTH = 8_000
const MAX_RESPONSE_LENGTH = 16_000
const REQUEST_TIMEOUT_MS = 120_000
const HEARTBEAT_INTERVAL_MS = 10_000

type PrivacyMode = 'local-only' | 'connected'

interface ModelStatus {
  available: boolean
  checkedAt: number
}

interface RuntimeSnapshot {
  schemaVersion: 1
  app: 'AI-Worker'
  version: string
  running: boolean
  startedAt: number
  heartbeatAt: number
  privacyMode: PrivacyMode
  model: ModelStatus | null
  port: number | null
  token: string | null
}

interface LocalInferenceResult {
  content: string
  provider: string
  model: string
}

interface PendingRequest {
  resolve: (result: LocalInferenceResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  cleanup: () => void
}

let snapshot: RuntimeSnapshot | null = null
let snapshotPath: string | null = null
let server: Server | null = null
let pendingRequestId: string | null = null
const pendingRequests = new Map<string, PendingRequest>()
let writeQueue = Promise.resolve()
let heartbeat: NodeJS.Timeout | null = null

let activeTask: { task: ExternalAgentTask; owner: WebContents; planner: WebContents } | null = null
let localTaskModelStatus: LocalTaskModelStatus = { model: null, checkedAt: 0 }

export function taskForRenderer(sender: WebContents, id?: string) {
  if (activeTask?.owner !== sender || (id !== undefined && activeTask.task.id !== id)) return null
  return activeTask.task
}

export function taskForPlanner(sender: WebContents, id?: string) {
  if (activeTask?.planner !== sender || (id !== undefined && activeTask.task.id !== id)) return null
  return activeTask.task
}

export function taskModelStatusForRenderer(sender: WebContents): LocalTaskModelStatus | null {
  return activeTask?.owner === sender ? localTaskModelStatus : null
}

export function revokeExternalTask() {
  activeTask?.task.cancel('Privacy mode changed.')
}

export function cancelExternalTask(reason = 'Task cancelled in AI-Worker.') {
  activeTask?.task.cancel(reason)
}

function rejectPendingRequest(requestId: string, message: string): void {
  const pending = pendingRequests.get(requestId)
  if (!pending) return
  clearTimeout(pending.timeout)
  pending.cleanup()
  pendingRequests.delete(requestId)
  if (pendingRequestId === requestId) pendingRequestId = null
  pending.reject(new Error(message))
}

function queueSnapshotWrite(): Promise<void> {
  if (!snapshot || !snapshotPath) return Promise.resolve()
  snapshot.heartbeatAt = Date.now()
  const data = JSON.stringify(snapshot)
  const destination = snapshotPath
  writeQueue = writeQueue.then(async () => {
    const directory = dirname(destination)
    await mkdir(directory, { recursive: true })
    const temporary = `${destination}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`
    await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await chmod(temporary, 0o600)
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }).catch((error) => {
    console.error('[Local MCP] Could not update runtime metadata:', error)
  })
  return writeQueue
}

function jsonResponse(response: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(text)
}

function isLoopbackRequest(request: IncomingMessage, port: number): boolean {
  const remote = request.socket.remoteAddress
  const loopback = remote === '127.0.0.1' || remote === '::ffff:127.0.0.1'
  return loopback && request.headers.host === `127.0.0.1:${port}`
}

function hasValidToken(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const limit = request.url === '/run-agent-task' ? 112 * 1024 : MAX_REQUEST_BYTES
  const contentLength = Number(request.headers['content-length'] || 0)
  if (contentLength > limit) throw new Error('Request is too large.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('Request is too large.')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request body.')
  return parsed as Record<string, unknown>
}

function askRenderer(window: BrowserWindow | null, prompt: string): Promise<LocalInferenceResult> {
  if (pendingRequestId) return Promise.reject(new Error('AI-Worker is already handling a local request. Try again shortly.'))
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() ||
      !isTrustedRendererUrl(window.webContents, window.webContents.getURL())) {
    return Promise.reject(new Error('AI-Worker is running without a ready app window. Open the app and retry.'))
  }

  const requestId = randomBytes(18).toString('hex')
  pendingRequestId = requestId

  return new Promise((resolve, reject) => {
    const onRendererGone = () => rejectPendingRequest(requestId, 'The AI-Worker app window closed during the local request. Reopen the app and retry.')
    const timeout = setTimeout(() => rejectPendingRequest(requestId, 'Local model request timed out. Check model status and retry.'), REQUEST_TIMEOUT_MS)
    timeout.unref()
    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      cleanup: () => {
        window.webContents.removeListener('destroyed', onRendererGone)
        window.webContents.removeListener('render-process-gone', onRendererGone)
      },
    })
    window.webContents.once('destroyed', onRendererGone)
    window.webContents.once('render-process-gone', onRendererGone)
    try {
      window.webContents.send('mcp-bridge:ask-local', { requestId, prompt })
    } catch {
      rejectPendingRequest(requestId, 'Could not send the local request to the AI-Worker app window. Reopen the app and retry.')
    }
  })
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: BridgeOptions
): Promise<void> {
  if (!snapshot?.running || !snapshot.port || !snapshot.token) {
    jsonResponse(response, 503, { error: 'AI-Worker local inference bridge is unavailable.' })
    return
  }
  if (!isLoopbackRequest(request, snapshot.port)) {
    jsonResponse(response, 403, { error: 'Loopback requests only.' })
    return
  }
  if (!hasValidToken(request, snapshot.token)) {
    jsonResponse(response, 401, { error: 'Unauthorized.' })
    return
  }
  if (request.method !== 'POST' || !['/ask-local', '/run-agent-task'].includes(request.url || '')) {
    jsonResponse(response, 404, { error: 'Not found.' })
    return
  }
  if (request.headers.origin) {
    jsonResponse(response, 403, { error: 'Browser-origin requests are not supported.' })
    return
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    jsonResponse(response, 415, { error: 'Expected application/json.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (request.url === '/run-agent-task') {
      let input: ReturnType<typeof parseTask>
      try { input = parseTask(body) }
      catch { jsonResponse(response, 400, { error: 'Invalid agent task request.' }); return }
      if (response.destroyed) return
      if (activeTask) { jsonResponse(response, 409, { error: 'An external task is already active.' }); return }
      const taskWindow = options.getTaskWindow()
      const plannerWindow = options.getPlannerWindow()
      if (!taskWindow || taskWindow.isDestroyed() || !isTrustedRendererUrl(taskWindow.webContents, taskWindow.webContents.getURL()) ||
          !plannerWindow || plannerWindow.isDestroyed() || !isTrustedRendererUrl(plannerWindow.webContents, plannerWindow.webContents.getURL())) {
        jsonResponse(response, 503, { error: 'AI-Worker background service is starting. Retry shortly.' })
        return
      }
      const owner = taskWindow.webContents
      const planner = plannerWindow.webContents
      const task = new ExternalAgentTask(input, {
        mode: options.getPrivacyMode, research,
        readyLocalModel: () => {
          const { checkedAt, model } = localTaskModelStatus
          const age = Date.now() - checkedAt
          return snapshot?.running && checkedAt >= snapshot.startedAt && age >= 0 && age < 90_000 ? model : null
        },
        services: input.requested.includes('services') ? options.getServiceChoices() : [],
        privateDirs: [options.userDataDirectory],
        publish: view => {
          if (!view) {
            if (!owner.isDestroyed()) owner.send('external-task:changed', null)
            if (!planner.isDestroyed()) planner.send('external-task:planner-changed', null)
            options.hideTaskWindow()
            return
          }
          if (!owner.isDestroyed() && isTrustedRendererUrl(owner, owner.getURL())) owner.send('external-task:changed', view)
          if (!planner.isDestroyed() && isTrustedRendererUrl(planner, planner.getURL())) planner.send('external-task:planner-changed', view)
          if (['consent', 'action', 'file', 'release'].includes(view.phase)) options.showTaskWindow()
          else options.hideTaskWindow()
        },
      })
      activeTask = { task, owner, planner }
      const cancel = () => task.cancel('External task interrupted.')
      const navigated = (_event: unknown, _url: string, inPage: boolean, mainFrame: boolean) => {
        if (!inPage && mainFrame) cancel()
      }
      owner.once('render-process-gone', cancel)
      owner.once('destroyed', cancel)
      owner.on('did-start-navigation', navigated)
      response.once('close', cancel)
      try {
        const result = await task.run()
        if (!response.destroyed) jsonResponse(response, 200, result)
      } catch (error) {
        // OS and third-party errors can contain unapproved file paths or account data.
        const reason = error instanceof Error ? error.message : ''
        const message = /^(Task (cancelled|expired|step limit|context limit)|Request declined|Privacy mode changed|External task interrupted|On-device planner)/.test(reason)
          ? reason : 'External task stopped. Check the approved scope and runtime, then retry.'
        if (!response.destroyed) jsonResponse(response, 409, { error: message })
      } finally {
        activeTask = null
        options.hideTaskWindow()
        owner.removeListener('destroyed', cancel)
        owner.removeListener('render-process-gone', cancel)
        owner.removeListener('did-start-navigation', navigated)
        response.removeListener('close', cancel)
      }
      return
    }
    const keys = Object.keys(body)
    if (keys.length !== 1 || keys[0] !== 'prompt' || typeof body.prompt !== 'string' ||
        body.prompt.trim().length === 0 || body.prompt.length > MAX_PROMPT_LENGTH) {
      jsonResponse(response, 400, { error: `Provide only a non-empty prompt up to ${MAX_PROMPT_LENGTH} characters.` })
      return
    }
    const result = await askRenderer(options.getInferenceWindow(), body.prompt.trim())
    if (!result.content || result.content.length > MAX_RESPONSE_LENGTH) {
      jsonResponse(response, 502, { error: 'The local model returned an empty or oversized response.' })
      return
    }
    jsonResponse(response, 200, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local inference failed.'
    jsonResponse(response, 503, { error: message.slice(0, 500) })
  }
}

interface BridgeOptions {
  getServiceChoices: typeof getExternalServiceChoices
  userDataDirectory: string
  appVersion: string
  getPrivacyMode: () => PrivacyMode
  getInferenceWindow: () => BrowserWindow | null
  getTaskWindow: () => BrowserWindow | null
  getPlannerWindow: () => BrowserWindow | null
  showTaskWindow: () => void
  hideTaskWindow: () => void
}

export async function startLocalMcpBridge(options: BridgeOptions): Promise<void> {
  if (server) return
  const startedAt = Date.now()
  snapshotPath = join(options.userDataDirectory, 'ai-worker-mcp-status.json')
  snapshot = {
    schemaVersion: 1,
    app: 'AI-Worker',
    version: options.appVersion,
    running: true,
    startedAt,
    heartbeatAt: startedAt,
    privacyMode: options.getPrivacyMode(),
    model: null,
    port: null,
    token: randomBytes(32).toString('hex'),
  }

  const activeServer = createServer((request, response) => {
    void handleHttpRequest(request, response, options)
  })
  activeServer.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  activeServer.on('error', (error) => {
    console.error('[Local MCP] Loopback server error:', error)
  })

  await new Promise<void>((resolve, reject) => {
    activeServer.once('error', reject)
    activeServer.listen(0, '127.0.0.1', () => {
      activeServer.off('error', reject)
      const address = activeServer.address() as AddressInfo
      snapshot!.port = address.port
      server = activeServer
      resolve()
    })
  })

  await queueSnapshotWrite()
  heartbeat = setInterval(() => {
    if (snapshot) snapshot.privacyMode = options.getPrivacyMode()
    void queueSnapshotWrite()
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()
  console.log('[Local MCP] Loopback inference bridge started.')
}

export async function stopLocalMcpBridge(): Promise<void> {
  activeTask?.task.cancel('External task interrupted.')
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  if (snapshot) {
    snapshot.running = false
    snapshot.port = null
    snapshot.token = null
  }
  for (const requestId of pendingRequests.keys()) {
    rejectPendingRequest(requestId, 'AI-Worker is shutting down.')
  }
  pendingRequestId = null
  await queueSnapshotWrite()
  if (server) {
    const activeServer = server
    server = null
    await new Promise<void>((resolve) => activeServer.close(() => resolve()))
  }
}

export async function publishLocalModelStatus(model: LocalTaskModel | null): Promise<void> {
  if (!snapshot?.running) return
  localTaskModelStatus = { model, checkedAt: Date.now() }
  snapshot.model = { available: model !== null, checkedAt: localTaskModelStatus.checkedAt }
  await queueSnapshotWrite()
}

export function resolveLocalMcpRendererReply(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const reply = value as Record<string, unknown>
  if (typeof reply.requestId !== 'string' || reply.requestId !== pendingRequestId) return false
  const pending = pendingRequests.get(reply.requestId)
  if (!pending) return false
  clearTimeout(pending.timeout)
  pending.cleanup()
  pendingRequests.delete(reply.requestId)
  pendingRequestId = null

  if (reply.success !== true) {
    const error = typeof reply.error === 'string' ? reply.error.slice(0, 500) : 'Local inference failed.'
    pending.reject(new Error(error))
    return true
  }
  if (typeof reply.content !== 'string' || typeof reply.provider !== 'string' || typeof reply.model !== 'string' ||
      reply.content.length > MAX_RESPONSE_LENGTH || reply.provider.length > 64 || reply.model.length > 128) {
    pending.reject(new Error('Invalid local inference response.'))
    return false
  }
  pending.resolve({ content: reply.content, provider: reply.provider, model: reply.model })
  return true
}
