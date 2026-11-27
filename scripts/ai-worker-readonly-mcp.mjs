#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
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
const TASK_ID_PATTERN = /^[a-f0-9]{64}$/
const TASK_STATES = new Set(['queued', 'running', 'waiting_for_parent', 'waiting_for_approval', 'completed', 'failed', 'cancelling', 'cancelled'])
const SAFE_LOCAL_MODEL_ERROR = 'The selected local model returned no answer text. Choose another installed local model and retry. No cloud fallback was used.'

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

  return {
    app: 'AI-Worker',
    version: isLive && typeof runtime.version === 'string' ? runtime.version : null,
    appRunning: isLive,
    privacyMode: isLive && ['connected', 'local-only'].includes(runtime.privacyMode) ? runtime.privacyMode : 'unknown',
    modelReady: modelStatusFresh && typeof model?.available === 'boolean' ? model.available : null,
    modelStatusFresh,
    networkUse: 'Status reads local metadata. ask_local and Tauri task tools use on-device inference only and never fall back to cloud. Workspace tasks read only the active project path provided by the host. Tauri task mode does not browse the web or access connected services. Model imports or explicit model setup may use the network.',
    scope: 'status, on-device text inference, bounded workspace list/read/search, and asynchronous staged file writes that require explicit desktop approval',
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

function agentTaskRequest({ capabilities = [], workspaceRoot, handoffContext, prompt }) {
  // OpenCode launches local MCP servers from its active project directory by default.
  const activeWorkspace = capabilities.includes('workspace') ? process.cwd() : undefined
  return {
    prompt,
    capabilities,
    workspaceRoot: workspaceRoot || activeWorkspace,
    handoffContext: handoffContext || (activeWorkspace ? { workingDirectory: activeWorkspace } : undefined),
  }
}

async function requestTauri(pathname, { method = 'GET', body, signal, timeout = TASK_REQUEST_TIMEOUT_MS } = {}) {
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

function validateTaskId(id, label = 'task ID') {
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) throw new Error(`Provide a valid ${label}.`)
  return id
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
    const result = value.result
    if (value.state !== 'completed' || !result || typeof result !== 'object' ||
        typeof result.content !== 'string' || [...result.content].length > 4000 ||
        !Array.isArray(result.sources) || result.sources.length > 16 ||
        result.sources.some(source => typeof source !== 'string' || source.length === 0 || source.length > 256 ||
          source.includes('\\') || source.includes(':') || source.startsWith('/') ||
          source.split('/').some(part => part === '' || part === '.' || part === '..'))) {
      throw new Error('AI-Worker returned an invalid task result.')
    }
    status.result = { content: result.content, sources: result.sources }
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

async function startAgentTask(input, signal) {
  const request = agentTaskRequest(input)
  const result = await requestTauri('/start-agent-task', { method: 'POST', body: request, signal })
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
  capabilities: z.array(z.enum(['workspace', 'web', 'services'])).max(3).optional(),
  workspaceRoot: handoffLine(1024).optional().describe('Absolute active project root supplied by the main agent.'),
  handoffContext: z.strictObject({
    summary: handoffNote(2000).optional(),
    constraints: z.array(handoffNote(256)).max(8).optional(),
    relevantFiles: z.array(handoffLine(256).refine(file => !file.includes(':') &&
      file.split(/[\\/]/).every(part => part !== '' && part !== '.' && part !== '..'))).max(12).optional(),
    sourceAgent: handoffLine(96).optional(),
    workingDirectory: handoffLine(1024).refine(dir => path.posix.isAbsolute(dir) || path.win32.isAbsolute(dir)).optional(),
  }).optional().describe('Explicit background for this task. Use relative file names and omit credentials and unrelated conversation.'),
}
const taskIdSchema = z.string().regex(TASK_ID_PATTERN, 'Task ID must be 64 lowercase hexadecimal characters.')
server.registerTool('run_agent_task', {
  title: 'Delegate a task to AI-Worker',
  description: 'Run a bounded synchronous read-only task with AI-Worker’s Tauri on-device model. For workspace tasks, pass capabilities:["workspace"] and the active project workspaceRoot; workspace reads are limited to that project. This route never writes, browses the web, or accesses connected services. The result is returned to this host, whose model may be remote; use a local host model to keep workspace content on-device.',
  inputSchema: taskInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ prompt, capabilities = [], workspaceRoot, handoffContext }, extra) => {
  try {
    const request = agentTaskRequest({ prompt, capabilities, workspaceRoot, handoffContext })
    const result = await requestTauri('/run-agent-task', {
      method: 'POST', body: request, signal: extra.signal, timeout: TASK_RUN_TIMEOUT_MS,
    })
    if (typeof result.content !== 'string' || !Array.isArray(result.sources)) throw new Error('Invalid agent task result.')
    return { content: [{ type: 'text', text: result.content }], structuredContent: { sources: result.sources } }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task failed.' }], isError: true }
  }
})

server.registerTool('start_agent_task', {
  title: 'Start a delegated AI-Worker task',
  description: 'Start a process-local task using AI-Worker’s on-device model. Workspace scope is the active project path supplied by the host; bounded reads need no per-file prompts. If a file write is proposed, the task pauses while the user reviews the exact current and proposed content in AI-Worker’s compact approval window; no write occurs before approval. Dismissing or declining cancels that write. This local-only task cannot browse the web or use connected services. Starting returns an ID only; poll get_agent_task for a parent question, write-approval wait state, or completed result. A remote host can receive text it requests, so use a local host model to keep workspace data on-device.',
  inputSchema: taskInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ prompt, capabilities = [], workspaceRoot, handoffContext }, extra) => {
  try {
    const task = await startAgentTask({ prompt, capabilities, workspaceRoot, handoffContext }, extra.signal)
    return { content: [{ type: 'text', text: JSON.stringify(task) }], structuredContent: task }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task could not be started.' }], isError: true }
  }
})

server.registerTool('get_agent_task', {
  title: 'Check AI-Worker task status',
  description: 'Read status for one task. If waiting for the parent, returns its bounded question; if waiting for a workspace write approval, returns only that state and no file contents. If completed, returns the result and workspace-relative sources. This call releases returned text to this MCP host, which may be remote; use a local host model to keep workspace data on-device.',
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

// Keep stdout exclusively for MCP JSON-RPC; Node reports fatal errors to stderr.
await server.connect(new StdioServerTransport())
