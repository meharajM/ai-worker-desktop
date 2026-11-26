const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('OpenCode and Copilot expose only the three approved MCP tools', () => {
  const openCode = JSON.parse(read('opencode.json'))
  const openCodePermission = openCode.agent.ai_worker_readonly.permission
  assert.deepEqual(Object.keys(openCodePermission), [
    '*',
    'ai_worker_readonly_get_runtime_status',
    'ai_worker_readonly_ask_local',
    'ai_worker_readonly_run_agent_task',
  ])
  assert.equal(openCodePermission['*'], 'deny')
  assert.equal(openCodePermission.ai_worker_readonly_get_runtime_status, 'allow')
  assert.equal(openCodePermission.ai_worker_readonly_ask_local, 'allow')
  assert.equal(openCodePermission.ai_worker_readonly_run_agent_task, 'allow')
  assert.deepEqual(openCode.mcp.ai_worker_readonly.command, ['node', 'scripts/ai-worker-readonly-mcp.mjs'])
  assert.equal(openCode.provider.ollama.options.baseURL, 'http://localhost:11434/v1')
  assert.ok(openCode.provider.ollama.models['qwen3-vl:4b'])

  const copilot = read('.github/agents/ai-worker-readiness.agent.md')
  assert.match(copilot, /strict-tools-list: true/)
  assert.deepEqual(copilot.match(/^  - ai-worker-readiness-local\/[a-z_]+$/gm), [
    '  - ai-worker-readiness-local/get_runtime_status',
    '  - ai-worker-readiness-local/ask_local',
    '  - ai-worker-readiness-local/run_agent_task',
  ])
  assert.match(copilot, /command: node\n    args:\n      - scripts\/ai-worker-readonly-mcp\.mjs/)
  assert.deepEqual(copilot.match(/^      - [a-z_]+$/gm), [
    '      - get_runtime_status',
    '      - ask_local',
    '      - run_agent_task',
  ])
})

test('ask_local is implemented and documented as local inference only', () => {
  const bridge = read('scripts/ai-worker-readonly-mcp.mjs')
  const docs = read('docs/AI_WORKER_READINESS_MCP.md')
  assert.match(bridge, /registerTool\('get_runtime_status'/)
  assert.match(bridge, /registerTool\('ask_local'/)
  assert.match(bridge, /redirect: 'error'/)
  assert.match(bridge, /http:\/\/127\.0\.0\.1:\$\{port\}\/ask-local/)
  assert.doesNotMatch(docs, /ask_local[^\n]*pending/i)
  assert.match(docs, /does not fall back to cloud/i)
  assert.match(docs, /host's own model may be remote/i)
})

test('packaged application includes the standalone MCP script and runtime dependencies', () => {
  const pkg = JSON.parse(read('package.json'))
  const resources = pkg.build.extraResources
  const scripts = resources.find(resource => resource.from === 'scripts')
  assert.ok(scripts?.filter.includes('ai-worker-readonly-mcp.mjs'))
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
    assert.ok(resources.some(resource => resource.from === `node_modules/${dependency}`), `packages ${dependency} for the MCP process`)
  }
})
