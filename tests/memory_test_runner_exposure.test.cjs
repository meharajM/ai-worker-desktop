const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')

test('memory verification runner is absent from production IPC and preload', () => {
  assert.doesNotMatch(read('src/main/ipc/memory.ts'), /memory:run-tests|MemoryTestRunner/)
  assert.doesNotMatch(read('src/preload/index.ts'), /runTests|memory:run-tests/)
  assert.doesNotMatch(read('src/renderer/src/env.d.ts'), /runTests/)
})

test('standalone memory verification remains available through its app-only CLI switch', () => {
  const main = read('src/main/index.ts')
  assert.match(main, /--ai-worker-run-memory-verification/)
  assert.match(main, /import\('\.\/tests\/MemoryTestRunner'\)/)
  assert.match(main, /MemoryServiceFactory\.getCurrentBackend\(\)/)
  assert.match(main, /backend !== 'server-memory'/)
  assert.match(main, /AI-Worker is already running/)
  assert.doesNotMatch(main, /isMemoryConnected\(\)/)
  assert.match(read('src/main/tests/MemoryTestRunner.ts'), /class MemoryTestRunner/)

  const standalone = read('tests/run_memory_verification.cjs')
  assert.match(standalone, /--ai-worker-run-memory-verification/)
  assert.match(standalone, /AI_WORKER_MEMORY_VERIFICATION_RESULT=/)
  assert.doesNotMatch(standalone, /window\.electron\.memory\.runTests/)
})
