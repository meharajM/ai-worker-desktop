import { LLMMessage, LLMSettings, LLMTool, LLMResponse } from "../types";
import { LLM_CONFIG, FEATURE_FLAGS } from "../constants";
import { ensureRecord, getEnvFallback } from "./utils";
import { ProviderStatus } from "./types";
import { fileUrlToBase64 } from "./utils";

const ANTHROPIC_VERSION = "2026-10-21";

async function getAnthropicSettings(settings?: LLMSettings) {
  const envModel = getEnvFallback("anthropic", "model");
  let apiKey = settings?.anthropicApiKey || "";
  if (!apiKey) {
    const electron = (await import("../electron")).default;
    apiKey = (await electron.secure.get("anthropic_api_key")).value || "";
  }
  const model = settings?.anthropicModel || envModel || LLM_CONFIG.ANTHROPIC.DEFAULT_MODEL;
  return { apiKey, model };
}

export async function checkAnthropic(settings?: LLMSettings): Promise<ProviderStatus> {
  if (settings?.localOnly) return { available: false, error: "Disabled in local-only mode" };
  if (!FEATURE_FLAGS.CLOUD_LLM_ENABLED) return { available: false, error: "Cloud LLM disabled" };

  const { apiKey, model } = await getAnthropicSettings(settings);
  if (!apiKey) return { available: false, error: "Anthropic API key not set" };

  try {
    const result = await window.electron?.llm.fetchAnthropicModels(apiKey);
    if (result?.success && result.models?.length) {
      return {
        available: true,
        model: result.models.includes(model) ? model : result.models[0],
        models: result.models,
        modelsEndpointAvailable: true,
      };
    }
    return {
      available: true,
      model,
      models: [model],
      modelsEndpointAvailable: false,
      error: result?.error || "Could not fetch Anthropic models",
    };
  } catch (error) {
    return {
      available: true,
      model,
      models: [model],
      modelsEndpointAvailable: false,
      error: error instanceof Error ? error.message : "Could not fetch Anthropic models",
    };
  }
}

function extensionMimeType(url: string): string {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/png";
}

async function anthropicImage(url: string): Promise<Record<string, unknown> | null> {
  let encoded = url;
  let mediaType = extensionMimeType(url);

  if (url.startsWith("file://")) {
    const base64 = await fileUrlToBase64(url);
    if (!base64) return null;
    encoded = base64;
  }

  const dataUri = encoded.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUri) {
    mediaType = dataUri[1];
    encoded = dataUri[2];
  } else if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
    return null;
  }

  return { type: "image", source: { type: "base64", media_type: mediaType, data: encoded } };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return ensureRecord(value);
  try {
    return ensureRecord(JSON.parse(value));
  } catch {
    return { _parse_error: "Invalid JSON arguments from model" };
  }
}

async function formatContent(content: LLMMessage["content"]): Promise<Record<string, unknown>[]> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else {
      const image = await anthropicImage(part.image_url.url);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

async function formatMessages(messages: LLMMessage[]): Promise<{ system: string; messages: Record<string, unknown>[] }> {
  const system: string[] = [];
  const formatted: Record<string, unknown>[] = [];
  const append = (role: "user" | "assistant", content: Record<string, unknown>[]) => {
    if (!content.length) return;
    const previous = formatted[formatted.length - 1];
    if (previous?.role === role && Array.isArray(previous.content)) {
      (previous.content as Record<string, unknown>[]).push(...content);
    } else {
      formatted.push({ role, content });
    }
  };

  for (const message of messages) {
    if (message.role === "system") {
      const value = typeof message.content === "string"
        ? message.content
        : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (value) system.push(value);
      continue;
    }

    if (message.role === "tool") {
      if (message.tool_call_id) {
        append("user", [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: typeof message.content === "string" ? message.content : await formatContent(message.content),
        }]);
      } else {
        append("user", await formatContent(message.content));
      }
      continue;
    }

    const blocks = await formatContent(message.content);
    if (message.role === "assistant") {
      const toolCalls = message.tool_calls || message.toolCalls?.map(call => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function?.name || call.name || "",
          arguments: call.function?.arguments ?? {},
        },
      }));
      for (const call of toolCalls || []) {
        if (!call.function?.name) continue;
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
    }
    append(message.role, blocks);
  }

  return { system: system.join("\n\n"), messages: formatted };
}

export async function callAnthropic(
  messages: LLMMessage[],
  tools?: LLMTool[],
  settings?: LLMSettings,
  abortSignal?: AbortSignal,
): Promise<LLMResponse> {
  if (settings?.localOnly) throw new Error("Anthropic is disabled in local-only mode");
  if (!FEATURE_FLAGS.CLOUD_LLM_ENABLED) throw new Error("Cloud LLM is disabled");

  const { apiKey, model } = await getAnthropicSettings(settings);
  if (!apiKey) throw new Error("Anthropic API key not configured");

  const formatted = await formatMessages(messages);
  const body = {
      model,
      max_tokens: 4096,
      ...(formatted.system ? { system: formatted.system } : {}),
      messages: formatted.messages,
      ...(tools?.length ? {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      } : {}),
  };
  let data: any;
  if (window.electron?.llm.anthropicChat) {
    const requestId = globalThis.crypto?.randomUUID?.() || `anthropic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (abortSignal?.aborted) throw new Error("Aborted by user");
    const cancel = () => { void window.electron?.llm.cancelAnthropicChat(requestId); };
    abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await window.electron.llm.anthropicChat(requestId, apiKey, body);
      if (!result.success) throw new Error(result.error || "Anthropic request failed");
      data = result.data || {};
    } finally {
      abortSignal?.removeEventListener("abort", cancel);
    }
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const cancel = () => controller.abort();
    abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `Anthropic error (${response.status}): ${response.statusText}`);
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", cancel);
    }
  }

  const contentBlocks = Array.isArray(data.content) ? data.content : [];
  const content = contentBlocks.filter((block: { type?: string }) => block.type === "text")
    .map((block: { text?: string }) => block.text || "").join("");
  const toolCalls = contentBlocks.filter((block: { type?: string }) => block.type === "tool_use")
    .map((block: { id: string; name: string; input: unknown }) => ({
      id: block.id,
      name: block.name,
      arguments: ensureRecord(block.input),
    }));

  return { content, toolCalls, provider: "anthropic", model };
}
