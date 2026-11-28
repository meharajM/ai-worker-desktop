#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = process.env.AI_WORKER_MCP_SERVER_PATH || path.join(ROOT, 'scripts', 'ai-worker-readonly-mcp.mjs')
const OLLAMA_GENERATE = 'http://127.0.0.1:11434/api/generate'
const POLL_INTERVAL_MS = 750
const TASK_TIMEOUT_MS = 305_000
const FILES = ['src-tauri/Cargo.toml']
const PROMPT = `Read only ${FILES[0]}. Extract the [package] name and version exactly as written. Return exactly one bullet in the form: name=<value>; version=<value>; source=${FILES[0]}. Do not infer beyond this file.`

export function calculateSavings(baselineTokens, handoffTokens) {
  if (!Number.isInteger(baselineTokens) || baselineTokens < 0 ||
      !Number.isInteger(handoffTokens) || handoffTokens < 0) {
    throw new TypeError('Token counts must be non-negative integers.')
  }
  return {
    reducedTokens: baselineTokens - handoffTokens,
    reducedPercent: baselineTokens === 0
      ? null
      : Number(((baselineTokens - handoffTokens) / baselineTokens * 100).toFixed(1)),
  }
}

function toolError(result, name) {
  if (result.isError) {
    const message = result.content?.find(item => item.type === 'text')?.text
    throw new Error(`${name} failed: ${message || 'no diagnostic returned'}`)
  }
}

function structured(result, name) {
  toolError(result, name)
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = result.content?.find(item => item.type === 'text')?.text
  if (!text) throw new Error(`${name} returned no result.`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned an invalid result.`)
  }
}

async function countLocalModelTokens(model, prompt) {
  const response = await fetch(OLLAMA_GENERATE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      raw: true,
      stream: false,
      options: { num_predict: 1, temperature: 0 },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Local Ollama tokenizer request failed with HTTP ${response.status}.`)
  const result = await response.json()
  if (!Number.isInteger(result.prompt_eval_count) || result.prompt_eval_count < 0) {
    throw new Error('Ollama did not return a prompt_eval_count for this model.')
  }
  return result.prompt_eval_count
}

async function readBenchmarkFiles() {
  return Promise.all(FILES.map(async relativePath => ({
    path: relativePath,
    content: await fs.readFile(path.join(ROOT, relativePath), 'utf8'),
  })))
}

function baselineContext(files) {
  return [
    PROMPT,
    'Full workspace context supplied directly to the host agent:',
    ...files.map(file => `<file path="${file.path}">\n${file.content}\n</file>`),
  ].join('\n\n')
}

function handoffContext(result, parentInteractions) {
  return [
    PROMPT,
    ...parentInteractions.flatMap(({ question, answer }, index) => [
      `Parent question ${index + 1}: ${question}`,
      `Parent answer ${index + 1}: ${answer}`,
    ]),
    `AI-Worker result:\n${result.content}`,
    `Sources:\n${result.sources.join('\n')}`,
  ].join('\n\n')
}

async function main() {
  const client = new Client({ name: 'ai-worker-handoff-token-benchmark', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      AI_WORKER_AUTOSTART: process.env.AI_WORKER_AUTOSTART?.trim().toLowerCase() === 'true' ? 'true' : 'false',
      AI_WORKER_HOST_SESSION_ID: `handoff-benchmark-${process.pid}`,
    },
    stderr: 'pipe',
  })

  try {
    await client.connect(transport)
    const status = structured(await client.callTool({ name: 'get_runtime_status', arguments: {} }), 'get_runtime_status')
    if (status.privacyMode !== 'local-only') {
      throw new Error(`Expected a fresh local-only runtime; received privacyMode=${status.privacyMode}.`)
    }
    if (status.appRunning !== true) {
      throw new Error('AI-Worker must be running before benchmarking.')
    }

    console.error('Warming the local model; the first load may take a few minutes.')
    const warmup = structured(await client.callTool({
      name: 'ask_local',
      arguments: { prompt: 'Reply with exactly READY.' },
    }, undefined, { timeout: 180_000, maxTotalTimeout: 180_000 }), 'ask_local')
    if (!String(warmup.provider).toLowerCase().includes('ollama') ||
        typeof warmup.model !== 'string' || warmup.model.toLowerCase().includes('cloud')) {
      throw new Error(`A local Ollama model is required for matching token counts; provider was ${warmup.provider || 'unknown'}.`)
    }
    const readyStatus = structured(await client.callTool({ name: 'get_runtime_status', arguments: {} }), 'get_runtime_status')
    if (readyStatus.modelReady !== true || readyStatus.modelStatusFresh !== true) {
      throw new Error('AI-Worker did not report a fresh, ready local model after warm-up.')
    }

    const files = await readBenchmarkFiles()
    console.error('Running the read-only MCP workspace task.')
    const started = structured(await client.callTool({
      name: 'start_agent_task',
      arguments: {
        prompt: PROMPT,
        capabilities: ['workspace'],
        workspaceRoot: ROOT,
        handoffContext: {
          summary: 'Read one small Tauri configuration file for a reproducible context-reduction benchmark.',
          constraints: ['Read-only task.', `Use only ${FILES[0]}.`, 'Return the requested facts with its source path.'],
          relevantFiles: FILES,
          sourceAgent: 'AI-Worker handoff benchmark',
          workingDirectory: ROOT,
        },
      },
    }), 'start_agent_task')
    if (typeof started.id !== 'string') throw new Error('AI-Worker did not return a task ID.')

    const deadline = Date.now() + TASK_TIMEOUT_MS
    const parentInteractions = []
    let completed
    while (Date.now() < deadline) {
      const task = structured(await client.callTool({
        name: 'get_agent_task',
        arguments: { taskId: started.id },
      }), 'get_agent_task')
      if (task.state === 'completed') {
        completed = task.result
        break
      }
      if (task.state === 'waiting_for_parent') {
        if (parentInteractions.length >= 1 || !task.pendingQuestion) {
          await client.callTool({ name: 'cancel_agent_task', arguments: { taskId: started.id } }).catch(() => {})
          throw new Error('The benchmark task needs more than one parent clarification; stopping without a token claim.')
        }
        const answer = `This is a read-only benchmark. Read only ${FILES[0]}; report the [package] name and version exactly, with the source path.`
        parentInteractions.push({ question: task.pendingQuestion.text, answer })
        structured(await client.callTool({
          name: 'answer_agent_question',
          arguments: { taskId: started.id, questionId: task.pendingQuestion.id, answer },
        }), 'answer_agent_question')
        continue
      }
      if (['failed', 'cancelled', 'waiting_for_approval'].includes(task.state)) {
        if (task.state === 'waiting_for_approval') {
          await client.callTool({ name: 'cancel_agent_task', arguments: { taskId: started.id } }).catch(() => {})
        }
        throw new Error(`The read-only benchmark task ended in state "${task.state}"${task.error ? `: ${task.error}` : '.'}`)
      }
      if (!['queued', 'running', 'cancelling'].includes(task.state)) {
        throw new Error(`AI-Worker returned unexpected task state "${task.state}".`)
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    if (!completed || typeof completed.content !== 'string' || !Array.isArray(completed.sources)) {
      throw new Error('AI-Worker did not complete the benchmark task before the timeout.')
    }
    const actualSources = [...new Set(completed.sources)].sort()
    if (JSON.stringify(actualSources) !== JSON.stringify([...FILES].sort())) {
      throw new Error(`Benchmark task must cite exactly the selected files; received ${actualSources.join(', ') || 'no sources'}.`)
    }
    const packageFile = files.find(file => file.path === FILES[0])
    const expectedName = packageFile.content.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1]
    const expectedVersion = packageFile.content.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
    const reported = completed.content.match(/(?:^|\n)\s*(?:-\s*)?name=([^;\n]+);\s*version=([^;\n]+);\s*source=([^\s;\n]+)/)
    if (!expectedName || !expectedVersion || reported?.[1].trim() !== expectedName ||
        reported?.[2].trim() !== expectedVersion || reported?.[3] !== FILES[0]) {
      throw new Error('Benchmark task completed, but its package metadata result did not pass the exact-content check.')
    }

    console.error(`Counting both contexts with the local ${warmup.model} tokenizer.`)
    const baselineTokens = await countLocalModelTokens(warmup.model, baselineContext(files))
    const handoffTokens = await countLocalModelTokens(warmup.model, handoffContext(completed, parentInteractions))
    const savings = calculateSavings(baselineTokens, handoffTokens)
    console.log(JSON.stringify({
      benchmark: 'AI-Worker handoff vs host full-context',
      model: warmup.model,
      tokenizer: 'Ollama prompt_eval_count (raw prompt mode)',
      taskFiles: FILES,
      parentQuestionsAnswered: parentInteractions.length,
      baselineTokens,
      handoffTokens,
      estimatedContextTokensReduced: savings.reducedTokens,
      estimatedContextReductionPercent: savings.reducedPercent,
      result: completed.content,
      sources: completed.sources,
      caveat: 'This estimates only the task prompt and selected file context using the local Ollama tokenizer. It excludes host system prompts and tool schemas, may differ from the host model tokenizer, is not provider-billed savings, and excludes AI-Worker local inference tokens.',
    }, null, 2))
  } finally {
    await client.close().catch(() => {})
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Handoff benchmark failed.')
  process.exitCode = 1
})
