import { app, BrowserWindow, dialog } from 'electron'
import { ipcMain } from './trustedIpc'
import { publishLocalModelStatus, resolveLocalMcpRendererReply, taskForPlanner, taskForRenderer, taskModelStatusForRenderer } from '../services/LocalMcpBridge'

export function registerLocalMcpBridgeHandlers(): void {
  ipcMain.handle('external-task:current', event => taskForRenderer(event.sender)?.view ?? null)
  ipcMain.handle('external-task:model-status', event => taskModelStatusForRenderer(event.sender))
  ipcMain.handle('external-task:choose-workspace', async (event, id, step) => {
    const task = taskForRenderer(event.sender, id)
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent || !task || task.view.phase !== 'consent' || task.view.step !== step ||
        !task.view.requested.includes('workspace')) return null
    const pick = await dialog.showOpenDialog(parent, {
      properties: ['openDirectory'],
      title: 'Choose workspace for this task',
      buttonLabel: 'Select Workspace',
      defaultPath: app.getPath('home'),
    })
    if (pick.canceled || !pick.filePaths[0]) return null
    return task.selectWorkspace(step, pick.filePaths[0])
  })
  ipcMain.handle('external-task:decide', (event, id, step, value) =>
    taskForRenderer(event.sender, id)?.reply(step, value) ?? false)
  ipcMain.handle('external-task:model-reply', (event, id, step, result) =>
    taskForPlanner(event.sender, id)?.reply(step, result, true) ?? false)
  ipcMain.handle('external-task:cancel', (event, id) => {
    const task = taskForRenderer(event.sender, id)
    if (!task) return false
    task.cancel()
    return true
  })

  ipcMain.handle('mcp-bridge:publish-model-status', async (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const model = (value as Record<string, unknown>).model
    if (model !== null) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return false
      const modelData = model as Record<string, unknown>
      if (!['browser', 'ollama'].includes(String(modelData.provider)) ||
          typeof modelData.model !== 'string' || modelData.model.length > 128) return false
    }
    await publishLocalModelStatus(model as import('../../shared/external-task').LocalTaskModel | null)
    return true
  })

  ipcMain.handle('mcp-bridge:answer-local', (_event, reply: unknown) => {
    return resolveLocalMcpRendererReply(reply)
  })
}
