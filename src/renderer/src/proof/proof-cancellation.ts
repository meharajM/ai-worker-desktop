import type { ProofBridge } from './proof-transport'

/** Tracks native cancel acknowledgement and its matching terminal event. */
export function observeNativeCancellation(bridge: ProofBridge) {
  let calls = 0
  let acceptedCalls = 0
  let runId: string | undefined
  let error = ''
  const results: boolean[] = []
  let acknowledge!: (accepted: boolean) => void
  let abort!: (runId: string) => void
  const acknowledgement = new Promise<boolean>((resolve) => { acknowledge = resolve })
  const aborted = new Promise<string>((resolve) => { abort = resolve })

  return {
    bridge: {
      ...bridge,
      cancel: async (id) => {
        calls++
        try {
          const accepted = await bridge.cancel(id)
          if (accepted) acceptedCalls++
          results.push(accepted)
          acknowledge(accepted)
          return accepted
        } catch (cause) {
          error = String(cause)
          acknowledge(false)
          return false
        }
      },
      stream: (id, scenario, onEvent) => bridge.stream(id, scenario, (event) => {
        runId = id
        if (event.event === 'aborted' && event.data.runId === id) abort(id)
        onEvent(event)
      }),
    } satisfies ProofBridge,
    acknowledgement,
    aborted,
    state: () => ({ calls, acceptedCalls, runId, error, results }),
  }
}
