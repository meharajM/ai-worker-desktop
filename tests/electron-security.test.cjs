const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { createHash } = require('node:crypto')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

function loadSecurity() {
  const handlers = new Map()
  const source = readFileSync(resolve(__dirname, '../src/main/ipc/trustedIpc.ts'), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: module.exports, URL, Map,
    require(name) {
      assert.equal(name, 'electron')
      return { ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) } }
    }
  })
  return { ...module.exports, handlers }
}

function renderer(url = 'http://localhost:5173/') {
  const mainFrame = { url, origin: new URL(url).origin }
  const contents = { mainFrame, isDestroyed: () => false, once: (_event, fn) => { contents.destroy = fn } }
  return { contents, event: { sender: contents, senderFrame: mainFrame } }
}

test('IPC accepts only registered live app main frame and rejects before invoking handlers', () => {
  const security = loadSecurity()
  const { contents, event } = renderer()
  assert.equal(security.validateIpcSender(event), false)
  security.trustRenderer(contents, event.senderFrame.url)
  assert.equal(security.validateIpcSender(event), true)
  assert.equal(security.validateIpcSender({ ...event, senderFrame: null }), false)
  assert.equal(security.validateIpcSender({ ...event, senderFrame: { ...event.senderFrame } }), false)
  const rogue = renderer()
  assert.equal(security.validateIpcSender(rogue.event), false)

  let calls = 0
  security.ipcMain.handle('probe', () => ++calls)
  assert.throws(() => security.handlers.get('probe')(rogue.event), /Untrusted IPC sender/)
  assert.equal(calls, 0)
  assert.equal(security.handlers.get('probe')(event), 1)
  event.senderFrame.origin = 'https://evil.example'
  assert.equal(security.validateIpcSender(event), false)
  event.senderFrame.origin = 'http://localhost:5173'
  event.senderFrame.url = 'http://localhost:5173/other.html'
  assert.equal(security.validateIpcSender(event), false)
  event.senderFrame.url = 'http://localhost:5173/'
  contents.destroy()
  assert.equal(security.validateIpcSender(event), false)
})

test('packaged IPC permits exact app file only, without trusting other opaque origins', () => {
  const security = loadSecurity()
  const { contents, event } = renderer('file:///app/out/renderer/index.html')
  security.trustRenderer(contents, event.senderFrame.url)
  assert.equal(security.validateIpcSender(event), true)
  event.senderFrame.url = 'file:///tmp/untrusted.html'
  assert.equal(security.validateIpcSender(event), false)
  event.senderFrame.url = 'about:blank'
  assert.equal(security.validateIpcSender(event), false)
})

test('external links allow HTTP(S), reject native protocols and embedded credentials', () => {
  const { safeExternalUrl } = loadSecurity()
  assert.equal(safeExternalUrl('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(safeExternalUrl('http://localhost:8000/'), 'http://localhost:8000/')
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hi', 'ftp://example.com', 'https://user:pass@example.com', 'not a url', null]) {
    assert.throws(() => safeExternalUrl(url))
  }
})

test('settings store IPC rejects untrusted renderer senders', () => {
  const security = loadSecurity()
  const storeValues = new Map()
  const source = readFileSync(resolve(__dirname, '../src/main/ipc/store.ts'), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, {
    exports: module.exports, Object, console,
    require(name) {
      if (name === './trustedIpc') return { ipcMain: security.ipcMain }
      if (name === '../lib/store-wrapper') return { Store: class { constructor() { return {
        get: (key) => storeValues.get(key),
        set: (key, value) => storeValues.set(key, value),
        delete: (key) => storeValues.delete(key),
      } } } }
      throw new Error(name)
    }
  })
  module.exports.registerStoreHandlers()

  const rogue = renderer()
  assert.throws(() => security.handlers.get('store:set')(rogue.event, 'privacyMode', 'connected'), /Untrusted IPC sender/)
  const trusted = renderer()
  security.trustRenderer(trusted.contents, trusted.event.senderFrame.url)
  assert.equal(security.handlers.get('store:set')(trusted.event, 'privacyMode', 'connected'), true)
  assert.equal(storeValues.get('privacyMode'), 'connected')
})

test('renderer CSP keeps Vosk WASM and loopback access without broad script or network grants', () => {
  const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8')
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
  const script = policy.match(/script-src ([^;]+)/)[1]
  assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"))
  assert.ok(script.includes("'wasm-unsafe-eval'"))
  assert.ok(!policy.includes('https://*') && !policy.includes('wss://*'))
  assert.ok(policy.includes('http://127.0.0.1:*'))
  assert.ok(policy.includes("frame-src 'none'") && policy.includes("object-src 'none'"))
  const preamble = require('@vitejs/plugin-react').preambleCode.replace('__BASE__', '/')
  const hash = createHash('sha256').update(preamble).digest('base64')
  assert.ok(script.includes(`'sha256-${hash}'`), 'Update CSP hash when Vite React refresh preamble changes')
})

test('speech IPC rejects arbitrary downloads and traversal before model service runs', async () => {
  const handlers = new Map()
  const calls = []
  const source = readFileSync(resolve(__dirname, '../src/main/ipc/speech.ts'), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, {
    exports: module.exports, process, Object,
    require(name) {
      if (name === 'path') return require('node:path')
      if (name === '@electron-toolkit/utils') return { is: { dev: true } }
      if (name === './trustedIpc') return { ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) } }
      if (name === '../services/ModelManager') return { ModelManager: class {
        downloadModel(...args) { calls.push(args); return { success: true } }
        checkSupport(name) { calls.push(name); return true }
        getModelPath(name) { calls.push(name); return 'local' }
      } }
      throw new Error(name)
    }
  })
  module.exports.registerSpeechHandlers()
  const options = { modelId: 'en-us', modelName: 'vosk-model-small-en-us-0.15', url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip' }
  for (const invalid of [null, {}, { ...options, url: 'https://evil.example/a.zip' }, { ...options, modelName: '../../private' }, { ...options, modelId: '__proto__' }]) {
    await assert.rejects(handlers.get('speech:download-model')({}, invalid), /Unknown offline speech model/)
  }
  await assert.rejects(handlers.get('speech:get-model-path')({}, '../../private'), /Unknown offline speech model/)
  await assert.rejects(handlers.get('speech:check-support')({}, 'x; id'), /Unknown offline speech model/)
  assert.equal(calls.length, 0)
  const unavailable = await handlers.get('speech:download-model')({}, options)
  assert.equal(unavailable.success, false)
  assert.match(unavailable.error, /unavailable under the secure runtime/)
  assert.equal(calls.length, 0)
})
