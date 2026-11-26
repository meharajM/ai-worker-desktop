import { registerAppHandlers } from './app'
import { registerMcpHandlers } from './mcp'
import { registerLlmHandlers } from './llm'
import { registerStoreHandlers } from './store'
import { registerLogsHandlers } from './logs'
import { registerSpeechHandlers } from './speech'
import { registerSecureHandlers } from './secure'
import { registerFsHandlers } from './fs'
import { registerMemoryHandlers } from './memory'
import { registerWhatsAppHandlers } from './whatsapp'
import { revokeExternalTask } from '../services/LocalMcpBridge'
import { registerLocalMcpBridgeHandlers } from './localMcpBridge'
// import { registerAntigravityHandlers } from './antigravity'

export function setupIpcHandlers(): void {
    registerAppHandlers()
    registerMcpHandlers()
    registerMemoryHandlers()
    registerLlmHandlers()
    registerStoreHandlers(revokeExternalTask)
    registerLogsHandlers()
    registerSpeechHandlers()
    registerSecureHandlers()
    registerFsHandlers()
    // Antigravity login integration temporarily disabled.
    // registerAntigravityHandlers()
    registerWhatsAppHandlers()
    registerLocalMcpBridgeHandlers()
}
