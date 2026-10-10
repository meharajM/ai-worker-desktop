import { ChatOpenAI } from '@langchain/openai'
import { proofFetch, type ProofBridge, type ProofScenario } from './proof-transport'

/**
 * proof-provider.ts — creates the pinned ChatOpenAI fixture model.
 *
 * Responsibilities: configure the official Chat Completions integration and
 * connect its Fetch implementation to the native byte transport.
 * Design decision: `fixture` is a non-secret marker; the fixed URL has no network
 * fallback, and LangChain/OpenAI owns SSE and response parsing. Callers pass an
 * empty callback list so framework defaults cannot export proof data to tracing.
 * Consumed by: proof-graph.ts and proof-assertions.ts.
 */

/**
 * Creates a Chat Completions model backed only by the local proof bridge.
 * @param bridge - Native or focused-check fixture bridge.
 * @param scenarios - Fixed response scenarios in request order.
 * @param onFirstChunk - Optional raw-byte hook used by abort assertions.
 * @returns ChatOpenAI instance configured for the proof endpoint.
 */
export function proofModel(
  bridge: ProofBridge,
  scenarios: ProofScenario[],
  onFirstChunk?: () => void,
): ChatOpenAI {
  return new ChatOpenAI({
    model: 'fixture',
    apiKey: 'fixture',
    streaming: true,
    maxRetries: 0,
    useResponsesApi: false,
    configuration: {
      baseURL: 'http://proof.invalid/v1',
      fetch: proofFetch(bridge, scenarios, onFirstChunk),
    },
  })
}
