import { useCallback, useEffect, useState } from 'react'
import { Button } from './components/primitives/Button'
import { DesktopBridgeError, writeApprovalBridge, type PendingWriteApproval } from './desktop-bridge'

function safeMessage(error: unknown) {
  return error instanceof DesktopBridgeError && error.code === 'unavailable'
    ? 'This review is only available inside AI-Worker.'
    : 'The write request expired or is no longer available. Close this window and retry the task.'
}

function displayPath(proposal: PendingWriteApproval) {
  const root = proposal.workspaceRoot.replace(/[\\/]+$/, '')
  return `${root}/${proposal.relativePath.replace(/\\/g, '/')}`
}

function ContentPreview({ title, content }: { title: string; content: string }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-dark)] p-3 text-xs leading-5">
        {content || <span className="italic text-[var(--color-text-secondary)]">Empty file</span>}
      </pre>
    </section>
  )
}

export function WriteApprovalWindow() {
  const [proposal, setProposal] = useState<PendingWriteApproval | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadProposal = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setProposal(await writeApprovalBridge.getPendingWriteApproval())
    } catch (reason) {
      setProposal(null)
      setError(safeMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadProposal() }, [loadProposal])

  async function decide(approved: boolean) {
    if (!proposal || busy) return
    setBusy(true)
    setError('')
    try {
      await writeApprovalBridge.resolveWriteApproval(proposal.taskId, proposal.approvalId, approved)
      setNotice(approved ? 'Approved. AI-Worker will apply this file change.' : 'Declined. AI-Worker will not write this file.')
    } catch (reason) {
      setError(safeMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen overflow-auto bg-[var(--color-bg-dark)] p-5 text-[var(--color-text-primary)]">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <header>
          <h1 className="text-lg font-semibold">Review file change</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            AI-Worker can read selected workspace files without prompts. It needs your approval before writing. Approval applies the exact proposed text shown below.
          </p>
        </header>

        {loading && <p role="status">Loading write request…</p>}
        {!loading && !proposal && !error && (
          <div className="rounded-lg border border-[var(--color-border)] p-4">
            <p role="status">No file change is waiting for approval.</p>
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadProposal()}>
              Check again
            </Button>
          </div>
        )}
        {proposal && (
          <>
            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <h2 className="text-xs font-medium text-[var(--color-text-secondary)]">Task being handed off</h2>
              <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-sm">{proposal.taskPrompt}</p>
              {proposal.handoffContext && (
                <dl className="mt-3 grid gap-2 border-t border-[var(--color-border)] pt-3 text-xs">
                  {proposal.handoffContext.sourceAgent && <div><dt className="text-[var(--color-text-secondary)]">Source agent</dt><dd>{proposal.handoffContext.sourceAgent}</dd></div>}
                  {proposal.handoffContext.summary && <div><dt className="text-[var(--color-text-secondary)]">Summary</dt><dd className="whitespace-pre-wrap">{proposal.handoffContext.summary}</dd></div>}
                  {proposal.handoffContext.constraints?.length ? <div><dt className="text-[var(--color-text-secondary)]">Constraints</dt><dd>{proposal.handoffContext.constraints.join(' · ')}</dd></div> : null}
                  {proposal.handoffContext.workingDirectory && <div><dt className="text-[var(--color-text-secondary)]">Working directory</dt><dd className="break-all font-mono">{proposal.handoffContext.workingDirectory}</dd></div>}
                  {proposal.handoffContext.relevantFiles?.length ? <div><dt className="text-[var(--color-text-secondary)]">Relevant files</dt><dd className="break-all font-mono">{proposal.handoffContext.relevantFiles.join(', ')}</dd></div> : null}
                </dl>
              )}
            </section>

            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <h2 className="text-xs font-medium text-[var(--color-text-secondary)]">File</h2>
              <p className="mt-1 break-all font-mono text-xs">{displayPath(proposal)}</p>
              {proposal.before === null && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">New file · no existing contents</p>}
            </section>

            <div className="grid gap-3 sm:grid-cols-2">
              {proposal.before !== null && <ContentPreview title="Current contents" content={proposal.before} />}
              <ContentPreview title={proposal.before === null ? 'New file contents' : 'Proposed contents'} content={proposal.proposed} />
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border)] pt-3">
              <Button type="button" variant="danger" onClick={() => void decide(false)} disabled={busy}>
                {busy ? 'Sending…' : 'Decline write'}
              </Button>
              <Button type="button" onClick={() => void decide(true)} disabled={busy}>
                {busy ? 'Sending…' : 'Approve write'}
              </Button>
            </div>
          </>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/40 p-3 text-sm">
            <p role="alert">{error}</p>
            {!proposal && <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadProposal()}>Check again</Button>}
          </div>
        )}
        {notice && <p role="status" aria-live="polite" className="rounded-lg border border-[var(--color-border)] p-3 text-sm">{notice}</p>}
      </div>
    </main>
  )
}
