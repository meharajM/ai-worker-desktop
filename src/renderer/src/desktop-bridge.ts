import { Channel, invoke, isTauri } from '@tauri-apps/api/core'

const PROTOCOL_VERSION = 1
const OWNER_ID = 'main'
const MAX_ID_LENGTH = 64
const ERROR_MESSAGES = {
  invalid_request: 'Native bridge rejected the request.',
  unauthorized: 'Native bridge caller is not authorized.',
  stale_session: 'Native bridge session is no longer active. Check again to open a new session.',
  internal: 'Native bridge is unavailable.',
  unavailable: 'Native bridge unavailable in browser preview.',
  protocol_error: 'Native bridge returned an invalid response.',
  transport_error: 'Native bridge request failed.',
} as const

export type DesktopBridgeErrorCode = keyof typeof ERROR_MESSAGES

export class DesktopBridgeError extends Error {
  readonly code: DesktopBridgeErrorCode

  constructor(code: DesktopBridgeErrorCode) {
    super(ERROR_MESSAGES[code])
    this.code = code
    this.name = 'DesktopBridgeError'
  }
}

type OpenReply = {
  protocolVersion: number
  ownerId: string
  sessionId: string
  requestId: string
}

export type DesktopStatus = {
  protocolVersion: number
  ownerId: string
  sessionId: string
  requestId: string
  appVersion: string
  available: boolean
}

export type DesktopPreferences = {
  schemaVersion: 1
  selectedProfileId: null
  resourcePreset: 'lowImpact' | 'balanced'
  idlePolicy: 'taskEnd' | 'shortIdle'
  allowOnlineResearch: boolean
}

export type DesktopPreferencesReply = {
  protocolVersion: number
  ownerId: string
  sessionId: string
  requestId: string
  preferences: DesktopPreferences
}

export type LocalChatReply = Identity & {
  content: string
  provider: 'Ollama (local)' | 'llama.cpp'
  model: string
}

type Identity = { protocolVersion: number; ownerId: string; sessionId: string; requestId: string }
type OpenRequest = Omit<Identity, 'sessionId'>
type NativeRequest = OpenRequest | Identity | (Identity & { preferences: DesktopPreferences })
type NativeCommand = 'bridge_open_session' | 'bridge_get_status' | 'bridge_get_preferences' | 'bridge_update_preferences' | 'chat_local' | 'model_catalog' | 'model_import' | 'model_install' | 'model_cancel_import' | 'model_cancel_install'
type Invoke = <T>(command: NativeCommand, args: { request: NativeRequest; prompt?: string; onProgress?: Channel<ModelImportProgress>; importRequestId?: string; installRequestId?: string; modelId?: string }) => Promise<T>

export type ModelCandidate = {
  id: string
  name: string
  status: string
  source: string
  license: string
  artifactSize: number
  artifactSha256: string
  templateSha256: string
  runtimeSha256: string
  diskRequired: number
  installed: boolean
}

export type ModelCatalog = {
  certifiedProfiles: string[]
  system: {
    operatingSystem: string
    architecture: string
    logicalCpuCount: number
    totalMemoryBytes: number
    availableMemoryBytes: number
    availableModelDiskBytes: number | null
  }
  ollamaAvailable: boolean
  installedModels: string[]
  configuredModel: string | null
  selectedModel: string | null
  recommendedModel: {
    id: string
    name: string
    ollamaName: string
    minimumMemoryBytes: number
    estimatedSizeBytes: number
    diskRequiredBytes: number
  } | null
  developerCandidate: ModelCandidate | null
}

export type ModelImportProgress = {
  requestId: string
  state: 'progress' | 'completed' | 'cancelled' | 'failed'
  copied: number
  total: number
  message: string | null
}

export type PendingWriteApproval = {
  taskId: string
  approvalId: string
  taskPrompt: string
  handoffContext?: {
    summary?: string
    constraints?: string[]
    relevantFiles?: string[]
    sourceAgent?: string
    workingDirectory?: string
  }
  workspaceRoot: string
  relativePath: string
  before: string | null
  proposed: string
}

type WriteApprovalCommand = 'get_pending_write_approval' | 'resolve_write_approval'
type WriteApprovalInvoke = <T>(command: WriteApprovalCommand, args?: Record<string, unknown>) => Promise<T>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isApprovalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isSafePath(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function parseHandoffContext(value: unknown): PendingWriteApproval['handoffContext'] {
  if (value === undefined || value === null) return undefined
  const allowed = ['constraints', 'relevantFiles', 'sourceAgent', 'summary', 'workingDirectory']
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new DesktopBridgeError('protocol_error')
  }
  const context: NonNullable<PendingWriteApproval['handoffContext']> = {}
  if (value.summary !== undefined && value.summary !== null) {
    if (!boundedText(value.summary, 2000)) throw new DesktopBridgeError('protocol_error')
    context.summary = value.summary
  }
  if (value.constraints !== undefined && value.constraints !== null) {
    if (!Array.isArray(value.constraints) || value.constraints.length > 8 || !value.constraints.every(item => boundedText(item, 256))) {
      throw new DesktopBridgeError('protocol_error')
    }
    context.constraints = value.constraints
  }
  if (value.relevantFiles !== undefined && value.relevantFiles !== null) {
    if (!Array.isArray(value.relevantFiles) || value.relevantFiles.length > 12 || !value.relevantFiles.every(item => isSafePath(item, 256))) {
      throw new DesktopBridgeError('protocol_error')
    }
    context.relevantFiles = value.relevantFiles
  }
  if (value.sourceAgent !== undefined && value.sourceAgent !== null) {
    if (!boundedText(value.sourceAgent, 96)) throw new DesktopBridgeError('protocol_error')
    context.sourceAgent = value.sourceAgent
  }
  if (value.workingDirectory !== undefined && value.workingDirectory !== null) {
    if (!isSafePath(value.workingDirectory, 1024)) throw new DesktopBridgeError('protocol_error')
    context.workingDirectory = value.workingDirectory
  }
  return context
}

function parsePendingWriteApproval(value: unknown): PendingWriteApproval | null {
  if (value === null) return null
  const requiredKeys = ['approvalId', 'before', 'proposed', 'relativePath', 'taskId', 'taskPrompt', 'workspaceRoot']
  const actualKeys = isRecord(value) ? Object.keys(value).sort() : []
  if (!isRecord(value) ||
      (actualKeys.join(',') !== requiredKeys.join(',') && actualKeys.join(',') !== [...requiredKeys, 'handoffContext'].sort().join(',')) ||
      !isApprovalId(value.taskId) || !isApprovalId(value.approvalId) ||
      !boundedText(value.taskPrompt, 4000) || value.taskPrompt.trim().length === 0 ||
      !isSafePath(value.workspaceRoot, 1024) || !isSafePath(value.relativePath, 512) ||
      (value.before !== null && (typeof value.before !== 'string' || value.before.length > 16_384)) ||
      typeof value.proposed !== 'string' || value.proposed.length > 16_384) {
    throw new DesktopBridgeError('protocol_error')
  }
  const handoffContext = parseHandoffContext(value.handoffContext)
  const proposal = { ...value } as unknown as PendingWriteApproval
  delete proposal.handoffContext
  if (handoffContext !== undefined) proposal.handoffContext = handoffContext
  return proposal
}

function writeApprovalError(error: unknown): DesktopBridgeError {
  if (isRecord(error) && typeof error.code === 'string' && Object.hasOwn(ERROR_MESSAGES, error.code) &&
      !['unavailable', 'protocol_error', 'transport_error'].includes(error.code)) {
    return new DesktopBridgeError(error.code as DesktopBridgeErrorCode)
  }
  return new DesktopBridgeError('transport_error')
}

export function createWriteApprovalBridgeClient(platform: { isTauri: () => boolean; invoke: WriteApprovalInvoke }) {
  return {
    getPendingWriteApproval(): Promise<PendingWriteApproval | null> {
      if (!platform.isTauri()) return Promise.reject(new DesktopBridgeError('unavailable'))
      return platform.invoke<unknown>('get_pending_write_approval').then(parsePendingWriteApproval).catch((error: unknown) => {
        if (error instanceof DesktopBridgeError) throw error
        throw writeApprovalError(error)
      })
    },
    resolveWriteApproval(taskId: string, approvalId: string, approved: boolean): Promise<void> {
      if (!platform.isTauri()) return Promise.reject(new DesktopBridgeError('unavailable'))
      if (!isApprovalId(taskId) || !isApprovalId(approvalId) || typeof approved !== 'boolean') {
        return Promise.reject(new DesktopBridgeError('invalid_request'))
      }
      return platform.invoke<void>('resolve_write_approval', { taskId, approvalId, approved }).catch((error: unknown) => {
        throw writeApprovalError(error)
      })
    },
  }
}

export const writeApprovalBridge = createWriteApprovalBridgeClient({ isTauri, invoke })

export function createDesktopBridgeClient(platform: { isTauri: () => boolean; invoke: Invoke }) {
  let requestSequence = 0
  let opening: Promise<string> | undefined

  const nextRequestId = () => {
    if (requestSequence >= Number.MAX_SAFE_INTEGER) throw new DesktopBridgeError('protocol_error')
    return `req-${++requestSequence}`
  }
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(value)
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const validPreferences = (value: unknown): value is DesktopPreferences => {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'allowOnlineResearch,idlePolicy,resourcePreset,schemaVersion,selectedProfileId') return false
    if (value.schemaVersion !== 1 || value.selectedProfileId !== null || typeof value.allowOnlineResearch !== 'boolean') return false
    return (value.resourcePreset === 'lowImpact' && value.idlePolicy === 'taskEnd') ||
      (value.resourcePreset === 'balanced' && value.idlePolicy === 'shortIdle')
  }

  function nativeError(error: unknown): DesktopBridgeError {
    if (object(error) && typeof error.code === 'string' && Object.hasOwn(ERROR_MESSAGES, error.code) && error.code !== 'unavailable' && error.code !== 'protocol_error' && error.code !== 'transport_error') {
      return new DesktopBridgeError(error.code as DesktopBridgeErrorCode)
    }
    return new DesktopBridgeError('transport_error')
  }

  function validateOpen(reply: unknown, requestId: string): string {
    if (!object(reply) || reply.protocolVersion !== PROTOCOL_VERSION || reply.ownerId !== OWNER_ID || reply.requestId !== requestId || !validId(reply.sessionId)) {
      throw new DesktopBridgeError('protocol_error')
    }
    return reply.sessionId
  }

  function validateIdentity(reply: unknown, identity: Identity): Record<string, unknown> {
    if (!object(reply) || reply.protocolVersion !== PROTOCOL_VERSION || reply.ownerId !== OWNER_ID ||
      reply.sessionId !== identity.sessionId || reply.requestId !== identity.requestId) {
      throw new DesktopBridgeError('protocol_error')
    }
    return reply
  }

  function validatePreferencesReply(value: unknown, identity: Identity): DesktopPreferencesReply {
    const reply = validateIdentity(value, identity)
    if (Object.keys(reply).sort().join(',') !== 'ownerId,preferences,protocolVersion,requestId,sessionId' || !validPreferences(reply.preferences)) {
      throw new DesktopBridgeError('protocol_error')
    }
    return reply as DesktopPreferencesReply
  }

  function samePreferences(left: DesktopPreferences, right: DesktopPreferences) {
    return left.schemaVersion === right.schemaVersion && left.selectedProfileId === right.selectedProfileId &&
      left.resourcePreset === right.resourcePreset && left.idlePolicy === right.idlePolicy &&
      left.allowOnlineResearch === right.allowOnlineResearch
  }

  async function correlatedRequest<T>(
    command: Exclude<NativeCommand, 'bridge_open_session'>,
    preferences: DesktopPreferences | undefined,
    validate: (reply: unknown, identity: Identity) => T,
    extraArgs: { prompt?: string; onProgress?: Channel<ModelImportProgress>; importRequestId?: string; installRequestId?: string; modelId?: string } = {},
  ): Promise<T> {
    if (!platform.isTauri()) throw new DesktopBridgeError('unavailable')
    if (preferences !== undefined && !validPreferences(preferences)) throw new DesktopBridgeError('invalid_request')
    const sessionId = await openSession()
    const identity = { protocolVersion: PROTOCOL_VERSION, ownerId: OWNER_ID, sessionId, requestId: nextRequestId() }
    const request: NativeRequest = preferences === undefined ? identity : { ...identity, preferences }
    let reply: unknown
    try {
      reply = await platform.invoke(command, { request, ...extraArgs })
    } catch (error) {
      const failure = nativeError(error)
      if (failure.code === 'stale_session') opening = undefined
      throw failure
    }
    return validate(reply, identity)
  }

  function openSession(): Promise<string> {
    if (!platform.isTauri()) return Promise.reject(new DesktopBridgeError('unavailable'))
    if (!opening) {
      const requestId = nextRequestId()
      const pending = platform.invoke<OpenReply>('bridge_open_session', {
        request: { protocolVersion: PROTOCOL_VERSION, ownerId: OWNER_ID, requestId },
      }).then((reply) => validateOpen(reply, requestId)).catch((error: unknown) => {
        if (opening === pending) opening = undefined
        if (error instanceof DesktopBridgeError) throw error
        throw nativeError(error)
      })
      opening = pending
    }
    return opening
  }

  return {
    isAvailable: platform.isTauri,
    getStatus(): Promise<DesktopStatus> {
      return correlatedRequest('bridge_get_status', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        if (typeof reply.available !== 'boolean' || typeof reply.appVersion !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(reply.appVersion)) {
          throw new DesktopBridgeError('protocol_error')
        }
        return reply as DesktopStatus
      })
    },
    getPreferences(): Promise<DesktopPreferencesReply> {
      return correlatedRequest('bridge_get_preferences', undefined, validatePreferencesReply)
    },
    updatePreferences(preferences: DesktopPreferences): Promise<DesktopPreferencesReply> {
      if (!validPreferences(preferences)) return Promise.reject(new DesktopBridgeError('invalid_request'))
      return correlatedRequest('bridge_update_preferences', preferences, (value, identity) => {
        const reply = validatePreferencesReply(value, identity)
        if (!samePreferences(preferences, reply.preferences)) throw new DesktopBridgeError('protocol_error')
        return reply
      })
    },
    sendLocalChat(prompt: string): Promise<LocalChatReply> {
      if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 8_000) {
        return Promise.reject(new DesktopBridgeError('invalid_request'))
      }
      return correlatedRequest('chat_local', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        if (Object.keys(reply).sort().join(',') !== 'content,model,ownerId,protocolVersion,provider,requestId,sessionId' ||
          typeof reply.content !== 'string' || new TextEncoder().encode(reply.content).byteLength > 64 * 1024 ||
          !['Ollama (local)', 'llama.cpp'].includes(String(reply.provider)) ||
          typeof reply.model !== 'string' || reply.model.length === 0 || reply.model.length > 128 ||
          !/^[A-Za-z0-9._:/-]+$/.test(reply.model)) {
          throw new DesktopBridgeError('protocol_error')
        }
        return reply as LocalChatReply
      }, { prompt })
    },
    getModelCatalog(): Promise<ModelCatalog & Identity> {
      return correlatedRequest('model_catalog', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        const candidate = reply.developerCandidate
        const profile = reply.system
        const recommendation = reply.recommendedModel
        const installedModels = reply.installedModels
        if (!Array.isArray(reply.certifiedProfiles) || reply.certifiedProfiles.length !== 0 ||
          !object(profile) || Object.keys(profile).sort().join(',') !== 'architecture,availableMemoryBytes,availableModelDiskBytes,logicalCpuCount,operatingSystem,totalMemoryBytes' ||
          typeof profile.operatingSystem !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(profile.operatingSystem) ||
          typeof profile.architecture !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(profile.architecture) ||
          !Number.isSafeInteger(profile.logicalCpuCount) || (profile.logicalCpuCount as number) < 1 ||
          !Number.isSafeInteger(profile.totalMemoryBytes) || (profile.totalMemoryBytes as number) < 1 ||
          !Number.isSafeInteger(profile.availableMemoryBytes) || (profile.availableMemoryBytes as number) < 0 ||
          (profile.availableModelDiskBytes !== null && (!Number.isSafeInteger(profile.availableModelDiskBytes) || (profile.availableModelDiskBytes as number) < 0)) ||
          typeof reply.ollamaAvailable !== 'boolean' || !Array.isArray(installedModels) || installedModels.length > 256 ||
          !installedModels.every(model => typeof model === 'string' && model.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(model)) ||
          (reply.configuredModel !== null && (typeof reply.configuredModel !== 'string' || reply.configuredModel.length > 256)) ||
          (reply.selectedModel !== null && (typeof reply.selectedModel !== 'string' || !installedModels.includes(reply.selectedModel))) ||
          (recommendation !== null && (!object(recommendation) ||
            Object.keys(recommendation).sort().join(',') !== 'diskRequiredBytes,estimatedSizeBytes,id,minimumMemoryBytes,name,ollamaName' ||
            typeof recommendation.id !== 'string' || typeof recommendation.name !== 'string' ||
            typeof recommendation.ollamaName !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(recommendation.ollamaName) ||
            !Number.isSafeInteger(recommendation.minimumMemoryBytes) ||
            !Number.isSafeInteger(recommendation.estimatedSizeBytes) ||
            !Number.isSafeInteger(recommendation.diskRequiredBytes))) ||
          (candidate !== null && (!object(candidate) || typeof candidate.id !== 'string' ||
            typeof candidate.name !== 'string' || typeof candidate.status !== 'string' ||
            typeof candidate.source !== 'string' || typeof candidate.license !== 'string' ||
            !Number.isSafeInteger(candidate.artifactSize) || typeof candidate.artifactSha256 !== 'string' ||
            typeof candidate.templateSha256 !== 'string' || typeof candidate.runtimeSha256 !== 'string' ||
            !Number.isSafeInteger(candidate.diskRequired) || typeof candidate.installed !== 'boolean'))) {
          throw new DesktopBridgeError('protocol_error')
        }
        return reply as ModelCatalog & Identity
      })
    },
    installModel(modelId: string, onProgress: (progress: ModelImportProgress) => void): Promise<{ requestId: string; started: boolean } & Identity> {
      if (!/^[a-z0-9-]{1,32}$/.test(modelId)) return Promise.reject(new DesktopBridgeError('invalid_request'))
      const channel = new Channel<ModelImportProgress>()
      channel.onmessage = (progress) => {
        if (!object(progress) || typeof progress.requestId !== 'string' ||
          !['progress', 'completed', 'cancelled', 'failed'].includes(String(progress.state)) ||
          !Number.isSafeInteger(progress.copied) || !Number.isSafeInteger(progress.total) ||
          (progress.message !== null && typeof progress.message !== 'string')) return
        onProgress(progress as ModelImportProgress)
      }
      return correlatedRequest('model_install', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        if (typeof reply.started !== 'boolean') throw new DesktopBridgeError('protocol_error')
        return reply as { requestId: string; started: boolean } & Identity
      }, { modelId, onProgress: channel })
    },
    importModel(onProgress: (progress: ModelImportProgress) => void): Promise<{ requestId: string; started: boolean } & Identity> {
      const channel = new Channel<ModelImportProgress>()
      channel.onmessage = (progress) => {
        if (!object(progress) || typeof progress.requestId !== 'string' ||
          !['progress', 'completed', 'cancelled', 'failed'].includes(String(progress.state)) ||
          !Number.isSafeInteger(progress.copied) || !Number.isSafeInteger(progress.total) ||
          (progress.message !== null && typeof progress.message !== 'string')) return
        onProgress(progress as ModelImportProgress)
      }
      return correlatedRequest('model_import', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        if (typeof reply.started !== 'boolean') throw new DesktopBridgeError('protocol_error')
        return reply as { requestId: string; started: boolean } & Identity
      }, { onProgress: channel })
    },
    cancelModelImport(importRequestId: string): Promise<void> {
      if (!validId(importRequestId)) return Promise.reject(new DesktopBridgeError('invalid_request'))
      return correlatedRequest('model_cancel_import', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        if (Object.keys(reply).sort().join(',') !== 'ownerId,protocolVersion,requestId,sessionId,started') {
          throw new DesktopBridgeError('protocol_error')
        }
      }, { importRequestId })
    },
    cancelModelInstall(installRequestId: string): Promise<void> {
      if (!validId(installRequestId)) return Promise.reject(new DesktopBridgeError('invalid_request'))
      return correlatedRequest('model_cancel_install', undefined, (value, identity) => {
        const reply = validateIdentity(value, identity)
        if (Object.keys(reply).sort().join(',') !== 'ownerId,protocolVersion,requestId,sessionId,started') {
          throw new DesktopBridgeError('protocol_error')
        }
      }, { installRequestId })
    },
  }
}

export const desktopBridge = createDesktopBridgeClient({ isTauri, invoke })
