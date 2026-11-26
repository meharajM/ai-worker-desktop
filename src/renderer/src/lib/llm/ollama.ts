import { LLMMessage, LLMSettings, LLMTool, LLMResponse } from "../types";
import { ProviderStatus } from "./types";
import { LLM_CONFIG, FEATURE_FLAGS } from "../constants";
import { extractTextForLegacyProviders, getEnvFallback } from "./utils";

export // Get Ollama settings from store or use defaults
  function getOllamaSettings(settings?: LLMSettings) {
  const envModel = getEnvFallback('ollama', 'model');
  const baseUrl = settings?.ollamaBaseUrl || LLM_CONFIG.OLLAMA.BASE_URL;
  const model = settings?.ollamaModel || envModel || LLM_CONFIG.OLLAMA.DEFAULT_MODEL;
  if (settings?.localOnly) {
    if (/(?:^|[:@-])cloud(?:$|[:@-])/i.test(model)) throw new Error('Local-only mode requires a model installed on this device.');
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('Invalid Ollama URL. Set a localhost URL in Settings > LLM Provider, then retry.');
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Local-only mode requires an Ollama URL on localhost, 127.0.0.1, or [::1]. Update Settings > LLM Provider.');
    }
  }
  return { baseUrl, model };
}

// Check if Ollama is running and list available models
export async function checkOllama(
  settings?: LLMSettings
): Promise<ProviderStatus> {
  if (!FEATURE_FLAGS.OLLAMA_ENABLED) {
    return { available: false, error: "Ollama disabled" };
  }

  try {
    const { baseUrl, model: preferredModel } = getOllamaSettings(settings);
    // Use IPC to fetch models from main process (bypasses potential CORS issues)
    const electron = (window as unknown as { electron: { llm: { fetchOllamaModels: (url: string) => Promise<{ success: boolean; models?: string[]; error?: string }> } } }).electron;
    if (!settings?.localOnly && electron?.llm?.fetchOllamaModels) {
      const result = await electron.llm.fetchOllamaModels(baseUrl);

      if (result.success && result.models && result.models.length > 0) {
        const defaultModel =
          result.models.find((m: string) => m.startsWith(preferredModel)) ||
          result.models[0] ||
          preferredModel;
        return {
          available: true,
          model: defaultModel,
          models: result.models,
        };
      } else if (result.error) {
        return { available: false, error: result.error };
      }
      return { available: false, error: "No models found" };
    }

    // Fallback to direct fetch if IPC not available (for development/testing)
    const response = await fetch(`${baseUrl}/api/tags`, settings?.localOnly ? { redirect: 'error', signal: AbortSignal.timeout(3000) } : undefined);
    if (response.ok) {
      const data = await response.json();
      const models = (data.models || []).map((m: { name: string }) => m.name);
      const localEntry = settings?.localOnly && (data.models || []).find((entry: { name: string }) =>
        entry.name === preferredModel || entry.name === `${preferredModel}:latest`);
      if (settings?.localOnly && (!localEntry || localEntry.remote_model || localEntry.remote_host ||
          !['gguf', 'ggml', 'safetensors', 'mlx'].includes(localEntry.details?.format))) {
        return { available: false, models, error: `Configured model "${preferredModel}" is not installed. Install it in Ollama, then retry.` };
      }
      const defaultModel =
        (settings?.localOnly ? preferredModel : models.find((m: string) => m.startsWith(preferredModel))) ||
        models[0] ||
        preferredModel;
      return {
        available: true,
        model: defaultModel,
        models: models,
      };
    }
    return { available: false, error: "Ollama not responding" };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "Ollama not running",
    };
  }
}

// Test Ollama connection with a specific model
export async function testOllamaConnection(
  baseUrl: string,
  model: string,
  localOnly = false
): Promise<{ success: boolean; error?: string }> {
  try {
    getOllamaSettings({ ollamaBaseUrl: baseUrl, ollamaModel: model, localOnly });
    if (localOnly) {
      const ready = await checkOllama({ localOnly, ollamaBaseUrl: baseUrl, ollamaModel: model });
      if (!ready.available) throw new Error(ready.error);
    }
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(localOnly ? { redirect: 'error' as const } : {}),
      body: JSON.stringify({
        model,
        prompt: "test",
        stream: false,
      }),
    });
    if (response.ok) {
      return { success: true };
    }
    const error = await response.json().catch(() => ({}));
    return { success: false, error: error.error || "Connection failed" };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

export // Call Ollama API
  async function callOllama(
    messages: LLMMessage[],
    tools?: LLMTool[],
    settings?: LLMSettings,
    abortSignal?: AbortSignal,
    _workspacePath?: string // New parameter
  ): Promise<LLMResponse> {
  const { baseUrl, model } = getOllamaSettings(settings);

  if (settings?.localOnly) {
    const ready = await checkOllama(settings);
    if (!ready.available) throw new Error(ready.error);
    abortSignal?.throwIfAborted();
  }
  console.log(`[LLM Chat] Calling Ollama at: ${baseUrl}/api/chat`);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: abortSignal,
    ...(settings?.localOnly ? { redirect: 'error' as const } : {}),
    body: JSON.stringify({
      model: model,
      messages: messages.map((m) => ({
        role: m.role,
        content: extractTextForLegacyProviders(m.content),
      })),
      stream: false,
      tools: tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    }),
  });

  if (!response || !response.ok) {
    if (response?.status === 404) {
      console.error(`[LLM Chat] 404 Error: Ollama endpoint not found at ${baseUrl}/api/chat`);
    }
    const error = response ? await response.json().catch(() => ({})) : { error: "Fetch failed" };
    throw new Error(error.error || `Ollama error: ${response?.statusText || "Unknown"}`);
  }

  const data = await response.json();

  return {
    content: data.message?.content || "",
    toolCalls: data.message?.tool_calls?.map(
      (tc: {
        function: { name: string; arguments: Record<string, unknown> };
      }) => ({
        id: `call_${Date.now()}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    ),
    provider: "ollama",
    model: model,
  };
}
