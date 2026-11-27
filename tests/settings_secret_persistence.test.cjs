const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function loadPersistenceOptions() {
  const source = readFileSync(resolve(__dirname, '../src/renderer/src/stores/settingsStore.ts'), 'utf8')
    .replaceAll('import.meta.env', '({})')
  const module = { exports: {} }
  let options
  const create = () => (creator) => creator(() => {}, () => ({}), {})

  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, {
    exports: module.exports,
    window: { electron: true },
    require(name) {
      if (name === 'zustand') return { create }
      if (name === 'zustand/middleware') return {
        persist: (creator, config) => { options = config; return creator },
        createJSONStorage: () => ({}),
      }
      if (name === '../lib/constants') return {
        VOICE_CONFIG: { SPEECH_LANG: 'en-US' },
        LLM_CONFIG: {
          OLLAMA: { DEFAULT_MODEL: 'local' },
          OPENAI_COMPATIBLE: { DEFAULT_MODEL: 'cloud' },
          ANTHROPIC: { DEFAULT_MODEL: 'claude-haiku-5-5' },
          GEMINI: { DEFAULT_MODEL: 'cloud' },
          OPENROUTER: { DEFAULT_MODEL: 'cloud' },
        },
        STORAGE_KEYS: { SETTINGS: 'settings' },
      }
      if (name === '../lib/electron') return { __esModule: true, default: {} }
      if (name === '../lib/firebase') return { getUserProfile: async () => null }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  assert.ok(options, 'settings persist configuration loaded')
  return options
}

test('API keys are cleared when old settings are rehydrated and excluded from future persistence', () => {
  const options = loadPersistenceOptions()
  const oldState = {
    theme: 'light',
    openaiApiKey: 'old-openai-secret',
    geminiApiKey: 'old-gemini-secret',
    openrouterApiKey: 'old-openrouter-secret',
    anthropicApiKey: 'old-anthropic-secret',
  }

  const migrated = options.migrate(oldState, 0)
  const partial = options.partialize({ ...oldState, ...migrated })
  for (const state of [migrated, partial]) {
    assert.equal(state.openaiApiKey, '')
    assert.equal(state.geminiApiKey, '')
    assert.equal(state.openrouterApiKey, '')
    assert.equal(state.anthropicApiKey, '')
  }
  assert.equal(migrated.theme, 'light')
})
