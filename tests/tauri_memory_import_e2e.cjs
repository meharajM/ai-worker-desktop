const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { chromium } = require('playwright-core')

const staticDir = path.resolve(__dirname, '../src-tauri/static')
const indexPath = path.join(staticDir, 'index.html')

function createArchive() {
  const entities = [
    { id: 'user-1', name: 'User', type: 'person', description: 'Prefers local tools.', observations: ['Values privacy.'], metadata: {}, createdAt: 'unknown' },
    { id: 'project-1', name: 'AI Worker', type: 'project', description: 'Desktop concierge.', observations: ['Runs locally.'], metadata: {}, createdAt: 'unknown' },
  ]
  const relations = [{ id: 'user-1-uses-project-1', fromEntityId: 'user-1', toEntityId: 'project-1', relationType: 'uses', metadata: {} }]
  const metadata = { exportedAt: '2026-11-27T10:00:00.000Z', version: '1.0.0', backend: 'server-memory' }
  const canonical = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const contentSha256 = crypto.createHash('sha256')
    .update(canonical({ entities, relations }))
    .digest('hex')
  return JSON.stringify({
    format: 'ai-worker-memory-export', schemaVersion: 1,
    exportedAt: metadata.exportedAt,
    migrationId: `sha256-${contentSha256}`, contentSha256,
    entities, relations, metadata,
  })
}

function mimeType(filePath) {
  switch (path.extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

function createStaticServer() {
  return http.createServer((request, response) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end('Bad request')
      return
    }
    const requested = pathname === '/' ? '/index.html' : pathname
    const filePath = path.resolve(staticDir, `.${requested}`)
    if (filePath !== staticDir && !filePath.startsWith(`${staticDir}${path.sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        response.writeHead(404).end('Not found')
        return
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
        'Content-Type': mimeType(filePath),
      })
      fs.createReadStream(filePath).pipe(response)
    })
  })
}

function verifyBuiltAssets() {
  if (!fs.existsSync(indexPath)) throw new Error('Tauri frontend is not built. Run `npm run web:build` first.')
  const html = fs.readFileSync(indexPath, 'utf8')
  const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^\"]+)"/g)].map((match) => match[1])
  if (!assets.length || assets.some((asset) => !fs.existsSync(path.resolve(staticDir, asset)))) {
    throw new Error('Tauri static index does not match its built assets. Run `npm run web:build` first.')
  }
}

async function main() {
  verifyBuiltAssets()
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
  if (!fs.existsSync(executablePath)) throw new Error(`Chromium not found at ${executablePath}`)

  const server = createStaticServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  let browser
  let context
  try {
    browser = await chromium.launch({ executablePath, headless: true })
    context = await browser.newContext()
    await context.addInitScript(() => {
      globalThis.isTauri = true
      let imported = false
      window.__AI_WORKER_TEST_COMMANDS__ = []
      window.__TAURI_INTERNALS__ = {
        async invoke(command, args = {}) {
          window.__AI_WORKER_TEST_COMMANDS__.push(command)
          const request = args.request || {}
          if (command === 'bridge_open_session') return { protocolVersion: 1, ownerId: 'main', sessionId: 'test-session', requestId: request.requestId }
          if (command === 'bridge_get_status') return { ...request, appVersion: '0.1.2', available: true }
          if (command === 'bridge_get_preferences') return {
            ...request,
            preferences: { schemaVersion: 1, selectedProfileId: null, resourcePreset: 'lowImpact', idlePolicy: 'taskEnd', allowOnlineResearch: false, theme: 'dark' },
          }
          if (command === 'model_catalog') return {
            ...request,
            certifiedProfiles: [],
            system: { operatingSystem: 'macos', architecture: 'arm64', logicalCpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, availableModelDiskBytes: null },
            ollamaAvailable: false, installedModels: [], configuredModel: null, selectedModel: null, recommendedModel: null, developerCandidate: null,
          }
          if (command === 'memory_preview_archive') {
            const archive = JSON.parse(args.archiveJson)
            return { ...request, payload: {
              entities: archive.entities.length,
              relations: archive.relations.length,
              contentSha256: archive.contentSha256,
              migrationId: archive.migrationId,
              alreadyImported: imported,
            } }
          }
          if (command === 'memory_import_archive') {
            const archive = JSON.parse(args.archiveJson)
            const wasImported = imported
            imported = true
            return { ...request, payload: {
              entitiesImported: wasImported ? 0 : archive.entities.length,
              relationsImported: wasImported ? 0 : archive.relations.length,
              alreadyImported: wasImported,
              contentSha256: archive.contentSha256,
              migrationId: archive.migrationId,
              backupPath: '/isolated-test-app-data/memory-archives/synthetic.json',
            } }
          }
          throw new Error(`Unexpected native command: ${command}`)
        },
      }
    })

    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'settings', exact: true }).click()

    const fileInput = page.locator('#memory-archive-file')
    const archive = createArchive()
    await fileInput.setInputFiles({ name: 'memory.json', mimeType: 'application/json', buffer: Buffer.from(archive) })
    await page.getByText('Memories', { exact: true }).waitFor()
    await page.getByText('Relationships', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Import memory' }).click()
    await page.getByText(/Imported 2 memories and 1 relationships\./).waitFor()
    await page.getByText('/isolated-test-app-data/memory-archives/synthetic.json').waitFor()

    await fileInput.setInputFiles({ name: 'memory-reexport.json', mimeType: 'application/json', buffer: Buffer.from(archive) })
    await page.getByRole('button', { name: 'Verify imported archive' }).waitFor()
    await page.getByRole('button', { name: 'Verify imported archive' }).click()
    await page.getByText(/already imported; no duplicate memory was added/).waitFor()

    const commands = await page.evaluate(() => window.__AI_WORKER_TEST_COMMANDS__)
    assert.ok(commands.includes('memory_preview_archive'))
    assert.equal(commands.filter((command) => command === 'memory_import_archive').length, 2)
    assert.deepEqual(pageErrors, [])
    console.log('PASS Tauri memory import UI E2E (isolated mocked native bridge)')
    console.log(' - previews a synthetic memory archive before import')
    console.log(' - imports only after explicit user click and shows local backup location')
    console.log(' - confirms retry is idempotent through the host bridge')
  } finally {
    if (context) await context.close()
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
