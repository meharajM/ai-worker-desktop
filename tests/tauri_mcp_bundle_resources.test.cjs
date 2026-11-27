const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..')
const tauriRoot = path.join(repoRoot, 'src-tauri')
const packageConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.conf.json'), 'utf8'))

test('Tauri bundle carries the standalone MCP adapter and its runtime packages', () => {
  assert.equal(config.bundle.active, true, 'Tauri build emits installable app bundles')
  assert.ok(config.bundle.targets.includes('app'), 'the app bundle is built on the current platform')
  const resources = config.bundle.resources
  assert.ok(resources && !Array.isArray(resources), 'Tauri resources use an explicit source-to-target map')

  const scriptSource = '../scripts/ai-worker-readonly-mcp.mjs'
  const scriptTarget = 'mcp/scripts/ai-worker-readonly-mcp.mjs'
  assert.equal(resources[scriptSource], scriptTarget)
  assert.ok(fs.statSync(path.resolve(tauriRoot, scriptSource)).isFile())

  const resourceNodeModules = path.posix.normalize(path.posix.join(path.posix.dirname(scriptTarget), '..', 'node_modules'))
  const electronResources = packageConfig.build.extraResources
  for (const dependency of [
    '@modelcontextprotocol/sdk',
    'zod',
    'zod-to-json-schema',
    'ajv',
    'ajv-formats',
    'fast-deep-equal',
    'fast-uri',
    'json-schema-traverse',
    'json-schema-typed',
    'require-from-string',
  ]) {
    const source = `../node_modules/${dependency}/`
    const target = `${resourceNodeModules}/${dependency}/`
    assert.equal(resources[source], target, `Tauri bundles ${dependency} beside the MCP script`)
    assert.ok(fs.statSync(path.resolve(tauriRoot, source)).isDirectory(), `${dependency} exists in the checkout`)
    assert.ok(electronResources.some(resource => resource.from === `node_modules/${dependency}`), `MCP dependency list includes ${dependency}`)
  }

  const docs = fs.readFileSync(path.join(repoRoot, 'docs/AI_WORKER_READINESS_MCP.md'), 'utf8')
  assert.match(docs, /mcp\/scripts\/ai-worker-readonly-mcp\.mjs/)
  assert.match(docs, /Install Node\.js 22\.12 or newer separately/)
  assert.match(docs, /does not edit host configuration automatically/)
})
