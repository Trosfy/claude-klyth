// How long klythd waits idle before it exits: ten minutes, or five past the longest cache lifetime a model or
// alias sets, read from the config of each call and never shortened, so the signed thinking it holds for a
// tool turn outlives the provider's cache.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { idleLimit, serve } from './main'

const MIN = 10 * 60_000
const HOUR_PLUS = 65 * 60_000
const model = { contextWindow: 100_000, maxOutputTokens: 8000 }
// A config of one anthropic provider with the given model-level cache and aliases.
const configOf = (cache: string | undefined, aliases: Record<string, unknown> = {}) =>
  JSON.stringify({
    providers: { cl: { kind: 'anthropic', baseUrl: 'https://cl.invalid', auth: { command: ['/bin/echo', 'k'] }, models: { m: { ...model, ...(cache === undefined ? {} : { cache }) } } } },
    aliases,
  })
const parsed = (text: string) => parseConfig(text).config as Config

test('the limit is ten minutes, or five past the longest cache lifetime a model or alias sets: 65 minutes for one hour', () => {
  expect(idleLimit(parsed(configOf(undefined)))).toBe(MIN)
  expect(idleLimit(parsed(configOf('5m')))).toBe(MIN)
  expect(idleLimit(parsed(configOf('1h')))).toBe(HOUR_PLUS)
  expect(idleLimit(parsed(configOf(undefined, { deep: { target: 'cl/m', cache: '1h' } })))).toBe(HOUR_PLUS)
  // An alias that turns its model's cache off does not count; its model's own setting does.
  expect(idleLimit(parsed(configOf('1h', { off: { target: 'cl/m', cache: null } })))).toBe(HOUR_PLUS)
})

const dir = mkdtempSync(join(tmpdir(), 'klythd-idle-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('klythd starts at ten minutes, grows to what the config of a call needs, and does not shrink when a later call carries a config that needs less', async () => {
  const sock = join(dir, 'd.sock')
  const { server, limitMs } = serve(sock, 'tok', { version: '0.2.0', post: async () => ({ cut: { kind: 'reset', detail: 'unused' } }), run: async () => ({ exitCode: 0, stdout: '' }), sleep: async () => {}, now: () => 0, log: () => {} })
  try {
    const call = (configText: string) => fetch('http://klythd/status', { method: 'POST', body: JSON.stringify({ token: 'tok', configText, approved: [] }), unix: sock } as RequestInit)
    expect(limitMs()).toBe(MIN)
    await call(configOf('5m'))
    expect(limitMs()).toBe(MIN)
    await call(configOf('1h'))
    expect(limitMs()).toBe(HOUR_PLUS)
    await call(configOf(undefined))
    expect(limitMs()).toBe(HOUR_PLUS)
    // A call without the token, or with a config that does not parse, changes nothing.
    await fetch('http://klythd/status', { method: 'POST', body: JSON.stringify({ token: 'bad', configText: configOf('1h') }), unix: sock } as RequestInit)
    await call('not json')
    expect(limitMs()).toBe(HOUR_PLUS)
  } finally {
    await server.stop(true)
  }
})
