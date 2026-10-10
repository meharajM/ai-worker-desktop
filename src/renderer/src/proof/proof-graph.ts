import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { END, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { z } from 'zod'
import { proofModel } from './proof-provider'
import type { ProofAction, ProofBridge, ProofScenario } from './proof-transport'

/**
 * proof-graph.ts — routes proof model output through fixed fixture tools.
 *
 * Responsibilities: declare the message graph, fixed native action tools, and
 * finite invocation policy.
 * Design decision: ToolNode processes every call in one assistant message and
 * returns matching tool messages before routing back to the model; tool handlers
 * receive and check the graph signal before touching the native bridge.
 * Consumed by: proof-assertions.ts.
 */

const State = new StateSchema({ messages: MessagesValue })

/** Converts an aggregated model stream chunk into a canonical stored AI message. */
export function normalizeGraphMessage(chunk: AIMessageChunk): AIMessage {
  // Passing a Serializable chunk instance makes Core's stored-message mapper omit its data.
  return new AIMessage({
    content: chunk.content,
    id: chunk.id,
    name: chunk.name,
    additional_kwargs: chunk.additional_kwargs,
    response_metadata: chunk.response_metadata,
    tool_calls: chunk.tool_calls,
    invalid_tool_calls: chunk.invalid_tool_calls,
    usage_metadata: chunk.usage_metadata,
  })
}

/**
 * Builds an explicit model → tools → model graph for the fixed fixture actions.
 * @param bridge - Native proof bridge whose action command is closed to two values.
 * @param scenarios - Fixed provider response scenarios in request order.
 * @returns Compiled graph with bounded recursion and explicit signal propagation.
 */
export function proofGraph(bridge: ProofBridge, scenarios: ProofScenario[], onFirstChunk?: () => void) {
  const tools = [tool(async ({ action }: { action: ProofAction }, config) => {
    if (config.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    const result = await bridge.action(action)
    if (config.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    return result
  }, {
    name: 'proof_fixture_action',
    description: 'Return fixed local proof fixture output.',
    schema: z.object({ action: z.enum(['first', 'second']) }),
  })]
  const model = proofModel(bridge, scenarios, onFirstChunk).bindTools(tools)

  const graph = new StateGraph(State)
    .addNode('model', async (state, config) => {
      if (config.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      // `invoke` estimates tokens through a remote tokenizer fetch; public stream keeps this path offline.
      let full: AIMessageChunk | undefined
      for await (const chunk of await model.stream(state.messages, config)) {
        full = full ? full.concat(chunk) : chunk
      }
      if (!full) throw new Error('ChatOpenAI returned an empty stream')
      return { messages: [normalizeGraphMessage(full)] }
    })
    .addNode('tools', new ToolNode(tools))
    .addEdge(START, 'model')
    .addConditionalEdges('model', (state) => {
      const last = state.messages.at(-1)
      return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END
    }, ['tools', END])
    .addEdge('tools', 'model')
    .compile()

  return {
    /**
     * Invokes graph with explicit cancellation and a six-superstep ceiling.
     * @param messages - Initial or restored canonical message turn.
     * @param signal - Caller-owned cancellation signal for model and tool nodes.
     * @returns Final LangGraph state, including all assistant/tool messages.
     */
    invoke: (messages: import('@langchain/core/messages').BaseMessage[], signal?: AbortSignal) =>
      graph.invoke({ messages }, { recursionLimit: 6, signal, callbacks: [] }),
  }
}
