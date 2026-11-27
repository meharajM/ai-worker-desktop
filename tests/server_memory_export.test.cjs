const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const ts = require('typescript')
const vm = require('node:vm')

function loadAdapter() {
  const filename = path.resolve(__dirname, '../src/main/services/memory/adapters/ServerMemoryAdapter.ts')
  const source = fs.readFileSync(filename, 'utf8')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href))
  const code = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  const localRequire = createRequire(filename)
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: name => {
      if (name === '@modelcontextprotocol/sdk/client/stdio.js') return { StdioClientTransport: class {} }
      if (name === '@modelcontextprotocol/sdk/client/index.js') return { Client: class {} }
      return localRequire(name)
    },
    process,
    Buffer,
    console: { log() {}, info() {}, warn() {}, error() {} },
  }, { filename })
  return module.exports.ServerMemoryAdapter
}

const ServerMemoryAdapter = loadAdapter()

function adapterWithResponse(response) {
  const adapter = new ServerMemoryAdapter({ storagePath: '/synthetic/profile-not-opened' })
  const requests = []
  adapter.client = {
    async callTool(request) {
      requests.push(request)
      return typeof response === 'function' ? response(request) : response
    },
  }
  return { adapter, requests }
}

test('exportAll reads the complete MCP graph and normalizes it without using its partial cache', async () => {
  const entities = Array.from({ length: 1_001 }, (_, index) => ({
    name: `entity-${index}`,
    entityType: 'note',
    observations: [`observation ${index}`],
  }))
  const graph = {
    entities,
    relations: [{ from: 'entity-0', to: 'entity-1000', relationType: 'references' }],
  }
  const { adapter, requests } = adapterWithResponse({ structuredContent: graph })
  adapter.entityCache.set('cache-only', { id: 'cache-only' })
  adapter.relationCache.set('cache-only', { id: 'cache-only' })

  const exported = await adapter.exportAll()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].name, 'read_graph')
  assert.deepEqual({ ...requests[0].arguments }, {})
  assert.equal(exported.entities.length, 1_001)
  assert.equal(exported.entities[0].id, 'entity-0')
  assert.equal(exported.entities[0].description, 'observation 0')
  assert.deepEqual(Array.from(exported.entities[0].observations), ['observation 0'])
  assert.equal(exported.entities[0].type, 'note')
  assert.equal(Object.keys(exported.entities[0].metadata).length, 0)
  assert.equal(exported.relations.length, 1)
  assert.equal(exported.relations[0].id, 'entity-0-references-entity-1000')
  assert.equal(exported.relations[0].fromEntityId, 'entity-0')
  assert.equal(exported.relations[0].toEntityId, 'entity-1000')
  assert.equal(exported.relations[0].relationType, 'references')
  assert.deepEqual({ ...exported.relations[0].metadata }, {})
  assert.equal(exported.metadata.backend, 'server-memory')
  assert.equal(adapter.entityCache.size, 1, 'export must not rewrite cache state')
})

test('exportAll fails closed on missing, unsupported, or corrupt MCP graph results', async () => {
  const invalidResponses = [
    { content: [{ type: 'text', text: '{"entities":[],"relations":[]}' }] },
    { structuredContent: { entities: [], relations: [], cursor: 'unexpected' } },
    { structuredContent: { entities: [{ name: 'broken', entityType: 'note' }], relations: [] } },
    { structuredContent: { entities: [{ name: 'broken', entityType: 'note', observations: [null] }], relations: [] } },
    { structuredContent: { entities: [{ name: 'one', entityType: 'note', observations: [] }], relations: [{ from: 'one', to: 'missing', relationType: 'links' }] } },
    { isError: true, structuredContent: { entities: [], relations: [] } },
  ]

  for (const response of invalidResponses) {
    const { adapter } = adapterWithResponse(response)
    await assert.rejects(adapter.exportAll(), /Memory export failed/)
  }
})

test('exportAll rejects graphs beyond the supported entity bound instead of truncating', async () => {
  const entities = Array.from({ length: 10_001 }, (_, index) => ({
    name: `entity-${index}`,
    entityType: 'note',
    observations: [],
  }))
  const { adapter } = adapterWithResponse({ structuredContent: { entities, relations: [] } })

  await assert.rejects(adapter.exportAll(), /10000 entity limit/)
})
