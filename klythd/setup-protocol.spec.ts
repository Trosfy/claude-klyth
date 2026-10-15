import { expect, test } from 'bun:test'
import { setupEvent, setupFrames, setupRequest, SETUP_FRAME_MAX } from '../hooks/setup-protocol'

const connection = { provider: 'gateway', kind: 'openai', baseUrl: 'https://gateway.invalid/v1', allowHttp: false, auth: { kind: 'none' } }
const save = { version: 1, action: 'save', connection, expectedRevision: null, model: { id: 'model-a', contextWindow: 32000, maxOutputTokens: 4000 } }

test('setup requests accept the concrete nonsecret operation shapes', () => {
  for (const request of [
    { version: 1, action: 'inspect' }, { version: 1, action: 'presence', provider: 'gateway' },
    { version: 1, action: 'login', provider: 'chatgpt', client: 'official' },
    { version: 1, action: 'models', connection }, save,
    { ...save, connection: { ...connection, auth: { kind: 'existing', provider: 'old', revision: 'a'.repeat(64) } } },
    { ...save, connection: { ...connection, auth: { kind: 'chatgpt', client: 'official', handle: 'b'.repeat(32) } } },
  ]) expect<unknown>(setupRequest(request)).toEqual(request)
})

test('setup rejects incomplete saves, ambiguous auth and unsafe endpoint input before effects', () => {
  for (const request of [
    { version: 1, action: 'login', provider: 'gateway', client: 'zz-test' },
    { ...save, connection: { ...connection, auth: { kind: 'chatgpt', client: 'zz-test', handle: 'b'.repeat(32) } } },
    { ...save, version: 2 }, { ...save, secret: 'never-pass' }, { ...save, model: { id: 'model-a' } },
    { ...save, expectedRevision: 'wrong' }, { ...save, alias: 'bad..alias' },
    { ...save, connection: { ...connection, provider: 'native' } },
    { ...save, connection: { ...connection, auth: { kind: 'none', key: 'never-pass' } } },
    { ...save, connection: { ...connection, baseUrl: 'https://user:password@gateway.invalid' } },
    { ...save, connection: { ...connection, baseUrl: 'https://gateway.invalid?token=never-pass' } },
    { ...save, connection: { ...connection, baseUrl: 'http://gateway.invalid' } },
  ]) expect(setupRequest(request)).toBeUndefined()
  expect(setupRequest({ ...save, connection: { ...connection, baseUrl: 'http://127.0.0.1:8000/v1', allowHttp: true } })).toBeDefined()
})

test('setup accepts bounded descriptors and profile-bound challenges, never callback or credential data', () => {
  expect(setupEvent({ version: 1, type: 'models', models: [{ id: 'model-a' }] })).toBeDefined()
  expect(setupEvent({ version: 1, type: 'browser-challenge', authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture', expiresAt: 1000 })).toBeDefined()
  for (const event of [
    { version: 1, type: 'device-challenge', verificationUrl: 'https://unregistered.invalid/device', userCode: 'CODE', expiresAt: 1000 },
    { version: 1, type: 'models', models: [{ id: 'model-a' }, { id: 'model-a' }] },
    { version: 1, type: 'models', models: [{ id: 'bad\u001b[31m' }] },
    { version: 1, type: 'models', models: Array.from({ length: 101 }, (_, i) => ({ id: `model-${i}` })) },
    { version: 1, type: 'credentials-saved', handle: 'a'.repeat(32), accessToken: 'never-pass' },
    { version: 1, type: 'browser-challenge', authorizeUrl: 'https://wrong.invalid/api/accounts/authorize', expiresAt: 1000 },
    { version: 1, type: 'browser-challenge', authorizeUrl: 'http://127.0.0.1:1455/auth/callback?code=never-pass', expiresAt: 1000 },
    { version: 1, type: 'failed', code: 'raw upstream failure' },
  ]) expect(setupEvent(event)).toBeUndefined()
})

test('setup frames validate fragmented and coalesced events before delivering them', () => {
  const received: unknown[] = [], frames = setupFrames(event => received.push(event))
  const first = { version: 1, type: 'presence', status: 'unknown' }, last = { version: 1, type: 'done' }
  const wire = `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`
  frames.feed(wire.slice(0, 7)); frames.feed(wire.slice(7)); frames.end()
  expect(received).toEqual([first, last])
})

test('setup frames fail closed on malformed, incomplete or oversized output', () => {
  expect(() => setupFrames(() => {}).feed('not-json\n')).toThrow('invalid setup event')
  expect(() => setupFrames(() => {}).feed('x'.repeat(SETUP_FRAME_MAX + 1))).toThrow('bound')
  expect(() => setupFrames(() => {}).feed('x'.repeat(512 * 1024 + 1))).toThrow('bound')
  const partial = setupFrames(() => {})
  partial.feed('{')
  expect(() => partial.end()).toThrow('incomplete')
})
