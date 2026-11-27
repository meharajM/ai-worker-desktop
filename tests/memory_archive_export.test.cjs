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
const serverMemoryFixture = fs.readFileSync(
  path.resolve(__dirname, 'fixtures/memory_archive_server_memory.json'),
  'utf8',
).trimEnd()

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
  const laterExport = {
    ...first,
    metadata: { ...first.metadata, exportedAt: '2026-11-28T00:00:00.000Z' },
  }

  const archive = JSON.parse(await serializeMemoryArchive(first))
  const reorderedArchive = JSON.parse(await serializeMemoryArchive(reordered))
  const laterArchive = JSON.parse(await serializeMemoryArchive(laterExport))
  const expectedPayload = '{"entities":[{"id":"note-1","metadata":{"a":2,"z":1},"name":"Note"}],"relations":[]}'
  const expectedDigest = crypto.createHash('sha256').update(expectedPayload).digest('hex')

  assert.equal(archive.format, 'ai-worker-memory-export')
  assert.equal(archive.schemaVersion, 1)
  assert.equal(archive.contentSha256, expectedDigest)
  assert.equal(archive.migrationId, `sha256-${expectedDigest}`)
  assert.equal(reorderedArchive.contentSha256, expectedDigest)
  assert.equal(laterArchive.contentSha256, expectedDigest, 'a new export timestamp must not create a duplicate import ID')
  assert.equal(laterArchive.migrationId, archive.migrationId)
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

test('frontend serializer output matches the archive fixture consumed by Rust', async () => {
  const graph = {
    entities: [
      { id: 'alice', name: 'Alice', type: 'person', description: 'Prefers local tools.\nValues privacy.', observations: ['Prefers local tools.', 'Values privacy.'], metadata: {}, createdAt: 'unknown' },
      { id: 'project-ai', name: 'AI Worker', type: 'project', description: 'A local desktop concierge.', observations: ['Stores memory locally.'], metadata: {}, createdAt: 'unknown' },
    ],
    relations: [{ id: 'alice-uses-project-ai', fromEntityId: 'alice', toEntityId: 'project-ai', relationType: 'uses', metadata: {} }],
    metadata: { exportedAt: '2026-11-27T10:00:00.000Z', version: '1.0.0', backend: 'server-memory' },
  }

  assert.equal(await serializeMemoryArchive(graph), serverMemoryFixture)
})
