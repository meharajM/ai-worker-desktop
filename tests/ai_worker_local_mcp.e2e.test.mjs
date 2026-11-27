import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverPath = process.env.AI_WORKER_MCP_SERVER_PATH || path.join(root, 'scripts', 'ai-worker-readonly-mcp.mjs')
const serverCwd = process.env.AI_WORKER_MCP_SERVER_CWD || root

test('stdio MCP handshake exposes status, inference and desktop-approved tasks without reading app storage', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-worker-mcp-'))
  const token = 'a'.repeat(64)
  const promptSeen = []
  const httpServer = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    promptSeen.push(body)
    assert.equal(request.method, 'POST')
    assert.ok(['/ask-local', '/run-agent-task'].includes(request.url))
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    assert.equal(request.headers.host, `127.0.0.1:${httpServer.address().port}`)
    if (request.url === '/run-agent-task') {
      if (body.capabilities?.some((capability) => ['web', 'services'].includes(capability))) {
        response.writeHead(422, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'This Tauri task route is local-only and does not provide web or connected-service tools.' }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ content: 'Approved.', sources: ['https://example.org/'] }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ content: 'Local answer: pong', provider: 'browser', model: 'fixture-model' }))
  })

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  const now = Date.now()
  await fs.writeFile(path.join(userData, 'ai-worker-store.json'), JSON.stringify({
    chatHistory: 'SECRET_CHAT_SENTINEL',
    memory: 'SECRET_MEMORY_SENTINEL',
    apiToken: 'SECRET_TOKEN_SENTINEL',
  }))
  await fs.writeFile(path.join(userData, 'ai-worker-mcp-status.json'), JSON.stringify({
    schemaVersion: 1,
    app: 'AI-Worker',
    version: 'test-version',
    running: true,
    startedAt: now - 100,
    heartbeatAt: now,
    privacyMode: 'local-only',
    model: { available: true, checkedAt: now },
    port,
    token,
  }))

  const client = new Client({ name: 'ai-worker-local-mcp-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: serverCwd,
    env: { AI_WORKER_USER_DATA_DIR: userData },
    stderr: 'pipe',
  })

  try {
    await client.connect(transport)
    const catalog = await client.listTools()
    assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), [
      'answer_agent_question', 'ask_local', 'cancel_agent_task', 'get_agent_task',
      'get_runtime_status', 'run_agent_task', 'start_agent_task',
    ])

    const statusResult = await client.callTool({ name: 'get_runtime_status', arguments: {} })
    const status = JSON.parse(statusResult.content[0].text)
    assert.equal(status.appRunning, true)
    assert.equal(status.privacyMode, 'local-only')
    assert.equal(status.modelReady, true)
    assert.equal(status.version, 'test-version')
    assert.match(status.scope, /staged file writes that require explicit desktop approval/)
    assert.doesNotMatch(JSON.stringify(status), /SECRET_(?:CHAT|MEMORY|TOKEN)_SENTINEL/)

    const answer = await client.callTool({ name: 'ask_local', arguments: { prompt: 'Say pong.' } })
    assert.equal(answer.isError, undefined)
    assert.equal(answer.content[0].text, 'Local answer: pong')
    assert.deepEqual(answer.structuredContent, { provider: 'browser', model: 'fixture-model' })
    assert.deepEqual(promptSeen, [{ prompt: 'Say pong.' }])

    const task = await client.callTool({ name: 'run_agent_task', arguments: { prompt: 'Find public material.', capabilities: ['workspace', 'web', 'services'], workspaceRoot: root,
      handoffContext: { summary: 'Inspect the selected repository.', constraints: ['Read only'], relevantFiles: ['README.md'], sourceAgent: 'test-agent', workingDirectory: root } } })
    assert.equal(task.isError, true)
    assert.match(task.content[0].text, /does not provide web or connected-service tools/i)
    const workspaceTask = await client.callTool({ name: 'run_agent_task', arguments: { prompt: 'Inspect this workspace.', capabilities: ['workspace'], workspaceRoot: root,
      handoffContext: { summary: 'Inspect the selected repository.', constraints: ['Read only'], relevantFiles: ['README.md'], sourceAgent: 'test-agent', workingDirectory: root } } })
    assert.equal(workspaceTask.content[0].text, 'Approved.')
    assert.deepEqual(workspaceTask.structuredContent.sources, ['https://example.org/'])
    assert.deepEqual(promptSeen[2], { prompt: 'Inspect this workspace.', capabilities: ['workspace'], workspaceRoot: root,
      handoffContext: { summary: 'Inspect the selected repository.', constraints: ['Read only'], relevantFiles: ['README.md'], sourceAgent: 'test-agent', workingDirectory: root } })
    const defaultWorkspace = await client.callTool({ name: 'run_agent_task', arguments: { prompt: 'Summarize this project.', capabilities: ['workspace'] } })
    assert.equal(defaultWorkspace.content[0].text, 'Approved.')
    assert.deepEqual(promptSeen[3], { prompt: 'Summarize this project.', capabilities: ['workspace'], workspaceRoot: root,
      handoffContext: { workingDirectory: root } })
    const unsupported = await client.callTool({ name: 'run_agent_task', arguments: { prompt: 'Bad', capabilities: ['shell'] } })
    assert.equal(unsupported.isError, true)
    const tooLarge = await client.callTool({ name: 'ask_local', arguments: { prompt: 'x'.repeat(8001) } })
    assert.equal(tooLarge.isError, true)
    assert.equal(promptSeen.length, 4)

    await fs.writeFile(path.join(userData, 'ai-worker-mcp-status.json'), JSON.stringify({
      schemaVersion: 1,
      app: 'AI-Worker',
      version: 'test-version',
      running: true,
      startedAt: now,
      heartbeatAt: Date.now(),
      privacyMode: 'connected',
      model: { available: true, checkedAt: now - 1 },
      port,
      token,
    }))
    const staleStatusResult = await client.callTool({ name: 'get_runtime_status', arguments: {} })
    const staleStatus = JSON.parse(staleStatusResult.content[0].text)
    assert.equal(staleStatus.privacyMode, 'connected')
    assert.equal(staleStatus.modelReady, null)
    assert.equal(staleStatus.modelStatusFresh, false)

    await fs.writeFile(path.join(userData, 'ai-worker-mcp-status.json'), JSON.stringify({
      schemaVersion: 1,
      app: 'AI-Worker',
      version: 'test-version',
      running: false,
      startedAt: now,
      heartbeatAt: Date.now(),
      privacyMode: 'local-only',
      model: null,
      port: null,
      token: null,
    }))
    const stoppedResult = await client.callTool({ name: 'ask_local', arguments: { prompt: 'Should fail while stopped.' } })
    assert.equal(stoppedResult.isError, true)
    assert.match(stoppedResult.content[0].text, /not running/i)
    assert.equal(promptSeen.length, 4)
  } finally {
    await client.close().catch(() => {})
    await new Promise((resolve) => httpServer.close(resolve))
    await fs.rm(userData, { recursive: true, force: true })
  }
})
