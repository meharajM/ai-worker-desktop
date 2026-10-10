import { invoke, isTauri } from '@tauri-apps/api/core'

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
}

export type DesktopPreferencesReply = {
  protocolVersion: number
  ownerId: string
  sessionId: string
  requestId: string
  preferences: DesktopPreferences
}

type Identity = { protocolVersion: number; ownerId: string; sessionId: string; requestId: string }
type OpenRequest = Omit<Identity, 'sessionId'>
type NativeRequest = OpenRequest | Identity | (Identity & { preferences: DesktopPreferences })
type NativeCommand = 'bridge_open_session' | 'bridge_get_status' | 'bridge_get_preferences' | 'bridge_update_preferences'
type Invoke = <T>(command: NativeCommand, args: { request: NativeRequest }) => Promise<T>

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
    if (!object(value) || Object.keys(value).sort().join(',') !== 'idlePolicy,resourcePreset,schemaVersion,selectedProfileId') return false
    if (value.schemaVersion !== 1 || value.selectedProfileId !== null) return false
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
      left.resourcePreset === right.resourcePreset && left.idlePolicy === right.idlePolicy
  }

  async function correlatedRequest<T>(
    command: Exclude<NativeCommand, 'bridge_open_session'>,
    preferences: DesktopPreferences | undefined,
    validate: (reply: unknown, identity: Identity) => T,
  ): Promise<T> {
    if (!platform.isTauri()) throw new DesktopBridgeError('unavailable')
    if (preferences !== undefined && !validPreferences(preferences)) throw new DesktopBridgeError('invalid_request')
    const sessionId = await openSession()
    const identity = { protocolVersion: PROTOCOL_VERSION, ownerId: OWNER_ID, sessionId, requestId: nextRequestId() }
    const request: NativeRequest = preferences === undefined ? identity : { ...identity, preferences }
    let reply: unknown
    try {
      reply = await platform.invoke(command, { request })
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
  }
}

export const desktopBridge = createDesktopBridgeClient({ isTauri, invoke })
