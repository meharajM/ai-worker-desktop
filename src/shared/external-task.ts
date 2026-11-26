export const capabilities = ['workspace', 'web', 'services'] as const
export type Capability = typeof capabilities[number]
export type TaskMode = 'local-only' | 'connected'

export interface ServiceTool {
  serverId: string
  name: string
  parameters: unknown
}

export interface LocalTaskModel {
  provider: 'browser' | 'ollama'
  model: string
}

export interface LocalTaskModelStatus {
  model: LocalTaskModel | null
  checkedAt: number
}

export interface HandoffContext {
  summary?: string
  constraints?: string[]
  relevantFiles?: string[]
  sourceAgent?: string
  workingDirectory?: string
}

export interface TaskGrant {
  workspace: string | null
  web: boolean
  services: number[]
  model: LocalTaskModel
}

export interface TaskView {
  id: string
  step: string
  phase: 'consent' | 'planning' | 'action' | 'file' | 'release' | 'working'
  prompt: string
  workspaceRoot: string | null
  handoffContext?: HandoffContext
  requested: Capability[]
  mode: TaskMode
  expiresAt: number
  services: ServiceTool[]
  title: string
  detail: string
  model?: LocalTaskModel
}

export interface ExternalTaskAPI {
  chooseWorkspace(id: string, step: string): Promise<string | null>
  current(): Promise<TaskView | null>
  modelStatus(): Promise<LocalTaskModelStatus>
  onChange(listener: (view: TaskView | null) => void): () => void
  decide(id: string, step: string, value: TaskGrant | boolean | 'model-unavailable'): Promise<boolean>
  modelReply(id: string, step: string, result: { content?: string; error?: string }): Promise<boolean>
  onPlannerChange(listener: (view: TaskView | null) => void): () => void
  cancel(id: string): Promise<boolean>
}

export type ExternalTaskApprovalAPI = Pick<ExternalTaskAPI,
  'chooseWorkspace' | 'current' | 'modelStatus' | 'onChange' | 'decide' | 'cancel'>
