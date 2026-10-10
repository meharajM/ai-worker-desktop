const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { createInterface } = require('node:readline')
const { cp, chmod, mkdir, readFile, readdir, readlink, rm, writeFile } = require('node:fs/promises')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const artifactRoot = '/Volumes/MAC_APPS/ai-worker-desktop-artifacts'
const cargoTargetRoot = path.join(artifactRoot, 'm06a2-cargo-target')
const id = randomUUID().replaceAll('-', '').slice(0, 12)
const productName = `AI-Worker M06a2 ${id}`
const identifier = `com.aiworker.app.m06a2${id}`
const defaultPrefs = { schemaVersion: 1, selectedProfileId: null, resourcePreset: 'lowImpact', idlePolicy: 'taskEnd' }
const balancedPrefs = { schemaVersion: 1, selectedProfileId: null, resourcePreset: 'balanced', idlePolicy: 'shortIdle' }
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.slice().sort().join(',')
const validPreferences = (value) => exactKeys(value, ['schemaVersion', 'selectedProfileId', 'resourcePreset', 'idlePolicy']) &&
  value.schemaVersion === 1 && value.selectedProfileId === null &&
  ((value.resourcePreset === 'lowImpact' && value.idlePolicy === 'taskEnd') ||
    (value.resourcePreset === 'balanced' && value.idlePolicy === 'shortIdle'))
const pluginBytes = (preferences) => Buffer.from(JSON.stringify({ preferences }))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const report = { sourceCommit: null, sourceHashes: {}, appPath: null, executable: null, executableSha256: null, bundleTreeSha256: null, privateDataRoot: null, appPids: [], observations: [] }
let temp
let app
let appExited = true
let buildProcess
let quitReader

function output(message) {
  process.stdout.write(`${message}\n`)
}

function command(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function readStoreFile(bytes) {
  const source = JSON.parse(bytes.toString('utf8'))
  assert.ok(exactKeys(source, ['preferences']), 'store file must contain only the fixed preferences key')
  assert.ok(validPreferences(source.preferences), 'stored preferences must match exact schema and paired policy')
  return source.preferences
}

function checkAssertions() {
  assert.deepEqual(JSON.parse(pluginBytes(defaultPrefs).toString()).preferences, defaultPrefs)
  assert.deepEqual(JSON.parse(pluginBytes(balancedPrefs).toString()).preferences, balancedPrefs)
  assert.throws(() => readStoreFile(Buffer.from('{"preferences":{"schemaVersion":0}}')))
  assert.throws(() => readStoreFile(Buffer.from('{"preferences":{"schemaVersion":1,"selectedProfileId":"x","resourcePreset":"balanced","idlePolicy":"shortIdle"}}')))
  assert.throws(() => readStoreFile(Buffer.from('{"preferences":{"schemaVersion":1,"selectedProfileId":null,"resourcePreset":"balanced","idlePolicy":"taskEnd"}}')))
  assert.notEqual(sha256(pluginBytes(defaultPrefs)), sha256(pluginBytes(balancedPrefs)))
}

async function hashTree(directory) {
  const entries = []
  async function visit(current, relative = '') {
    const children = await readdir(current, { withFileTypes: true })
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, child.name)
      const name = path.join(relative, child.name)
      if (child.isDirectory()) await visit(absolute, name)
      else if (child.isSymbolicLink()) entries.push([name, `link:${await readlink(absolute)}`])
      else if (child.isFile()) entries.push([name, await readFile(absolute)])
    }
  }
  await visit(directory)
  const hash = createHash('sha256')
  for (const [name, content] of entries) {
    hash.update(name)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function locatePreferences() {
  const found = []
  async function visit(directory) {
    let children
    try { children = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const child of children) {
      const candidate = path.join(directory, child.name)
      if (child.isDirectory()) await visit(candidate)
      else if (child.isFile() && child.name === 'preferences.json') found.push(candidate)
    }
  }
  await visit(report.privateDataRoot)
  assert.ok(found.length <= 1, `expected at most one synthetic preferences.json, found ${found.length}`)
  return found[0]
}

function waitForAppExit(timeoutMs = 10 * 60 * 1000) {
  if (appExited) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native menu Quit did not close the owned app within 10 minutes')), timeoutMs)
    app.once('exit', (code, signal) => {
      appExited = true
      clearTimeout(timer)
      output(`APP EXIT pid=${app.pid} code=${code} signal=${signal}`)
      resolve()
    })
  })
}

function appExecutable(bundle) {
  const plist = path.join(bundle, 'Contents/Info.plist')
  const name = command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist])
  return path.join(bundle, 'Contents/MacOS', name)
}

function launchApp(phase) {
  app = spawn(report.executable, [], { cwd: temp, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  appExited = false
  report.appPids.push({ phase, pid: app.pid })
  output(`APP STARTED phase=${phase} pid=${app.pid} path=${report.appPath}`)
  app.stdout.on('data', (chunk) => output(`APP OUT ${chunk.toString().trimEnd()}`))
  app.stderr.on('data', (chunk) => output(`APP ERR ${chunk.toString().trimEnd()}`))
  app.once('error', (error) => output(`APP SPAWN ERROR ${error.message}`))
  app.once('exit', () => { appExited = true })
}

async function acknowledge(message) {
  output(`CUA STEP: ${message}`)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CUA acknowledgement timed out after 10 minutes')), 10 * 60 * 1000)
    quitReader.question('After observing the step, press Enter here: ', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function buildApp() {
  const config = {
    productName,
    identifier,
    app: {
      appDirectoriesOverride: report.privateDataRoot,
      windows: [{ label: 'main', title: productName, width: 1100, height: 760 }],
    },
  }
  assert.equal(Object.hasOwn(config.app, 'dataStoreIdentifier'), false)
  const cli = path.join(root, 'node_modules/.bin/tauri')
  const args = ['build', '--debug', '--bundles', 'app', '--config', JSON.stringify(config)]
  output(`BUILD COMMAND tauri ${args.map((part) => part.startsWith('{') ? '<temporary-isolated-config>' : part).join(' ')}`)
  await new Promise((resolve, reject) => {
    buildProcess = spawn(cli, args, { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: cargoTargetRoot }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => reject(new Error('Tauri build exceeded 30 minute bound')), 30 * 60 * 1000)
    buildProcess.stdout.on('data', (chunk) => process.stdout.write(chunk))
    buildProcess.stderr.on('data', (chunk) => process.stderr.write(chunk))
    buildProcess.once('error', (error) => { clearTimeout(timer); reject(error) })
    buildProcess.once('exit', (code, signal) => {
      clearTimeout(timer)
      buildProcess = undefined
      code === 0 ? resolve() : reject(new Error(`Tauri build failed (${code ?? signal})`))
    })
  })
  const built = path.join(cargoTargetRoot, 'debug/bundle/macos', `${productName}.app`)
  report.appPath = path.join(temp, `${productName}.app`)
  await cp(built, report.appPath, { recursive: true, preserveTimestamps: true })
  report.executable = appExecutable(report.appPath)
  report.executableSha256 = sha256(await readFile(report.executable))
  report.bundleTreeSha256 = await hashTree(report.appPath)
  output(`APP BUNDLE path=${report.appPath} executable=${report.executable} executableSha256=${report.executableSha256} treeSha256=${report.bundleTreeSha256}`)
}

async function main() {
  if (process.argv.includes('--check-assertions')) return checkAssertions()
  assert.equal(process.platform, 'darwin', 'native preferences gate requires macOS WKWebView')
  assert.equal(process.stdin.isTTY, true, 'run this finite CUA gate from an interactive terminal')
  await mkdir(artifactRoot, { recursive: true })
  temp = path.join(artifactRoot, `m06a2-${id}`)
  await mkdir(temp, { mode: 0o700 })
  report.privateDataRoot = path.join(temp, 'private-app-data')
  await mkdir(report.privateDataRoot, { mode: 0o700 })
  report.sourceCommit = command('git', ['rev-parse', 'HEAD'])
  for (const file of ['src/renderer/src/desktop-bridge.ts', 'src/renderer/src/LocalApp.tsx', 'tests/desktop-bridge.test.mjs', 'tests/m06a-preferences-native.cjs']) {
    report.sourceHashes[file] = command('git', ['hash-object', file])
  }
  output(`RUNNER pid=${process.pid} sourceCommit=${report.sourceCommit} sourceHashes=${JSON.stringify(report.sourceHashes)} privateDataRoot=${report.privateDataRoot}`)
  quitReader = createInterface({ input: process.stdin, output: process.stdout })
  await buildApp()

  assert.equal(await locatePreferences(), undefined, 'isolated preferences path must be absent before the app starts')
  launchApp('default-read-and-balanced-save')
  await acknowledge('In the exact copied app, confirm the initial Chat screen and native status. Do not open Settings yet.')
  assert.equal(await locatePreferences(), undefined, 'app startup must not create preferences.json before a preferences read')
  report.observations.push({ phase: 'startup-before-read', outcome: 'PASS', preferencesFileCreated: false })
  output('NATIVE CHECK app startup left fixed preferences.json absent before Settings was opened.')
  await acknowledge('Open Settings. Confirm Low impact is loaded and Local model says Not configured. Do not save yet.')
  assert.equal(await locatePreferences(), undefined, 'reading missing preferences must not create preferences.json')
  report.observations.push({ phase: 'default-read', outcome: 'PASS', preferencesFileCreated: false })
  output('NATIVE CHECK default read returned Low impact in UI; fixed preferences.json remains absent.')
  await acknowledge('Choose Balanced and click Save preferences. Confirm “Preferences saved.” Then use app menu → Quit.')
  await waitForAppExit()
  const file = await locatePreferences()
  assert.ok(file, 'explicit save must create the fixed private preferences.json')
  const savedBytes = await readFile(file)
  assert.deepEqual(await readStoreFile(savedBytes), balancedPrefs)
  await chmod(file, 0o600)
  const privateSavedBytes = await readFile(file)
  assert.deepEqual(privateSavedBytes, savedBytes)
  const savedHash = sha256(privateSavedBytes)
  report.observations.push({ phase: 'balanced-save', outcome: 'PASS', preferencesPath: file, mode: '0600', bytesSha256: savedHash, bytesHex: privateSavedBytes.toString('hex') })
  output(`NATIVE CHECK balanced save persisted exact paired record path=${file} sha256=${savedHash}`)

  launchApp('restart-balanced-read')
  await acknowledge('Confirm Settings restored Balanced after relaunch. Use app menu → Quit.')
  await waitForAppExit()
  assert.deepEqual(await readFile(file), privateSavedBytes, 'read on relaunch must preserve exact stored bytes')
  report.observations.push({ phase: 'restart-read', outcome: 'PASS', bytesSha256: sha256(await readFile(file)) })
  output('NATIVE CHECK relaunch restored Balanced and kept preference bytes unchanged.')

  const malformedBytes = Buffer.from('{"preferences":{"schemaVersion":0,"selectedProfileId":null,"resourcePreset":"balanced","idlePolicy":"shortIdle"}}\n')
  await writeFile(file, malformedBytes, { mode: 0o600 })
  const malformedHash = sha256(malformedBytes)
  launchApp('malformed-source-load-error')
  await acknowledge('Confirm safe load failure is visible, Retry is available, and Save is disabled. Do not save. Use app menu → Quit.')
  await waitForAppExit()
  assert.deepEqual(await readFile(file), malformedBytes, 'shutdown after rejected source must preserve exact old bytes')
  report.observations.push({ phase: 'malformed-source', outcome: 'PASS', bytesSha256Before: malformedHash, bytesSha256AfterQuit: sha256(await readFile(file)), bytesHex: malformedBytes.toString('hex') })
  output(`NATIVE CHECK malformed/old schema remained byte-identical after native Quit sha256=${malformedHash}`)

  await writeFile(file, privateSavedBytes, { mode: 0o600 })
  await chmod(file, 0o444)
  const deniedHash = sha256(privateSavedBytes)
  launchApp('permission-denied-save')
  await acknowledge('Confirm Balanced loads. Select Low impact and Save. Confirm safe save error, no saved-success message, and saved value remains Balanced. Use app menu → Quit.')
  await waitForAppExit()
  assert.deepEqual(await readFile(file), privateSavedBytes, 'permission-denied save and shutdown must preserve original bytes')
  report.observations.push({ phase: 'permission-denied-save', outcome: 'PASS', bytesSha256Before: deniedHash, bytesSha256AfterQuit: sha256(await readFile(file)), modeBeforeCleanup: '0444' })
  output(`NATIVE CHECK denied save kept exact source bytes after quit sha256=${deniedHash}`)
  await chmod(file, 0o600)
  output(`GATE SUMMARY observations=${JSON.stringify(report.observations)} appPids=${JSON.stringify(report.appPids)}`)
}

main().catch((error) => {
  output(`HARNESS ERROR ${error.stack || error}`)
  process.exitCode = 1
}).finally(async () => {
  quitReader?.close()
  if (buildProcess) {
    const ownedBuild = buildProcess
    const ownedPid = ownedBuild.pid
    ownedBuild.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => ownedBuild.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))])
    if (buildProcess === ownedBuild) {
      ownedBuild.kill('SIGKILL')
      await new Promise((resolve) => ownedBuild.once('exit', resolve))
    }
    output(`CLEANUP exactOwnedBuildPid=${ownedPid} stopped=${!buildProcess}`)
  }
  if (app && !appExited) {
    const ownedPid = app.pid
    app.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))])
    if (!appExited) app.kill('SIGKILL')
    output(`CLEANUP exactOwnedAppPid=${ownedPid} forcedTermination=${!appExited}`)
    if (!appExited) process.exitCode = 1
  }
  if (temp && temp.startsWith(`${artifactRoot}${path.sep}`)) await rm(temp, { recursive: true, force: true })
  if (temp) output(`CLEANUP removedOnlyOwnedArtifactRoot=${temp}`)
})
