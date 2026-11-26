import { ipcMain } from './trustedIpc'
import * as path from 'path'
import { is } from '@electron-toolkit/utils'
import { ModelManager } from '../services/ModelManager'

const voskModels = {
    'en-us': 'vosk-model-small-en-us-0.15',
    'en-in': 'vosk-model-small-en-in-0.4',
    'zh-cn': 'vosk-model-small-cn-0.22',
    'ja': 'vosk-model-small-ja-0.22',
    'fr': 'vosk-model-small-fr-0.22',
    'de': 'vosk-model-small-de-0.15',
    'es': 'vosk-model-small-es-0.42',
    'it': 'vosk-model-small-it-0.22',
    'hi': 'vosk-model-small-hi-0.22'
}

function validateModelName(value: unknown = voskModels['en-us']): string {
    if (typeof value !== 'string' || !Object.values(voskModels).includes(value)) throw new Error('Unknown offline speech model')
    return value
}

function getBaseModelsDir(): string {
    if (is.dev) {
        return path.join(process.cwd(), 'public', 'models')
    }
    return path.join(process.resourcesPath, 'models')
}

const SPEECH_UNAVAILABLE = 'Local Vosk voice input is unavailable under the secure runtime.'

let modelManager: ModelManager | null = null

export function registerSpeechHandlers(): void {
    // Initialize manager
    modelManager = new ModelManager(getBaseModelsDir())

    ipcMain.handle('speech:check-support', async (_event, modelName: string) => {
        // modelName passed from renderer (dynamic now)
        return { ...await modelManager!.checkSupport(validateModelName(modelName)), nativeSupport: false, supported: false, reason: SPEECH_UNAVAILABLE }
    })

    ipcMain.handle('speech:initialize', async () => ({ success: false, error: SPEECH_UNAVAILABLE }))
    ipcMain.handle('speech:start-listening', async () => ({ success: false, error: SPEECH_UNAVAILABLE }))
    ipcMain.handle('speech:stop-listening', async () => ({ success: true }))

    ipcMain.handle('speech:download-model', async (_event, options: { modelId: string, url: string, modelName: string }) => {
        const expectedModel = options && voskModels[options.modelId]
        if (!Object.hasOwn(voskModels, options?.modelId) || options.modelName !== expectedModel ||
            options.url !== `https://alphacephei.com/vosk/models/${expectedModel}.zip`) {
            throw new Error('Unknown offline speech model download')
        }
        return { success: false, error: SPEECH_UNAVAILABLE }
    })

    ipcMain.handle('speech:get-model-path', async (_event, modelName: string) => {
        return await modelManager!.getModelPath(validateModelName(modelName))
    })

    ipcMain.handle('speech:cleanup', async () => {
        if (modelManager) {
            await modelManager.cleanup()
        }
        return { success: true }
    })

    // Cleanup when app quits
    ipcMain.handle('speech:cleanup-server', async () => {
        if (modelManager) {
            await modelManager.cleanup()
        }
        return { success: true }
    })
}
