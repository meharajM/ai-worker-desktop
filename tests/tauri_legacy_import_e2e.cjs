const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { chromium } = require('playwright-core')

const staticDir = path.resolve(__dirname, '../src-tauri/static')
const indexPath = path.join(staticDir, 'index.html')
const omissions = [
  'Credentials, account tokens, and connected-account state',
  'Workspace paths, grants, and write-approval settings',
  'Tool arguments/results, attachments, and file paths',
  'Internal system messages',
  'MCP server configuration and environment values',
  'Memory databases, browser profiles, WhatsApp pairing, and logs',
]
const preferences = {
  theme: 'dark', displayMode: 'prod', speechLang: 'en-US', offlineSpeech: true,
  ttsEnabled: false, ttsRate: 1, ttsPitch: 1, ttsVoice: null,
}

function createArchive(id, title, assistantText) {
  const at = '2026-11-27T10:00:00.000Z'
  const sessions = [{
    id,
    title,
    createdAt: at,
    updatedAt: at,
    turns: [{
      turnId: `${id}-turn`,
      userText: `Question for ${title}`,
      assistantText,
      status: 'completed',
      endedAt: at,
    }],
  }]
  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify({ sessions, preferences, omissions }))
    .digest('hex')
  return JSON.stringify({
    format: 'ai-worker-electron-export',
    schemaVersion: 1,
    migrationId: `sha256-${payloadHash}`,
    exportedAt: at,
    sessions,
    preferences,
    omissions,
  })
}

function mimeType(filePath) {
  switch (path.extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.woff2': return 'font/woff2'
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

async function readHistoryCounts(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('ai-worker-chat-history', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['sessions', 'turns'], 'readonly')
      const sessions = tx.objectStore('sessions').getAll()
      const turns = tx.objectStore('turns').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve({ sessions: sessions.result, turns: turns.result })
      }
      tx.onerror = () => reject(tx.error)
    }
  }))
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
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chromium not found at ${executablePath}. Install the Playwright Chromium browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.`)
  }

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
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'settings', exact: true }).click()
    const fileInput = page.locator('#legacy-export-file')
    const upload = async (name, json) => fileInput.setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: Buffer.from(json),
    })
    const importOne = async (name, json) => {
      await upload(name, json)
      await page.getByRole('button', { name: 'Import 1 chat' }).click()
      await page.getByText(/Import complete:/).waitFor()
    }

    await importOne('unrelated.json', createArchive('keep-session', 'Keep local chat', 'Keep this unrelated local message.'))
    const targetArchive = createArchive('target-session', 'Imported chat', 'Imported text for E2E.')
    await importOne('target.json', targetArchive)
    await page.getByRole('button', { name: 'Import 1 chat' }).click()
    await page.getByText(/Import complete:/).waitFor()
    let history = await readHistoryCounts(page)
    assert.equal(history.sessions.length, 2, 'same archive retry must not duplicate sessions')
    assert.equal(history.turns.length, 2, 'same archive retry must not duplicate turns')

    await page.getByRole('button', { name: 'chat', exact: true }).click()
    await page.getByText('Imported text for E2E.').waitFor()
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText('Imported text for E2E.').waitFor()
    history = await readHistoryCounts(page)
    assert.equal(history.sessions.length, 2, 'reload must retain both sessions')
    assert.equal(history.turns.length, 2, 'reload must retain both turns')

    await page.getByRole('button', { name: 'settings', exact: true }).click()
    await upload('utf8-limit.json', createArchive('too-long-session', '界'.repeat(128), 'Must not import.'))
    await page.getByRole('alert').filter({ hasText: 'invalid chat session' }).waitFor()
    history = await readHistoryCounts(page)
    assert.equal(history.sessions.length, 2, 'invalid multibyte title must not write sessions')
    assert.equal(history.turns.length, 2, 'invalid multibyte title must not write turns')

    await upload('target.json', targetArchive)
    await page.getByRole('button', { name: 'Remove imported copy' }).click()
    await page.getByRole('checkbox', {
      name: 'I understand these sessions and any later turns in them will be deleted.',
    }).check()
    await page.getByRole('button', { name: 'Remove imported chats' }).click()
    await page.getByText('Removed 1 imported chat. The selected export file was not changed.').waitFor()
    history = await readHistoryCounts(page)
    assert.equal(history.sessions.length, 1, 'rollback must remove only the selected archive session')
    assert.equal(history.sessions[0].title, 'Keep local chat', 'rollback must preserve unrelated chat')
    assert.equal(history.turns.length, 1, 'rollback must preserve unrelated turns')

    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Keep local chat' }).waitFor()
    await page.getByText('Keep this unrelated local message.').waitFor()
    assert.deepEqual(pageErrors, [], 'page must not report uncaught errors')

    console.log('PASS Tauri legacy import E2E')
    console.log(' - imports a validated synthetic Electron archive locally')
    console.log(' - retries and reloads without duplicate sessions or turns')
    console.log(' - rejects a multibyte title above the IndexedDB byte limit before writes')
    console.log(' - rolls back only the selected archive and preserves unrelated chat')
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
