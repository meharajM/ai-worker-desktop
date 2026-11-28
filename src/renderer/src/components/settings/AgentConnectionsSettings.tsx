import { useCallback, useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { Check, CircleHelp, Loader2, PlugZap, RefreshCw, Unplug } from 'lucide-react'

type AgentClientStatus = {
  id: string
  name: string
  installed: boolean
  connected: boolean
  configPath: string
}

export function AgentConnectionsSettings() {
  const [clients, setClients] = useState<AgentClientStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [workingClient, setWorkingClient] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setError('Agent connections are available in the installed desktop app.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      setClients(await invoke<AgentClientStatus[]>('list_agent_clients'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not scan agent configurations.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function toggle(client: AgentClientStatus) {
    setWorkingClient(client.id)
    setMessage('')
    setError('')
    try {
      const command = client.connected ? 'disconnect_agent_client' : 'connect_agent_client'
      const updated = await invoke<AgentClientStatus>(command, { clientId: client.id })
      setClients(current => current.map(item => item.id === updated.id ? updated : item))
      setMessage(client.connected
        ? `Removed AI-Worker from ${client.name}.`
        : `Connected ${client.name}. Restart that agent to load AI-Worker's tools.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not update ${client.name}.`)
    } finally {
      setWorkingClient(null)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold mb-2">AI agent connections</h3>
          <p className="text-sm text-[var(--color-text-muted)]">
            Add AI-Worker as a local MCP server in the agents you use. No Node.js install or manual path copying is needed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Scan for AI agents"
          className="shrink-0 rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card-elevated)] p-4 text-sm text-[var(--color-text-secondary)] space-y-2">
        <p><strong className="text-[var(--color-text-primary)]">What this changes:</strong> AI-Worker adds one MCP server entry to the selected agent's user config. Existing entries stay in place.</p>
        <p>After connecting, restart that agent. It can send selected task prompts and results through AI-Worker; project writes pause for your approval in the desktop app.</p>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card-elevated)] p-4">
        <p className="mb-2 text-xs font-semibold text-[var(--color-text-primary)]">Try this in your agent</p>
        <p className="select-text text-xs leading-relaxed text-[var(--color-text-secondary)]">
          Use AI-Worker's <code>start_agent_task</code> for this request. Pass the active project root as <code>workspaceRoot</code>, include <code>capabilities:["workspace"]</code>, and send my full request. Poll <code>get_agent_task</code> until it finishes. Relay any question. If it waits for approval, ask me to review AI-Worker. Return the result and source paths.
        </p>
      </div>

      {message && <p role="status" className="text-sm text-[var(--color-success)]">{message}</p>}
      {error && <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p>}

      <div className="space-y-3">
        {clients.map(client => (
          <div key={client.id} className="flex items-center justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-elevated)] p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-[var(--color-text-primary)]">{client.name}</p>
                {client.connected && <Check size={15} className="text-[var(--color-success)]" aria-label="Connected" />}
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {client.connected
                  ? `Connected · ${client.configPath}`
                  : client.installed
                    ? `Detected · ${client.configPath}`
                    : `Not detected · will add config at ${client.configPath}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void toggle(client)}
              disabled={loading || workingClient !== null}
              className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${client.connected
                ? 'border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]'
                : 'bg-[var(--color-primary)] text-[var(--color-text-inverse)] hover:opacity-90'
              }`}
            >
              {workingClient === client.id
                ? <Loader2 size={14} className="animate-spin" />
                : client.connected ? <Unplug size={14} /> : <PlugZap size={14} />}
              {client.connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        ))}
        {!loading && clients.length === 0 && !error && (
          <p className="rounded-xl border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">No supported agent profiles are available on this device.</p>
        )}
      </div>

      <a
        href="https://github.com/meharajM/ai-worker-desktop/blob/main/docs/AI_WORKER_READINESS_MCP.md"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      >
        <CircleHelp size={14} /> Manual setup and other MCP clients
      </a>
      <p className="text-xs text-[var(--color-text-dim)]">ChatGPT web and other remote-only clients need an HTTPS MCP endpoint. This local installer does not create or expose a remote tunnel.</p>
    </div>
  )
}
