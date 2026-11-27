/** Stable, allowlisted format shared by the Electron exporter and Tauri importer. */
export type LegacyDataExport = {
  format: 'ai-worker-electron-export'
  schemaVersion: 1
  migrationId: string
  exportedAt: string
  sessions: Array<{
    id: string
    title: string
    createdAt: string
    updatedAt: string
    turns: Array<{
      turnId: string
      userText: string
      assistantText: string
      status: 'completed' | 'failed'
      endedAt: string
    }>
  }>
  preferences: {
    theme: 'dark' | 'light' | 'system'
    displayMode: 'dev' | 'prod'
    speechLang: string
    offlineSpeech: boolean
    ttsEnabled: boolean
    ttsRate: number
    ttsPitch: number
    ttsVoice: string | null
  }
  omissions: string[]
}
