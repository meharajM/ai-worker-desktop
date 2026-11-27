import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTauriTheme } from './hooks/useTauriTheme'

const states = {
  queued: { label: 'Queued', color: 'var(--color-text-secondary)' },
  running: { label: 'Running locally', color: 'var(--color-agent-mcp)' },
  waiting_for_parent: {
    label: 'Waiting for the calling agent',
    color: 'var(--color-warning)',
    hint: 'Reply to the task in the app that sent it.',
  },
  waiting_for_approval: {
    label: 'Waiting for file review',
    color: 'var(--color-warning)',
    hint: 'Review the proposed change in the file review window.',
  },
  cancelling: { label: 'Cancelling', color: 'var(--color-text-secondary)' },
  cancelled: { label: 'Cancelled', color: 'var(--color-text-secondary)' },
  completed: { label: 'Completed', color: 'var(--color-success)' },
  failed: { label: 'Failed', color: 'var(--color-error)' },
} satisfies Record<string, { label: string; color: string; hint?: string }>

interface ActivityTask {
  id: string
  protocol: 'MCP' | 'A2A'
  prompt: string
  handoffContext: {
    sourceAgent: string | null
    summary: string | null
    constraints: string[]
    workingDirectory: string | null
    relevantFiles: string[]
  } | null
  webAccess: boolean
  state: keyof typeof states
  modelTurns: number
}

function TaskRow({ task }: { task: ActivityTask }) {
  const state = states[task.state]
  const context = task.handoffContext
  return (
    <li className="min-w-0 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 text-xs font-semibold" role="status">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: state.color }}
          />
          {state.label}
        </p>
        {task.modelTurns > 0 && (
          <span className="text-xs tabular-nums text-[var(--color-text-secondary)]">
            Model pass {task.modelTurns}
          </span>
        )}
      </div>
      <h2 className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words text-sm font-medium leading-5">
        {task.prompt}
      </h2>
      <p className="mt-1 break-words text-xs text-[var(--color-text-secondary)]">
        {context?.sourceAgent ? `${context.sourceAgent} · ${task.protocol}` : task.protocol}
      </p>
      {task.webAccess && (
        <p className="mt-2 rounded-md border border-amber-500/40 p-2 text-xs leading-5 text-amber-100" role="status">
          Public web access is enabled. Search terms and URL paths and queries are sent as supplied. Outbound
          request planning uses the host task prompt and public web results, not workspace files or handoff notes.
          AI-Worker does not attach saved cookies or account credentials. Do not include secrets in the task prompt
          or URLs. Model inference stays on this device.
        </p>
      )}
      {'hint' in state && <p className="mt-2 text-xs leading-5">{state.hint}</p>}
      {context && (context.summary || context.workingDirectory || context.constraints.length > 0 || context.relevantFiles.length > 0) && (
        <details className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
          <summary className="cursor-pointer font-medium">Handoff context</summary>
          <dl className="mt-2 space-y-2 break-words pl-3">
            {context.summary && <div><dt className="font-semibold">Summary</dt><dd className="whitespace-pre-wrap">{context.summary}</dd></div>}
            {context.workingDirectory && <div><dt className="font-semibold">Working directory</dt><dd>{context.workingDirectory}</dd></div>}
            {context.constraints.length > 0 && <div><dt className="font-semibold">Constraints</dt><dd>{context.constraints.join(' · ')}</dd></div>}
            {context.relevantFiles.length > 0 && <div><dt className="font-semibold">Relevant files</dt><dd>{context.relevantFiles.join(', ')}</dd></div>}
          </dl>
        </details>
      )}
    </li>
  )
}

export function TaskActivityWindow() {
  useTauriTheme()
  const [tasks, setTasks] = useState<ActivityTask[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    async function refresh() {
      try {
        const snapshot = await invoke<ActivityTask[]>('get_task_activity')
        if (!stopped) {
          setTasks(snapshot)
          setUnavailable(false)
        }
      } catch {
        if (!stopped) setUnavailable(true)
      } finally {
        if (!stopped) timer = setTimeout(refresh, 1000)
      }
    }

    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  return (
    <main className="flex h-screen flex-col bg-[var(--color-card-dark)] text-[var(--color-text-primary)]">
      <header className="shrink-0 border-b border-[var(--color-border)] px-5 pb-3 pt-4">
        <h1 className="text-lg font-semibold tracking-tight">Task activity</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        {unavailable && <p className="py-4 text-sm" role="status">Activity unavailable. Retrying…</p>}
        {!unavailable && tasks === null && <p className="py-4 text-sm" role="status">Loading tasks…</p>}
        {!unavailable && tasks?.length === 0 && (
          <p className="py-4 text-sm text-[var(--color-text-secondary)]" role="status">
            No recent tasks. New background tasks appear here.
          </p>
        )}
        <ul className="divide-y divide-[var(--color-border)]">
          {tasks?.map(task => <TaskRow key={task.id} task={task} />)}
        </ul>
      </div>
      <footer className="shrink-0 border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-secondary)]">
        Tasks continue if you close this window.
      </footer>
    </main>
  )
}
