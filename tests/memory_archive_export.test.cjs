const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const ts = require('typescript')
const vm = require('node:vm')

function loadArchiveHelpers() {
  const filename = path.resolve(__dirname, '../src/renderer/src/components/settings/memory/MemoryInspector.tsx')
  const source = fs.readFileSync(filename, 'utf8')
  const code = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  const localRequire = createRequire(filename)
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: name => {
      if (name === 'react') return { __esModule: true, default: {}, useState() {}, useEffect() {} }
      if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: {} }
      if (name === 'lucide-react') return new Proxy({}, { get: () => function Icon() {} })
      return localRequire(name)
    },
    window: { crypto: crypto.webcrypto },
    TextEncoder,
    Uint8Array,
    Number,
    Date,
  }, { filename })
  return module.exports
}

const { serializeMemoryArchive, assertMemoryArchiveSize } = loadArchiveHelpers()

test('memory archive has a stable canonical content digest and versioned envelope', async () => {
  const first = {
    entities: [{ id: 'note-1', name: 'Note', metadata: { z: 1, a: 2 } }],
    relations: [],
    metadata: { backend: 'server-memory', exportedAt: '2026-11-27T00:00:00.000Z' },
  }
  const reordered = {
    metadata: { exportedAt: '2026-11-27T00:00:00.000Z', backend: 'server-memory' },
    relations: [],
    entities: [{ metadata: { a: 2, z: 1 }, name: 'Note', id: 'note-1' }],
  }

  const archive = JSON.parse(await serializeMemoryArchive(first))
  const reorderedArchive = JSON.parse(await serializeMemoryArchive(reordered))
  const expectedPayload = '{"entities":[{"id":"note-1","metadata":{"a":2,"z":1},"name":"Note"}],"metadata":{"backend":"server-memory","exportedAt":"2026-11-27T00:00:00.000Z"},"relations":[]}'
  const expectedDigest = crypto.createHash('sha256').update(expectedPayload).digest('hex')

  assert.equal(archive.format, 'ai-worker-memory-export')
  assert.equal(archive.schemaVersion, 1)
  assert.equal(archive.contentSha256, expectedDigest)
  assert.equal(archive.migrationId, `sha256-${expectedDigest}`)
  assert.equal(reorderedArchive.contentSha256, expectedDigest)
  assert.equal(archive.exportedAt, first.metadata.exportedAt)
  assert.deepEqual(archive.entities, first.entities)
  assert.deepEqual(archive.relations, first.relations)
  assert.deepEqual(archive.metadata, first.metadata)
})

test('archive size guard accepts the exact limit and rejects overflow or invalid counts', () => {
  assert.doesNotThrow(() => assertMemoryArchiveSize(64 * 1024 * 1024))
  assert.throws(() => assertMemoryArchiveSize(64 * 1024 * 1024 + 1), /64 MiB limit/)
  assert.throws(() => assertMemoryArchiveSize(-1), /size is invalid/)
})

test('memory archive serializer rejects malformed graph payloads', async () => {
  await assert.rejects(serializeMemoryArchive({ entities: 'not-an-array', relations: [] }), /invalid graph/)
  await assert.rejects(serializeMemoryArchive({ entities: [], relations: [], metadata: [] }), /invalid graph/)
  await assert.rejects(serializeMemoryArchive({ entities: [undefined], relations: [] }), /unsupported data/)
})
