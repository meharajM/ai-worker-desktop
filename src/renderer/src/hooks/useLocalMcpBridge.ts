import { useEffect } from 'react'
import { chat, getAvailableProviders, type LLMSettings } from '../lib/llm'
import { electron } from '../lib/electron'
import { useSettingsStore } from '../stores/settingsStore'

let inferenceInFlight = false

/** Handles bounded inference-only MCP requests from trusted local AI hosts. */
export function useLocalMcpBridge(): void {
  useEffect(() => electron.mcpBridge.onAskLocal(({ requestId, prompt }) => {
    void (async () => {
      if (inferenceInFlight) {
        await electron.mcpBridge.answerLocal({
          requestId,
          success: false,
          error: 'AI-Worker is already handling a local request. Try again shortly.',
        })
        return
      }

      inferenceInFlight = true
      try {
        const current = useSettingsStore.getState()
        // Only allow the app's existing on-device providers. Do not pass cloud
        // credentials, cloud endpoint settings, memory, workspace, or tools.
        const localSettings: LLMSettings = {
          localOnly: true,
          preferredProvider: 'auto',
          browserModel: current.browserModel,
          ollamaModel: current.ollamaModel,
          ollamaBaseUrl: current.ollamaBaseUrl,
        }
        const providers = await getAvailableProviders(localSettings)
        const localProvider = providers.browser.available && providers.browser.isLoaded
          ? 'browser'
          : providers.ollama.available
            ? 'ollama'
            : null

        if (!localProvider) {
          throw new Error('No on-device model is ready. Load a WebLLM model in Settings or start Ollama with the configured model. AI-Worker did not send this prompt to a cloud provider.')
        }

        const response = await chat(
          [{ role: 'user', content: prompt }],
          [],
          { ...localSettings, preferredProvider: localProvider },
          [],
          undefined,
          undefined,
          false,
          undefined,
          false,
        )

        if (!response.content.trim()) throw new Error('The local model returned no text. Try a shorter prompt.')
        await electron.mcpBridge.answerLocal({
          requestId,
          success: true,
          content: response.content,
          provider: response.provider,
          model: response.model,
        })
      } catch (error) {
        await electron.mcpBridge.answerLocal({
          requestId,
          success: false,
          error: error instanceof Error ? error.message : 'Local inference failed.',
        })
      } finally {
        inferenceInFlight = false
      }
    })()
  }), [])
}
