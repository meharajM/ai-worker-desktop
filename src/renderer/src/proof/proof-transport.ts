import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export type ProofScenario = 'normal' | 'error' | 'abort' | 'tool_calls'
export type ProofAction = 'first' | 'second'

export type ProofEvent =
  | { event: 'chunk'; data: { runId: string; bytes: number[] } }
  | { event: 'complete'; data: { runId: string } }
  | { event: 'failed'; data: { runId: string; message: string } }
  | { event: 'aborted'; data: { runId: string } }

export type ProofBridge = {
  stream: (runId: string, scenario: ProofScenario, onEvent: (event: ProofEvent) => void) => Promise<void>
  cancel: (runId: string) => Promise<boolean>
  action: (action: ProofAction) => Promise<string>
}

const MAX_STREAM_BYTES = 4096

export const nativeProofBridge: ProofBridge = {
  stream: (runId, scenario, onEvent) => {
    if (!isTauri()) return Promise.reject(new Error('Native bridge unavailable in browser preview'))
    const onEventChannel = new Channel<ProofEvent>()
    onEventChannel.onmessage = onEvent
    return invoke('proof_stream', { runId, scenario, onEvent: onEventChannel })
  },
  cancel: (runId) => invoke<boolean>('proof_cancel', { runId }),
  action: (action) => invoke<string>('proof_fixture_action', { action }),
}

export function proofFetch(bridge: ProofBridge, scenarios: ProofScenario[], onFirstChunk?: () => void) {
  let requestIndex = 0
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const scenario = scenarios[Math.min(requestIndex++, scenarios.length - 1)]
    if (!scenario) throw new Error('No proof scenario configured')
    const signal = init?.signal
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')

    const runId = crypto.randomUUID()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let started = false
    let settled = false
    let cancelRequested = false
    let cancellationSent = false
    let firstChunkSeen = false
    let receivedBytes = 0
    const cancelNative = () => {
      cancelRequested = true
      if (started && !cancellationSent) {
        cancellationSent = true
        void bridge.cancel(runId).catch(() => undefined)
      }
    }
    const cleanup = () => {
      settled = true
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cancelNative()
      if (!settled) {
        cleanup()
        controller?.error(new DOMException('The operation was aborted', 'AbortError'))
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) {
          abort()
          return
        }
        void bridge.stream(runId, scenario, (message) => {
          if (settled || message.data.runId !== runId) return
          if (message.event === 'chunk') {
            receivedBytes += message.data.bytes.length
            if (receivedBytes > MAX_STREAM_BYTES) {
              cleanup()
              controller?.error(new Error('Proof stream exceeded 4 KiB'))
              cancelNative()
              return
            }
            controller?.enqueue(new Uint8Array(message.data.bytes))
            if (!firstChunkSeen) {
              firstChunkSeen = true
              onFirstChunk?.()
            }
          } else if (message.event === 'complete') {
            cleanup()
            controller?.close()
          } else if (message.event === 'failed') {
            cleanup()
            controller?.error(new Error(message.data.message))
          } else {
            cleanup()
            controller?.error(new DOMException('Native proof stream aborted', 'AbortError'))
          }
        }).then(() => {
          started = true
          if (cancelRequested || signal?.aborted) {
            cancelNative()
            if (!settled) abort()
          }
        }).catch((error: unknown) => {
          if (!settled) {
            cleanup()
            controller?.error(error)
          }
        })
      },
      cancel() {
        cleanup()
        cancelNative()
      },
    }, { highWaterMark: 1 })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
}

export function proofModel(bridge: ProofBridge, scenarios: ProofScenario[], onFirstChunk?: () => void) {
  const provider = createOpenAICompatible({
    name: 'm03-proof',
    baseURL: 'http://proof.invalid/v1',
    fetch: proofFetch(bridge, scenarios, onFirstChunk),
  })
  return provider.chatModel('fixture')
}
