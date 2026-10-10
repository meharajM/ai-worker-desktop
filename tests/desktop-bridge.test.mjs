import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopBridgeClient, DesktopBridgeError } from '../src/renderer/src/desktop-bridge.ts'

const opened = (request) => ({
  protocolVersion: 1,
  ownerId: 'main',
  sessionId: 's-1',
  requestId: request.requestId,
})
const lowImpact = { schemaVersion: 1, selectedProfileId: null, resourcePreset: 'lowImpact', idlePolicy: 'taskEnd' }
const balanced = { schemaVersion: 1, selectedProfileId: null, resourcePreset: 'balanced', idlePolicy: 'shortIdle' }
const preferenceReply = (request, preferences = lowImpact) => ({
  protocolVersion: 1, ownerId: 'main', sessionId: request.sessionId, requestId: request.requestId, preferences,
})

test('browser preview reports unavailable without invoking native commands', async () => {
  let calls = 0
  const client = createDesktopBridgeClient({ isTauri: () => false, invoke: async () => { calls++ } })
  assert.equal(client.isAvailable(), false)
  await assert.rejects(client.getStatus(), { code: 'unavailable' })
  await assert.rejects(client.getPreferences(), { code: 'unavailable' })
  await assert.rejects(client.updatePreferences(balanced), { code: 'unavailable' })
  assert.equal(calls, 0)
})

test('concurrent status checks share one open and use correlated request IDs', async () => {
  const calls = []
  let releaseOpen
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => {
      calls.push({ command, request })
      if (command === 'bridge_open_session') {
        await new Promise((resolve) => { releaseOpen = resolve })
        return opened(request)
      }
      return { protocolVersion: 1, ownerId: 'main', sessionId: request.sessionId, requestId: request.requestId, appVersion: '0.1.2', available: true }
    },
  })
  const first = client.getStatus()
  const second = client.getStatus()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter(({ command }) => command === 'bridge_open_session').length, 1)
  releaseOpen()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual([a.requestId, b.requestId], ['req-2', 'req-3'])
  assert.deepEqual(calls.map(({ request }) => request.requestId), ['req-1', 'req-2', 'req-3'])
  assert.equal(calls[1].request.sessionId, 's-1')
})

test('structured native errors keep their safe code', async () => {
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async () => { throw { code: 'unauthorized', message: 'untrusted detail' } },
  })
  await assert.rejects(client.getStatus(), (error) => error instanceof DesktopBridgeError && error.code === 'unauthorized' && !error.message.includes('untrusted'))
})

test('malformed or mismatched replies fail as protocol errors', async (t) => {
  for (const corrupt of [
    (reply) => ({ ...reply, protocolVersion: 2 }),
    (reply) => ({ ...reply, ownerId: 'other' }),
    (reply) => ({ ...reply, requestId: 'forged' }),
    (reply) => ({ ...reply, sessionId: 'bad id' }),
  ]) {
    await t.test('invalid open reply', async () => {
      const client = createDesktopBridgeClient({ isTauri: () => true, invoke: async (_command, { request }) => corrupt(opened(request)) })
      await assert.rejects(client.getStatus(), { code: 'protocol_error' })
    })
  }
  for (const corrupt of [
    (reply) => ({ ...reply, protocolVersion: 2 }),
    (reply) => ({ ...reply, ownerId: 'other' }),
    (reply) => ({ ...reply, sessionId: 's-forged' }),
    (reply) => ({ ...reply, requestId: 'forged' }),
    (reply) => ({ ...reply, available: 'yes' }),
    (reply) => ({ ...reply, appVersion: 'x'.repeat(65) }),
  ]) {
    const client = createDesktopBridgeClient({
      isTauri: () => true,
      invoke: async (command, { request }) => command === 'bridge_open_session'
        ? opened(request)
        : corrupt({ protocolVersion: 1, ownerId: 'main', sessionId: request.sessionId, requestId: request.requestId, appVersion: '0.1.2', available: true }),
    })
    await assert.rejects(client.getStatus(), { code: 'protocol_error' })
  }
})

test('failed open can retry, while stale status does not reopen implicitly', async () => {
  let opens = 0
  let failOpen = true
  let stale = true
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => {
      if (command === 'bridge_open_session') {
        opens++
        if (failOpen) { failOpen = false; throw { code: 'internal', message: 'static' } }
        return opened(request)
      }
      if (stale) { stale = false; throw { code: 'stale_session', message: 'static' } }
      return { protocolVersion: 1, ownerId: 'main', sessionId: request.sessionId, requestId: request.requestId, appVersion: '0.1.2', available: true }
    },
  })
  await assert.rejects(client.getStatus(), { code: 'internal' })
  await assert.rejects(client.getStatus(), { code: 'stale_session' })
  assert.equal(opens, 2)
  assert.equal((await client.getStatus()).available, true)
  assert.equal(opens, 3)
})

test('status and preferences share the cached session and validate correlated replies', async () => {
  const calls = []
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => {
      calls.push({ command, request })
      if (command === 'bridge_open_session') return opened(request)
      if (command === 'bridge_get_status') return { ...request, appVersion: '0.1.2', available: true }
      if (command === 'bridge_get_preferences') return preferenceReply(request, balanced)
      return preferenceReply(request, request.preferences)
    },
  })
  assert.equal((await client.getStatus()).available, true)
  assert.deepEqual((await client.getPreferences()).preferences, balanced)
  assert.deepEqual((await client.updatePreferences(lowImpact)).preferences, lowImpact)
  assert.equal(calls.filter(({ command }) => command === 'bridge_open_session').length, 1)
  assert.deepEqual(calls.map(({ request }) => request.requestId), ['req-1', 'req-2', 'req-3', 'req-4'])
  assert.deepEqual(calls[3].request.preferences, lowImpact)
})

test('preferences reject malformed input before invocation and malformed replies as protocol errors', async (t) => {
  let calls = 0
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => {
      calls++
      if (command === 'bridge_open_session') return opened(request)
      return preferenceReply(request, client.replyPreferences)
    },
  })
  for (const invalid of [
    { ...lowImpact, selectedProfileId: 'profile-1' },
    { ...lowImpact, resourcePreset: 'balanced' },
    { ...lowImpact, idlePolicy: 'shortIdle' },
    { ...lowImpact, schemaVersion: 2 },
    { ...lowImpact, path: '/tmp/private' },
    { ...lowImpact, idlePolicy: undefined },
  ]) {
    await assert.rejects(client.updatePreferences(invalid), { code: 'invalid_request' })
  }
  assert.equal(calls, 0)
  for (const invalid of [
    { ...lowImpact, selectedProfileId: 'profile-1' },
    { ...lowImpact, selectedProfileId: undefined },
    { ...lowImpact, resourcePreset: 'balanced' },
    { ...lowImpact, idlePolicy: 'shortIdle' },
    { ...lowImpact, schemaVersion: 2 },
    { ...lowImpact, extra: true },
    null,
  ]) {
    client.replyPreferences = invalid
    await assert.rejects(client.getPreferences(), { code: 'protocol_error' })
  }
})

test('preferences update rejects a valid but unrequested saved pair', async () => {
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => command === 'bridge_open_session'
      ? opened(request)
      : preferenceReply(request, balanced),
  })
  await assert.rejects(client.updatePreferences(lowImpact), { code: 'protocol_error' })
})

test('preference identity mismatch and native errors preserve protocol/static codes', async (t) => {
  for (const corrupt of [
    (reply) => ({ ...reply, protocolVersion: 2 }),
    (reply) => ({ ...reply, ownerId: 'other' }),
    (reply) => ({ ...reply, sessionId: 'other' }),
    (reply) => ({ ...reply, requestId: 'other' }),
  ]) {
    const client = createDesktopBridgeClient({
      isTauri: () => true,
      invoke: async (command, { request }) => command === 'bridge_open_session'
        ? opened(request)
        : corrupt(preferenceReply(request)),
    })
    await t.test('correlation', () => assert.rejects(client.getPreferences(), { code: 'protocol_error' }))
  }
  for (const code of ['internal', 'unauthorized', 'stale_session']) {
    const client = createDesktopBridgeClient({
      isTauri: () => true,
      invoke: async (command, { request }) => {
        if (command === 'bridge_open_session') return opened(request)
        throw { code, message: 'untrusted detail' }
      },
    })
    await t.test(code, () => assert.rejects(client.updatePreferences(balanced), (error) =>
      error instanceof DesktopBridgeError && error.code === code && !error.message.includes('untrusted')))
  }
  const transport = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => command === 'bridge_open_session' ? opened(request) : Promise.reject(new Error('raw transport detail')),
  })
  await assert.rejects(transport.getPreferences(), (error) =>
    error instanceof DesktopBridgeError && error.code === 'transport_error' && !error.message.includes('raw transport detail'))
})

test('stale preference mutation is not replayed and next explicit call reopens', async () => {
  let opens = 0
  let updates = 0
  const client = createDesktopBridgeClient({
    isTauri: () => true,
    invoke: async (command, { request }) => {
      if (command === 'bridge_open_session') return opened({ ...request, sessionId: `s-${++opens}` })
      if (command === 'bridge_update_preferences' && ++updates === 1) throw { code: 'stale_session' }
      return preferenceReply(request, request.preferences || lowImpact)
    },
  })
  await assert.rejects(client.updatePreferences(balanced), { code: 'stale_session' })
  assert.equal(updates, 1)
  await client.getPreferences()
  assert.equal(opens, 2)
  assert.equal(updates, 1)
})
