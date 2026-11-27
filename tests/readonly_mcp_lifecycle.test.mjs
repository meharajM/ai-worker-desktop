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
const serverPath = path.join(root, 'scripts', 'ai-worker-readonly-mcp.mjs')
const taskId = 'a'.repeat(64)
const questionId = 'b'.repeat(64)
const cancelTaskId = 'c'.repeat(64)
const approvalTaskId = 'd'.repeat(64)
const modelErrorTaskId = 'e'.repeat(64)
const privateErrorTaskId = '9'.repeat(64)
const token = 'f'.repeat(64)
const safeLocalModelError = 'The selected local model returned no answer text. Choose another installed local model and retry. No cloud fallback was used.'

test('MCP task lifecycle uses authenticated Tauri routes and filters task responses', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-worker-lifecycle-'))
  const requests = []
  let answered = false
  let cancelState = 'queued'
  let cancelStatusPolls = 0
  const httpServer = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization })
    assert.equal(request.headers.host, `127.0.0.1:${httpServer.address().port}`)

    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'Invalid local bridge token.' })
      return
    }
    if (request.url === '/start-agent-task') {
      if (body.prompt === 'Malformed response') {
        send(202, { id: 'not-an-id', state: 'queued' })
      } else if (body.prompt === 'Unauthorized response') {
        send(401, { error: 'Local bridge rejected this request.' })
      } else if (body.prompt === 'Cancel me') {
        send(202, { id: cancelTaskId, state: 'queued' })
      } else if (body.prompt === 'Approval wait') {
        send(202, { id: approvalTaskId, state: 'queued' })
      } else if (body.prompt === 'Model did not answer') {
        send(202, { id: modelErrorTaskId, state: 'queued' })
      } else if (body.prompt === 'Private failure') {
        send(202, { id: privateErrorTaskId, state: 'queued' })
      } else {
        send(202, { id: taskId, state: 'queued', prompt: 'PRIVATE_HANDOFF_PROMPT' })
      }
      return
    }
    if (request.url === `/agent-task/${taskId}/answer`) {
      assert.deepEqual(body, { questionId, answer: 'Use the project docs.' })
      answered = true
      send(202, { id: taskId, state: 'queued', prompt: 'PRIVATE_HANDOFF_PROMPT' })
      return
    }
    if (request.url === `/agent-task/${cancelTaskId}/cancel`) {
      cancelState = 'cancelling'
      send(202, { id: cancelTaskId, state: cancelState, internal: 'PRIVATE_HANDOFF_PROMPT' })
      return
    }
    if (request.url === `/agent-task/${cancelTaskId}`) {
      cancelStatusPolls += 1
      if (cancelState === 'cancelling' && cancelStatusPolls > 2) cancelState = 'cancelled'
      send(200, { id: cancelTaskId, state: cancelState, prompt: 'PRIVATE_HANDOFF_PROMPT' })
      return
    }
    if (request.url === `/agent-task/${approvalTaskId}`) {
      send(200, {
        id: approvalTaskId,
        state: 'waiting_for_approval',
        taskPrompt: 'PRIVATE_HANDOFF_PROMPT',
        pendingApproval: {
          relativePath: 'README.md',
          before: 'PRIVATE_OLD_CONTENT',
          proposed: 'PRIVATE_NEW_CONTENT',
        },
      })
      return
    }
    if (request.url === `/agent-task/${modelErrorTaskId}`) {
      send(200, { id: modelErrorTaskId, state: 'failed', error: safeLocalModelError })
      return
    }
    if (request.url === `/agent-task/${privateErrorTaskId}`) {
      send(200, { id: privateErrorTaskId, state: 'failed', error: 'SECRET_LOCAL_PATH /Users/test/private prompt' })
      return
    }
    if (request.url === `/agent-task/${taskId}`) {
      if (answered) {
        send(200, {
          id: taskId,
          state: 'completed',
          result: { content: 'Read-only summary.', sources: ['README.md', 'src/main.rs'] },
          prompt: 'PRIVATE_HANDOFF_PROMPT',
          workspaceRoot: '/private/workspace',
        })
      } else {
        send(200, {
          id: taskId,
          state: 'waiting_for_parent',
          pendingQuestion: { id: questionId, text: 'Which project constraint should I prioritize?' },
          prompt: 'PRIVATE_HANDOFF_PROMPT',
          workspaceContents: 'PRIVATE_WORKSPACE_CONTENT',
        })
      }
      return
    }
    send(404, { error: 'Unknown route.' })
  })

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const now = Date.now()
  await fs.writeFile(path.join(userData, 'ai-worker-mcp-status.json'), JSON.stringify({
    schemaVersion: 1,
    app: 'AI-Worker',
    version: 'test-version',
    running: true,
    startedAt: now - 100,
    heartbeatAt: now,
    privacyMode: 'local-only',
    model: { available: true, checkedAt: now },
    port: httpServer.address().port,
    token,
  }))

  const client = new Client({ name: 'ai-worker-lifecycle-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: { AI_WORKER_USER_DATA_DIR: userData },
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const catalog = await client.listTools()
    const runTaskTool = catalog.tools.find(({ name }) => name === 'run_agent_task')
    const startTaskTool = catalog.tools.find(({ name }) => name === 'start_agent_task')
    assert.equal(runTaskTool.annotations.readOnlyHint, true)
    assert.equal(startTaskTool.annotations.readOnlyHint, false)
    assert.match(startTaskTool.description, /user reviews the exact current and proposed content/i)

    const started = await client.callTool({
      name: 'start_agent_task',
      arguments: { prompt: 'Inspect the current project.', capabilities: ['workspace'] },
    })
    assert.equal(started.isError, undefined)
    assert.deepEqual(started.structuredContent, { id: taskId, state: 'queued' })
    assert.deepEqual(requests[0].body, {
      prompt: 'Inspect the current project.',
      capabilities: ['workspace'],
      workspaceRoot: root,
      handoffContext: { workingDirectory: root },
    })
    assert.equal(requests[0].authorization, `Bearer ${token}`)

    const waiting = await client.callTool({ name: 'get_agent_task', arguments: { taskId } })
    assert.equal(waiting.structuredContent.state, 'waiting_for_parent')
    assert.deepEqual(waiting.structuredContent.pendingQuestion, {
      id: questionId,
      text: 'Which project constraint should I prioritize?',
    })
    assert.doesNotMatch(waiting.content[0].text, /PRIVATE_(?:HANDOFF_PROMPT|WORKSPACE_CONTENT)/)
    assert.equal(JSON.stringify(waiting.structuredContent).includes('/private/workspace'), false)

    const answer = await client.callTool({
      name: 'answer_agent_question',
      arguments: { taskId, questionId, answer: 'Use the project docs.' },
    })
    assert.equal(answer.isError, undefined)
    assert.deepEqual(answer.structuredContent, { id: taskId, state: 'queued' })

    const completed = await client.callTool({ name: 'get_agent_task', arguments: { taskId } })
    assert.equal(completed.structuredContent.state, 'completed')
    assert.deepEqual(completed.structuredContent.result, {
      content: 'Read-only summary.',
      sources: ['README.md', 'src/main.rs'],
    })
    assert.doesNotMatch(completed.content[0].text, /PRIVATE_HANDOFF_PROMPT|private\/workspace/)

    const cancelStarted = await client.callTool({
      name: 'start_agent_task',
      arguments: { prompt: 'Cancel me' },
    })
    assert.deepEqual(cancelStarted.structuredContent, { id: cancelTaskId, state: 'queued' })
    const cancelQueued = await client.callTool({ name: 'get_agent_task', arguments: { taskId: cancelTaskId } })
    assert.equal(cancelQueued.structuredContent.state, 'queued')
    const cancelled = await client.callTool({ name: 'cancel_agent_task', arguments: { taskId: cancelTaskId } })
    assert.equal(cancelled.isError, undefined)
    assert.deepEqual(cancelled.structuredContent, { id: cancelTaskId, state: 'cancelling' })
    const cancelling = await client.callTool({ name: 'get_agent_task', arguments: { taskId: cancelTaskId } })
    assert.equal(cancelling.structuredContent.state, 'cancelling')
    const confirmedCancelled = await client.callTool({ name: 'get_agent_task', arguments: { taskId: cancelTaskId } })
    assert.equal(confirmedCancelled.structuredContent.state, 'cancelled')

    const approvalStarted = await client.callTool({
      name: 'start_agent_task',
      arguments: { prompt: 'Approval wait' },
    })
    assert.deepEqual(approvalStarted.structuredContent, { id: approvalTaskId, state: 'queued' })
    const approvalWait = await client.callTool({ name: 'get_agent_task', arguments: { taskId: approvalTaskId } })
    assert.deepEqual(approvalWait.structuredContent, { id: approvalTaskId, state: 'waiting_for_approval' })
    assert.doesNotMatch(approvalWait.content[0].text, /PRIVATE_(?:HANDOFF_PROMPT|OLD_CONTENT|NEW_CONTENT)/)

    for (const [prompt, failedTaskId] of [
      ['Model did not answer', modelErrorTaskId],
      ['Private failure', privateErrorTaskId],
    ]) {
      await client.callTool({ name: 'start_agent_task', arguments: { prompt } })
      const failed = await client.callTool({ name: 'get_agent_task', arguments: { taskId: failedTaskId } })
      assert.equal(failed.structuredContent.state, 'failed')
      assert.doesNotMatch(failed.content[0].text, /SECRET_LOCAL_PATH|private prompt/)
      assert.equal(failed.structuredContent.error,
        failedTaskId === modelErrorTaskId ? safeLocalModelError : 'Task failed. Check the local model status or retry with a narrower task.')
    }

    const invalidId = await client.callTool({ name: 'get_agent_task', arguments: { taskId: '../escape' } })
    assert.equal(invalidId.isError, true)
    assert.match(invalidId.content[0].text, /valid task ID|64 lowercase hexadecimal/i)
    assert.equal(requests.some(request => request.url.includes('escape')), false)

    const malformed = await client.callTool({ name: 'start_agent_task', arguments: { prompt: 'Malformed response' } })
    assert.equal(malformed.isError, true)
    assert.match(malformed.content[0].text, /invalid task ID/i)

    const unauthorized = await client.callTool({ name: 'start_agent_task', arguments: { prompt: 'Unauthorized response' } })
    assert.equal(unauthorized.isError, true)
    assert.match(unauthorized.content[0].text, /rejected/i)
    assert.ok(requests.every(request => request.authorization === `Bearer ${token}`))
  } finally {
    await client.close().catch(() => {})
    await new Promise((resolve) => httpServer.close(resolve))
    await fs.rm(userData, { recursive: true, force: true })
  }
})
