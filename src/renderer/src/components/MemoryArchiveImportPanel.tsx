import { useState } from 'react'
import { Button } from './primitives/Button'
import { DesktopBridgeError, desktopBridge, type MemoryArchivePreview } from '../desktop-bridge'

const MAX_MEMORY_ARCHIVE_BYTES = 64 * 1024 * 1024

export function MemoryArchiveImportPanel() {
  const [fileName, setFileName] = useState('')
  const [archiveJson, setArchiveJson] = useState('')
  const [preview, setPreview] = useState<MemoryArchivePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const selectFile = async (file?: File) => {
    setFileName('')
    setArchiveJson('')
    setPreview(null)
    setError('')
    setNotice('')
    if (!file) return
    if (file.size > MAX_MEMORY_ARCHIVE_BYTES) {
      setError('Memory archive must be 64 MiB or smaller.')
      return
    }

    setBusy(true)
    try {
      const contents = await file.text()
      const validated = await desktopBridge.previewMemoryArchive(contents)
      setArchiveJson(contents)
      setFileName(file.name)
      setPreview(validated)
    } catch (cause) {
      setError(cause instanceof DesktopBridgeError ? cause.message : 'This archive could not be validated. No memory was imported.')
    } finally {
      setBusy(false)
    }
  }

  const importArchive = async () => {
    if (!archiveJson || !preview || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await desktopBridge.importMemoryArchive(archiveJson)
      const summary = result.alreadyImported
        ? 'This archive was already imported; no duplicate memory was added.'
        : `Imported ${result.entitiesImported} memories and ${result.relationsImported} relationships.`
      setNotice(`${summary} A local backup is kept at ${result.backupPath}`)
    } catch (cause) {
      const detail = cause instanceof DesktopBridgeError ? cause.message : 'The import could not be completed.'
      setError(`${detail} The archive remains available to retry; any saved backup is kept.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="memory-import-heading" className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h3 id="memory-import-heading" className="font-semibold">Bring memory from the full app</h3>
      <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
        Choose the versioned memory archive downloaded from the Electron Memory Inspector. AI-Worker validates it before showing a preview, then imports it additively into local SQLite. No archive contents are uploaded. The source file is left unchanged and an additional local backup is retained before import.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor="memory-archive-file" className="text-sm font-medium">Memory archive</label>
        <input
          id="memory-archive-file"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => { void selectFile(event.currentTarget.files?.[0]) }}
          className="max-w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-bg-dark)] file:px-3 file:py-2 file:text-[var(--color-text-primary)]"
        />
      </div>

      {busy && <p role="status" className="mt-3 text-sm text-[var(--color-text-secondary)]">Validating or importing local memory…</p>}
      {preview && (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] p-4">
          <p className="break-all text-sm font-medium">{fileName}</p>
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <div><dt className="text-[var(--color-text-secondary)]">Memories</dt><dd>{preview.entities}</dd></div>
            <div><dt className="text-[var(--color-text-secondary)]">Relationships</dt><dd>{preview.relations}</dd></div>
            <div><dt className="text-[var(--color-text-secondary)]">Archive</dt><dd className="break-all">{preview.migrationId.slice(0, 20)}…</dd></div>
          </dl>
          <Button type="button" variant="secondary" className="mt-4" onClick={() => void importArchive()} disabled={busy}>
            {preview.alreadyImported ? 'Verify imported archive' : 'Import memory'}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="mt-3 break-all text-sm text-[var(--color-text-secondary)]">{notice}</p>}
    </section>
  )
}
