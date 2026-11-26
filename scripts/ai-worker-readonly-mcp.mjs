#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const USER_DATA_OVERRIDE = process.env.AI_WORKER_USER_DATA_DIR?.trim()
const SNAPSHOT_FILE = 'ai-worker-mcp-status.json'
const MAX_SNAPSHOT_BYTES = 4096
const MAX_PROMPT_LENGTH = 8000
const REQUEST_TIMEOUT_MS = 125_000

function getUserDataDirectories() {
  if (USER_DATA_OVERRIDE) return [path.resolve(USER_DATA_OVERRIDE)]
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support')
    return [path.join(base, 'AI-Worker'), path.join(base, 'ai-worker')]
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return [path.join(base, 'AI-Worker')]
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return [path.join(base, 'AI-Worker'), path.join(base, 'ai-worker')]
}

function readRuntimeSnapshot() {
  const snapshots = []
  for (const directory of getUserDataDirectories()) {
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
  const now = Date.now()
  const liveSnapshots = snapshots.filter((value) => {
    const age = now - Number(value.heartbeatAt)
    return value.running === true && Number.isFinite(age) && age >= 0 && age < 45_000
  })
  const candidates = liveSnapshots.length ? liveSnapshots : snapshots
  candidates.sort((a, b) => Number(b.heartbeatAt || b.startedAt || 0) - Number(a.heartbeatAt || a.startedAt || 0))
  return candidates[0] || null
}

function getRuntimeStatus() {
  const runtime = readRuntimeSnapshot() || {}
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
    networkUse: 'ask_local sends inference only to the configured on-device WebLLM runtime or loopback Ollama. WebLLM model downloads are explicit and may use the network. This status lookup reads local metadata only.',
    scope: 'read-only status metadata and on-device text inference; no app actions',
    dataExposed: ['app version', 'app running state', 'privacy mode', 'on-device model readiness'],
    excluded: ['chat history', 'memory content', 'workspace files', 'browser automation', 'account tokens', 'connected services'],
  }
}

function getLocalEndpoint() {
  const runtime = readRuntimeSnapshot()
  if (!runtime?.running || typeof runtime.heartbeatAt !== 'number' ||
      Date.now() - runtime.heartbeatAt < 0 || Date.now() - runtime.heartbeatAt >= 45_000) {
    throw new Error('AI-Worker is not running or its local bridge heartbeat is stale. Start AI-Worker and retry.')
  }
  const port = Number(runtime.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof runtime.token !== 'string' || !/^[a-f0-9]{64}$/.test(runtime.token)) {
    throw new Error('AI-Worker local inference bridge is not ready. Restart the desktop app and retry.')
  }
  return { port, token: runtime.token }
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
  description: 'Send one bounded prompt to AI-Worker’s configured on-device model and return its answer. Uses loaded WebLLM or loopback Ollama only; never falls back to cloud. Does not use chat history, memory, workspace files, connected services, or tools, and does not save the prompt in AI-Worker.',
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
server.registerTool('run_agent_task', {
  title: 'Delegate a task to AI-Worker',
  description: 'Delegate to the desktop on-device model. Pass a concise handoffContext and the active project workspaceRoot for workspace tasks. In Local-only mode, a valid project hint allows bounded workspace reads and searches in the background. Broader scopes need desktop consent. File changes and the result returned to this host require review. Online operations require Connected mode.',
  inputSchema: {
    prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
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
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async ({ prompt, capabilities = [], workspaceRoot, handoffContext }, extra) => {
  try {
    const { port, token } = getLocalEndpoint()
    // OpenCode launches local MCP servers from its active project directory by
    // default. Forward that directory so a delegated read task is scoped to the
    // same worktree the parent agent is using, without a redundant folder prompt.
    const activeWorkspace = capabilities.includes('workspace') ? process.cwd() : undefined
    const selectedWorkspace = workspaceRoot || activeWorkspace
    const context = handoffContext || (activeWorkspace ? { workingDirectory: activeWorkspace } : undefined)
    const response = await fetch(`http://127.0.0.1:${port}/run-agent-task`, {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([extra.signal, AbortSignal.timeout(305_000)]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, capabilities, workspaceRoot: selectedWorkspace, handoffContext: context }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'AI-Worker stopped the task.')
    if (typeof result.content !== 'string' || !Array.isArray(result.sources)) throw new Error('Invalid agent task result.')
    return { content: [{ type: 'text', text: result.content }], structuredContent: { sources: result.sources } }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task failed.' }], isError: true }
  }
})

// Keep stdout exclusively for MCP JSON-RPC; Node reports fatal errors to stderr.
await server.connect(new StdioServerTransport())
