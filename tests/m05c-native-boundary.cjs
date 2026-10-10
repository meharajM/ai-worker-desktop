const { createHash, randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { createServer } = require('node:http')
const { cp, mkdtemp, readFile, readdir, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const root = path.resolve(__dirname, '..')
const assets = path.join(root, 'src-tauri/static-proof/assets')
const id = randomUUID().replaceAll('-', '').slice(0, 12)
const productName = `AI-Worker M05c ${id}`
const identifier = `com.aiworker.app.m05c${id}`
let temp
const report = { runnerPid: process.pid, appPid: null, port: null, appPath: null, appExecutableSha256: null, rows: [] }
let server
let app
let appExited = false
let remoteBundle

function output(text) {
  process.stdout.write(`${text}\n`)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function end(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function isOriginDenial({ started, label, denial }) {
  return started === '1' && label === 'main' &&
    /bridge_open_session not allowed on window "main", webview "main", URL: http:\/\/127\.0\.0\.1:\d+\/[\s\S]*allowed on:.*URL: local/i.test(denial)
}

const originDenialFixture = 'bridge_open_session not allowed on window "main", webview "main", URL: http://127.0.0.1:57151/\n\nallowed on: [windows: "main", URL: local]'
assert.equal(isOriginDenial({ started: '1', label: 'main', denial: originDenialFixture }), true)
assert.equal(isOriginDenial({ started: '1', label: 'main', denial: 'Command bridge_open_session not allowed by ACL' }), false)
assert.equal(isOriginDenial({ started: '1', label: 'untrusted', denial: originDenialFixture }), false)
assert.equal(isOriginDenial({ started: '1', label: 'main', denial: originDenialFixture.replace('127.0.0.1', 'example.invalid') }), false)
if (process.argv.includes('--check-assertion')) process.exit(0)

async function findRemoteBundle() {
  const files = await readdir(assets)
  const match = files.find((name) => /^m05cRemote-.*\.js$/.test(name))
  if (!match) throw new Error(`Vite remote entry missing in ${assets}`)
  return match
}

async function startServer() {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/remote') {
      return end(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><head><meta charset="utf-8"><title>M05c remote origin proof</title></head><body><main><h1>M05c remote origin proof</h1><p id="result">REMOTE PAGE LOADED; awaiting module</p></main><script type="module" src="/assets/${remoteBundle}"></script></body></html>`)
    }
    if (url.pathname.startsWith('/assets/')) {
      const file = path.resolve(assets, path.basename(url.pathname))
      if (!file.startsWith(`${assets}${path.sep}`)) return end(res, 404, 'text/plain', 'not found')
      try {
        return end(res, 200, 'text/javascript; charset=utf-8', await readFile(file))
      } catch {
        return end(res, 404, 'text/plain', 'asset not found')
      }
    }
    if (url.pathname === '/report') {
      const denial = url.searchParams.get('denial') || ''
      const rowsText = url.searchParams.get('rows') || '[]'
      try { report.rows = JSON.parse(rowsText) } catch { report.rows = [{ outcome: 'FAIL', evidence: 'malformed local row report' }] }
      report.remote = { started: url.searchParams.get('started'), label: url.searchParams.get('label'), denial }
      // Tauri 2.12.2 debug builds report this local-only capability mismatch with the actual window URL.
      report.remote.outcome = isOriginDenial(report.remote) ? 'PASS' : 'FAIL'
      output(`REMOTE REPORT ${JSON.stringify(report.remote)}`)
      output(`LOCAL ROWS ${JSON.stringify(report.rows)}`)
      return end(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><head><meta charset="utf-8"><title>M05c remote report</title></head><body><main><h1>M05c remote origin proof</h1><p id="marker">${report.remote.outcome} REMOTE MODULE STARTED</p><p id="denial">IPC denial: ${escapeHtml(denial)}</p><pre id="rows">${escapeHtml(JSON.stringify(report.rows, null, 2))}</pre></main></body></html>`)
    }
    end(res, 404, 'text/plain', 'not found')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function runBuild(port) {
  const tauri = path.join(root, 'node_modules/.bin/tauri')
  const remote = `http://127.0.0.1:${port}/remote`
  const runtime = JSON.stringify({
    productName,
    identifier,
    app: {
      appDirectoriesOverride: path.join(temp, 'app-data'),
      windows: [
        { label: 'main', title: productName, url: `m05c.html?remote=${encodeURIComponent(remote)}`, width: 1100, height: 760 },
        { label: 'untrusted', title: 'M05c untrusted window', url: 'm05c-untrusted.html', width: 520, height: 280 },
      ],
    },
  })
  output(`BUILD COMMAND node ${tauri} build --debug --features proof --bundles app --config src-tauri/tauri.proof.conf.json --config src-tauri/tauri.m05c.conf.json --config <runtime-json>`)
  const result = spawnSync(tauri, [
    'build', '--debug', '--features', 'proof', '--bundles', 'app',
    '--config', 'src-tauri/tauri.proof.conf.json',
    '--config', 'src-tauri/tauri.m05c.conf.json',
    '--config', runtime,
  ], { cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  output(result.stdout || '')
  output(result.stderr || '')
  if (result.status !== 0) throw new Error(`Tauri build failed (${result.status ?? result.signal})`)
}

async function executableFor(bundle) {
  const plist = path.join(bundle, 'Contents/Info.plist')
  const name = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' })
  if (name.status !== 0) throw new Error(`Cannot read bundle executable: ${name.stderr}`)
  return path.join(bundle, 'Contents/MacOS', name.stdout.trim())
}

async function waitForApp() {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 10 * 60 * 1000)
    app.once('exit', () => { appExited = true; clearTimeout(timer); resolve() })
  })
  if (!appExited) throw new Error('App did not quit through its native menu within 10 minutes')
}

async function main() {
  temp = await mkdtemp(path.join(os.tmpdir(), 'aiworker-m05c-'))
  const port = await startServer()
  report.port = port
  output(`SERVER pid=${process.pid} address=127.0.0.1:${port}`)
  runBuild(port)
  remoteBundle = await findRemoteBundle()
  output(`REMOTE BUNDLE ${remoteBundle}`)

  const built = path.join(root, 'src-tauri/target/debug/bundle/macos', `${productName}.app`)
  report.appPath = path.join(temp, `${productName}.app`)
  await cp(built, report.appPath, { recursive: true, preserveTimestamps: true })
  const executable = await executableFor(report.appPath)
  report.appExecutableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
  output(`APP path=${report.appPath} executable=${executable} sha256=${report.appExecutableSha256}`)
  app = spawn(executable, [], { cwd: temp, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  report.appPid = app.pid
  output(`APP STARTED pid=${app.pid}; use native Quit after all rows and report page are visible`)
  app.stdout.on('data', (chunk) => output(`APP OUT ${chunk.toString().trimEnd()}`))
  app.stderr.on('data', (chunk) => output(`APP ERR ${chunk.toString().trimEnd()}`))
  app.on('exit', (code, signal) => { appExited = true; output(`APP EXIT pid=${app.pid} code=${code} signal=${signal}`) })
  await waitForApp()
  const rowsPass = report.rows.length === 7 && report.rows.every(({ outcome }) => outcome === 'PASS')
  const remotePass = report.remote?.outcome === 'PASS'
  output(`GATE SUMMARY localRows=${rowsPass ? 'PASS' : 'FAIL'} remoteOrigin=${remotePass ? 'PASS' : 'FAIL'}`)
  if (!rowsPass || !remotePass) process.exitCode = 1
  output(`CLEANUP appPidExited=${appExited}`)
}

main().catch((error) => {
  output(`HARNESS ERROR ${error.stack || error}`)
  process.exitCode = 1
}).finally(async () => {
  if (app && !appExited) {
    app.kill('SIGTERM')
    await new Promise((resolve) => app.once('exit', resolve))
    output('CLEANUP forcedAppTermination=true (native menu quit not observed)')
    process.exitCode = 1
  }
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
  if (server) output(`SERVER CLOSED pid=${process.pid} port=${report.port} listening=${server.listening}`)
  if (report.appPath) await rm(report.appPath, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})
