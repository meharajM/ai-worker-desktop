import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopBridgeClient, DesktopBridgeError } from '../src/renderer/src/desktop-bridge.ts'

const opened = (request) => ({
  protocolVersion: 1,
  ownerId: 'main',
  sessionId: 's-1',
  requestId: request.requestId,
})

test('browser preview reports unavailable without invoking native commands', async () => {
  let calls = 0
  const client = createDesktopBridgeClient({ isTauri: () => false, invoke: async () => { calls++ } })
  assert.equal(client.isAvailable(), false)
  await assert.rejects(client.getStatus(), { code: 'unavailable' })
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
