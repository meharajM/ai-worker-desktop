import React, { useState } from 'react'
import { Loader2, Plus, Search } from 'lucide-react'
import { MCPServer } from '../../stores/mcpStore'

type RegistryEntry = NonNullable<Awaited<ReturnType<NonNullable<typeof window.electron>['mcp']['searchRegistry']>>['servers']>[number]
type NewServerConfig = Omit<MCPServer, 'id' | 'connected' | 'tools' | 'autoConnect'>

interface McpRegistryBrowserProps {
    configuredNames: string[]
    onAdd: (config: NewServerConfig) => Promise<void>
}

export function McpRegistryBrowser({ configuredNames, onAdd }: McpRegistryBrowserProps) {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<RegistryEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string>()
    const [adding, setAdding] = useState<string>()
    const [added, setAdded] = useState<string[]>([])

    const configured = new Set([...configuredNames, ...added].map(name => name.toLowerCase()))

    async function search() {
        const term = query.trim()
        if (term.length < 3) return
        setLoading(true)
        setError(undefined)
        try {
            const result = await window.electron?.mcp.searchRegistry(term)
            if (!result?.success) throw new Error(result?.error || 'MCP Registry search is unavailable')
            setResults(result.servers || [])
        } catch (err) {
            setError(err instanceof Error ? err.message : 'MCP Registry search failed')
            setResults([])
        } finally {
            setLoading(false)
        }
    }

    async function addServer(server: RegistryEntry) {
        if (!server.configuration) return
        setAdding(server.name)
        setError(undefined)
        const description = [
            server.description,
            `Registry listing · version ${server.version}`,
            server.requirements.length ? `Required environment values: ${server.requirements.join(', ')}. Edit this connection before connecting.` : '',
            server.repositoryUrl ? `Source: ${server.repositoryUrl}` : '',
        ].filter(Boolean).join('\n')
        try {
            await onAdd({
                name: server.name,
                description,
                type: server.configuration.type,
                command: server.configuration.command,
                args: server.configuration.args,
                url: server.configuration.url,
                env: undefined,
            })
            setAdded(current => [...current, server.name])
        } catch (err) {
            setError(err instanceof Error ? err.message : `Could not add ${server.name}`)
        } finally {
            setAdding(undefined)
        }
    }

    return (
        <section className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-elevated)] p-4">
            <div className="mb-3">
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Official MCP Registry</h3>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Search active listings. Add saves configuration; connecting may download and run third-party code under your user account. Review the source first.
                </p>
            </div>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search() }}>
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search servers, e.g. filesystem"
                    aria-label="Search the MCP Registry"
                    maxLength={80}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                />
                <button
                    type="submit"
                    disabled={loading || query.trim().length < 3}
                    className="flex items-center gap-2 rounded-lg bg-[var(--color-brand-teal)] px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                    Search
                </button>
            </form>
            {query.trim().length > 0 && query.trim().length < 3 && <p className="mt-2 text-xs text-[var(--color-text-dim)]">Enter at least 3 characters.</p>}
            {error && <p role="alert" className="mt-3 text-xs text-[var(--color-error)]">{error}</p>}
            {results.length > 0 && (
                <div className="mt-4 space-y-3">
                    {results.map(server => {
                        const isAdded = configured.has(server.name.toLowerCase())
                        return (
                            <article key={`${server.name}@${server.version}`} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <h4 className="break-all text-sm font-medium text-[var(--color-text-primary)]">{server.name}</h4>
                                        <p className="mt-0.5 text-[10px] text-[var(--color-text-dim)]">Active listing · {server.version}</p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={!server.configuration || isAdded || adding === server.name}
                                        onClick={() => void addServer(server)}
                                        className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-brand-teal)]/30 px-2.5 py-1.5 text-xs text-[var(--color-brand-teal)] disabled:opacity-40"
                                    >
                                        {adding === server.name ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                                        {isAdded ? 'Added' : server.configuration ? 'Add' : 'Unsupported'}
                                    </button>
                                </div>
                                {server.description && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{server.description}</p>}
                                {server.requirements.length > 0 && <p className="mt-2 text-xs text-[var(--color-warning)]">Needs setup: {server.requirements.join(', ')}</p>}
                                {server.repositoryUrl && (
                                    <button
                                        type="button"
                                        onClick={() => { void window.electron?.shell?.openExternal(server.repositoryUrl!) }}
                                        className="mt-2 text-xs text-[var(--color-brand-teal)] hover:underline"
                                    >View source</button>
                                )}
                                {!server.configuration && <p className="mt-2 text-xs text-[var(--color-text-dim)]">This listing uses an install or authentication method not supported by this app.</p>}
                            </article>
                        )
                    })}
                </div>
            )}
            {!loading && !error && results.length === 0 && query.trim().length >= 3 && <p className="mt-3 text-xs text-[var(--color-text-dim)]">No active supported listings found. Try a broader search.</p>}
        </section>
    )
}
