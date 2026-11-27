import { useState } from 'react'
import { Button } from './primitives/Button'
import type { ChatHistory } from '../lib/chat-history'
import { parseLegacyDataExport } from '../lib/legacy-data-import'
import { importLegacyData, rollbackLegacyData } from '../lib/legacy-data-migration'

type Props = {
  history: ChatHistory
  disabled?: boolean
  onImported: (sessionIds: string[]) => Promise<void>
  onRolledBack: (sessionIds: string[]) => Promise<void>
}

const MAX_EXPORT_BYTES = 18 * 1024 * 1024

export function LegacyDataImportPanel({ history, disabled = false, onImported, onRolledBack }: Props) {
  const [fileName, setFileName] = useState('')
  const [archive, setArchive] = useState<Awaited<ReturnType<typeof parseLegacyDataExport>> | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [understandsRollback, setUnderstandsRollback] = useState(false)

  const selectFile = async (file?: File) => {
    setArchive(null)
    setFileName('')
    setError('')
    setNotice('')
    setConfirmRollback(false)
    setUnderstandsRollback(false)
    if (!file) return
    if (file.size > MAX_EXPORT_BYTES) {
      setError('Export file must be 18 MB or smaller.')
      return
    }
    setBusy(true)
    try {
      const parsed = await parseLegacyDataExport(await file.text())
      setArchive(parsed)
      setFileName(file.name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This export could not be validated. No data was imported.')
    } finally {
      setBusy(false)
    }
  }

  const importArchive = async () => {
    if (!archive || busy || disabled) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await importLegacyData(history, archive.data)
      await onImported(result.targetSessionIds)
      setNotice(`Import complete: ${result.sessionsAdded} chats and ${result.turnsAdded} turns added. Repeating this import is safe.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import did not complete. Select the same export and retry safely.')
    } finally {
      setBusy(false)
    }
  }

  const removeImportedCopy = async () => {
    if (!archive || busy || disabled || !understandsRollback) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await rollbackLegacyData(history, archive.data)
      await onRolledBack(result.targetSessionIds)
      setNotice(`Removed ${result.sessionsRemoved} imported ${result.sessionsRemoved === 1 ? 'chat' : 'chats'}. The selected export file was not changed.`)
      setConfirmRollback(false)
      setUnderstandsRollback(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The imported copy was not removed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="legacy-import-heading" className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h3 id="legacy-import-heading" className="font-semibold">Bring chats from the full app</h3>
      <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
        Choose an AI-Worker Electron export JSON file. It is read locally, validated before import, and never uploaded. Existing Tauri chats are preserved. Import includes chat text only; appearance and speech preferences in the archive are not applied here.
      </p>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
        Excluded from this transfer: credentials, workspace grants and paths, tools and their results, attachments, MCP configuration, memory, browser profiles, linked accounts, and logs.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor="legacy-export-file">Export file</label>
        <input
          id="legacy-export-file"
          type="file"
          accept=".json,application/json"
          disabled={busy || disabled}
          onChange={(event) => { void selectFile(event.currentTarget.files?.[0]) }}
          className="max-w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-bg-dark)] file:px-3 file:py-2 file:text-[var(--color-text-primary)]"
        />
      </div>

      {busy && <p role="status" className="mt-3 text-sm text-[var(--color-text-secondary)]">Validating or updating local chat history…</p>}
      {archive && (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] p-4">
          <p className="break-all text-sm font-medium">{fileName}</p>
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <div><dt className="text-[var(--color-text-secondary)]">Chats</dt><dd>{archive.sessionCount}</dd></div>
            <div><dt className="text-[var(--color-text-secondary)]">Turns</dt><dd>{archive.turnCount}</dd></div>
            <div><dt className="text-[var(--color-text-secondary)]">Exported</dt><dd>{new Date(archive.data.exportedAt).toLocaleString()}</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => void importArchive()} disabled={busy || disabled || archive.sessionCount === 0}>
              Import {archive.sessionCount} {archive.sessionCount === 1 ? 'chat' : 'chats'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmRollback((value) => !value)} disabled={busy || disabled || archive.sessionCount === 0}>
              {confirmRollback ? 'Cancel removal' : 'Remove imported copy'}
            </Button>
          </div>
          {confirmRollback && (
            <div className="mt-4 rounded-lg border border-amber-500/40 p-4">
              <p className="text-sm text-amber-100">This removes the matching imported chat sessions, including any later turns added to those sessions. It does not change the original export file.</p>
              <label className="mt-3 flex items-start gap-2 text-xs">
                <input type="checkbox" checked={understandsRollback} disabled={busy} onChange={(event) => setUnderstandsRollback(event.target.checked)} className="mt-0.5" />
                <span>I understand these sessions and any later turns in them will be deleted.</span>
              </label>
              <Button type="button" variant="danger" size="sm" className="mt-3" onClick={() => void removeImportedCopy()} disabled={busy || disabled || !understandsRollback}>
                Remove imported chats
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-[var(--color-text-secondary)]">{notice}</p>}
      {disabled && <p role="status" className="mt-3 text-xs text-[var(--color-text-secondary)]">Finish the current local chat turn before changing history.</p>}
    </section>
  )
}
