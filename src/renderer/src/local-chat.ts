import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { END, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { desktopBridge, type LocalChatEvent, type LocalChatMessage } from './desktop-bridge'

/** One fixed pseudo endpoint keeps every model request inside this Fetch adapter. */
export const LOCAL_CHAT_URL = 'http://local-chat.invalid/v1'
const CHAT_URL = `${LOCAL_CHAT_URL}/chat/completions`
const DEADLINE_MS = 120_000
const State = new StateSchema({ messages: MessagesValue })

type LocalChatBridge = Pick<typeof desktopBridge, 'startLocalChat' | 'cancelLocalChat'>

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError')
}

function graphMessages(value: unknown): LocalChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('Unsupported local chat messages')
  const encoder = new TextEncoder()
  let total = 0
  return value.map((message: unknown) => {
    if (message === null || typeof message !== 'object') throw new Error('Unsupported local chat message')
    const candidate = message as BaseMessage
    const role = candidate.getType() === 'human' ? 'user' : candidate.getType()
    if (!['system', 'user', 'assistant'].includes(role) || typeof candidate.content !== 'string' ||
      candidate.content.length === 0 || candidate.content.includes('\0') || candidate.name !== undefined ||
      Object.keys(candidate.additional_kwargs).length > 0) throw new Error('Unsupported local chat message')
    if (candidate.getType() === 'ai') {
      const ai = candidate as AIMessage
      if (ai.tool_calls?.length || ai.invalid_tool_calls?.length) throw new Error('Local chat does not support tool calls')
    }
    const bytes = encoder.encode(candidate.content).length
    total += bytes
    if (bytes > 8192 || total > 32768) throw new Error('Local chat prompt exceeds native limits')
    return { role: role as LocalChatMessage['role'], content: candidate.content }
  })
}

function wireMessages(value: unknown): LocalChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('Unsupported local chat messages')
  const encoder = new TextEncoder()
  let total = 0
  return value.map((message: unknown) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) throw new Error('Unsupported local chat message')
    const item = message as Record<string, unknown>
    if (Object.keys(item).sort().join(',') !== 'content,role' ||
      !['system', 'user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string' ||
      item.content.length === 0 || item.content.includes('\0')) throw new Error('Unsupported local chat message')
    const bytes = encoder.encode(item.content).length
    total += bytes
    if (bytes > 8192 || total > 32768) throw new Error('Local chat prompt exceeds native limits')
    return { role: item.role as LocalChatMessage['role'], content: item.content }
  })
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<LocalChatMessage[]> {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (url !== CHAT_URL || method.toUpperCase() !== 'POST') throw new Error('Rejected non-local chat request')
  const source = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (typeof source !== 'string') throw new Error('Rejected invalid local chat body')
  let body: unknown
  try { body = JSON.parse(source) } catch { throw new Error('Rejected invalid local chat body') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Rejected invalid local chat body')
  const record = body as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'messages,model,stream' || record.model !== 'local-chat' || record.stream !== true) {
    throw new Error('Rejected unsupported local chat request')
  }
  return wireMessages(record.messages)
}

/** Adapt native token events to ChatOpenAI's SSE parser without browser networking. */
export function localChatFetch(bridge: LocalChatBridge) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const messages = await requestBody(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (signal?.aborted) throw abortError()

    const taskId = crypto.randomUUID()
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let requestId: string | undefined
    const pendingEvents: LocalChatEvent[] = []
    let terminal = false
    let cancelRequested = false
    let cancelSent = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelNative = () => {
      cancelRequested = true
      if (requestId && !cancelSent) {
        cancelSent = true
        void bridge.cancelLocalChat(taskId).catch(() => undefined)
      }
    }
    const cleanup = () => {
      terminal = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error, cancel = false) => {
      if (terminal) return
      cleanup()
      if (cancel) cancelNative()
      controller?.error(error)
    }
    const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
    const emit = (event: LocalChatEvent) => {
      if (terminal || event.data.taskId !== taskId) return
      if (!requestId) {
        pendingEvents.push(event)
        return
      }
      if (event.data.requestId !== requestId) return
      if (event.event === 'chunk') {
        controller?.enqueue(encoder.encode(frame({ id: `chatcmpl-${taskId}`, object: 'chat.completion.chunk', created: 0,
          model: 'local-chat', choices: [{ index: 0, delta: { content: event.data.content }, finish_reason: null }] })))
      } else if (event.event === 'complete') {
        controller?.enqueue(encoder.encode(frame({ id: `chatcmpl-${taskId}`, object: 'chat.completion.chunk', created: 0,
          model: 'local-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })))
        controller?.enqueue(encoder.encode('data: [DONE]\n\n'))
        cleanup()
        controller?.close()
      } else if (event.event === 'failed') fail(new Error(event.data.message))
      else if (event.event === 'cancelled') fail(abortError())
    }
    const abort = () => fail(abortError(), true)
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        timer = setTimeout(() => fail(new Error(`Local chat timed out after ${DEADLINE_MS}ms`), true), DEADLINE_MS)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) { abort(); return }
        void bridge.startLocalChat(taskId, messages, emit).then((started) => {
          requestId = started.requestId
          for (const event of pendingEvents.splice(0)) emit(event)
          if (cancelRequested || signal?.aborted) cancelNative()
        }).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      },
      cancel() {
        if (terminal) return
        cleanup()
        cancelNative()
      },
    }, { highWaterMark: 1 })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
}

/** Compile the one-node local chat graph; LangChain parses SSE and LangGraph owns state. */
export function createLocalChatGraph(bridge: LocalChatBridge = desktopBridge) {
  const model = new ChatOpenAI({
    model: 'local-chat', apiKey: 'local-only', streaming: true, streamUsage: false, maxRetries: 0,
    useResponsesApi: false,
    configuration: { baseURL: LOCAL_CHAT_URL, fetch: localChatFetch(bridge) },
  })
  const graph = new StateGraph(State)
    .addNode('model', async (state, config) => {
      let full: AIMessageChunk | undefined
      for await (const chunk of await model.stream(graphMessages(state.messages), config)) {
        full = full ? full.concat(chunk) : chunk
      }
      if (!full) throw new Error('ChatOpenAI returned an empty stream')
      return { messages: [new AIMessage({ content: full.content, id: full.id, name: full.name,
        additional_kwargs: full.additional_kwargs, response_metadata: full.response_metadata,
        tool_calls: full.tool_calls, invalid_tool_calls: full.invalid_tool_calls, usage_metadata: full.usage_metadata })] }
    }, { retryPolicy: { maxAttempts: 1 } })
    .addEdge(START, 'model')
    .addEdge('model', END)
    .compile()

  return {
    stream: (messages: BaseMessage[], signal?: AbortSignal) => graph.stream(
      { messages }, { signal, callbacks: [], streamMode: 'messages' },
    ),
    streamState: (messages: BaseMessage[], signal?: AbortSignal) => graph.stream(
      { messages }, { signal, callbacks: [], streamMode: 'values' },
    ),
  }
}
