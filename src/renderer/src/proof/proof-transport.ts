import { Channel, invoke, isTauri } from '@tauri-apps/api/core'

/**
 * proof-transport.ts — adapts fixed Tauri proof commands to browser byte streams.
 *
 * Responsibilities: define the fixture DTOs, invoke native proof commands, and
 * expose their bytes as a bounded Fetch Response for the provider adapter.
 * Design decision: wait for native start acknowledgement before cancellation so
 * cancel cannot race ahead of producer registration.
 * Consumed by: proof-provider.ts and the focused transport check page.
 */

/** Fixed native response scripts available to the isolated proof harness. */
export type ProofScenario = 'normal' | 'error' | 'abort' | 'tool_calls'
/** Closed action set exposed by the native proof fixture. */
export type ProofAction = 'first' | 'second'

/** Typed Channel payloads emitted by the native fixture producer. */
export type ProofEvent =
  | { event: 'chunk'; data: { runId: string; bytes: number[] } }
  | { event: 'complete'; data: { runId: string } }
  | { event: 'failed'; data: { runId: string; message: string } }
  | { event: 'aborted'; data: { runId: string } }

/** Small command surface shared by Tauri bridge and generic transport checks. */
export type ProofBridge = {
  stream: (runId: string, scenario: ProofScenario, onEvent: (event: ProofEvent) => void) => Promise<void>
  cancel: (runId: string) => Promise<boolean>
  action: (action: ProofAction) => Promise<string>
}

const MAX_STREAM_BYTES = 4096
// Fixture silence is a failed proof; bound it and cancel native work.
const STREAM_DEADLINE_MS = 5000

/** Tauri-backed bridge; browser preview fails closed before any fixture command. */
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

/**
 * Builds a custom Fetch implementation over typed Channel byte events.
 * @param bridge - Native or focused-check fixture bridge.
 * @param scenarios - One fixed scenario per provider request.
 * @param onFirstChunk - Optional raw-byte hook used to trigger cancellation.
 * @returns Fetch-compatible function returning a bounded SSE Response.
 */
export function proofFetch(bridge: ProofBridge, scenarios: ProofScenario[], onFirstChunk?: () => void) {
  let requestIndex = 0
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const scenario = scenarios[Math.min(requestIndex++, scenarios.length - 1)]
    if (!scenario) throw new Error('No proof scenario configured')
    const signal = init?.signal ?? (_input instanceof Request ? _input.signal : undefined)
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')

    const runId = crypto.randomUUID()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let started = false
    let settled = false
    let cancelRequested = false
    let cancellationSent = false
    let firstChunkSeen = false
    let receivedBytes = 0
    let deadline: ReturnType<typeof setTimeout> | undefined
    const cancelNative = () => {
      cancelRequested = true
      if (started && !cancellationSent) {
        cancellationSent = true
        void bridge.cancel(runId).catch(() => undefined)
      }
    }
    const cleanup = () => {
      settled = true
      if (deadline) clearTimeout(deadline)
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
        deadline = setTimeout(() => {
          cleanup()
          controller?.error(new Error(`Native proof stream timed out after ${STREAM_DEADLINE_MS}ms`))
          cancelNative()
        }, STREAM_DEADLINE_MS)
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
