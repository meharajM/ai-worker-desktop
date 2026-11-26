import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ExternalTaskAPI, ExternalTaskApprovalAPI, TaskView, LocalTaskModelStatus } from '../../../shared/external-task'

const button = 'rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50'
const primary = button + ' bg-emerald-700 text-white'

function ExternalFileReview({ detail, onApprove, onReject }: { detail: string; onApprove: () => void; onReject: () => void }) {
  let proposal: { file: string; previous: string | null; proposed: string }
  try {
    const parsed = JSON.parse(detail)
    if (!parsed || typeof parsed.file !== 'string' ||
        !(parsed.previous === null || typeof parsed.previous === 'string') || typeof parsed.proposed !== 'string') {
      throw new Error('Invalid review')
    }
    proposal = parsed
  } catch {
    return <p role="alert">The proposed change could not be reviewed. Reject this write and retry the task.</p>
  }
  return <section aria-label="Review pending external file write" className="mt-4 text-sm">
    <h3 className="font-semibold break-all">{proposal.file}</h3>
    {[['Current content', proposal.previous ?? '(new file)'], ['Proposed content', proposal.proposed]].map(([label, content]) =>
      <div key={label} className="mt-3"><h4 className="font-medium">{label}</h4>
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded border p-2">{content}</pre>
      </div>)}
    <div className="mt-4 flex justify-end gap-2">
      <button className={button} onClick={onReject}>Reject write</button>
      <button className={primary} onClick={onApprove}>Approve write</button>
    </div>
  </section>
}

function TaskDialog({ view, api }: { view: TaskView; api: ExternalTaskApprovalAPI }) {
  const [workspace, setWorkspace] = useState<string | null>(view.workspaceRoot)
  const [web, setWeb] = useState(false)
  const [services, setServices] = useState<number[]>([])
  const [error, setError] = useState('')
  const mode = view.mode
  const [modelStatus, setModelStatus] = useState<LocalTaskModelStatus>({ model: null, checkedAt: 0 })
  useEffect(() => {
    if (view.phase !== 'consent') return
    let active = true
    const refresh = async () => {
      const result = await api.modelStatus().catch(() => null)
      if (active && result) setModelStatus(result)
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 1200)
    return () => { active = false; window.clearInterval(timer) }
  }, [view.phase, api])
  const ready = Boolean(modelStatus.model)
  const model = modelStatus.model
  const unavailable = view.phase === 'consent' && modelStatus.checkedAt > 0 && !ready
  const cancel = () => { void api.cancel(view.id).catch(() => setError('Could not cancel this task.')) }
  const decide = (value: Parameters<ExternalTaskAPI['decide']>[2]) => {
    void api.decide(view.id, view.step, value).catch(() => setError('The request expired or the scope changed.'))
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) cancel() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/70" />
      <Dialog.Content aria-describedby="external-task-description" className="fixed z-[121] left-1/2 top-1/2 w-[min(30rem,94vw)] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-[var(--color-text-primary)] shadow-2xl" onPointerDownOutside={e => e.preventDefault()}>
        <Dialog.Title className="text-lg font-semibold">{view.title}</Dialog.Title>
        <Dialog.Description id="external-task-description" className="mt-1 text-sm text-[var(--color-text-muted)]">
          Local sub-agent request · {view.mode} · expires {new Date(view.expiresAt).toLocaleTimeString()}
        </Dialog.Description>
        {view.phase === 'consent' && <div className="mt-4 space-y-3 text-sm">
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3">{view.prompt}</pre>
          {view.handoffContext && <details className="rounded-md border p-3">
            <summary className="cursor-pointer font-medium">Context from the requesting agent</summary>
            <div className="mt-2 space-y-2 text-xs text-[var(--color-text-muted)]">
              {view.handoffContext.sourceAgent && <p>Agent: {view.handoffContext.sourceAgent}</p>}
              {view.handoffContext.workingDirectory && <p className="break-all">Current folder: {view.handoffContext.workingDirectory}</p>}
              {view.handoffContext.summary && <p className="whitespace-pre-wrap break-words">{view.handoffContext.summary}</p>}
              {view.handoffContext.constraints?.length > 0 && <div><p>Constraints</p><ul className="list-disc pl-5">
                {view.handoffContext.constraints.map((item, index) => <li key={index} className="break-words">{item}</li>)}
              </ul></div>}
              {view.handoffContext.relevantFiles?.length > 0 && <div><p>Relevant files</p><ul className="list-disc pl-5">
                {view.handoffContext.relevantFiles.map((item, index) => <li key={index} className="break-all">{item}</li>)}
              </ul></div>}
            </div>
          </details>}
          <p>Local model inference and selected workspace reads stay on this device. After this one-time scope grant, bounded workspace reads run without more prompts; proposed file writes and returning the result to the requesting agent still require review. If that agent is cloud-hosted, anything you release will leave this device.</p>
          <p role="status">{ready ? `On-device model ready: ${model?.provider} · ${model?.model}` : modelStatus.checkedAt === 0 ? 'Checking on-device model…' : 'No on-device model is ready. Load a WebLLM model in the hub or start Ollama, then retry.'}</p>
          {view.requested.includes('workspace') && <div>
            <button className={button} onClick={async () => {
              const selected = await api.chooseWorkspace(view.id, view.step).catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : 'Could not select this workspace.')
                return null
              })
              if (selected) setWorkspace(selected)
            }}>{workspace ? 'Change workspace' : 'Choose workspace'}</button>
            {workspace && <button className={button} onClick={() => setWorkspace(null)}>Remove</button>}
            <p className="mt-1 break-all">{workspace
              ? `${workspace === view.workspaceRoot ? 'From requesting agent' : 'Selected in AI-Worker'}: ${workspace}`
              : 'Workspace access is off.'}</p>
          </div>}
          {view.requested.includes('web') && <label className="flex gap-2"><input type="checkbox" checked={web}
            disabled={mode !== 'connected'} onChange={e => setWeb(e.target.checked)} />
            {mode === 'connected' ? 'Allow public web reads. Search queries and URLs go to the public internet; each read runs without another prompt.' : 'Public web research requires Connected mode.'}</label>}
          {view.requested.includes('services') && <fieldset className="space-y-1">
            <legend>Connected service tools</legend>
            <p className="text-xs text-[var(--color-text-muted)]">Selected read tools can run during this task. Any write or unclassified tool action pauses for review; arguments go to the selected connected service.</p>
            {!view.services.length && <p>{mode === 'connected' ? 'No eligible connected tools available.' : 'Connected mode required.'}</p>}
            {view.services.map((tool, i) => <label key={i} className="flex gap-2 break-all"><input type="checkbox"
              checked={services.includes(i)} disabled={mode !== 'connected' || (!services.includes(i) && services.length >= 8)}
              onChange={e => setServices(e.target.checked ? [...services, i] : services.filter(id => id !== i))} />
              {tool.serverId} / {tool.name}</label>)}
          </fieldset>}
        </div>}
        {view.phase === 'file' && <ExternalFileReview detail={view.detail}
          onApprove={() => decide(true)} onReject={() => decide(false)} />}
        {(view.phase === 'action' || view.phase === 'release') &&
          <pre className="mt-3 max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-sm">{view.detail}</pre>}
        {error && <p role="alert">{error}</p>}
        {view.phase !== 'file' && <div className="mt-5 flex justify-end gap-2">
          <button className={button} onClick={unavailable ? () => decide('model-unavailable') : cancel}>{unavailable ? 'Report unavailable model' : view.phase === 'consent' ? 'Decline' : 'Cancel task'}</button>
          {view.phase === 'consent' && <button className={primary} disabled={!ready} onClick={() => decide({ workspace, web, services, model: model! })}>Run once</button>}
          {view.phase === 'action' && <button className={primary} onClick={() => decide(true)}>Approve action</button>}
          {view.phase === 'release' && <button className={primary} onClick={() => decide(true)}>Return result</button>}
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function ExternalTaskPanel() {
  const api = window.externalTask
  const [view, setView] = useState<TaskView | null>(null)
  useEffect(() => {
    if (!api) return
    let received = false
    const remove = api.onChange(value => { received = true; setView(value) })
    void api.current().then(value => { if (!received) setView(value) }).catch(() => {})
    return () => { received = true; remove() }
  }, [api])
  return api && view ? <TaskDialog key={view.id} api={api} view={view} /> : null
}
