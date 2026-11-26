import path from 'node:path'

export const AIWorkerHandoff = async ({ worktree, directory }) => ({
  'tool.execute.before': async ({ tool }, { args }) => {
    if (tool !== 'ai_worker_readonly_run_agent_task') return
    const context = args.handoffContext || {}
    args.handoffContext = { ...context, sourceAgent: context.sourceAgent || 'OpenCode' }
    if (!args.capabilities?.includes('workspace')) return
    // OpenCode uses a filesystem root as the worktree for some non-Git sessions.
    const root = [worktree, directory].find(value => typeof value === 'string' &&
      path.isAbsolute(value) && path.resolve(value) !== path.parse(value).root)
    if (root) args.workspaceRoot = root
    if (typeof directory === 'string' && path.isAbsolute(directory)) args.handoffContext.workingDirectory = directory
  },
})
