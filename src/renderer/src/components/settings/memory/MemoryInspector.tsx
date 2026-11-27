import React, { useState, useEffect } from 'react'
import { FileJson, FolderOpen, RefreshCw, Copy, Check, Download } from 'lucide-react'

const MAX_MEMORY_ARCHIVE_BYTES = 64 * 1024 * 1024

type MemoryExportData = {
    entities: unknown[]
    relations: unknown[]
    metadata?: Record<string, unknown>
}

export function assertMemoryArchiveSize(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Memory archive size is invalid.')
    if (bytes > MAX_MEMORY_ARCHIVE_BYTES) {
        throw new Error('Memory archive exceeds the 64 MiB limit. Export a smaller memory graph.')
    }
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const serialized = JSON.stringify(value)
        if (serialized === undefined) throw new Error('Memory export contains unsupported data.')
        return serialized
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
    }
    throw new Error('Memory export contains unsupported data.')
}

export async function serializeMemoryArchive(data: MemoryExportData): Promise<string> {
    if (!Array.isArray(data.entities) || !Array.isArray(data.relations) ||
        (data.metadata !== undefined && (data.metadata === null || typeof data.metadata !== 'object' || Array.isArray(data.metadata)))) {
        throw new Error('Memory export returned an invalid graph.')
    }

    const payload = {
        entities: data.entities,
        relations: data.relations,
        metadata: data.metadata ?? {},
    }
    const canonicalPayload = canonicalJson(payload)
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload))
    const contentSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    const exportedAt = typeof payload.metadata.exportedAt === 'string'
        ? payload.metadata.exportedAt
        : new Date().toISOString()
    const archive = {
        format: 'ai-worker-memory-export',
        schemaVersion: 1,
        exportedAt,
        migrationId: `sha256-${contentSha256}`,
        contentSha256,
        ...payload,
    }
    const serialized = JSON.stringify(archive)
    assertMemoryArchiveSize(new TextEncoder().encode(serialized).byteLength)
    return serialized
}

export function MemoryInspector() {
    const [data, setData] = useState<MemoryExportData | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState('')
    const [copied, setCopied] = useState(false)
    const [expanded, setExpanded] = useState(false)

    const loadData = async (): Promise<MemoryExportData | null> => {
        setLoading(true)
        setError(null)
        setNotice('')
        try {
            if (!window.electron?.memory) {
                throw new Error('Memory API not available')
            }
            const result = await window.electron.memory.exportAll()
            if (!result.success || !result.data || !Array.isArray(result.data.entities) || !Array.isArray(result.data.relations)) {
                throw new Error(result.error || 'Memory export returned an invalid graph.')
            }
            setData(result.data)
            return result.data
        } catch (err: any) {
            setError(err.message)
            return null
        } finally {
            setLoading(false)
        }
    }

    const handleExport = async () => {
        const exportData = await loadData()
        if (!exportData) return
        try {
            const contents = await serializeMemoryArchive(exportData)
            const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
            const link = document.createElement('a')
            link.href = url
            link.download = `ai-worker-memory-${new Date().toISOString().replaceAll(':', '-')}.json`
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.setTimeout(() => URL.revokeObjectURL(url), 0)
            setNotice('Memory archive downloaded. Keep this file as your local backup.')
        } catch (err: any) {
            setError(err.message || 'Memory archive could not be created.')
        }
    }

    const openFileLocation = async () => {
        if (!window.electron?.memory) return
        await window.electron.memory.openFileLocation()
    }

    const handleCopy = () => {
        if (data) {
            navigator.clipboard.writeText(JSON.stringify(data, null, 2))
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        }
    }

    return (
        <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FileJson className="text-[var(--color-brand-teal)]" size={20} />
                    <h3 className="font-medium text-[var(--color-text-primary)]">Data Inspector</h3>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => void handleExport()}
                        disabled={loading}
                        className="px-3 py-1.5 bg-[var(--color-brand-teal)]/10 text-[var(--color-brand-teal)] rounded-lg text-xs font-medium hover:bg-[var(--color-brand-teal)]/20 transition-colors disabled:opacity-50"
                    >
                        <span className="inline-flex items-center gap-1.5"><Download size={14} />{loading ? 'Preparing…' : 'Export memory'}</span>
                    </button>
                     <button
                        onClick={openFileLocation}
                        className="p-2 hover:bg-[var(--color-surface)] rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                        title="Open File Location"
                    >
                        <FolderOpen size={16} />
                    </button>
                    <button
                        onClick={() => {
                            if (!expanded) loadData()
                            setExpanded(!expanded)
                        }}
                        className="px-3 py-1.5 bg-[var(--color-brand-teal)]/10 text-[var(--color-brand-teal)] rounded-lg text-xs font-medium hover:bg-[var(--color-brand-teal)]/20 transition-colors"
                    >
                        {expanded ? 'Hide Data' : 'View Raw JSON'}
                    </button>
                </div>
            </div>

            {notice && <p role="status" className="px-4 py-2 text-xs text-[var(--color-success)]">{notice}</p>}
            {error && !expanded && <p role="alert" className="px-4 py-2 text-xs text-[var(--color-error)]">{error}</p>}

            {expanded && (
                <div className="p-0 bg-[var(--color-bg-dark)]">
                    <div className="flex items-center justify-end px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                        <button
                            onClick={loadData}
                            className="p-1.5 hover:bg-[var(--color-border)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                            title="Refresh"
                        >
                            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                        </button>
                        <button
                            onClick={handleCopy}
                            className="p-1.5 hover:bg-[var(--color-border)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors ml-2"
                            title="Copy JSON"
                        >
                            {copied ? <Check size={14} className="text-[var(--color-success)]" /> : <Copy size={14} />}
                        </button>
                    </div>
                    
                    <div className="p-4 overflow-auto max-h-[400px] text-xs font-mono">
                        {loading ? (
                            <div className="text-[var(--color-text-muted)] text-center py-8">Loading memory data...</div>
                        ) : error ? (
                            <div className="text-[var(--color-error)] p-2">{error}</div>
                        ) : (
                            <pre className="text-[var(--color-text-primary)]">
                                {JSON.stringify(data, null, 2)}
                            </pre>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
