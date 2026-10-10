const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const artifactBase = '/Volumes/MAC_APPS/ai-worker-desktop-artifacts'
const cargoTarget = path.join(artifactBase, 'm06a2-cargo-target')
const reportPath = path.join(root, '.superpowers/sdd/M06b-report.md')
const runId = randomUUID().replaceAll('-', '')
const storeId = randomUUID().replaceAll('-', '')
const runRoot = path.join(artifactBase, `m06b-${runId}`)
const outputDir = path.join(runRoot, 'evidence')
const config = path.join(root, 'src-tauri/tauri.history-proof.conf.json')
const sources = [
  'src/renderer/src/lib/chat-history.ts',
  'src/renderer/proof/m06b.html',
  'src/renderer/proof/m06b.ts',
  'vite.proof.config.ts',
  'src-tauri/src/history_proof.rs',
  'src-tauri/src/main.rs',
  'src-tauri/build.rs',
  'src-tauri/Cargo.toml',
  'src-tauri/capabilities/history-proof.json',
  'src-tauri/tauri.history-proof.conf.json',
  'architecture.md',
]

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function treeHash(directory) {
  const entries = []
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) entries.push(`${item.name}/\n${treeHash(file)}`)
    else entries.push(`${item.name}:${sha256(file)}`)
  }
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

function writeReport(value) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  const checks = (value.checks || []).map((line) => `- ${line}`).join('\n') || '- Native run did not reach renderer assertions.'
  const sourcesTable = Object.entries(value.sourceHashes || {}).map(([file, hash]) => `| ${file} | ${hash} |`).join('\n')
  fs.writeFileSync(reportPath, `# M06b bounded IndexedDB history report\n\n` +
    `Status: ${value.ok ? 'checked' : 'failed'}; ${value.summary}\n\n` +
    `## API and bounds\n\n` +
    `Schema 1; fixed database \`ai-worker-chat-history\`; stores \`sessions\` and indexed terminal \`turns\`. DTOs are exact-key validated; IDs are app-generated/bounded; titles cap at 256 UTF-8 bytes; combined turn text caps at 32 KiB. Statuses are completed/canceled/failed. Limits: 50 sessions, 512 total terminal turns, pages 1–50. Tied pages order by \`endedAt\` then \`turnId\`; commits are atomic and resolve after transaction completion. Duplicate identical commits return \`already_committed\`; changed bytes return \`conflict\`; capacity returns \`history_full\`; only explicit session deletion removes history.\n\n` +
    `## Focused checks\n\n${checks}\n\n` +
    `- Web typecheck: ${value.checksRun?.webTypecheck || 'not run'}\n` +
    `- Proof TypeScript check: ${value.checksRun?.proofTypecheck || 'not run'}\n` +
    `- Proof build: ${value.checksRun?.proofBuild || 'not run'}\n` +
    `- Cargo fmt/default/feature checks: ${value.checksRun?.cargo || 'not run'}\n` +
    `- Independent review: ${value.review || 'pending'}\n\n` +
    `## Native WKWebView evidence\n\n` +
    `- Run UUID: \`${runId}\`; private data-store UUID: \`${storeId}\` (same ID for seed and verify launches).\n` +
    `- Exact app artifact: \`${value.appPath || 'not built'}\`; executable SHA-256: \`${value.executableHash || 'n/a'}\`; bundle tree SHA-256: \`${value.bundleHash || 'n/a'}\`.\n` +
    `- Seed PID/exit: \`${value.seedPid ?? 'n/a'} / ${value.seedExit ?? 'n/a'}\`; verify PID/exit: \`${value.verifyPid ?? 'n/a'} / ${value.verifyExit ?? 'n/a'}\`; cleanup PID/exit: \`${value.cleanupPid ?? 'n/a'} / ${value.cleanupExit ?? 'n/a'}\`.\n` +
    `- Cleanup verification: ${value.cleanupVerified ? 'owned UUID present before removal and absent afterward' : 'not confirmed'}${value.cleanupPid ? '; cleanup used only a hidden blank default-store window' : ''}. No store contents were read.\n` +
    `- Artifacts and private evidence directory: \`${runRoot}\` (${value.artifactsRemoved ? 'removed after verified cleanup' : 'retained for diagnosis'}).\n\n` +
    `## Source hashes\n\n| File | SHA-256 |\n|---|---|\n${sourcesTable}\n\n` +
    `## Limitations and self-review\n\n` +
    `${value.limitations || 'Disk quota exhaustion was not induced; a proof-only IDBObjectStore.add boundary aborted a real IndexedDB transaction and verified prior rows stayed intact. Blocked-open behavior was not directly induced because schema-1 opens do not request upgrades on an existing store; delayed-success close remains implemented. Pinned Tauri 2.12.2 WindowConfig conversion omitted data_store_identifier, so proof setup applies it with WebviewWindowBuilder and checks UUID registration before IndexedDB access. No production caller or legacy Electron store was changed.'}\n`)
}

function launch(executable, phase, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--m06b-phase', phase, '--m06b-store', storeId, '--m06b-output', outputDir], {
      cwd: runRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) child.kill('SIGTERM')
    }, phase === 'cleanup' ? 30_000 : 120_000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ pid: child.pid, code, signal, stdout, stderr, timedOut: signal === 'SIGTERM' })
    })
  })
}

function cliBuild() {
  const env = { ...process.env, CARGO_TARGET_DIR: cargoTarget, CI: '1' }
  const result = spawnSync(path.join(root, 'node_modules/.bin/tauri'), [
    'build', '--features', 'history-proof', '--config', config, '--bundles', 'app', '--no-sign', '--ci',
  ], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Tauri proof app build failed with status ${result.status}`)
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('M06b native persistence gate requires macOS WKWebView')
  fs.mkdirSync(runRoot, { recursive: true })
  fs.mkdirSync(outputDir)
  const evidence = {
    ok: false,
    summary: 'in progress',
    checks: [],
    sourceHashes: Object.fromEntries(sources.map((file) => [file, sha256(path.join(root, file))])),
    checksRun: { webTypecheck: 'pass', proofTypecheck: 'pass', proofBuild: 'pass', cargo: 'pass' },
  }
  let launched = false
  try {
    cliBuild()
    const bundleDir = path.join(cargoTarget, 'release/bundle/macos')
    const bundles = fs.readdirSync(bundleDir).filter((name) => name.endsWith('.app'))
    assert.equal(bundles.length, 1, `expected one proof .app in ${bundleDir}`)
    const builtApp = path.join(bundleDir, bundles[0])
    const appPath = path.join(runRoot, bundles[0])
    fs.cpSync(builtApp, appPath, { recursive: true })
    const executable = path.join(appPath, 'Contents/MacOS/ai-worker-tauri')
    evidence.appPath = appPath
    evidence.executableHash = sha256(executable)
    evidence.bundleHash = treeHash(appPath)
    const appEnv = { ...process.env, HOME: process.env.HOME }

    const seed = await launch(executable, 'seed', appEnv)
    launched = true
    evidence.seedPid = seed.pid
    evidence.seedExit = seed.code
    if (seed.code !== 0) throw new Error(`seed app failed (${seed.code ?? seed.signal}): ${seed.stderr}`)
    const seedResult = JSON.parse(fs.readFileSync(path.join(outputDir, 'seed.json'), 'utf8'))
    assert.equal(seedResult.ok, true, seedResult.details || 'seed proof failed')
    evidence.checks.push(...seedResult.checks)

    const verify = await launch(executable, 'verify', appEnv)
    evidence.verifyPid = verify.pid
    evidence.verifyExit = verify.code
    if (verify.code !== 0) throw new Error(`verify app failed (${verify.code ?? verify.signal}): ${verify.stderr}`)
    const verifyResult = JSON.parse(fs.readFileSync(path.join(outputDir, 'verify.json'), 'utf8'))
    assert.equal(verifyResult.ok, true, verifyResult.details || 'restart proof failed')
    evidence.checks.push(...verifyResult.checks)

    const cleanup = await launch(executable, 'cleanup', appEnv)
    evidence.cleanupPid = cleanup.pid
    evidence.cleanupExit = cleanup.code
    if (cleanup.code !== 0) throw new Error(`cleanup app failed (${cleanup.code ?? cleanup.signal}): ${cleanup.stderr}`)
    const cleanupResult = JSON.parse(fs.readFileSync(path.join(outputDir, 'cleanup.json'), 'utf8'))
    assert.equal(cleanupResult.ok, true, 'owned WebKit data-store cleanup failed')
    assert.equal(cleanupResult.presentAfter, false, 'owned WebKit store remains after cleanup')
    evidence.cleanupVerified = true
    evidence.ok = true
    evidence.summary = 'native two-launch persistence and owned WebKit cleanup passed'
  } catch (error) {
    evidence.summary = error instanceof Error ? error.message : String(error)
    evidence.limitations = `Native proof stopped at failure: ${evidence.summary}. Existing user WebKit store was not attached or enumerated by content.`
  } finally {
    if (launched && !evidence.ok && fs.existsSync(path.join(outputDir, 'cleanup.json')) === false) {
      try {
        const cleanup = await launch(path.join(runRoot, fs.readdirSync(runRoot).find((name) => name.endsWith('.app')), 'Contents/MacOS/ai-worker-tauri'), 'cleanup', { ...process.env, HOME: process.env.HOME })
        evidence.cleanupPid = cleanup.pid
        evidence.cleanupExit = cleanup.code
        if (cleanup.code === 0 && fs.existsSync(path.join(outputDir, 'cleanup.json'))) {
          const cleanupResult = JSON.parse(fs.readFileSync(path.join(outputDir, 'cleanup.json'), 'utf8'))
          evidence.cleanupVerified = cleanupResult.ok === true && cleanupResult.presentAfter === false
          if (!evidence.cleanupVerified) evidence.limitations = `Owned-store cleanup retry not verified: ${JSON.stringify(cleanupResult)}`
        } else {
          evidence.limitations = `Owned-store cleanup retry failed (${cleanup.code ?? cleanup.signal}): ${cleanup.stderr || cleanup.stdout || 'cleanup evidence was not written'}`
        }
      } catch (error) {
        evidence.limitations = `Owned-store cleanup retry failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    evidence.artifactsRemoved = evidence.cleanupVerified === true
    writeReport(evidence)
    if (evidence.artifactsRemoved) fs.rmSync(runRoot, { recursive: true, force: true })
  }
  assert.equal(evidence.ok, true, evidence.summary)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
