import { expect, test } from 'claude-code/testing'
import { parseConfig } from '../hooks/config'
import { choiceFor, mainChoiceKey, persistMainChoice, restoreMainChoice } from '../hooks/main-choice'
import type { MainChoicePort } from '../hooks/main-choice'
import { modelCommand } from '../hooks/model'
import { createSession } from '../hooks/session'
import { CONFIG, CONFIG_OBJECT } from './world'

function fixture(store = new Map<string, unknown>(), initialId = 'session-a') {
  const s = createSession()
  s.loaded = { config: parseConfig(CONFIG).config!, errors: [], missing: false, path: 'klyth.json' }
  let id = initialId
  let hot: string | null | undefined
  const writes: string[] = [], notices: string[] = []
  const io: MainChoicePort = {
    sessionId: async () => id,
    get: async key => store.get(key),
    set: async (key, value) => { writes.push(key); store.set(key, JSON.parse(JSON.stringify(value))) },
    main: async () => hot,
    setMain: async value => { hot = value },
    toast: text => { notices.push(text) },
  }
  const select = async (label: string) => modelCommand({ ...io,
    setMain: value => persistMainChoice(io, s, value),
    trusted: async () => true, remember: async () => { throw new Error('must not grant trust') }, ask: async () => { throw new Error('must not ask') },
    contextTokens: async () => 0, debug: () => {}, status: () => {}, home: async () => '', write: async () => {}, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  }, s, { command: 'model', args: label } as never, async () => ({ text: 'native selected' }))
  return { s, io, store, writes, notices, select, id: (value: string) => { id = value } }
}

test('explicit selection survives a fresh Session and fresh host state with the same engine id', async () => {
  const a = fixture()
  await restoreMainChoice(a.io, a.s)
  expect((await a.select('fast')).text).toContain('Set model to fast')
  const b = fixture(a.store)
  await restoreMainChoice(b.io, b.s)
  expect(b.s.main).toBe('fast')
  expect(await b.io.main()).toBe('fast')
  expect(b.writes).toEqual([])
  expect(b.s.approved.size).toBe(0)
})

test('different ids start native; two old sessions restore their own choices after clear/resume', async () => {
  const a = fixture()
  await a.select('fast')
  a.id('session-b')
  await restoreMainChoice(a.io, a.s)
  expect(a.s.main).toBeNull()
  await a.select('strong')
  a.id('session-c')
  await restoreMainChoice(a.io, a.s)
  expect(a.s.main).toBeNull()
  a.id('session-a')
  await restoreMainChoice(a.io, a.s)
  expect(a.s.main).toBe('fast')
  a.id('session-b')
  await restoreMainChoice(a.io, a.s)
  expect(a.s.main).toBe('strong')
  expect(a.store.size).toBe(2)
})

test('explicit native selection tombstones the old choice and survives restart', async () => {
  const a = fixture()
  await a.select('fast')
  await a.select('native/sonnet')
  expect(a.store.get(mainChoiceKey('session-a'))).toEqual({ version: 1, sessionId: 'session-a', label: null })
  const b = fixture(a.store)
  await restoreMainChoice(b.io, b.s)
  expect(b.s.main).toBeNull()
})

for (const [name, config] of [
  ['alias remap', { ...CONFIG_OBJECT, aliases: { ...CONFIG_OBJECT.aliases, fast: 'acme/model-b' } }],
  ['provider origin change', { ...CONFIG_OBJECT, providers: { acme: { ...CONFIG_OBJECT.providers.acme, baseUrl: 'https://changed.invalid/v1' } } }],
  ['provider helper change', { ...CONFIG_OBJECT, providers: { acme: { ...CONFIG_OBJECT.providers.acme, auth: { command: ['/new-helper'] } } } }],
  ['unknown model', { ...CONFIG_OBJECT, providers: {} }],
  ['missing config', undefined],
] as const) test(`restoration and config reload refuse ${name}, with no approval writes`, async () => {
  const a = fixture()
  await a.select('fast')
  const b = fixture(a.store)
  b.s.loaded.config = config === undefined ? undefined : parseConfig(JSON.stringify(config)).config
  await restoreMainChoice(b.io, b.s)
  expect(b.s.main).not.toBeNull()
  expect(b.s.mainChoiceError).toContain('No native/provider fallback')
  expect(b.writes).toEqual([])
  expect(b.s.approved.size).toBe(0)
  b.s.loaded.config = parseConfig(CONFIG).config!
  await restoreMainChoice(b.io, b.s)
  expect(b.s.main).toBe('fast')
  expect(b.s.mainChoiceError).toBeUndefined()
})

for (const [name, bad] of [
  ['future schema', { version: 2, sessionId: 'session-a', label: 'fast' }],
  ['wrong id', { version: 1, sessionId: 'session-b', label: null }],
  ['unexpected authority', { version: 1, sessionId: 'session-a', label: null, approved: true }],
  ['nonplain data', ['fast']],
  ['unbounded label', { version: 1, sessionId: 'session-a', label: 'x'.repeat(257) }],
] as const) test(`invalid saved record refuses ${name} and explicit selection repairs it`, async () => {
  const a = fixture(new Map([[mainChoiceKey('session-a'), bad]]))
  await restoreMainChoice(a.io, a.s)
  expect(a.s.mainChoiceError).toBeDefined()
  expect(a.notices.length).toBe(1)
  expect(a.writes).toEqual([])
  await a.select('fast')
  expect(a.s.mainChoiceError).toBeUndefined()
  expect(a.s.main).toBe('fast')
})

test('store capacity/write failure cannot report successful selection or alter the route', async () => {
  const a = fixture()
  await restoreMainChoice(a.io, a.s)
  a.io.set = async () => { throw new Error('store over 4 MiB') }
  let failed = false
  try { await a.select('fast') } catch { failed = true }
  expect(failed).toBe(true)
  expect(a.s.main).toBeNull()
  expect(await a.io.main()).toBeUndefined()
  expect(a.store.size).toBe(0)
})

test('unavailable store blocks instead of treating its failure as an unrelated native session', async () => {
  const a = fixture()
  a.io.get = async () => { throw new Error('unavailable') }
  await restoreMainChoice(a.io, a.s)
  expect(a.s.mainChoiceError).toBeDefined()
  expect(a.s.main).not.toBeNull()
})

test('session change while a write waits cannot install another session choice', async () => {
  const a = fixture()
  let release = () => {}, entered = () => {}
  const held = new Promise<void>(r => { release = r })
  const writing = new Promise<void>(r => { entered = r })
  const set = a.io.set
  a.io.set = async (key, value) => { entered(); await held; await set(key, value) }
  const pending = a.select('fast').then(() => false, () => true)
  await writing
  a.id('session-b')
  const restoring = restoreMainChoice(a.io, a.s)
  release()
  expect(await pending).toBe(true)
  await restoring
  expect(a.s.main).toBeNull()
  expect(a.store.has(mainChoiceKey('session-b'))).toBe(false)
})

test('hook reload restores without rewriting the store and never treats old hot state as durable authority', async () => {
  const a = fixture()
  await a.select('fast')
  const b = fixture(a.store)
  await b.io.setMain('fast')
  await restoreMainChoice(b.io, b.s)
  expect(b.writes).toEqual([])
  const legacy = fixture()
  await legacy.io.setMain('strong')
  await restoreMainChoice(legacy.io, legacy.s)
  expect(legacy.s.main).toBeNull()
  expect(legacy.store.size).toBe(0)
})

test('failed native tombstone is actionable and a retry really clears durable choice', async () => {
  const a = fixture()
  await a.select('fast')
  const set = a.io.set
  a.io.set = async () => { throw new Error('disk full') }
  await a.select('native/sonnet')
  expect(a.s.main).toBeNull()
  expect(a.notices.at(-1)).toContain('could not be saved')
  const resumed = fixture(a.store)
  await restoreMainChoice(resumed.io, resumed.s)
  expect(resumed.s.main).toBe('fast')
  a.io.set = set
  await a.select('native/sonnet')
  const retried = fixture(a.store)
  await restoreMainChoice(retried.io, retried.s)
  expect(retried.s.main).toBeNull()
})
