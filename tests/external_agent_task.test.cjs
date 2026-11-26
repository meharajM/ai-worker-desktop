const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter, once } = require('node:events')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)

const { ExternalAgentTask, parseTask } = require('../src/main/services/ExternalAgentTask.ts')
const { ExternalWorkspace } = require('../src/main/services/ExternalWorkspace.ts')
const { publicIPv4, researchUrl } = require('../src/main/services/ExternalResearch.ts')
const { externalServiceChoices, rememberExternalTools } = require('../src/main/services/ExternalServiceTools.ts')
const { trustRenderer } = require('../src/main/ipc/trustedIpc.ts')
const bridge = require('../src/main/services/LocalMcpBridge.ts')
const grant = { model: { provider: 'ollama', model: 'test-local' }, workspace: null, web: false, services: [] }
const wait = () => new Promise(resolve => setImmediate(resolve))

function start(overrides = {}, ttl = 1000, input = { prompt: 'External prompt', requested: ['workspace', 'web', 'services'] }) {
  const views = []
  const task = new ExternalAgentTask(input, {
    mode: () => 'connected', readyLocalModel: () => ({ provider: 'ollama', model: 'test-local' }), services: [], privateDirs: [],
    research: async () => assert.fail('Unexpected network call'), publish: view => views.push(view), ...overrides,
  }, ttl)
  const done = task.run()
  const reply = (value, fromModel = false) => task.reply(task.view.step, value, fromModel)
  const plan = async (action, args) => {
    assert.equal(task.view.phase, 'planning')
    reply({ content: JSON.stringify({ action, args }) }, true)
    await wait()
  }
  return { task, done, views, reply, plan }
}

test('public reads and searches run under the web grant; results await release', async () => {
  assert.throws(() => parseTask({ prompt: 'go', workspace: '/private' }))
  assert.throws(() => parseTask({ prompt: 'go', capabilities: ['shell'] }))
  const dispatched = []
  const r = start({ research: async url => { dispatched.push(url); return { url, links: [], text: 'source' } } })
  assert.equal(r.task.view.phase, 'consent')
  assert.deepEqual(dispatched, [])
  assert.equal(r.reply({ content: 'answer' }, true), false)
  const stale = r.task.view.step
  r.reply({ ...grant, web: true })
  await wait()
  assert.equal(r.task.reply(stale, true), false)
  const first = JSON.parse(r.task.view.detail)
  assert.deepEqual(first.history, [])
  assert.equal(first.task, 'External prompt')
  assert.deepEqual(Object.keys(first.actions), ['answer', 'web_search', 'web_read'])
  await r.plan('web_read', { url: 'https://example.org/' })
  await r.plan('web_search', { query: 'public sources' })
  assert.deepEqual(dispatched, ['https://example.org/', 'https://html.duckduckgo.com/html/?q=public%20sources'])
  assert.ok(r.views.every(view => view.phase !== 'action'))
  await r.plan('answer', { text: 'Evidence' })
  assert.equal(r.task.view.phase, 'release')
  assert.equal(await Promise.race([r.done.then(() => 'returned'), wait().then(() => 'waiting')]), 'waiting')
  const approved = JSON.parse(r.task.view.detail)
  r.reply(true)
  assert.deepEqual(await r.done, approved)
  assert.deepEqual(approved.sources, dispatched)
})

test('local-only fails closed on forged online grants and out-of-scope model actions', async () => {
  const denied = start({ mode: () => 'local-only' })
  denied.reply({ ...grant, web: true })
  await assert.rejects(denied.done, /scope/i)
  const r = start({ mode: () => 'local-only' })
  r.reply(grant)
  await wait()
  assert.deepEqual(Object.keys(JSON.parse(r.task.view.detail).actions), ['answer'])
  const stopped = assert.rejects(r.done, /outside/)
  await r.plan('web_read', { url: 'https://example.org/' })
  await stopped
})

test('Connected mode alone grants neither web research nor service access', async () => {
  const service = { tool: { serverId: 'catalog', name: 'list_tasks', parameters: {} },
    call: async () => assert.fail('Unselected service call') }
  for (const [name, args] of [['web_search', { query: 'example' }], ['service_0', {}]]) {
    const r = start({ services: [service] })
    r.reply(grant)
    await wait()
    const rejected = assert.rejects(r.done, /outside/)
    await r.plan(name, args)
    await rejected
  }
})

test('selected service reads run immediately and remain bound to the exact tool and live client', async () => {
  const calls = []
  const client = id => ({ callTool: async (args, _, options) => {
    calls.push({ id, args })
    assert.ok(options.signal)
    return { content: [{ type: 'text', text: 'issue' }] }
  } })
  const connections = new Map([['one', client('one')], ['two', client('two')]])
  for (const [id, c] of connections) rememberExternalTools(id, c, [
    { name: 'get_issue', inputSchema: { properties: { issue_number: { type: 'number' } } } }, { name: 'exec', inputSchema: {} }, { name: 'send_message', inputSchema: {} },
  ])
  const services = externalServiceChoices(connections)
  assert.deepEqual(services.map(s => s.tool.name), ['get_issue', 'get_issue'])
  const r = start({ services })
  r.reply({ ...grant, services: [1] })
  await wait()
  const args = { issue_number: 3 }
  await r.plan('service_1', args)
  assert.ok(r.views.every(view => view.phase !== 'action'))
  assert.deepEqual(calls, [{ id: 'two', args: { name: 'get_issue', arguments: args } }])
  connections.set('two', client('replacement'))
  const rejected = assert.rejects(r.done, /connection changed/)
  await r.plan('service_1', args)
  await rejected
  assert.equal(calls.length, 1)
})

test('cancel, expiry and privacy revocation reject pending decisions and late tool results', async () => {
  let mode = 'connected'
  const r = start({ mode: () => mode })
  r.reply(grant)
  await wait()
  mode = 'local-only'
  assert.throws(() => r.reply({ content: '{}' }, true), /Privacy mode changed/)
  await assert.rejects(r.done, /Privacy mode changed/)
  const expired = start({}, 10)
  await assert.rejects(expired.done, /expired/)
  assert.throws(() => expired.reply(true), /expired/)
  let resolve
  const late = start({ research: () => new Promise(r => { resolve = r }) })
  late.reply({ ...grant, web: true })
  await wait()
  await late.plan('web_read', { url: 'https://example.org/' })
  late.task.cancel()
  await assert.rejects(late.done, /cancelled/)
  resolve({ text: 'late private data', url: 'https://example.org/', links: [] })
  await wait()
  assert.equal(late.views.at(-1), null)
  assert.ok(!JSON.stringify(late.views).includes('late private data'))
})

test('workspace consent covers local list, read and search while host release still needs approval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-read-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'notes.txt'), 'reviewed locally')
  const r = start({ mode: () => 'local-only' })
  const selected = r.task.selectWorkspace(r.task.view.step, root)
  assert.equal(r.task.view.phase, 'consent')
  r.reply({ ...grant, workspace: selected })
  await wait()
  await r.plan('list', { path: '.' })
  await r.plan('read', { path: 'notes.txt' })
  await r.plan('search', { path: '.', query: 'locally' })
  const history = JSON.parse(r.task.view.detail).history
  assert.deepEqual(history.map(entry => entry.observation), ['["notes.txt"]', 'reviewed locally', '["notes.txt"]'])
  assert.ok(r.views.every(view => view.phase !== 'action'))
  await r.plan('answer', { text: 'reviewed locally' })
  assert.equal(r.task.view.phase, 'release')
  assert.equal(await Promise.race([r.done.then(() => 'returned'), wait().then(() => 'waiting')]), 'waiting')
  r.reply(true)
  assert.deepEqual(await r.done, { content: 'reviewed locally', sources: [] })
})

test('valid local-only workspace handoff skips the initial prompt, reads in scope, and still reviews release', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'README.md'), '# Handoff workspace')
  const r = start({ mode: () => 'local-only' }, 1000, parseTask({ prompt: 'Read README.md', capabilities: ['workspace'], workspaceRoot: root,
    handoffContext: { summary: 'Answer the parent agent.', constraints: ['Read only'], relevantFiles: ['README.md'], sourceAgent: 'OpenCode', workingDirectory: root } }))
  t.after(() => r.task.cancel())
  assert.equal(r.task.view.phase, 'planning')
  assert.equal(r.task.view.workspaceRoot, root)
  const instruction = JSON.parse(r.task.view.detail)
  assert.deepEqual(instruction.handoffContext.relevantFiles, ['README.md'])
  assert.deepEqual(Object.keys(instruction.actions), ['answer', 'list', 'read', 'search', 'write'])
  await r.plan('read', { path: 'README.md' })
  await r.plan('answer', { text: '# Handoff workspace' })
  assert.equal(r.task.view.phase, 'release')
  r.reply(true)
  assert.deepEqual(await r.done, { content: '# Handoff workspace', sources: [] })
})

test('workspace reads/search are bounded; immutable file approval is required and revalidated', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-root-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'project'))
  const root = path.join(dir, 'project')
  const file = path.join(root, 'notes.txt')
  fs.writeFileSync(file, 'first')
  fs.writeFileSync(path.join(root, '.env'), 'private')
  fs.writeFileSync(path.join(root, 'oversize'), 'x'.repeat(16001))
  fs.symlinkSync(dir, path.join(root, 'outside'), 'dir')
  const w = new ExternalWorkspace(root)
  for (const name of ['../x', '/x', '.env', 'outside/x', 'oversize']) assert.throws(() => w.read(name))
  assert.deepEqual(w.search('.', 'first'), ['notes.txt'])
  const proposal = w.stage('notes.txt', 'reviewed')
  fs.writeFileSync(file, 'edited')
  assert.throws(() => proposal.commit(), /changed/)
  const r = start()
  const picked = r.task.selectWorkspace(r.task.view.step, root)
  r.reply({ ...grant, workspace: picked })
  await wait()
  await r.plan('write', { path: 'notes.txt', content: 'reviewed' })
  assert.equal(r.task.view.phase, 'action')
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited')
  r.reply(true)
  await wait()
  assert.equal(r.task.view.phase, 'file')
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited')
  assert.equal(JSON.parse(r.task.view.detail).proposed, 'reviewed')
  r.reply(true)
  await wait()
  assert.equal(fs.readFileSync(file, 'utf8'), 'reviewed')
  await r.plan('write', { path: 'cancelled.txt', content: 'discarded' })
  r.reply(true)
  await wait()
  r.task.cancel()
  await assert.rejects(r.done, /cancelled/)
  assert.equal(fs.existsSync(path.join(root, 'cancelled.txt')), false)
})

test('public research rejects credentials, reserved addresses and non-HTTPS schemes', () => {
  for (const ip of ['127.0.0.1','0.0.0.0','10.0.0.1','100.64.1.1','169.254.169.254','172.16.0.1','192.168.0.1','198.19.0.1','203.0.113.1','224.0.0.1','::1']) assert.equal(publicIPv4(ip), false)
  assert.equal(publicIPv4('93.184.216.34'), true)
  for (const raw of ['file:///etc/passwd','http://example.org','https://user@public.org','https://host.local','https://127.0.0.1','https://example.org:8443/']) assert.throws(() => researchUrl(raw))
})

test('real authenticated HTTP route cancels on client disconnect and renderer loss', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-bridge-'))
  function mockWindow(url) {
    const webContents = new EventEmitter()
    webContents.getURL = () => url
    webContents.isDestroyed = () => false
    webContents.send = (_, value) => webContents.emit('view', value)
    trustRenderer(webContents, url)
    return { isDestroyed: () => false, webContents }
  }
  const consentWindow = mockWindow('file:///app/consent.html')
  const plannerWindow = mockWindow('file:///app/index.html')
  const owner = consentWindow.webContents
  await bridge.startLocalMcpBridge({ userDataDirectory: dir, getPrivacyMode: () => 'local-only',
    getTaskWindow: () => consentWindow, getPlannerWindow: () => plannerWindow, getInferenceWindow: () => plannerWindow,
    showTaskWindow() {}, hideTaskWindow() {},
    getServiceChoices: () => [], appVersion: 'test' })
  t.after(async () => { await bridge.stopLocalMcpBridge(); fs.rmSync(dir, { recursive: true, force: true }) })
  const { port, token } = JSON.parse(fs.readFileSync(path.join(dir, 'ai-worker-mcp-status.json')))
  const url = 'http://127.0.0.1:' + port + '/run-agent-task'
  const run = (headers = {}, signal) => fetch(url, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
    body: JSON.stringify({ prompt: '漢'.repeat(8000), capabilities: ['workspace'] }) })
  assert.equal((await run({ Authorization: 'Bearer x' })).status, 401)
  assert.equal((await run({ Origin: 'https://example.org' })).status, 403)
  const controller = new AbortController()
  const ready = once(owner, 'view')
  const pending = run({}, controller.signal)
  const [consent] = await ready
  assert.equal(consent.phase, 'consent')
  assert.equal(bridge.taskForRenderer({}, consent.id), null)
  assert.equal(bridge.taskForRenderer(plannerWindow.webContents, consent.id), null)
  assert.equal(bridge.taskForPlanner(owner, consent.id), null)
  assert.equal((await run()).status, 409)
  const closed = once(owner, 'view')
  controller.abort()
  await assert.rejects(pending)
  assert.deepEqual(await closed, [null])
  const next = once(owner, 'view')
  const interrupted = run()
  await next
  owner.emit('render-process-gone')
  assert.equal((await interrupted).status, 409)
})

test('research parses a bounded fixture in a real isolated Chromium context using the pinned address', async t => {
  const { Readable } = require('node:stream')
  const dns = require('node:dns/promises')
  const https = require('node:https')
  const { research } = require('../src/main/services/ExternalResearch.ts')
  t.mock.method(dns, 'resolve4', async () => ['93.184.216.34'])
  let gets = 0
  t.mock.method(https, 'get', (options, callback) => {
    gets++
    assert.equal(options.hostname, '93.184.216.34')
    assert.equal(options.servername, 'public.example')
    assert.equal(options.headers.Host, 'public.example')
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Accept-Encoding', 'Host'])
    const res = Readable.from([Buffer.from('<p>Example text</p><a href="/source">Source</a><script>unsafe()</script><img src="http://localhost/">')])
    res.statusCode = 200
    res.headers = { 'content-type': 'text/html' }
    queueMicrotask(() => callback(res))
    return new EventEmitter()
  })
  const result = await research('https://public.example/docs', new AbortController().signal)
  assert.equal(gets, 1)
  assert.equal(result.url, 'https://public.example/docs')
  assert.match(result.text, /Example text/)
  assert.doesNotMatch(result.text, /unsafe/)
  assert.deepEqual(result.links, [{ text: 'Source', url: 'https://public.example/source' }])
})

test('connected edits and ambiguous operations require exact-argument approval', async () => {
  const calls = []
  const c = { callTool: async input => { calls.push(input); return { content: [] } } }
  const inputSchema = { type: 'object', properties: { title: { type: 'string' } } }
  const names = ['jira_update_issue', 'create_document', 'delete_task', 'get_or_create_task', 'send_email', 'browser_evaluate', 'run_shell']
  rememberExternalTools('service', c, names.map(name => ({ name, inputSchema })))
  const services = externalServiceChoices(new Map([['service', c]]))
  assert.deepEqual(services.map(s => s.tool.name), names.slice(0, 4))
  const signal = new AbortController().signal
  await assert.rejects(services[1].call({ command: 'unexpected' }, signal), /outside/)
  await assert.rejects(services[1].call({ path: 'unexpected' }, signal), /advertised/)
  const r = start({ services })
  r.reply({ ...grant, services: [0, 3] })
  await wait()
  await r.plan('service_0', { title: 'Reviewed edit' })
  assert.equal(r.task.view.phase, 'action')
  assert.deepEqual(JSON.parse(r.task.view.detail), { serverId: 'service', tool: 'jira_update_issue', arguments: { title: 'Reviewed edit' } })
  assert.deepEqual(calls, [])
  r.reply(true)
  await wait()
  assert.deepEqual(calls, [{ name: 'jira_update_issue', arguments: { title: 'Reviewed edit' } }])
  await r.plan('service_3', { title: 'Possible new task' })
  assert.equal(r.task.view.phase, 'action')
  r.reply(false)
  await assert.rejects(r.done, /declined/)
  assert.equal(calls.length, 1)
})
