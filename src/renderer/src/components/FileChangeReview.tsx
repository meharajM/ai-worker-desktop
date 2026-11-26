import React, { useEffect, useMemo, useState } from 'react'
import { FileText, Check, X, AlertTriangle, RefreshCw, Clock3 } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'

interface FileChange {
    id: string
    originalPath: string
    shadowPath: string
    type: 'create' | 'modify' | 'delete'
    content?: string
    timestamp: number
}

interface ExternalReview {
    detail: string
    onApprove: () => void
    onReject: () => void
}

// Delegated proposals are immutable in main-process memory and expire with their task.
// Their approval is bound to a single task and step, independent of the active chat.
export const FileChangeReview = ({ external }: { external?: ExternalReview }) => {
    if (!external) return <ChatFileChangeReview />
    const proposal = JSON.parse(external.detail) as { file: string; previous: string | null; proposed: string }
    return <section aria-label="Review pending external file write">
        <h3 className="font-semibold break-all">{proposal.file}</h3>
        {[['Current content', proposal.previous ?? '(new file)'], ['Proposed content', proposal.proposed]].map(([label, content]) =>
            <div key={label} className="mt-3"><h4>{label}</h4>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border p-2">{content}</pre>
            </div>)}
        <div className="flex gap-3 mt-4">
            <button className="rounded border px-3 py-2" onClick={external.onReject}>Reject file change</button>
            <button className="rounded bg-emerald-700 text-white px-3 py-2" onClick={external.onApprove}>Approve file change</button>
        </div>
    </section>
}

const ChatFileChangeReview: React.FC = () => {
    const [changes, setChanges] = useState<FileChange[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const { activeSessionId } = useChatStore()

    const fetchChanges = async () => {
        setIsLoading(true)
        try {
            const pending = await window?.electron?.fs.getPendingChanges(activeSessionId || 'default')
            if (pending) {
                setChanges(pending)
            }
        } catch (error) {
            console.error('Failed to fetch changes:', error)
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        fetchChanges()
        // Poll for changes every 2 seconds
        const interval = setInterval(fetchChanges, 2000)
        return () => clearInterval(interval)
    }, [activeSessionId])

    const handleApprove = async (id: string) => {
        try {
            const result = await window?.electron?.fs.approveChange(id)
            if (!result?.success) throw new Error(result?.error || 'Failed to approve change')
            setChanges(prev => prev.filter(c => c.id !== id))
        } catch (error) {
            console.error('Failed to approve change:', error)
        }
    }

    const handleReject = async (id: string) => {
        try {
            const result = await window?.electron?.fs.rejectChange(id)
            if (!result?.success) throw new Error(result?.error || 'Failed to reject change')
            setChanges(prev => prev.filter(c => c.id !== id))
        } catch (error) {
            console.error('Failed to reject change:', error)
        }
    }

    const sortedChanges = useMemo(
        () => [...changes].sort((a, b) => b.timestamp - a.timestamp),
        [changes]
    )

    if (changes.length === 0) return null

    return (
        <div className="fixed bottom-4 right-4 z-50 w-[30rem] max-w-[calc(100vw-1.5rem)]">
            <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-elevated)] shadow-2xl">
                <div className="border-b border-[var(--color-border)] bg-gradient-to-r from-amber-400/15 to-transparent px-4 py-3">
                    <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-300" />
                        <div className="flex-1">
                            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                                Review Pending File Writes
                            </h3>
                            <p className="text-[11px] text-[var(--color-text-muted)]">
                                {changes.length} change{changes.length === 1 ? '' : 's'} waiting for approval
                            </p>
                        </div>
                        <button
                            onClick={fetchChanges}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
                            disabled={isLoading}
                            title="Refresh"
                        >
                            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                <div className="max-h-[68vh] space-y-3 overflow-y-auto p-3">
                    {sortedChanges.map(change => (
                        <div
                            key={change.id}
                            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-3"
                        >
                            <div className="flex items-start gap-3">
                                <div className="mt-0.5 rounded-lg bg-[var(--color-surface)] p-2">
                                    <FileText className="h-4 w-4 text-[var(--color-text-muted)]" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div
                                        className="truncate text-sm font-medium text-[var(--color-text-primary)]"
                                        title={change.originalPath}
                                    >
                                        {change.originalPath.split(/[\\/]/).pop() || change.originalPath}
                                    </div>
                                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-dim)]">
                                        {change.originalPath}
                                    </div>
                                    <div className="mt-2 flex items-center gap-2">
                                        <span
                                            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${change.type === 'create'
                                                ? 'bg-emerald-500/15 text-emerald-300'
                                                : change.type === 'delete'
                                                    ? 'bg-red-500/15 text-red-300'
                                                    : 'bg-amber-500/15 text-amber-300'
                                                }`}
                                        >
                                            {change.type}
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-dim)]">
                                            <Clock3 className="h-3 w-3" />
                                            {new Date(change.timestamp).toLocaleTimeString()}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {change.content && (
                                <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] leading-4 text-[var(--color-text-secondary)]">
                                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">
                                        {change.content.substring(0, 320)}
                                        {change.content.length > 320 && '...'}
                                    </pre>
                                </div>
                            )}

                            <div className="mt-3 flex gap-2">
                                <button
                                    onClick={() => handleApprove(change.id)}
                                    className="flex-1 rounded-md border border-emerald-500/35 bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/30"
                                >
                                    <span className="inline-flex items-center gap-1">
                                        <Check className="h-3.5 w-3.5" />
                                        Approve
                                    </span>
                                </button>
                                <button
                                    onClick={() => handleReject(change.id)}
                                    className="flex-1 rounded-md border border-red-500/35 bg-red-500/20 px-3 py-2 text-xs font-medium text-red-100 transition hover:bg-red-500/30"
                                >
                                    <span className="inline-flex items-center gap-1">
                                        <X className="h-3.5 w-3.5" />
                                        Reject
                                    </span>
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
