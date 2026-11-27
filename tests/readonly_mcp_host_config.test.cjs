const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('OpenCode launches only the AI-Worker subagent and limits its MCP tools', () => {
  const openCode = JSON.parse(read('opencode.json'))
  const parent = openCode.agent.ai_worker_parent
  assert.equal(parent.mode, 'primary')
  assert.equal(parent.permission['*'], 'deny')
  for (const tool of [
    'start_agent_task',
    'get_agent_task',
    'answer_agent_question',
    'cancel_agent_task',
  ]) assert.equal(parent.permission[`ai_worker_readonly_${tool}`], 'allow')
  assert.equal(Object.keys(parent.permission).length, 5)
  assert.match(parent.prompt, /start_agent_task/)
  assert.match(parent.prompt, /get_agent_task/)
  assert.match(parent.prompt, /waiting_for_parent/)

  const openCodePermission = openCode.agent.ai_worker_readonly.permission
  assert.deepEqual(Object.keys(openCodePermission), [
    '*',
    'ai_worker_readonly_get_runtime_status',
    'ai_worker_readonly_ask_local',
    'ai_worker_readonly_run_agent_task',
    'ai_worker_readonly_start_agent_task',
    'ai_worker_readonly_get_agent_task',
    'ai_worker_readonly_answer_agent_question',
    'ai_worker_readonly_cancel_agent_task',
  ])
  assert.equal(openCodePermission['*'], 'deny')
  assert.equal(openCodePermission.ai_worker_readonly_get_runtime_status, 'allow')
  assert.equal(openCodePermission.ai_worker_readonly_ask_local, 'allow')
  assert.equal(openCodePermission.ai_worker_readonly_run_agent_task, 'allow')
  for (const tool of [
    'start_agent_task',
    'get_agent_task',
    'answer_agent_question',
    'cancel_agent_task',
  ]) assert.equal(openCodePermission[`ai_worker_readonly_${tool}`], 'allow')
  assert.deepEqual(openCode.mcp.ai_worker_readonly.command, ['node', 'scripts/ai-worker-readonly-mcp.mjs'])
  assert.equal(openCode.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1')
  assert.ok(openCode.provider.ollama.models['qwen3-vl:4b'])

  const subagent = openCode.agent.ai_worker_readonly
  assert.equal(subagent.mode, 'subagent')
  assert.match(subagent.prompt, /ai_worker_readonly_start_agent_task/)
  assert.match(subagent.prompt, /ai_worker_readonly_get_agent_task/)
  assert.match(subagent.prompt, /ai_worker_readonly_answer_agent_question/)
  assert.match(subagent.prompt, /in memory only/)
  assert.match(subagent.prompt, /may be remote/)

  const copilot = read('.github/agents/ai-worker-readiness.agent.md')
  assert.match(copilot, /strict-tools-list: true/)
  assert.deepEqual(copilot.match(/^  - ai-worker-readiness-local\/[a-z_]+$/gm), [
    '  - ai-worker-readiness-local/get_runtime_status',
    '  - ai-worker-readiness-local/ask_local',
    '  - ai-worker-readiness-local/run_agent_task',
    '  - ai-worker-readiness-local/start_agent_task',
    '  - ai-worker-readiness-local/get_agent_task',
    '  - ai-worker-readiness-local/answer_agent_question',
    '  - ai-worker-readiness-local/cancel_agent_task',
  ])
  assert.match(copilot, /command: node\n    args:\n      - scripts\/ai-worker-readonly-mcp\.mjs/)
  assert.deepEqual(copilot.match(/^      - [a-z_]+$/gm), [
    '      - get_runtime_status',
    '      - ask_local',
    '      - run_agent_task',
    '      - start_agent_task',
    '      - get_agent_task',
    '      - answer_agent_question',
    '      - cancel_agent_task',
  ])
})

test('ask_local is implemented and documented as local inference only', () => {
  const bridge = read('scripts/ai-worker-readonly-mcp.mjs')
  const docs = read('docs/AI_WORKER_READINESS_MCP.md')
  assert.match(bridge, /registerTool\('get_runtime_status'/)
  assert.match(bridge, /registerTool\('ask_local'/)
  for (const tool of [
    'run_agent_task',
    'start_agent_task',
    'get_agent_task',
    'answer_agent_question',
    'cancel_agent_task',
  ]) assert.match(bridge, new RegExp(`registerTool\\('${tool}'`))
  assert.match(bridge, /redirect: 'error'/)
  assert.match(bridge, /http:\/\/127\.0\.0\.1:\$\{port\}\/ask-local/)
  assert.doesNotMatch(docs, /ask_local[^\n]*pending/i)
  assert.match(docs, /never falls back to a cloud provider/i)
  assert.match(docs, /host receives task results and may run a remote model/i)
  assert.match(docs, /waiting_for_parent/)
  assert.match(docs, /process memory/i)
  assert.match(docs, /cancelling/i)
  assert.match(docs, /A2A v1\.0 endpoint/i)
  assert.match(docs, /SendMessage/)
  assert.match(docs, /message\.extensions/)
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
