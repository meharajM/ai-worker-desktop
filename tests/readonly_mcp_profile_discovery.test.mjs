import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = fileURLToPath(new URL('../scripts/ai-worker-readonly-mcp.mjs', import.meta.url))
const tauriIdentifier = 'com.aiworker.app.tauri'
const electronToken = 'a'.repeat(64)
const tauriToken = 'b'.repeat(64)

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-worker-mcp-profile-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  return home
}

async function writeProfile(directory, version, overrides = {}) {
  const now = Date.now()
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'ai-worker-mcp-status.json'), JSON.stringify({
    schemaVersion: 1,
    version,
    running: true,
    startedAt: now - 10_000,
    heartbeatAt: now,
    privacyMode: 'local-only',
    ...overrides,
  }))
}

async function connect(t, platform, home, env = {}) {
  const prelude = `
    import os from 'node:os'
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })
    os.homedir = () => ${JSON.stringify(home)}
  `
  const client = new Client({ name: 'ai-worker-mcp-discovery-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [`--import=data:text/javascript,${encodeURIComponent(prelude)}`, serverPath],
    env: {
      AI_WORKER_USER_DATA_DIR: '', APPDATA: '', XDG_CONFIG_HOME: '', XDG_DATA_HOME: '',
      AI_WORKER_AUTOSTART: 'false', AI_WORKER_HOST_SESSION_ID: 'profile-test-session', ...env,
    },
    stderr: 'pipe',
  })
  const protocolErrors = []
  client.onerror = error => protocolErrors.push(error)
  t.after(async () => {
    await client.close()
    assert.deepEqual(protocolErrors, [])
  })
  await client.connect(transport)
  return client
}

async function readStatus(client) {
  const result = await client.callTool({ name: 'get_runtime_status', arguments: {} })
  const status = JSON.parse(result.content[0].text)
  assert.equal(status.appRunning, true)
  return status
}

test('discovers Windows Tauri profile under APPDATA', async t => {
  const home = await makeHome(t)
  const appData = path.join(home, 'redirected-roaming')
  await writeProfile(path.join(appData, tauriIdentifier), 'tauri-windows')

  const client = await connect(t, 'win32', home, { APPDATA: appData })
  assert.equal((await readStatus(client)).version, 'tauri-windows')
})

test('discovers Linux Tauri profiles under XDG_DATA_HOME or the default data directory', async t => {
  const home = await makeHome(t)
  const config = path.join(home, 'xdg-config')
  const data = path.join(home, 'xdg-data')
  const now = Date.now()
  await writeProfile(path.join(data, tauriIdentifier), 'tauri-xdg', { heartbeatAt: now - 5_000 })
  await writeProfile(path.join(home, '.local', 'share', tauriIdentifier), 'tauri-default')
  await writeProfile(path.join(config, 'ai-worker'), 'electron-xdg', { heartbeatAt: now - 1_000 })

  const xdg = await connect(t, 'linux', home, { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data })
  assert.equal((await readStatus(xdg)).version, 'electron-xdg')
  await fs.rm(path.join(config, 'ai-worker'), { recursive: true })
  assert.equal((await readStatus(xdg)).version, 'tauri-xdg')

  const defaults = await connect(t, 'linux', home, { XDG_DATA_HOME: 'relative-path' })
  assert.equal((await readStatus(defaults)).version, 'tauri-default')
})

test('prefers live Linux Tauri profile over an earlier stale Electron profile', async t => {
  const home = await makeHome(t)
  const config = path.join(home, 'xdg-config')
  const data = path.join(home, 'xdg-data')
  const requests = []
  const bridge = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (request.url.startsWith('/host-session/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ sessionId: body.sessionId, connectedSessions: 1 }))
      return
    }
    requests.push([request.url, request.headers.authorization, body])
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ content: 'Live Tauri answer', provider: 'ollama', model: 'fixture' }))
  })
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => bridge.close(resolve)))

  const now = Date.now()
  const port = bridge.address().port
  await writeProfile(path.join(config, 'ai-worker'), 'stale-electron', {
    heartbeatAt: now - 46_000,
    port,
    token: electronToken,
  })
  await writeProfile(path.join(data, tauriIdentifier), 'live-tauri', {
    heartbeatAt: now,
    port,
    token: tauriToken,
  })

  const client = await connect(t, 'linux', home, { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data })
  assert.equal((await readStatus(client)).version, 'live-tauri')
  const inference = await client.callTool({ name: 'ask_local', arguments: { prompt: 'Use live runtime.' } })
  assert.equal(inference.content[0].text, 'Live Tauri answer')
  assert.deepEqual(requests, [
    ['/ask-local', `Bearer ${tauriToken}`, { prompt: 'Use live runtime.' }],
  ])
})

test('selects the freshest macOS profile for inference and keeps delegation on Tauri', async t => {
  const home = await makeHome(t)
  const base = path.join(home, 'Library', 'Application Support')
  const electron = path.join(base, 'AI-Worker')
  const tauri = path.join(base, tauriIdentifier)
  const requests = []
  const bridge = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (request.url.startsWith('/host-session/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ sessionId: body.sessionId, connectedSessions: 1 }))
      return
    }
    requests.push([request.url, request.headers.authorization, body])
    const result = request.url === '/ask-local'
      ? { content: 'Local answer', provider: 'ollama', model: 'fixture' }
      : { content: 'Delegated answer', sources: [] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(result))
  })
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => bridge.close(resolve)))

  const port = bridge.address().port
  const now = Date.now()
  await writeProfile(electron, 'electron', { port, token: electronToken, heartbeatAt: now - 1_000 })
  await writeProfile(tauri, 'tauri', { port, token: tauriToken, heartbeatAt: now })
  const client = await connect(t, 'darwin', home)
  assert.equal((await readStatus(client)).version, 'tauri')

  const inference = await client.callTool({ name: 'ask_local', arguments: { prompt: ' Answer locally. ' } })
  assert.equal(inference.content[0].text, 'Local answer')
  assert.deepEqual(inference.structuredContent, { provider: 'ollama', model: 'fixture' })
  const task = await client.callTool({ name: 'run_agent_task', arguments: { prompt: 'Delegate.' } })
  assert.equal(task.content[0].text, 'Delegated answer')
  assert.deepEqual(requests, [
    ['/ask-local', `Bearer ${tauriToken}`, { prompt: 'Answer locally.' }],
    ['/run-agent-task', `Bearer ${tauriToken}`, { prompt: 'Delegate.', capabilities: [], hostSessionId: 'profile-test-session' }],
  ])

  await writeProfile(tauri, 'tauri-stale', { heartbeatAt: now - 46_000 })
  assert.equal((await readStatus(client)).version, 'electron')
  const liveFallback = await client.callTool({ name: 'ask_local', arguments: { prompt: 'Use live profile.' } })
  assert.equal(liveFallback.content[0].text, 'Local answer')
  assert.deepEqual(requests.at(-1), ['/ask-local', `Bearer ${electronToken}`, { prompt: 'Use live profile.' }])
  await writeProfile(tauri, 'tauri-stopped', { running: false, heartbeatAt: now })
  assert.equal((await readStatus(client)).version, 'electron')

  for (const malformed of [
    { heartbeatAt: String(now) },
    { token: tauriToken.toUpperCase() },
    { port: 65_536 },
  ]) {
    await writeProfile(tauri, 'tauri', { port, token: tauriToken, heartbeatAt: now, ...malformed })
    assert.equal((await readStatus(client)).version, 'tauri')
    const prompt = 'Use the valid endpoint.'
    const fallback = await client.callTool({ name: 'ask_local', arguments: { prompt } })
    assert.equal(fallback.content[0].text, 'Local answer')
    assert.deepEqual(requests.at(-1), ['/ask-local', `Bearer ${electronToken}`, { prompt }])
  }
  assert.equal(requests.length, 6)

  await writeProfile(electron, 'electron', { port, token: electronToken, heartbeatAt: now - 1_000 })
  await writeProfile(tauri, 'tauri-invalid', { port: true, token: tauriToken })
  const invalidTask = await client.callTool({ name: 'run_agent_task', arguments: { prompt: 'Delegate.' } })
  assert.equal(invalidTask.isError, true)
  assert.match(invalidTask.content[0].text, /bridge is not ready/)
  assert.equal(requests.length, 6)

  await writeProfile(electron, 'electron-invalid', { port: true, token: electronToken })
  const override = await connect(t, 'darwin', home, { AI_WORKER_USER_DATA_DIR: electron })
  const invalidOverride = await override.callTool({ name: 'ask_local', arguments: { prompt: 'Answer locally.' } })
  assert.equal(invalidOverride.isError, true)
  assert.match(invalidOverride.content[0].text, /bridge is not ready/)

  await writeProfile(electron, 'electron-stale', { heartbeatAt: now - 46_000 })
  await writeProfile(tauri, 'tauri', { port, token: 'invalid-token' })
  assert.equal((await readStatus(client)).version, 'tauri')
  const invalidToken = await client.callTool({ name: 'ask_local', arguments: { prompt: 'Answer locally.' } })
  assert.equal(invalidToken.isError, true)
  assert.match(invalidToken.content[0].text, /bridge is not ready/)
  assert.equal(requests.length, 6)
})

test('explicit user data override keeps precedence over discovered profiles', async t => {
  const home = await makeHome(t)
  const override = path.join(home, 'custom-profile')
  await writeProfile(override, 'override', { heartbeatAt: Date.now() - 5_000 })
  await writeProfile(path.join(home, 'Library', 'Application Support', tauriIdentifier), 'tauri')

  const client = await connect(t, 'darwin', home, { AI_WORKER_USER_DATA_DIR: ` ${override} ` })
  assert.equal((await readStatus(client)).version, 'override')
})
