// Private recovery fixtures are preserved. TMPDIR is set to the worker scratch directory by the gate.
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, symlinkSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { recoveryStorage } from '../scripts/delivery-recovery'
import type { RecoveryRequest } from '../hooks/delivery-recovery'

function fixture() {
  const configDir = mkdtempSync(join(realpathSync(tmpdir()), 'klyth-recovery-'))
  const sessionId = 'engine-session'
  const request = (input: RecoveryRequest) => recoveryStorage({ ...input, configDir, sessionId })
  const capture = (call = 'tool-1', text = 'Private message', recipient = 'main') => request({ action: 'capture', sender: 'child', toolUseId: call, address: recipient, recipient, text }).id!
  const records = () => request({ action: 'list' }).records!.map(item => request({ action: 'get', id: item.backup.id }).record!)
  const path = (id: string, recipient = 'main') => join(configDir, 'klyth', 'delivery-recovery', sessionId, recipient, id)
  return { configDir, sessionId, request, capture, records, path }
}
const record = (f: ReturnType<typeof fixture>, id: string) => f.records().find(item => item.backup.id === id)!
const script = join(import.meta.dir, '../scripts/delivery-recovery.ts')
async function processRequest(f: ReturnType<typeof fixture>, request: RecoveryRequest) {
  const child = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', script], {
    stdin: new Blob([JSON.stringify({ ...request, configDir: f.configDir, sessionId: f.sessionId })]), stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text()
  return { code: await child.exited, stdout, stderr }
}

test('read-only missing journals do not create private directories', () => {
  const f = fixture()
  expect(f.records()).toEqual([])
  expect(readdirSync(f.configDir)).toEqual([])
})
test('immutable private backups use call identity, not text, recipient or provider cache identity', () => {
  const f = fixture(), id = f.capture(), second = f.capture('tool-2'), child = f.capture('tool-3', 'Private message', 'local-child')
  expect(second).not.toBe(id)
  expect(child).not.toBe(id)
  expect(f.capture()).toBe(id)
  expect(f.records().length).toBe(3)
  const backup = join(f.path(id), 'backup.json'), before = readFileSync(backup, 'utf8')
  expect(statSync(backup).mode & 0o777).toBe(0o600)
  expect(statSync(f.path(id)).mode & 0o777).toBe(0o700)
  expect(statSync(join(f.configDir, 'klyth')).mode & 0o777).toBe(0o700)
  expect(() => f.capture('tool-1', 'different')).toThrow('conflicting')
  expect(readFileSync(backup, 'utf8')).toBe(before)
  expect(record(f, id).outcome).toBe('unknown')
  f.request({ action: 'outcome', id, outcome: 'queued' })
  expect(record(f, id).outcome).toBe('queued')
  expect(record(f, id).attempts).toEqual([])
  expect(readFileSync(backup, 'utf8')).toBe(before)
  expect(recoveryStorage({ action: 'list', configDir: f.configDir, sessionId: 'new-session' }).records).toEqual([])
})
test('input, path, public directory and symlink failures retain prior evidence', () => {
  const f = fixture(), id = f.capture(), before = readFileSync(join(f.path(id), 'backup.json'), 'utf8')
  for (const text of ['', 'x'.repeat(65_537), '💬'.repeat(16_385)]) expect(() => f.capture('oversize', text)).toThrow()
  expect(() => recoveryStorage({ action: 'list', configDir: f.configDir, sessionId: '../escape' })).toThrow()
  expect(() => f.request({ action: 'outcome', id: '../escape', outcome: 'queued' })).toThrow()
  expect(() => f.capture('bad-target', 'text', '../escape')).toThrow()
  expect(readFileSync(join(f.path(id), 'backup.json'), 'utf8')).toBe(before)
  const outside = fixture(), unsafe = fixture()
  symlinkSync(outside.configDir, join(unsafe.configDir, 'klyth'))
  expect(() => unsafe.capture()).toThrow()
  expect(readdirSync(outside.configDir)).toEqual([])
  const publicDir = fixture()
  mkdirSync(join(publicDir.configDir, 'klyth'), { mode: 0o755 })
  chmodSync(join(publicDir.configDir, 'klyth'), 0o755)
  expect(() => publicDir.capture()).toThrow('private')
})
test('128-record and metadata-inclusive byte reservations never evict or truncate backups', () => {
  const count = fixture(), first = count.capture()
  for (let index = 1; index < 128; index++) count.capture(`call-${index}`)
  expect(() => count.capture('over-record-cap')).toThrow('capacity')
  expect(count.request({ action: 'list' }).records!.length).toBe(128)
  expect(count.request({ action: 'get', id: first }).record!.backup.text).toBe('Private message')
  const size = fixture(), text = '\u0000'.repeat(65_536)
  let accepted = 0
  for (let index = 0; index < 128; index++) {
    try { size.capture(`call-${index}`, text); accepted++ } catch (error) { expect(String(error)).toContain('capacity'); break }
  }
  expect(accepted).toBeGreaterThan(1)
  expect(accepted).toBeLessThan(128)
  const records = size.records()
  expect(records.every(item => item.backup.text === text)).toBe(true)
  const reserved = records.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item.backup) + '\n') + 8192, 0)
  expect(reserved).toBeLessThanOrEqual(8 * 1024 * 1024)
})
test('exclusive receipt claims fence concurrent restore, dismissal and stale consent', async () => {
  const observed = fixture(), observationId = observed.capture(), beforeObservation = record(observed, observationId).revision
  observed.request({ action: 'outcome', id: observationId, outcome: 'unknown' })
  expect(() => observed.request({ action: 'claim', id: observationId, revision: beforeObservation, epoch: 'host' })).toThrow()
  const f = fixture(), id = f.capture(), revision = record(f, id).revision
  const results = await Promise.all(Array.from({ length: 4 }, () => processRequest(f, { action: 'claim', id, revision, epoch: 'host-1' })))
  expect(results.filter(result => result.code === 0).length).toBe(1)
  const held = record(f, id)
  expect(held.attempts.length).toBe(1)
  expect(held.attempts[0]!.status).toBe('unknown')
  expect(() => f.request({ action: 'claim', id, revision: held.revision, epoch: 'host-1' })).toThrow()
  expect(() => f.request({ action: 'dismiss', id, revision })).toThrow()
  f.request({ action: 'finish', id, token: held.attempts[0]!.token, status: 'restored', uuid: 'new-row-uuid' })
  expect(record(f, id).attempts[0]).toMatchObject({ status: 'restored', uuid: 'new-row-uuid' })
  expect(() => f.request({ action: 'claim', id, revision: record(f, id).revision, epoch: 'host-2' })).toThrow()
  const g = fixture(), other = g.capture(), reviewed = record(g, other).revision
  const race = await Promise.all([processRequest(g, { action: 'claim', id: other, revision: reviewed, epoch: 'host' }), processRequest(g, { action: 'dismiss', id: other, revision: reviewed })])
  expect(race.filter(result => result.code === 0).length).toBe(1)
  const state = record(g, other)
  expect(Number(state.dismissed) + state.attempts.length).toBe(1)
})
test('concurrent identical capture is idempotent and separate calls keep identical payloads', async () => {
  const f = fixture(), capture: RecoveryRequest = { action: 'capture', sender: 'child', toolUseId: 'same-call', recipient: 'main', address: 'main', text: 'same text' }
  const results = await Promise.all(Array.from({ length: 4 }, () => processRequest(f, capture)))
  expect(results.some(result => result.code === 0)).toBe(true)
  expect(f.records().length).toBe(1)
  await processRequest(f, { ...capture, toolUseId: 'different-call' })
  expect(f.records().length).toBe(2)
})
test('completed pending backup publication survives a missing canonical link and starts unknown', () => {
  const f = fixture(), root = join(f.configDir, 'klyth', 'delivery-recovery', f.sessionId)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const path of [join(f.configDir, 'klyth'), join(f.configDir, 'klyth', 'delivery-recovery'), root]) chmodSync(path, 0o700)
  const id = createHash('sha256').update(JSON.stringify([f.sessionId, 'child', 'crash-call'])).digest('hex')
  const b = { version: 1, id, sessionId: f.sessionId, sender: 'child', toolUseId: 'crash-call', recipient: 'main', address: 'main', text: 'Survives interruption', capturedAt: new Date().toISOString() }
  writeFileSync(join(root, 'slot-0.pending'), JSON.stringify(b) + '\n', { mode: 0o600 })
  expect(record(f, id).backup.text).toBe(b.text)
  expect(record(f, id).outcome).toBe('unknown')
  expect(JSON.parse(readFileSync(join(f.path(id), 'backup.json'), 'utf8'))).toEqual(b)
  f.request({ action: 'claim', id, revision: record(f, id).revision, epoch: 'before-crash' })
  expect(record(f, id).attempts[0]!.status).toBe('unknown')
  expect(() => f.request({ action: 'claim', id, revision: record(f, id).revision, epoch: 'before-crash' })).toThrow()
  const retry = f.request({ action: 'claim', id, revision: record(f, id).revision, epoch: 'after-resume' })
  expect(retry.token).toBeDefined()
  expect(record(f, id).attempts.length).toBe(2)
})
test('refusal and dismissal are separate evidence and retain the original backup bytes', () => {
  const f = fixture(), id = f.capture(), before = readFileSync(join(f.path(id), 'backup.json'), 'utf8')
  f.request({ action: 'outcome', id, outcome: 'refused' })
  const token = f.request({ action: 'claim', id, revision: record(f, id).revision, epoch: 'host' }).token!
  f.request({ action: 'finish', id, token, status: 'refused' })
  expect(record(f, id).attempts[0]!.status).toBe('refused')
  f.request({ action: 'dismiss', id, revision: record(f, id).revision })
  expect(record(f, id).dismissed).toBe(true)
  expect(record(f, id).outcome).toBe('refused')
  expect(readFileSync(join(f.path(id), 'backup.json'), 'utf8')).toBe(before)
})
test('corrupt, symlink and interrupted partial files fail closed without overwriting evidence', () => {
  for (const kind of ['corrupt', 'symlink', 'partial'] as const) {
    const f = fixture(), id = f.capture(), backup = join(f.path(id), 'backup.json'), before = readFileSync(backup, 'utf8')
    const receipt = join(f.path(id), 'receipt-0.pending')
    if (kind === 'symlink') symlinkSync(backup, receipt)
    else writeFileSync(receipt, kind === 'partial' ? '' : '{"kind":"bogus"}', { mode: 0o600 })
    expect(() => f.records()).toThrow()
    expect(readFileSync(backup, 'utf8')).toBe(before)
    expect(() => f.request({ action: 'claim', id, revision: 'not-reviewed', epoch: 'host' })).toThrow()
  }
})

test('non-string identities and tool ids cannot create a usable backup', () => {
  const f = fixture(), base = { action: 'capture', sender: 'child', toolUseId: 'call', recipient: 'main', address: 'main', text: 'message', configDir: f.configDir, sessionId: f.sessionId }
  for (const patch of [{ sender: undefined }, { recipient: null }, { toolUseId: 42 }, { sessionId: undefined }, { address: {} }, { text: [] }]) expect(() => recoveryStorage({ ...base, ...patch } as never)).toThrow()
  expect(f.records()).toEqual([])
})
test('metadata-only listings stay below host output limits and individual get returns full text', () => {
  const f = fixture(), text = 'x'.repeat(65_536)
  for (let index = 0; index < 8; index++) f.capture(`large-${index}`, text)
  const listed = f.request({ action: 'list' }).records!
  expect(listed.every(item => item.backup.text === '')).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(4 * 1024 * 1024)
  expect(f.request({ action: 'get', id: listed[0]!.backup.id }).record!.backup.text).toBe(text)
})
