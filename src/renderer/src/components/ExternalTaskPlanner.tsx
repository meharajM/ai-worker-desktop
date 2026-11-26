import { useEffect, useState } from 'react'
import type { TaskView } from '../../../shared/external-task'
import { useSettingsStore } from '../stores/settingsStore'
import { planExternalTask } from '../lib/external-task-model'

/** Runs local task planning in the hidden hub renderer, which owns WebLLM. */
export function ExternalTaskPlanner() {
  const api = window.electron?.externalTask
  const ollamaBaseUrl = useSettingsStore(s => s.ollamaBaseUrl)
  const [view, setView] = useState<TaskView | null>(null)
  useEffect(() => {
    if (!api) return
    return api.onPlannerChange(next => {
      setView(next)
    })
  }, [api])
  useEffect(() => {
    if (!api || view?.phase !== 'planning' || !view.model) return
    const controller = new AbortController()
    const signal = controller.signal
    void (async () => {
      try {
        const content = await planExternalTask(view.model!, ollamaBaseUrl, view.detail, signal)
        if (!signal.aborted) await api.modelReply(view.id, view.step, { content })
      } catch {
        if (!signal.aborted) await api.modelReply(view.id, view.step, { error: 'Model unavailable' })
      }
    })().catch(() => {})
    return () => controller.abort()
  }, [api, view, ollamaBaseUrl])
  return null
}
