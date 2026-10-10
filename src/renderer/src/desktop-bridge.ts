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

type Invoke = <T>(command: string, args: { request: Record<string, string | number> }) => Promise<T>

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
    async getStatus(): Promise<DesktopStatus> {
      if (!platform.isTauri()) throw new DesktopBridgeError('unavailable')
      const sessionId = await openSession()
      const requestId = nextRequestId()
      let reply: unknown
      try {
        reply = await platform.invoke<DesktopStatus>('bridge_get_status', {
          request: { protocolVersion: PROTOCOL_VERSION, ownerId: OWNER_ID, sessionId, requestId },
        })
      } catch (error) {
        const failure = nativeError(error)
        if (failure.code === 'stale_session') opening = undefined
        throw failure
      }
      if (
        !object(reply) || reply.protocolVersion !== PROTOCOL_VERSION || reply.ownerId !== OWNER_ID ||
        reply.sessionId !== sessionId || reply.requestId !== requestId || typeof reply.available !== 'boolean' ||
        typeof reply.appVersion !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(reply.appVersion)
      ) {
        throw new DesktopBridgeError('protocol_error')
      }
      return reply as DesktopStatus
    },
  }
}

export const desktopBridge = createDesktopBridgeClient({ isTauri, invoke })
