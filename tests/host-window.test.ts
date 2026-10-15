// Host-window policy uses versioned session state; registered lifecycle tests cover clear/resume handoff.
import { expect, test } from 'claude-code/testing'
import { applyHostWindow, type HostWindowPort, type HostWindowState } from '../hooks/host-window'
import { parseConfig } from '../hooks/config'

function world(initial?: string) {
  let environment = initial, value: HostWindowState | undefined, version = 0
  const writes: (string | undefined)[] = [], notes: string[] = []
  const stateWrites: HostWindowState[] = []
  const failures = { read: false, environmentRead: false, environmentWrite: false, stateWrite: 0 }
  const io: HostWindowPort = {
    environment: async () => { if (failures.environmentRead) throw new Error('read denied'); return environment },
    setEnvironment: async next => { if (failures.environmentWrite) throw new Error('write denied'); writes.push(next); environment = next },
    state: async () => { if (failures.read) throw new Error('state denied'); return { value, version } },
    setState: async (next, expected) => {
      stateWrites.push(next)
      if (stateWrites.length === failures.stateWrite) throw new Error('state full')
      if (expected !== version) return { isSet: false, version }
      value = next; return { isSet: true, version: ++version }
    },
    debug: text => { notes.push(text) },
  }
  return { io, failures, writes, notes, stateWrites, environment: () => environment, state: () => value, independent: (next: string) => { environment = next } }
}

const configured = (compaction: unknown) => parseConfig(JSON.stringify({ compaction }))
test('valid configs default to the Klyth window, and false and both integer edges are accepted', () => {
  expect(parseConfig('{}').config?.compaction).toEqual({ hostWindow: 777_000, deliveryRecovery: true })
  expect(configured({}).config?.compaction).toEqual({ hostWindow: 777_000, deliveryRecovery: true })
  for (const hostWindow of [false, 100_000, 777_000, 1_000_000]) {
    const parsed = configured({ hostWindow })
    expect(parsed.errors).toEqual([])
    expect(parsed.config?.compaction).toEqual({ hostWindow, deliveryRecovery: true })
  }
})
test('unknown keys, types and ranges reject the entire config', () => {
  for (const compaction of [null, false, [], '777000', { threshold: 777000 }, ...[true, null, '777000', [], {}, 99_999, 1_000_001, 777_000.5].map(hostWindow => ({ hostWindow }))]) {
    const parsed = configured(compaction)
    expect(parsed.config).toBeUndefined()
    expect(parsed.errors.length).toBeGreaterThan(0)
  }
  expect(parseConfig('{"compaction":{},"typo":true}').config).toBeUndefined()
})
test('acquisition captures unset, repeated reloads and updates preserve it, false restores unset', async () => {
  const w = world()
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toEqual({ original: null, applied: '777000' })
  await applyHostWindow(w.io, 777_000)
  await applyHostWindow(w.io, 800_000)
  expect(w.state()).toEqual({ original: null, applied: '800000' })
  await applyHostWindow(w.io, false)
  expect(w.environment()).toBeUndefined()
  expect(w.state()).toBeNull()
  expect(w.writes).toEqual(['777000', '800000', undefined])
})
test('existing values, including empty, restore exactly after an invalid or missing config', async () => {
  for (const initial of ['900000', '']) {
    const w = world(initial)
    await applyHostWindow(w.io, 777_000)
    await applyHostWindow(w.io, 800_000)
    await applyHostWindow(w.io, undefined)
    expect(w.environment()).toBe(initial)
    expect(w.state()).toBeNull()
  }
})
test('removing a custom section reapplies the default instead of releasing ownership', async () => {
  const w = world('900000')
  await applyHostWindow(w.io, configured({ hostWindow: 800_000 }).config?.compaction?.hostWindow)
  await applyHostWindow(w.io, parseConfig('{}').config?.compaction?.hostWindow)
  expect(w.state()).toEqual({ original: '900000', applied: '777000' })
  await applyHostWindow(w.io, false)
  expect(w.environment()).toBe('900000')
})
test('independent writes are not overwritten on restoration or an enabled reload', async () => {
  for (const desired of [false, 800_000] as const) {
    const w = world()
    await applyHostWindow(w.io, 777_000)
    w.independent('600000')
    await applyHostWindow(w.io, desired)
    expect(w.environment()).toBe('600000')
    expect(w.state()).toBeNull()
    expect(w.notes[0]).toContain('independently')
  }
})
test('state and environment read failures and the first reservation failure never write env', async () => {
  for (const failure of ['read', 'environmentRead', 'stateWrite'] as const) {
    const w = world('900000')
    if (failure === 'stateWrite') w.failures.stateWrite = 1
    else w.failures[failure] = true
    await applyHostWindow(w.io, 777_000)
    expect(w.writes).toEqual([])
    expect(w.environment()).toBe('900000')
    expect(w.notes.length).toBe(1)
  }
})
test('an unchanged environment after a rejected write releases the reservation and can retry', async () => {
  const w = world('900000')
  w.failures.environmentWrite = true
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toBeNull()
  expect(w.environment()).toBe('900000')
  w.failures.environmentWrite = false
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toEqual({ original: '900000', applied: '777000' })
})
test('a rejected update preserves the first baseline and the old owned value', async () => {
  const w = world()
  await applyHostWindow(w.io, 777_000)
  w.failures.environmentWrite = true
  await applyHostWindow(w.io, 800_000)
  expect(w.state()).toEqual({ original: null, applied: '777000' })
  w.failures.environmentWrite = false
  await applyHostWindow(w.io, false)
  expect(w.environment()).toBeUndefined()
})
test('final state failure keeps the baseline pending and later reloads decline mutation', async () => {
  const w = world('900000')
  w.failures.stateWrite = 2
  await applyHostWindow(w.io, 777_000)
  expect(w.environment()).toBe('777000')
  expect(w.state()).toEqual({ original: '900000', applied: '777000', pending: true })
  await applyHostWindow(w.io, false)
  expect(w.writes).toEqual(['777000'])
  expect(w.notes[1]).toContain('restart Claude Code')
})
test('a write that mutates then throws preserves pending state rather than forgetting the baseline', async () => {
  const w = world('900000')
  w.io.setEnvironment = async next => { w.independent(next!); throw new Error('uncertain host reply') }
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toEqual({ original: '900000', applied: '777000', pending: true })
  await applyHostWindow(w.io, 800_000)
  expect(w.environment()).toBe('777000')
  expect(w.notes[1]).toContain('unfinished')
})
test('stale concurrent dispatch snapshots cannot both acquire or overwrite ownership', async () => {
  const w = world('900000')
  w.io.state = async () => ({ value: undefined, version: 0 })
  await Promise.all([applyHostWindow(w.io, 777_000), applyHostWindow(w.io, 800_000)])
  expect(w.writes.length).toBe(1)
  expect(w.state()).toEqual({ original: '900000', applied: '777000' })
  expect(w.notes[0]).toContain('ownership changed')
})
test('an independent write after reservation is left alone', async () => {
  const w = world('900000'), save = w.io.setState
  w.io.setState = async (next, version) => { const result = await save(next, version); if (next?.pending) w.independent('600000'); return result }
  await applyHostWindow(w.io, 777_000)
  expect(w.writes).toEqual([])
  expect(w.environment()).toBe('600000')
  expect(w.state()).toBeNull()
})
test('failed restoration keeps the owned value and original baseline for a later retry', async () => {
  const w = world('900000')
  await applyHostWindow(w.io, 777_000)
  w.failures.environmentWrite = true
  await applyHostWindow(w.io, false)
  expect(w.environment()).toBe('777000')
  expect(w.state()).toEqual({ original: '900000', applied: '777000' })
  w.failures.environmentWrite = false
  await applyHostWindow(w.io, false)
  expect(w.environment()).toBe('900000')
  expect(w.state()).toBeNull()
})
test('failed rollback retains a pending baseline instead of permitting another acquisition', async () => {
  const w = world('900000')
  w.failures.environmentWrite = true
  w.failures.stateWrite = 2
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toEqual({ original: '900000', applied: '777000', pending: true })
  w.failures.environmentWrite = false
  await applyHostWindow(w.io, 800_000)
  expect(w.environment()).toBe('900000')
  expect(w.writes).toEqual([])
  expect(w.notes[1]).toContain('unfinished')
})
test('a refused final state write diagnoses uncertainty without discarding pending ownership', async () => {
  const w = world('900000'), save = w.io.setState
  w.io.setState = async (next, version) => next?.pending ? save(next, version) : { isSet: false, version: version + 1 }
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toEqual({ original: '900000', applied: '777000', pending: true })
  expect(w.notes[0]).toContain('after environment write')
  await applyHostWindow(w.io, false)
  expect(w.writes).toEqual(['777000'])
})
test('unreasonably large baselines are declined to keep state bounded', async () => {
  const w = world('x'.repeat(1025))
  await applyHostWindow(w.io, 777_000)
  expect(w.state()).toBeUndefined()
  expect(w.writes).toEqual([])
})
