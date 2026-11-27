#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const USER_DATA_OVERRIDE = process.env.AI_WORKER_USER_DATA_DIR?.trim()
const TAURI_APP_IDENTIFIER = 'com.aiworker.app.tauri'
const SNAPSHOT_FILE = 'ai-worker-mcp-status.json'
const MAX_SNAPSHOT_BYTES = 4096
const MAX_PROMPT_LENGTH = 8000
const MAX_TASK_PROMPT_LENGTH = 4000
const MAX_PARENT_ANSWER_LENGTH = 2000
const REQUEST_TIMEOUT_MS = 125_000
const TASK_REQUEST_TIMEOUT_MS = 30_000
const TASK_RUN_TIMEOUT_MS = 305_000
const HOST_SESSION_HEARTBEAT_MS = 15_000
const RUNTIME_START_TIMEOUT_MS = 30_000
const TASK_ID_PATTERN = /^[a-f0-9]{64}$/
const HOST_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const TASK_STATES = new Set(['queued', 'running', 'waiting_for_parent', 'waiting_for_approval', 'completed', 'failed', 'cancelling', 'cancelled'])
const SAFE_LOCAL_MODEL_ERROR = 'The selected local model returned no answer text. Choose another installed local model and retry. No cloud fallback was used.'
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const configuredHostSessionId = process.env.AI_WORKER_HOST_SESSION_ID?.trim()
const hostSessionId = configuredHostSessionId || randomBytes(16).toString('hex')
if (!HOST_SESSION_ID_PATTERN.test(hostSessionId)) throw new Error('AI_WORKER_HOST_SESSION_ID must contain 1–64 letters, digits, dots, underscores, colons or hyphens.')

let runtimeStartPromise
let heartbeatTimer
let heartbeatInFlight = false
let shuttingDown = false
const activeHostSessionIds = new Set()

function getUserDataDirectories(profile = 'all') {
  if (USER_DATA_OVERRIDE) return [path.resolve(USER_DATA_OVERRIDE)]
  const platform = process.platform
  let electronBase
  if (platform === 'darwin') {
    electronBase = path.join(os.homedir(), 'Library', 'Application Support')
  } else if (platform === 'win32') {
    electronBase = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  } else {
    electronBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  }
  const electronDirectories = [path.join(electronBase, 'AI-Worker')]
  if (platform !== 'win32') electronDirectories.push(path.join(electronBase, 'ai-worker'))
  let tauriBase = electronBase
  if (platform !== 'darwin' && platform !== 'win32') {
    const dataHome = process.env.XDG_DATA_HOME
    tauriBase = dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(os.homedir(), '.local', 'share')
  }
  const tauriDirectory = path.join(tauriBase, TAURI_APP_IDENTIFIER)
  if (profile === 'tauri') return [tauriDirectory]
  if (profile === 'electron') return electronDirectories
  return [...electronDirectories, tauriDirectory]
}

function readRuntimeSnapshots(profile = 'all') {
  const snapshots = []
  for (const directory of getUserDataDirectories(profile)) {
    const snapshotPath = path.join(directory, SNAPSHOT_FILE)
    try {
      const fileInfo = fs.lstatSync(snapshotPath)
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_SNAPSHOT_BYTES) continue
      const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) continue
      snapshots.push(parsed)
    } catch {
      continue
    }
  }
  return snapshots
}

function getRuntimeStatus() {
  const snapshots = readRuntimeSnapshots()
  const now = Date.now()
  const liveSnapshots = snapshots.filter((value) => {
    const age = now - Number(value.heartbeatAt)
    return value.running === true && Number.isFinite(age) && age >= 0 && age < 45_000
  })
  const candidates = liveSnapshots.length ? liveSnapshots : snapshots
  candidates.sort((a, b) => Number(b.heartbeatAt || b.startedAt || 0) - Number(a.heartbeatAt || a.startedAt || 0))
  const runtime = candidates[0] || {}
  const heartbeatAt = Number(runtime.heartbeatAt)
  const startedAt = Number(runtime.startedAt)
  const heartbeatAgeMs = Date.now() - heartbeatAt
  const isLive = runtime.running === true && Number.isFinite(heartbeatAt) && heartbeatAgeMs >= 0 && heartbeatAgeMs < 45_000
  const model = runtime.model && typeof runtime.model === 'object' ? runtime.model : null
  const checkedAt = Number(model?.checkedAt)
  const modelStatusAgeMs = Date.now() - checkedAt
  const modelStatusFresh = isLive && checkedAt >= startedAt && modelStatusAgeMs >= 0 && modelStatusAgeMs < 90_000
  const privacyMode = isLive && ['connected', 'local-only'].includes(runtime.privacyMode) ? runtime.privacyMode : 'unknown'
  const networkUse = privacyMode === 'local-only'
    ? 'This running AI-Worker instance reports local-only mode. MCP ask_local and Tauri task inference stay on-device with no cloud fallback. In Tauri local-only mode, public research is disabled. Model setup downloads and the MCP host’s own network use are separate.'
    : privacyMode === 'connected'
      ? 'This running AI-Worker instance reports connected mode. Electron app chat may use its selected connected provider; MCP ask_local and Tauri task inference stay on-device with no cloud fallback. Tauri public research requires both the AI-Worker Settings opt-in and capabilities:["web"]. Search terms go to DuckDuckGo and requested public HTTPS URLs are fetched as supplied, including their paths and query strings. Outbound request planning uses the host task prompt and public web results, not workspace files or handoff notes. AI-Worker does not attach saved cookies or account credentials; result text and source URLs are returned to the MCP host, which may be remote. Model downloads and host networking are separate.'
      : 'AI-Worker runtime status is missing, stale, or stopped, so current privacy and network settings are unknown. Do not infer that cloud or public web use is disabled from this status. MCP inference and task tools require a running app. Model setup downloads and the MCP host’s own network use may occur separately.'

  return {
    app: 'AI-Worker',
    version: isLive && typeof runtime.version === 'string' ? runtime.version : null,
    appRunning: isLive,
    privacyMode,
    modelReady: modelStatusFresh && typeof model?.available === 'boolean' ? model.available : null,
    modelStatusFresh,
    networkUse,
    scope: 'status, on-device text inference, bounded workspace list/read/search, optional Tauri public web research when enabled in AI-Worker settings and explicitly requested by the task, and asynchronous staged file writes that require exact-content desktop approval',
    dataExposed: ['app version', 'app running state', 'privacy mode', 'on-device model readiness'],
    excluded: ['chat history', 'memory content', 'workspace files', 'browser automation', 'account tokens', 'connected services'],
  }
}

function getLocalEndpoint({ profile = 'all' } = {}) {
  const snapshots = readRuntimeSnapshots(profile)
  const now = Date.now()
  const liveSnapshots = snapshots.filter(({ running, heartbeatAt }) => {
    if (running !== true || !Number.isFinite(heartbeatAt)) return false
    const age = now - heartbeatAt
    return age >= 0 && age < 45_000
  })
  if (liveSnapshots.length === 0) {
    throw new Error('AI-Worker is not running or its local bridge heartbeat is stale. Start AI-Worker and retry.')
  }
  const runtime = liveSnapshots.sort((a, b) => b.heartbeatAt - a.heartbeatAt).find(({ port, token }) =>
    Number.isInteger(port) && port >= 1 && port <= 65535 &&
    typeof token === 'string' && /^[a-f0-9]{64}$/.test(token),
  )
  if (!runtime) {
    throw new Error('AI-Worker local inference bridge is not ready. Restart the desktop app and retry.')
  }
  return { port: runtime.port, token: runtime.token }
}

function validateTauriExecutable(candidate) {
  const executable = path.resolve(candidate)
  try {
    if (!fs.statSync(executable).isFile()) return null
    if (process.platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK)
    return executable
  } catch {
    return null
  }
}

function findTauriExecutable() {
  const override = process.env.AI_WORKER_TAURI_EXECUTABLE?.trim()
  if (override) {
    const executable = validateTauriExecutable(override)
    if (!executable) throw new Error('AI_WORKER_TAURI_EXECUTABLE does not point to an executable file.')
    return executable
  }

  const name = process.platform === 'win32' ? 'ai-worker-tauri.exe' : 'ai-worker-tauri'
  const candidates = [
    path.resolve(SCRIPT_DIRECTORY, `../src-tauri/target/debug/${name}`),
    path.resolve(SCRIPT_DIRECTORY, `../src-tauri/target/release/${name}`),
  ]
  if (process.platform === 'darwin') {
    candidates.push(
      path.resolve(SCRIPT_DIRECTORY, '../../../MacOS/AI-Worker'),
      path.resolve(SCRIPT_DIRECTORY, '../../../MacOS/ai-worker-tauri'),
    )
  } else if (process.platform === 'win32') {
    candidates.push(
      path.resolve(SCRIPT_DIRECTORY, '../../AI-Worker.exe'),
      path.resolve(SCRIPT_DIRECTORY, '../../../AI-Worker.exe'),
    )
  } else {
    candidates.push(
      path.resolve(SCRIPT_DIRECTORY, '../../AI-Worker'),
      path.resolve(SCRIPT_DIRECTORY, '../../../AI-Worker'),
      path.resolve(SCRIPT_DIRECTORY, '../../ai-worker-tauri'),
      path.resolve(SCRIPT_DIRECTORY, '../../../ai-worker-tauri'),
    )
  }
  return candidates.map(validateTauriExecutable).find(Boolean) || null
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function acquireStartupLock() {
  const dataDirectory = getUserDataDirectories('tauri')[0]
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const lockPath = path.join(dataDirectory, 'ai-worker-mcp-start.lock')
  const lockContents = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex'), createdAt: Date.now() })
  const openLock = () => {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, lockContents)
    } catch (error) {
      fs.closeSync(descriptor)
      fs.unlinkSync(lockPath)
      throw error
    }
    return { descriptor, lockPath, lockContents }
  }
  try {
    return openLock()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  try {
    const entry = fs.lstatSync(lockPath)
    if (entry.isSymbolicLink() || !entry.isFile() || Date.now() - entry.mtimeMs < RUNTIME_START_TIMEOUT_MS + 5_000) return null
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) {
      fs.unlinkSync(lockPath)
      return openLock()
    }
    try {
      process.kill(owner.pid, 0)
      return null
    } catch (error) {
      if (error?.code !== 'ESRCH') return null
    }
    fs.unlinkSync(lockPath)
    return openLock()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return null
    if (error instanceof SyntaxError) {
      try { fs.unlinkSync(lockPath); return openLock() } catch { return null }
    }
    throw error
  }
}

function releaseStartupLock(lock) {
  fs.closeSync(lock.descriptor)
  try {
    if (fs.readFileSync(lock.lockPath, 'utf8') === lock.lockContents) fs.unlinkSync(lock.lockPath)
  } catch {}
}

async function ensureTauriRuntime() {
  try {
    getLocalEndpoint({ profile: 'tauri' })
    return
  } catch (initialError) {
    if (['false', '0'].includes(process.env.AI_WORKER_AUTOSTART?.trim().toLowerCase())) {
      throw new Error(`${initialError instanceof Error ? initialError.message : 'AI-Worker is not running.'} Automatic startup is disabled by AI_WORKER_AUTOSTART.`)
    }
    if (!runtimeStartPromise) {
      runtimeStartPromise = (async () => {
        const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS
        while (Date.now() < deadline) {
          try {
            getLocalEndpoint({ profile: 'tauri' })
            return
          } catch {
            const startupLock = acquireStartupLock()
            if (startupLock) {
              try {
                try {
                  getLocalEndpoint({ profile: 'tauri' })
                  return
                } catch {}
                const executable = findTauriExecutable()
                if (!executable) {
                  throw new Error('AI-Worker background app was not found. Open AI-Worker once or set AI_WORKER_TAURI_EXECUTABLE to its Tauri executable.')
                }
                let launchError
                const child = spawn(executable, ['--worker-service'], {
                  cwd: path.dirname(executable),
                  detached: true,
                  stdio: 'ignore',
                  windowsHide: true,
                })
                child.once('error', error => { launchError = error })
                child.unref()
                while (Date.now() < deadline) {
                  if (launchError) throw new Error(`Could not start AI-Worker background app: ${launchError.message}`)
                  try {
                    getLocalEndpoint({ profile: 'tauri' })
                    return
                  } catch {
                    await sleep(250)
                  }
                }
                throw new Error('AI-Worker background app did not become ready within 30 seconds. Open AI-Worker and check its local model and bridge status.')
              } finally {
                releaseStartupLock(startupLock)
              }
            }
            await sleep(250)
          }
        }
        throw new Error('AI-Worker background app did not become ready within 30 seconds. Open AI-Worker and check its local model and bridge status.')
      })().finally(() => { runtimeStartPromise = undefined })
    }
    return runtimeStartPromise
  }
}

function isAbsolutePath(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

async function askLocal(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Provide a non-empty prompt up to ${MAX_PROMPT_LENGTH} characters.`)
  }
  const { port, token } = getLocalEndpoint()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ask-local`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ prompt: prompt.trim() }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(typeof result.error === 'string' ? result.error : `AI-Worker local inference returned HTTP ${response.status}.`)
    }
    if (!result || typeof result.content !== 'string' || typeof result.provider !== 'string' || typeof result.model !== 'string') {
      throw new Error('AI-Worker returned an invalid local inference response.')
    }
    return result
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AI-Worker local inference timed out. Check the model status and retry.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function resolveHostSessionId(value) {
  const id = value === undefined ? hostSessionId : value
  if (typeof id !== 'string' || !HOST_SESSION_ID_PATTERN.test(id)) {
    throw new Error('Host session ID must contain 1–64 letters, digits, dots, underscores, colons or hyphens.')
  }
  return id
}

function agentTaskRequest({ capabilities = [], workspaceRoot, handoffContext, prompt, hostSessionId: requestedSessionId }) {
  const hasWorkspace = capabilities.includes('workspace')
  const activeWorkspace = hasWorkspace ? process.cwd() : undefined
  const selectedWorkspace = workspaceRoot || activeWorkspace
  const context = handoffContext ? { ...handoffContext } : {}
  if (hasWorkspace && !context.workingDirectory) context.workingDirectory = selectedWorkspace
  const request = { prompt, capabilities, hostSessionId: resolveHostSessionId(requestedSessionId) }
  if (selectedWorkspace) request.workspaceRoot = selectedWorkspace
  if (Object.keys(context).length > 0) request.handoffContext = context
  return request
}

function validateHostSessionAck(value, expectedSessionId) {
  if (!value || value.sessionId !== expectedSessionId || !Number.isInteger(value.connectedSessions) ||
      value.connectedSessions < 0 || value.connectedSessions > 16) {
    throw new Error('AI-Worker returned an invalid host session acknowledgement.')
  }
}

async function requestTauriAtRuntime(pathname, { method = 'GET', body, signal, timeout = TASK_REQUEST_TIMEOUT_MS } = {}) {
  const { port, token } = getLocalEndpoint({ profile: 'tauri' })
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout)
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      redirect: 'error',
      signal: requestSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('The MCP caller cancelled this request.')
    if (requestSignal.aborted) throw new Error('AI-Worker local task request timed out. Check the app status and retry.')
    throw error
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : `AI-Worker local task request returned HTTP ${response.status}.`)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('AI-Worker returned an invalid task response.')
  }
  return result
}

async function registerHostSession(sessionId = hostSessionId) {
  if (shuttingDown) return
  const result = await requestTauriAtRuntime('/host-session/open', {
    method: 'POST',
    body: { sessionId },
  })
  validateHostSessionAck(result, sessionId)
  activeHostSessionIds.add(sessionId)
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(async () => {
      if (shuttingDown || activeHostSessionIds.size === 0 || heartbeatInFlight) return
      heartbeatInFlight = true
      try {
        for (const sessionId of [...activeHostSessionIds]) {
          try {
            const heartbeat = await requestTauriAtRuntime('/host-session/heartbeat', {
              method: 'POST',
              body: { sessionId },
            })
            validateHostSessionAck(heartbeat, sessionId)
          } catch {
            activeHostSessionIds.delete(sessionId)
            if (!shuttingDown) {
              try {
                await ensureTauriRuntime()
                await registerHostSession(sessionId)
              } catch (error) {
                console.error(`[AI-Worker MCP] Host session heartbeat failed: ${error instanceof Error ? error.message : 'local bridge unavailable'}`)
              }
            }
          }
        }
      } finally {
        heartbeatInFlight = false
      }
    }, HOST_SESSION_HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  }
}

async function closeHostSession() {
  shuttingDown = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  while (heartbeatInFlight) await sleep(10)
  const sessionIds = [...activeHostSessionIds]
  activeHostSessionIds.clear()
  await Promise.all(sessionIds.map(sessionId => requestTauriAtRuntime('/host-session/close', {
    method: 'POST',
    body: { sessionId },
    timeout: 2_000,
  }).then(value => validateHostSessionAck(value, sessionId)).catch(() => {})))
}

async function requestTauri(pathname, options = {}) {
  await ensureTauriRuntime()
  if (!activeHostSessionIds.has(hostSessionId) && !pathname.startsWith('/host-session/')) {
    await registerHostSession(hostSessionId)
  }
  return requestTauriAtRuntime(pathname, options)
}

async function ensureHostSession(sessionId) {
  await ensureTauriRuntime()
  if (!activeHostSessionIds.has(sessionId)) await registerHostSession(sessionId)
}

function validateTaskId(id, label = 'task ID') {
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) throw new Error(`Provide a valid ${label}.`)
  return id
}

function invalidTaskSource(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 2048) return true
  if (source.startsWith('https://')) {
    try {
      const url = new URL(source)
      return url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
    } catch {
      return true
    }
  }
  return source.length > 256 || source.includes('\\') || source.includes(':') || source.startsWith('/') ||
    source.split('/').some(part => part === '' || part === '.' || part === '..')
}

function normalizeTaskResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.content !== 'string' || [...value.content].length > 4000 ||
      !Array.isArray(value.sources) || value.sources.length > 16 ||
      value.sources.some(invalidTaskSource)) {
    throw new Error('AI-Worker returned an invalid task result.')
  }
  return { content: value.content, sources: value.sources }
}

function normalizeTaskStatus(value, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.id !== expectedId || !TASK_STATES.has(value.state)) {
    throw new Error('AI-Worker returned an invalid task status.')
  }
  const status = { id: expectedId, state: value.state }
  if (value.pendingQuestion !== undefined) {
    const question = value.pendingQuestion
    if (value.state !== 'waiting_for_parent' || !question || typeof question !== 'object' ||
        !TASK_ID_PATTERN.test(question.id) || typeof question.text !== 'string' ||
        question.text.trim().length === 0 || [...question.text].length > 1000) {
      throw new Error('AI-Worker returned an invalid parent question.')
    }
    status.pendingQuestion = { id: question.id, text: question.text }
  }
  if (value.result !== undefined) {
    if (value.state !== 'completed') {
      throw new Error('AI-Worker returned an invalid task result.')
    }
    status.result = normalizeTaskResult(value.result)
  }
  if (value.state === 'waiting_for_parent' && status.pendingQuestion === undefined) {
    throw new Error('AI-Worker returned an invalid parent question.')
  }
  if (value.state === 'completed' && status.result === undefined) {
    throw new Error('AI-Worker returned an invalid task result.')
  }
  if (value.state === 'failed') {
    // Do not echo arbitrary diagnostics that may contain handoff text or local paths.
    status.error = value.error === SAFE_LOCAL_MODEL_ERROR
      ? SAFE_LOCAL_MODEL_ERROR
      : 'Task failed. Check the local model status or retry with a narrower task.'
  }
  return status
}

function normalizeTaskAck(value, expectedId, allowedStates) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== expectedId ||
      !allowedStates.includes(value.state)) {
    throw new Error('AI-Worker returned an invalid task acknowledgement.')
  }
  return { id: expectedId, state: value.state }
}

async function startAgentTask(input) {
  const taskHostSessionId = resolveHostSessionId(input.hostSessionId)
  await ensureHostSession(taskHostSessionId)
  const request = agentTaskRequest({ ...input, hostSessionId: taskHostSessionId })
  const result = await requestTauri('/start-agent-task', { method: 'POST', body: request })
  if (typeof result.id !== 'string' || !TASK_ID_PATTERN.test(result.id) || result.state !== 'queued') {
    throw new Error('AI-Worker returned an invalid task ID.')
  }
  return { id: result.id, state: 'queued' }
}

async function getAgentTask(taskId, signal) {
  validateTaskId(taskId)
  const result = await requestTauri(`/agent-task/${taskId}`, { signal })
  return normalizeTaskStatus(result, taskId)
}

async function answerAgentQuestion({ taskId, questionId, answer }, signal) {
  validateTaskId(taskId)
  validateTaskId(questionId, 'question ID')
  const result = await requestTauri(`/agent-task/${taskId}/answer`, {
    method: 'POST', body: { questionId, answer }, signal,
  })
  return normalizeTaskAck(result, taskId, ['queued', 'running'])
}

async function cancelAgentTask(taskId, signal) {
  validateTaskId(taskId)
  const result = await requestTauri(`/agent-task/${taskId}/cancel`, {
    method: 'POST', body: {}, signal,
  })
  return normalizeTaskAck(result, taskId, [...TASK_STATES])
}

const server = new McpServer({ name: 'ai_worker_readonly', version: '1.0.0' })

server.registerTool('get_runtime_status', {
  title: 'Get AI-Worker readiness',
  description: 'Read non-sensitive AI-Worker app, privacy-mode, and local-model readiness metadata. Reads a small metadata-only snapshot and does not inspect chat, memory, workspace files, credentials, or connected services.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => ({
  content: [{ type: 'text', text: JSON.stringify(getRuntimeStatus(), null, 2) }],
}))

server.registerTool('ask_local', {
  title: 'Ask AI-Worker on-device',
  description: 'Send one bounded prompt to AI-Worker’s configured on-device model and return its answer. Uses local inference only and never falls back to cloud (Electron: loaded WebLLM or loopback Ollama; Tauri: its pinned local llama.cpp runtime when available). Does not use chat history, memory, workspace files, connected services, or tools, and does not save the prompt in AI-Worker.',
  inputSchema: { prompt: z.string().min(1).max(MAX_PROMPT_LENGTH) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ prompt }) => {
  try {
    const result = await askLocal(prompt)
    return {
      content: [{ type: 'text', text: result.content }],
      structuredContent: { provider: result.provider, model: result.model },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI-Worker local inference failed.'
    return { content: [{ type: 'text', text: message }], isError: true }
  }
})

const handoffLine = max => z.string().min(1).max(max).trim().min(1).regex(/^[^\x00-\x1f\x7f]+$/)
const handoffNote = max => z.string().min(1).max(max).trim().min(1).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$/)
const taskInputSchema = {
  prompt: z.string().trim().min(1).max(MAX_TASK_PROMPT_LENGTH),
  hostSessionId: z.string().regex(HOST_SESSION_ID_PATTERN).optional()
    .describe('Optional stable ID for this host conversation when one MCP process serves multiple conversations.'),
  capabilities: z.array(z.enum(['workspace', 'web'])).max(2).optional(),
  workspaceRoot: handoffLine(1024).refine(isAbsolutePath, 'Workspace root must be an absolute path.').optional()
    .describe('Absolute active project root supplied by the main agent.'),
  handoffContext: z.strictObject({
    summary: handoffNote(2000).optional(),
    constraints: z.array(handoffNote(256)).max(8).optional(),
    relevantFiles: z.array(handoffLine(256).refine(file => !file.includes(':') &&
      file.split(/[\\/]/).every(part => part !== '' && part !== '.' && part !== '..'))).max(12).optional(),
    sourceAgent: handoffLine(96).optional(),
    workingDirectory: handoffLine(1024).refine(isAbsolutePath).optional(),
  }).optional().describe('Explicit background for this task. Use relative file names and omit credentials and unrelated conversation.'),
}
const taskIdSchema = z.string().regex(TASK_ID_PATTERN, 'Task ID must be 64 lowercase hexadecimal characters.')
const syncTaskInputSchema = { ...taskInputSchema, capabilities: z.array(z.literal('workspace')).max(1).optional() }
server.registerTool('run_agent_task', {
  title: 'Delegate a task to AI-Worker',
  description: 'Run a bounded synchronous read-only task with AI-Worker’s Tauri on-device model. For workspace tasks, pass capabilities:["workspace"] and the active project workspaceRoot; workspace reads are limited to that project. This route never writes, browses the web, or accesses connected services. The result is returned to this host, whose model may be remote; use a local host model to keep workspace content on-device.',
  inputSchema: syncTaskInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ prompt, capabilities = [], workspaceRoot, handoffContext, hostSessionId: requestedSessionId }, extra) => {
  try {
    const taskHostSessionId = resolveHostSessionId(requestedSessionId)
    await ensureHostSession(taskHostSessionId)
    const request = agentTaskRequest({ prompt, capabilities, workspaceRoot, handoffContext, hostSessionId: taskHostSessionId })
    const result = await requestTauri('/run-agent-task', {
      method: 'POST', body: request, signal: extra.signal, timeout: TASK_RUN_TIMEOUT_MS,
    })
    const taskResult = normalizeTaskResult(result)
    return { content: [{ type: 'text', text: taskResult.content }], structuredContent: { sources: taskResult.sources } }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task failed.' }], isError: true }
  }
})

server.registerTool('start_agent_task', {
  title: 'Start a delegated AI-Worker task',
  description: 'Start a process-local task using AI-Worker’s on-device model. Workspace scope is the active project path supplied by the host; bounded reads need no per-file prompts. For public research, both the AI-Worker Settings opt-in and capabilities:["web"] are required. Search terms and requested public HTTPS URLs leave this device; fetched result text and source URLs return to this MCP host, which may be remote. Keep private workspace content out of search terms and URLs. Connected services remain unavailable. If a file write is proposed, the task pauses while the user reviews the exact current and proposed content in AI-Worker’s compact approval window; no write occurs before approval. Dismissing or declining cancels that write. Starting returns an ID only; poll get_agent_task for a parent question, write-approval wait state, or completed result.',
  inputSchema: taskInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ prompt, capabilities = [], workspaceRoot, handoffContext, hostSessionId }, extra) => {
  try {
    if (extra.signal.aborted) throw new Error('The MCP caller cancelled this request.')
    // Keep start uncancellable until its ID arrives, so a host cancellation can cancel the task it created.
    const task = await startAgentTask({ prompt, capabilities, workspaceRoot, handoffContext, hostSessionId })
    if (extra.signal.aborted) {
      await cancelAgentTask(task.id).catch(() => {})
      throw new Error('The MCP caller cancelled this request.')
    }
    return { content: [{ type: 'text', text: JSON.stringify(task) }], structuredContent: task }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task could not be started.' }], isError: true }
  }
})

server.registerTool('get_agent_task', {
  title: 'Check AI-Worker task status',
  description: 'Read status for one task. If waiting for the parent, returns its bounded question; if waiting for a workspace write approval, returns only that state and no file contents. If completed, returns the result and sources, which may be workspace-relative paths or public HTTPS URLs from requested research. This call releases returned text to this MCP host, which may be remote; use a local host model to keep workspace data on-device.',
  inputSchema: { taskId: taskIdSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ taskId }, extra) => {
  try {
    const status = await getAgentTask(taskId, extra.signal)
    return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task status is unavailable.' }], isError: true }
  }
})

server.registerTool('answer_agent_question', {
  title: 'Answer AI-Worker question',
  description: 'Send a bounded answer to the exact pending question for this task. AI-Worker treats parent answers as untrusted task data and resumes within the original scope; any proposed workspace write still requires user approval in AI-Worker.',
  inputSchema: {
    taskId: taskIdSchema,
    questionId: taskIdSchema.describe('Exact question ID returned by get_agent_task.'),
    answer: handoffNote(MAX_PARENT_ANSWER_LENGTH),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ taskId, questionId, answer }, extra) => {
  try {
    const result = await answerAgentQuestion({ taskId, questionId, answer }, extra.signal)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Answer was not accepted.' }], isError: true }
  }
})

server.registerTool('cancel_agent_task', {
  title: 'Cancel AI-Worker task',
  description: 'Request cancellation of one task. A running local model may finish its current generation before cancellation is confirmed; check the returned state before starting follow-on work.',
  inputSchema: { taskId: taskIdSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ taskId }, extra) => {
  try {
    const result = await cancelAgentTask(taskId, extra.signal)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Cancellation was not accepted.' }], isError: true }
  }
})

async function startMcpServer() {
  try {
    await ensureTauriRuntime()
    await registerHostSession()
  } catch (error) {
    console.error(`[AI-Worker MCP] Background service unavailable: ${error instanceof Error ? error.message : 'unknown local startup error'}`)
  }
  // Keep stdout exclusively for MCP JSON-RPC; Node reports fatal errors to stderr.
  await server.connect(new StdioServerTransport())
}

process.once('beforeExit', () => { void closeHostSession() })
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void closeHostSession().finally(() => process.exit(code))
  })
}

await startMcpServer()
