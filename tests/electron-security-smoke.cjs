// Isolated Electron smoke: no app state, microphone, account, or remote service.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const { _electron } = require('playwright-core')

;(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-security-'))
  let electron
  try {
    const root = path.resolve(__dirname, '..')
    const compile = (filename) => ts.transpileModule(fs.readFileSync(path.join(root, filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
    fs.writeFileSync(path.join(temporary, 'trustedIpc.cjs'), compile('src/main/ipc/trustedIpc.ts'))
    fs.writeFileSync(path.join(temporary, 'preload.cjs'), compile('src/preload/index.ts'))
    fs.writeFileSync(path.join(temporary, 'vosk.js'), fs.readFileSync(require.resolve('vosk-browser'), 'utf8'))
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').replace('<script type="module" src="./src/main.tsx"></script>', '<script src="vosk.js"></script>')
    fs.writeFileSync(path.join(temporary, 'index.html'), html)
    fs.writeFileSync(path.join(temporary, 'main.cjs'), `
      const { app, BrowserWindow } = require('electron');
      const http = require('node:http');
      const { pathToFileURL } = require('node:url');
      const { trustRenderer, ipcMain } = require('./trustedIpc.cjs');
      app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))});
      global.modelFetches = 0;
      global.remoteRequests = [];
      app.whenReady().then(() => {
        const server = http.createServer((req, res) => {
          global.modelFetches++;
          res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
          res.end('No model needed for initialization check');
        });
        server.listen(0, '127.0.0.1', () => {
          global.modelUrl = 'http://127.0.0.1:' + server.address().port + '/models/absent.zip';
          const window = new BrowserWindow({show: false, webPreferences: {preload: __dirname + '/preload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true}});
          global.window = window;
          trustRenderer(window.webContents, pathToFileURL(__dirname + '/index.html').href);
          ipcMain.handle('app:get-version', () => 'security-smoke');
          window.webContents.session.setPermissionCheckHandler(() => false);
          window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
          window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
            const url = new URL(details.url);
            const remote = url.protocol.startsWith('http') && url.hostname !== '127.0.0.1';
            if (remote) global.remoteRequests.push(details.url);
            callback({cancel: remote});
          });
          window.loadFile(__dirname + '/index.html');
        });
      });
      app.on('window-all-closed', () => app.quit());
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({ executablePath: require('electron'), args: [path.join(temporary, 'main.cjs')], env, timeout: 30000 })
    const page = await electron.firstWindow()
    const errors = []
    page.on('console', (message) => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text().slice(0, 600)) } })
    await page.waitForFunction(() => !!window.Vosk && !!window.electron)
    assert.equal(await page.evaluate(() => window.electron.app.getVersion()), 'security-smoke')
    const preferences = await electron.evaluate(() => global.window.webContents.getLastWebPreferences())
    assert.ok(preferences.sandbox && preferences.contextIsolation && preferences.webSecurity)
    assert.equal(preferences.nodeIntegration, false)
    const modelUrl = await electron.evaluate(() => global.modelUrl)
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, modelUrl), 404)
    assert.equal(await page.evaluate(() => !!new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))), true)
    const blockedVosk = page.waitForEvent('console', { predicate: (message) => /unsafe-eval/.test(message.text()), timeout: 10000 })
    await page.evaluate((url) => { window.voskSmoke = new window.Vosk.Model(url, 0) }, modelUrl)
    await blockedVosk
    await page.evaluate(() => window.voskSmoke.worker.terminate())
    assert.equal(await electron.evaluate(() => global.modelFetches), 1, 'Only explicit loopback fetch ran; incompatible Vosk worker was blocked')
    assert.deepEqual(await electron.evaluate(() => global.remoteRequests), [])
    console.log('PASS: sandboxed preload + validated file-origin IPC; loopback fetch passed CORS; WASM permitted; Vosk JavaScript eval blocked; zero remote requests; no microphone')
  } finally {
    if (electron) await electron.close()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
