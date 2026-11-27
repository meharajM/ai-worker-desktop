const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function loadAnthropicProvider(sendRequest) {
  const source = readFileSync(resolve(__dirname, '../src/renderer/src/lib/llm/anthropic.ts'), 'utf8')
    .replaceAll('import.meta.env', '({})')
  const module = { exports: {} }
  const context = {
    exports: module.exports,
    module,
    window: { electron: { llm: { anthropicChat: sendRequest, cancelAnthropicChat: async () => ({ success: true }) } } },
    require(name) {
      if (name === '../constants') return {
        FEATURE_FLAGS: { CLOUD_LLM_ENABLED: true },
        LLM_CONFIG: { ANTHROPIC: { DEFAULT_MODEL: 'claude-haiku-5-5' } },
      }
      if (name === './utils') return {
        ensureRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} },
        getEnvFallback() { return undefined },
        fileUrlToBase64: async () => null,
      }
      if (name === './types') return {}
      if (name === '../types') return {}
      throw new Error(`Unexpected dependency: ${name}`)
    },
  }
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, context)
  return module.exports
}

test('Anthropic messages preserve tool calls and results in Messages API format', async () => {
  let request
  const provider = loadAnthropicProvider(async (...args) => {
    request = args
    return {
      success: true,
      data: { content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'README.md' } },
      ] },
    }
  })

  const response = await provider.callAnthropic([
    { role: 'system', content: 'Use approved tools.' },
    { role: 'user', content: 'Read README.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'list_files', arguments: {} } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'README.md' },
  ], [{ name: 'read_file', description: 'Read a workspace file', parameters: { type: 'object' } }], {
    localOnly: false,
    anthropicApiKey: 'sk-ant-test-key',
    anthropicModel: 'claude-haiku-5-5',
  })

  assert.equal(request[1], 'sk-ant-test-key')
  assert.equal(request[2].system, 'Use approved tools.')
  assert.deepEqual(JSON.parse(JSON.stringify(request[2].messages)), [
    { role: 'user', content: [{ type: 'text', text: 'Read README.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_files', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }] },
  ])
  assert.equal(request[2].tools[0].name, 'read_file')
  assert.equal(response.content, 'Reading the file.')
  assert.deepEqual(JSON.parse(JSON.stringify(response.toolCalls)), [
    { id: 'toolu_2', name: 'read_file', arguments: { path: 'README.md' } },
  ])
})

test('Anthropic requests cannot bypass Local-only mode', async () => {
  let called = false
  const provider = loadAnthropicProvider(async () => { called = true; return { success: true, data: {} } })
  await assert.rejects(provider.callAnthropic([], [], {
    localOnly: true,
    anthropicApiKey: 'sk-ant-test-key',
  }), /disabled in local-only mode/i)
  assert.equal(called, false)
})
