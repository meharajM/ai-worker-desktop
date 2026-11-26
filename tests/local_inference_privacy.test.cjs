const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the renderer modules without starting Electron or downloading models.
function loadRendererModule(file, imports = {}, globals = {}) {
  const filename = path.join(__dirname, '../src/renderer/src', file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, URL, AbortSignal,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
    ...globals,
  }, { filename });
  return module.exports;
}

async function run() {
  const probes = [];
  let browserStatus = { isSupported: true, isLoaded: false, currentModel: null };
  let ollamaStatus = { available: false };
  let failingProvider;
  const result = provider => async () => {
    if (provider === failingProvider) throw new Error(`${provider} failed`);
    return { provider, content: 'ok' };
  };
  const remoteProbe = name => async () => { probes.push(name); return { available: true }; };
  const llm = loadRendererModule('lib/llm.ts', {
    './webllm': { getWebLLMStatus: () => browserStatus },
    './plan_manager': { CREATE_PLAN_TOOL: { name: 'create_plan' } },
    './dcp': { pruneContext: messages => messages },
    './llm/ollama': { checkOllama: async () => ollamaStatus, callOllama: result('ollama') },
    './llm/browser-llm': { callBrowserLLM: result('browser') },
    './llm/openai': {
      checkOpenAI: remoteProbe('openai'), checkOpenRouter: remoteProbe('openrouter'), callOpenAI: result('openai'),
    },
    './llm/gemini': { checkGemini: remoteProbe('gemini'), callGemini: result('gemini') },
    './llm/prompts': { buildSystemPrompt: async () => '' },
    './llm/utils': { getEnvFallback: () => 'openai' },
  });

  const local = { localOnly: true, preferredProvider: 'openai' };
  const providers = await llm.getAvailableProviders(local);
  assert.equal(providers.openai.available, false);
  assert.equal(providers.gemini.available, false);
  assert.equal(providers.openrouter.available, false);
  await assert.rejects(llm.chat([], undefined, local), /No local model ready.*Settings.*Cloud providers are disabled/);
  browserStatus = { ...browserStatus, isLoaded: true, currentModel: 'cached-model' };
  assert.equal((await llm.chat([], undefined, local)).provider, 'browser');
  browserStatus = { ...browserStatus, isLoaded: false };
  ollamaStatus = { available: true };
  assert.equal((await llm.chat([], undefined, local)).provider, 'ollama');
  assert.equal((await llm.chat([], undefined, { ...local, preferredProvider: 'auto' })).provider, 'ollama');
  failingProvider = 'ollama';
  await assert.rejects(llm.chat([], undefined, local), /ollama failed/);
  failingProvider = undefined;
  assert.deepEqual(probes, [], 'Local-only must never probe cloud providers');
  ollamaStatus = { available: false };
  assert.equal((await llm.chat([], undefined, { preferredProvider: 'openai' })).provider, 'openai');
  assert.deepEqual(probes.sort(), ['gemini', 'openai', 'openrouter']);

  const requests = [];
  let models = [];
  const ollama = loadRendererModule('lib/llm/ollama.ts', {
    '../constants': { FEATURE_FLAGS: { OLLAMA_ENABLED: true }, LLM_CONFIG: { OLLAMA: { BASE_URL: 'http://localhost:11434', DEFAULT_MODEL: 'local-model' } } },
    './utils': { getEnvFallback: () => undefined, extractTextForLegacyProviders: content => content },
  }, {
    window: { electron: { llm: { fetchOllamaModels: () => assert.fail('Local-only must bypass IPC redirects') } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ models: models.map(name => typeof name === 'string' ? { name, details: { format: 'gguf' } } : name), message: { content: 'ok' } }) };
    },
  });
  for (const url of ['https://remote.example', 'http://localhost.evil.example', 'http://127.evil.example', 'http://user:pass@localhost:11434', 'file:///tmp/ollama']) {
    assert.equal((await ollama.checkOllama({ ...local, ollamaBaseUrl: url })).available, false);
    await assert.rejects(ollama.callOllama([], undefined, { ...local, ollamaBaseUrl: url }), /Local-only mode requires/);
    assert.equal((await ollama.testOllamaConnection(url, 'local-model', true)).success, false);
  }
  assert.equal(requests.length, 0, 'Invalid local URLs must not make requests');
  assert.match((await ollama.checkOllama(local)).error, /not installed/);
  models = ['different-model'];
  assert.equal((await ollama.checkOllama(local)).available, false);
  models = [{ name: 'local-model:latest', remote_model: 'remote', remote_host: 'https://cloud.example', details: { format: '' } }];
  assert.equal((await ollama.checkOllama(local)).available, false);
  await assert.rejects(ollama.callOllama([], undefined, local), /not installed/);
  await assert.rejects(ollama.callOllama([], undefined, { ...local, ollamaModel: 'test:1t-cloud' }), /installed on this device/);
  assert.ok(requests.every(request => request.url.endsWith('/api/tags')), 'No inference on remote-backed aliases');
  models = ['local-model:latest'];
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const settings = { ...local, ollamaBaseUrl: `http://${host}:11434` };
    assert.equal((await ollama.checkOllama(settings)).available, true);
    assert.equal((await ollama.callOllama([], undefined, settings)).provider, 'ollama');
    assert.equal((await ollama.testOllamaConnection(settings.ollamaBaseUrl, 'local-model', true)).success, true);
  }
  assert.ok(requests.every(request => request.options.redirect === 'error'), 'Local requests must reject redirects');

  let loads = 0;
  const browser = loadRendererModule('lib/llm/browser-llm.ts', {
    '../constants': { FEATURE_FLAGS: {} }, './utils': {},
    '../webllm': { getWebLLMStatus: () => ({ isSupported: true, isLoaded: false }), loadWebLLMModel: () => { loads++; } },
  });
  await assert.rejects(browser.callBrowserLLM([], undefined, local), /No On-Device model loaded.*Settings/);
  assert.equal(loads, 0, 'Local-only must not auto-load or download a missing browser model');
  assert.equal((await browser.downloadBrowserModel(undefined, 'missing-model')).success, false);

  const environment = loadRendererModule('lib/user-environment.ts', {}, {
    fetch: () => assert.fail('Environment context must not make network requests'),
  });
  assert.match(await environment.getUserEnvironmentContext(), /System Timezone.*\n.*System Locale/);
  console.log('Local inference privacy checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
