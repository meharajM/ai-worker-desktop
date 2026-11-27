import { useMcpStore, MCPServer, MCPTool } from "../stores/mcpStore";
import electron from "./electron";
import { useWhatsAppStore } from "../stores/whatsappStore";

/// <reference path="../env.d.ts" />

// Get all servers - FROM STORE
export function getServers(): MCPServer[] {
  return useMcpStore.getState().servers;
}

// Disconnect from a server - Delegated to store
export async function disconnectServer(serverId: string): Promise<void> {
  return useMcpStore.getState().disconnectServer(serverId);
}

// Get all available tools - FROM STORE
export function getAllTools(): MCPTool[] {
  return useMcpStore.getState().getAllTools();
}

// Find which server a tool belongs to - FROM STORE
export function findServerForTool(toolName: string): MCPServer | null {
  return useMcpStore.getState().findServerForTool(toolName);
}

// Logging utility for renderer process
function logMcpRenderer(
  level: "info" | "warn" | "error",
  message: string,
  context: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();

  const logMessage = `[MCP Renderer ${level.toUpperCase()}] ${timestamp} - ${message}`;

  switch (level) {
    case "error":
      console.error(logMessage, context);
      break;
    case "warn":
      console.warn(logMessage, context);
      break;
    default:
      console.log(logMessage, context);
  }
}

// Sanitize arguments for logging (remove sensitive data)
function sanitizeArgsForLogging(
  args: Record<string, unknown>
): Record<string, unknown> {
  const sanitized = { ...args };
  const sensitiveKeys = [
    "password",
    "apiKey",
    "token",
    "secret",
    "key",
    "auth",
  ];

  for (const key in sanitized) {
    if (
      sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))
    ) {
      sanitized[key] = "***REDACTED***";
    } else if (typeof sanitized[key] === "object" && sanitized[key] !== null) {
      sanitized[key] = sanitizeArgsForLogging(
        sanitized[key] as Record<string, unknown>
      );
    }
  }

  return sanitized;
}

// Helper to ensure args is a record
function ensureRecord(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return args || {};
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function normalizeAbsoluteFsPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let normalized = trimmed.replace(/\\/g, '/');
  let root = '';

  if (/^[a-zA-Z]:\//.test(normalized)) {
    root = normalized.slice(0, 2).toLowerCase();
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('/')) {
    root = '/';
  } else {
    return null;
  }

  const stack: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  if (root === '/') return `/${stack.join('/')}`;
  return stack.length > 0 ? `${root}/${stack.join('/')}` : `${root}/`;
}

function resolveFsPath(baseAbsolutePath: string, targetPath: string): string | null {
  const normalizedBase = normalizeAbsoluteFsPath(baseAbsolutePath);
  if (!normalizedBase) return null;

  const rawTarget = targetPath.trim();
  if (!rawTarget) return normalizedBase;

  if (isAbsolutePath(rawTarget)) {
    return normalizeAbsoluteFsPath(rawTarget);
  }

  const normalizedRelative = rawTarget.replace(/\\/g, '/');
  let root = '';
  let tail = '';

  if (/^[a-zA-Z]:\//.test(normalizedBase)) {
    root = normalizedBase.slice(0, 2).toLowerCase();
    tail = normalizedBase.slice(2);
  } else if (normalizedBase.startsWith('/')) {
    root = '/';
    tail = normalizedBase.slice(1);
  } else {
    return null;
  }

  const stack = tail.split('/').filter(Boolean);
  for (const part of normalizedRelative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  if (root === '/') return `/${stack.join('/')}`;
  return stack.length > 0 ? `${root}/${stack.join('/')}` : `${root}/`;
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = normalizeAbsoluteFsPath(rootPath);
  const normalizedTarget = normalizeAbsoluteFsPath(targetPath);
  if (!normalizedRoot || !normalizedTarget) return false;
  const rootComparable = (normalizedRoot.replace(/\/+$/, '') || '/').toLowerCase();
  const targetComparable = (normalizedTarget.replace(/\/+$/, '') || '/').toLowerCase();
  return (
    targetComparable === rootComparable ||
    targetComparable.startsWith(`${rootComparable}/`)
  );
}

// Execute tools only on explicitly connected servers.

// ── MCP Idle Disconnect Timers ──────────────────────────────────────────────────
// Automatically disconnect backend processes (Node/Python) after 10m of inactivity
// to ensure idle agents don't consume gigabytes of background RAM.
const mcpIdleTimers = new Map<string, NodeJS.Timeout>();
const MCP_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function resetMcpIdleTimer(serverId: string, serverName: string) {
  const existing = mcpIdleTimers.get(serverId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    logMcpRenderer("info", `Disconnecting server ${serverName} due to ${MCP_IDLE_TIMEOUT_MS / 60000}m of inactivity...`, { serverId, serverName });
    try {
      await disconnectServer(serverId);
    } catch (err) {
      logMcpRenderer("warn", `Failed to idle-disconnect server ${serverName}`, { error: String(err) });
    }
  }, MCP_IDLE_TIMEOUT_MS);

  mcpIdleTimers.set(serverId, timer);
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown> | null | undefined
): Promise<{ result: unknown; error?: string }> {
  const startTime = Date.now();
  const safeArgs = ensureRecord(args);
  const sanitizedArgs = sanitizeArgsForLogging(safeArgs);

  logMcpRenderer("info", `Tool call initiated: ${toolName}`, {
    operation: "executeToolCall",
    toolName,
    args: sanitizedArgs,
    argsSize: JSON.stringify(safeArgs).length,
  });

  console.log(`[MCP Renderer] Invoking Tool: ${toolName}`, sanitizedArgs);

  // VALIDATION: convert_to_markdown requires an absolute URI or path.
  // Accepts: file:///absolute/path, /absolute/path, C:\absolute\path
  // Rejects: file://relative, bare-filename.ext (no leading slash or drive letter)
  if (toolName === 'convert_to_markdown') {
    const uri = (args?.uri || args?.path) as string | undefined;

    // Guard against completely empty URI (file.path was "" on the attachment)
    if (!uri || uri.trim() === '' || uri === 'file://' || uri === 'file:') {
      return {
        result: null,
        error: `PATH ERROR: URI is empty. The attached file did not expose a native filesystem path. ` +
          `Check the [ATTACHED FILES] block in this conversation for the exact uri= argument to use.`
      };
    }

    if (typeof uri === 'string') {
      // Accept: file:///absolute, file:// immediately followed by '/' (Unix), bare /absolute, C:\...
      // uri[7] must be '/' — catches file://filename (relative, no leading slash after //)
      // and file:// (empty path, caught above but doubled here for safety).
      const isAbsolute =
        uri.startsWith('file:///') ||
        uri.startsWith('file:////') ||
        (uri.startsWith('file://') && uri[7] === '/') ||
        uri.startsWith('/') ||
        !!uri.match(/^[a-zA-Z]:[\\/]/);

      const isRelativeFileUri =
        uri.startsWith('file:') &&
        !uri.startsWith('file:///') &&
        !uri.startsWith('file:////') &&
        !(uri.startsWith('file://') && uri[7] === '/');

      if (!isAbsolute || isRelativeFileUri) {
        return {
          result: null,
          error:
            `PATH ERROR: '${uri}' is not an absolute file URI. ` +
            `You must copy the uri= value CHARACTER-FOR-CHARACTER from the ` +
            `[ATTACHED FILES] block — do NOT reconstruct it from the filename alone. ` +
            `The correct format is: file:///Users/username/path/to/file.ext`
        };
      }
    }
  }


  if (toolName.startsWith('fs_')) {
    const wsPath = args?.workspacePath as string | undefined;
    if (!wsPath) {
      return {
        result: null,
        error: 'WORKSPACE REQUIRED: Select a workspace folder before using filesystem tools.'
      };
    }
    const normalizedWorkspacePath = normalizeAbsoluteFsPath(wsPath);
    if (!normalizedWorkspacePath) {
      return {
        result: null,
        error: `WORKSPACE REQUIRED: Invalid workspace path '${wsPath}'.`
      };
    }

    const userHomePath = await electron.getHomePath();
    if (!userHomePath || !isPathWithin(userHomePath, normalizedWorkspacePath)) {
      return {
        result: null,
        error: `WORKSPACE REQUIRED: Workspace must be inside your user home folder (${userHomePath || 'unavailable'}).`
      };
    }
    (args as Record<string, unknown>).workspacePath = normalizedWorkspacePath;

    const rawTargetPath = args?.path as string | undefined;
    if (rawTargetPath && rawTargetPath.trim() !== '') {
      const resolvedTargetPath = resolveFsPath(normalizedWorkspacePath, rawTargetPath);
      if (!resolvedTargetPath) {
        return {
          result: null,
          error: `SECURITY VIOLATION: Invalid path '${rawTargetPath}'.`
        };
      }

      if (!isPathWithin(normalizedWorkspacePath, resolvedTargetPath)) {
        return {
          result: null,
          error: `SECURITY VIOLATION: Access denied. Path '${resolvedTargetPath}' is outside the active workspace '${normalizedWorkspacePath}'.`
        };
      }

      (args as Record<string, unknown>).path = resolvedTargetPath;
    }
  }


  const server = findServerForTool(toolName);
  if (!server) {
    // FALLBACK: Check if it's an internal WhatsApp tool
    if (toolName.startsWith('whatsapp_')) {
      logMcpRenderer("info", "Executing whatsapp tool via direct IPC fallback", { tool: toolName });
      try {
        // Automatically resolve the target number
        const targetJid = (safeArgs?.to as string) || useWhatsAppStore.getState().connectionState.phoneNumber;
        if (!targetJid) {
          return { result: null, error: "Missing 'to' parameter: Target WhatsApp number could not be resolved automatically." };
        }

        if (toolName === 'whatsapp_send_media') {
          const filePath = safeArgs?.filePath as string;
          if (!filePath) return { result: null, error: "Missing 'filePath' parameter." };
          
          const result = await electron.whatsapp.sendMediaMessage(
            targetJid,
            filePath,
            safeArgs?.caption as string | undefined,
            safeArgs?.type as string | undefined
          ) as { success: boolean; error?: string };
          
          if (result && result.error) return { result: null, error: result.error };
          return { result: "Media sent successfully." };
          
        } else if (toolName === 'whatsapp_send_message') {
          const content = safeArgs?.content as string;
          if (!content) return { result: null, error: "Missing 'content' parameter." };
          
          const result = await electron.whatsapp.sendMessage(targetJid, content) as { success: boolean; error?: string };
          
          if (result && result.error) return { result: null, error: result.error };
          return { result: "Message sent successfully." };
        }
      } catch (err) {
        return { result: null, error: `Direct whatsapp tool call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const duration = Date.now() - startTime;
    logMcpRenderer("error", "Tool not found in any connected server", {
      operation: "executeToolCall",
      toolName,
      duration,
    });

    return {
      result: null,
      error: `Tool ${toolName} not found in any connected server`,
    };
  }

  if (!server.connected) {
    return { result: null, error: `Connect ${server.name} in Connections before using its tools.` };
  }

  resetMcpIdleTimer(server.id, server.name);

  try {
    const result = (await electron.mcp.callTool(server.id, toolName, safeArgs)) as {
      result: unknown;
      error?: string;
    };
    if (result.error && /-32000|connection closed|ECONNRESET|EPIPE/i.test(result.error)) {
      useMcpStore.getState().updateServerState(server.id, {
        connected: false,
        error: "Connection closed unexpectedly. Reconnect in Connections."
      });
    }
    return result;
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Tool execution failed",
    };
  }
}

/**
 * Parses a tabId from a `new_tab` tool result.
 *
 * The MCP IPC layer wraps all in-process tool results in the standard MCP
 * content envelope: `{ result: { content: [{ type: 'text', text: '{"tabId":1}' }] } }`
 * This utility handles that format plus a raw-object fallback for robustness.
 *
 * @param toolResult - The raw result returned by `executeToolCall('new_tab', ...)`
 * @returns The numeric tabId, or undefined if it cannot be parsed.
 */
export function parseTabIdFromResult(toolResult: { result: unknown }): number | undefined {
  const resAny = toolResult.result as Record<string, unknown> | null | undefined;

  // Primary path: standard MCP content envelope
  if (resAny?.content && Array.isArray(resAny.content) && (resAny.content[0] as Record<string, unknown>)?.text) {
    try {
      const parsed = JSON.parse((resAny.content[0] as Record<string, unknown>).text as string);
      if (typeof parsed.tabId === 'number') return parsed.tabId;
    } catch {
      console.warn('[MCP] parseTabIdFromResult: failed to JSON-parse content[0].text:', (resAny.content[0] as Record<string, unknown>).text);
    }
  }

  // Fallback: tool returned raw object (e.g. in tests or non-wrapped contexts)
  if (typeof resAny?.tabId === 'number') return resAny.tabId;

  return undefined;
}

type ParsedTab = {
  index: number;
  title?: string;
  url?: string;
  active?: boolean;
};

/**
 * Parses tab lists from a `get_tabs` tool result.
 * Supports both MCP content envelope and raw object result.
 */
export function parseTabsFromResult(toolResult: { result: unknown }): ParsedTab[] {
  const resAny = toolResult.result as Record<string, unknown> | null | undefined;

  const normalize = (value: unknown): ParsedTab[] => {
    if (!value || typeof value !== "object") return [];
    const tabs = (value as { tabs?: unknown[] }).tabs;
    if (!Array.isArray(tabs)) return [];
    return tabs
      .map((tab): ParsedTab | null => {
        if (!tab || typeof tab !== "object") return null;
        const t = tab as Record<string, unknown>;
        const index = typeof t.index === "number" ? t.index : undefined;
        if (index === undefined) return null;
        return {
          index,
          title: typeof t.title === "string" ? t.title : undefined,
          url: typeof t.url === "string" ? t.url : undefined,
          active: typeof t.active === "boolean" ? t.active : undefined,
        };
      })
      .filter((tab): tab is ParsedTab => tab !== null);
  };

  // Primary path: MCP content envelope
  if (resAny?.content && Array.isArray(resAny.content) && (resAny.content[0] as Record<string, unknown>)?.text) {
    try {
      const parsed = JSON.parse((resAny.content[0] as Record<string, unknown>).text as string);
      const tabs = normalize(parsed);
      if (tabs.length > 0) return tabs;
    } catch {
      // ignore and fall through
    }
  }

  // Fallback: raw object
  return normalize(resAny);
}
