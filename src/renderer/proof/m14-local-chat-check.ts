import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { LocalChatEvent, LocalChatMessage } from '../src/desktop-bridge'
import { createLocalChatGraph, localChatFetch, LOCAL_CHAT_URL } from '../src/local-chat'

type MockBridge = {
  startLocalChat: (taskId: string, messages: LocalChatMessage[], onEvent: (event: LocalChatEvent) => void) => Promise<{ taskId: string; requestId: string }>
  cancelLocalChat: (taskId: string) => Promise<void>
}

type Result = { name: string; passed: boolean; detail: string }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3000)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

function mock(events: (taskId: string, callback: (event: LocalChatEvent) => void) => void): MockBridge {
  return {
    startLocalChat: async (taskId, _messages, callback) => {
      events(taskId, callback)
      return { taskId, requestId: 'request-1' }
    },
    cancelLocalChat: async () => undefined,
  }
}

export async function runM14MockAssertions(onResult?: (result: Result) => void): Promise<Result[]> {
  const results: Result[] = []
  const check = async (name: string, run: () => Promise<string>) => {
    try { results.push({ name, passed: true, detail: await run() }) }
    catch (error) { results.push({ name, passed: false, detail: String(error) }) }
    onResult?.(results.at(-1)!)
  }

  await check('production LangGraph streams ChatOpenAI tokens over native events', async () => {
    const bridge = mock((taskId, onEvent) => {
      const base = { taskId, requestId: 'request-1' }
      onEvent({ event: 'started', data: base })
      onEvent({ event: 'chunk', data: { ...base, content: 'café' } })
      onEvent({ event: 'complete', data: base })
    })
    let final: { messages: unknown[] } | undefined
    for await (const state of await createLocalChatGraph(bridge).streamState([new HumanMessage('greet')])) final = state
    const answer = final?.messages.at(-1)
    assert(answer instanceof AIMessage && answer.content === 'café', `unexpected final message: ${String(answer)}`)
    return `assistant=${answer.content}`
  })

  await check('graph messages stream before native completion and retain final state', async () => {
    let releaseCompletion!: () => void
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve })
    const bridge: MockBridge = {
      startLocalChat: async (taskId, _messages, onEvent) => {
        const base = { taskId, requestId: 'request-1' }
        queueMicrotask(() => {
          onEvent({ event: 'started', data: base })
          onEvent({ event: 'chunk', data: { ...base, content: 'live' } })
        })
        void completion.then(() => onEvent({ event: 'complete', data: base }))
        return { taskId, requestId: 'request-1' }
      },
      cancelLocalChat: async () => undefined,
    }
    try {
      const iterable = await bounded(createLocalChatGraph(bridge).stream([new HumanMessage('stream')]), 'graph did not create message stream')
      const iterator = iterable[Symbol.asyncIterator]()
      let token = ''
      while (!token) {
        const next = await bounded(iterator.next(), 'graph did not stream token before native completion')
        assert(!next.done, 'message stream ended before native completion')
        const [chunk] = next.value
        if (typeof chunk.content === 'string') token += chunk.content
      }
      assert(token === 'live', `unexpected live token: ${token}`)
      releaseCompletion()
      while (!(await bounded(iterator.next(), 'graph did not finish after native completion')).done) { /* drain */ }
    } finally {
      releaseCompletion()
    }

    let final: { messages: unknown[] } | undefined
    for await (const state of await createLocalChatGraph(mock((taskId, onEvent) => {
      const base = { taskId, requestId: 'request-1' }
      onEvent({ event: 'chunk', data: { ...base, content: 'final' } })
      onEvent({ event: 'complete', data: base })
    })).streamState([new HumanMessage('state')])) final = state
    const answer = final?.messages.at(-1)
    assert(answer instanceof AIMessage && answer.content === 'final', `final graph state missing: ${String(answer)}`)
    return 'received live token before native completion; final state remains available via streamState'
  })

  await check('fixed endpoint and strict request body reject before native start', async () => {
    let starts = 0
    const bridge: MockBridge = { ...mock(() => undefined), startLocalChat: async (...args) => {
      starts++
      return { taskId: args[0], requestId: 'request-1' }
    } }
    const fetch = localChatFetch(bridge)
    for (const [input, init] of [
      ['https://example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'local-chat', stream: true, messages: [{ role: 'user', content: 'x' }] }) }],
      [`${LOCAL_CHAT_URL}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'local-chat', stream: true, tools: [], messages: [{ role: 'user', content: 'x' }] }) }],
      [`${LOCAL_CHAT_URL}/chat/completions`, { method: 'GET', body: JSON.stringify({ model: 'local-chat', stream: true, messages: [{ role: 'user', content: 'x' }] }) }],
    ] as [string, RequestInit][]) {
      try { await fetch(input, init); throw new Error('invalid request was accepted') } catch (error) {
        assert(String(error).includes('Rejected'), `unexpected validation error: ${String(error)}`)
      }
    }
    assert(starts === 0, `native start count=${starts}`)
    return 'external URL, tools body, and wrong method rejected'
  })

  await check('native failure reaches LangGraph caller', async () => {
    const bridge = mock((taskId, onEvent) => onEvent({ event: 'failed', data: {
      taskId, requestId: 'request-1', message: 'fixture native failure',
    } }))
    try {
      for await (const _state of await createLocalChatGraph(bridge).stream([new HumanMessage('fail')])) { /* consume */ }
      throw new Error('expected native failure')
    } catch (error) {
      assert(String(error).includes('fixture native failure'), `unexpected error: ${String(error)}`)
      return String(error)
    }
  })

  await check('abort before native start acknowledgement cancels once after acknowledgement', async () => {
    let callback: ((event: LocalChatEvent) => void) | undefined
    let taskId = ''
    let acknowledge!: (reply: { taskId: string; requestId: string }) => void
    let announceStarted!: () => void
    let cancelCalls = 0
    const started = new Promise<void>((resolve) => { announceStarted = resolve })
    const bridge: MockBridge = {
      startLocalChat: (id, _messages, onEvent) => {
        taskId = id
        callback = onEvent
        announceStarted()
        return new Promise((resolve) => { acknowledge = resolve })
      },
      cancelLocalChat: async (id) => { assert(id === taskId, 'cancel task mismatch'); cancelCalls++ },
    }
    const abort = new AbortController()
    const stream = createLocalChatGraph(bridge).stream([new HumanMessage('cancel')], abort.signal)
    await bounded(started, 'graph did not start')
    abort.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert(cancelCalls === 0, 'cancel sent before native acknowledgement')
    acknowledge({ taskId, requestId: 'request-1' })
    try {
      const iterable = await bounded(stream, 'graph stream did not abort')
      await bounded(iterable[Symbol.asyncIterator]().next(), 'graph stream did not abort')
      throw new Error('expected abort')
    } catch (error) {
      assert(String(error).includes('AbortError'), `unexpected graph result: ${String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert(Number(cancelCalls) === 1, `cancel calls=${cancelCalls}`)
    callback?.({ event: 'chunk', data: { taskId, requestId: 'request-1', content: 'late' } })
    assert(Number(cancelCalls) === 1, 'late event caused duplicate cancellation')
    return 'AbortError surfaced; native cancel sent once after acknowledgement'
  })

  await check('tool-call and multimodal graph inputs are rejected', async () => {
    const bridge = mock(() => undefined)
    for (const messages of [
      [new AIMessage({ content: '', tool_calls: [{ id: 'call', name: 'x', args: {}, type: 'tool_call' }] })],
      [new HumanMessage([{ type: 'text', text: 'structured' } as never])],
    ]) {
      try {
        for await (const _state of await createLocalChatGraph(bridge).stream(messages)) { /* consume */ }
        throw new Error('unsupported input was accepted')
      } catch (error) { assert(String(error).includes('Unsupported local chat message') || String(error).includes('tool calls'), String(error)) }
    }
    return 'tool calls and content blocks rejected'
  })

  return results
}
