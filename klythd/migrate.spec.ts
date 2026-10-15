// Core auth entry-point behavior over shared offline worlds.
import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli } from '../scripts/auth'
import type { Run } from '../scripts/credential-store'
import { keychain, lookup, secretTool } from '../scripts/credential-store'
import { migrate } from '../scripts/migrate'
import { migrateHostIdentity } from '../scripts/migrate-host'
import { HOST, KEY, OTHER_HOST, V1, args, folder, world } from './fixtures/migrate-world'

for (const [kind, value] of [['api', KEY], ['registered', V1]] as const) {
  test(`migrates the complete ${kind} record exactly, verifies it, and preserves source by default`, async () => {
    const w = world({ source: value! })
    if (kind === 'registered') writeFileSync(join(w.dir, 'styx-host-id'), HOST, { mode: 0o600 })
    expect(await w.run()).toBe(0)
    expect(w.items).toEqual({ 'styx:acme': value, 'klyth:acme': value })
    expect(w.log).toEqual(['take:klyth', 'take:styx', 'read:styx:acme', 'read:klyth:acme', 'create:klyth:acme', 'read:klyth:acme', 'release:styx', 'release:klyth'])
    expect(w.calls.find(c => c.input)?.input).not.toContain(' -U ')
    expect(w.said()).toContain('source preserved')
    expect(w.said()).toContain('Do not let both copies refresh concurrently')
    for (const secret of [KEY, 'refresh-secret', 'access-secret']) expect(JSON.stringify([w.out, w.err, w.calls.map(c => c.argv)])).not.toContain(secret)
    if (kind === 'registered') { expect(readFileSync(join(w.dir, 'klyth-host-id'), 'utf8')).toBe(HOST); expect(lstatSync(join(w.dir, 'klyth-host-id')).mode & 0o777).toBe(0o600) }
    else expect(existsSync(join(w.dir, 'klyth-host-id'))).toBe(false)
  })
}

test('registered-login host identity crosses migration and the ordinary Klyth token reader', async () => {
  const w = world({ source: V1 })
  const source = join(w.dir, 'styx-host-id'), destination = join(w.dir, 'klyth-host-id')
  w.io.hostIdPath = source
  w.io.now = () => 1_800_000_000_000
  w.io.random = n => new Uint8Array(n).fill(41)
  // The real host-ID producer runs before the busy listener; the network and browser ports still reject use.
  w.io.listen = () => new Error('synthetic occupied listener')
  expect(await cli(['login', 'acme', '--chatgpt'], w.io)).toBe(1)
  const produced = readFileSync(source, 'utf8')
  expect(await w.run()).toBe(0)
  expect(readFileSync(destination, 'utf8')).toBe(produced)
  expect(readFileSync(source, 'utf8')).toBe(produced)
  expect(lstatSync(destination).mode & 0o777).toBe(0o600)
  expect(w.items).toEqual({ 'styx:acme': V1, 'klyth:acme': V1 })
  w.io.hostIdPath = destination
  w.out.length = 0
  w.log.length = 0
  expect(await cli(['token', 'acme'], w.io)).toBe(0)
  expect(w.out).toEqual(['access-secret'])
  expect(w.log).toEqual(['read:klyth:acme'])
  expect(w.items).toEqual({ 'styx:acme': V1, 'klyth:acme': V1 })
})

test('identical destination permits an idempotent retry, without another create', async () => {
  const w = world({ destination: KEY })
  expect(await w.run()).toBe(0)
  expect(await w.run()).toBe(0)
  expect(w.calls.some(c => c.input)).toBe(false)
  expect(w.items).toEqual({ 'styx:acme': KEY, 'klyth:acme': KEY })
})
for (const [label, faults, message] of [
  ['absent source', { source: null }, 'no source item'],
  ['unreadable source', { failRead: 'styx:acme' }, 'source keyring lookup failed'],
  ['unreadable destination', { failRead: 'klyth:acme' }, 'destination keyring lookup failed'],
  ['different destination', { destination: 'other-key' }, 'different item'],
  ['creation failure', { refuseCreate: true }, 'create failed'],
  ['creation race', { race: 'other-key' }, 'create failed'],
  ['readback mismatch', { readback: 'other-key' }, 'readback did not verify'],
  ['readback unavailable', { failLaterRead: 'klyth:acme' }, 'readback did not verify'],
  ['source unreadable before retirement', { failLaterRead: 'styx:acme' }, 'source changed'],
  ['source changed', { changed: 'rotated-key' }, 'source changed'],
  ['removal failure', { refuseRemove: true }, 'source removal failed'],
  ['removal not performed', { removeNoop: true }, 'removal could not be verified'],
  ['runner throws', { throwRun: true }, 'lookup failed'],
] as const) {
  test(`${label} fails closed and preserves source`, async () => {
    const w = world(faults)
    expect(await w.run('--retire-source')).toBe(1)
    expect(w.said()).toContain(message)
    expect(w.items['styx:acme']).toBe(faults.source === null ? undefined : 'changed' in faults ? faults.changed : KEY)
    if ('race' in faults) expect(w.items['klyth:acme']).toBe('other-key')
    expect(w.log.slice(-2)).toEqual(['release:styx', 'release:klyth'])
    expect(w.said()).not.toContain(KEY)
  })
}

test('retirement happens only after verified complete record and host preservation', async () => {
  const w = world({ source: V1 })
  writeFileSync(join(w.dir, 'styx-host-id'), HOST, { mode: 0o600 })
  expect(await w.run('--retire-source')).toBe(0)
  expect(w.log).toEqual(['take:klyth', 'take:styx', 'read:styx:acme', 'read:klyth:acme', 'create:klyth:acme', 'read:klyth:acme', 'read:styx:acme', 'delete:styx:acme', 'read:styx:acme', 'release:styx', 'release:klyth'])
  expect(w.items).toEqual({ 'klyth:acme': V1 })
  expect(readFileSync(join(w.dir, 'styx-host-id'), 'utf8')).toBe(HOST)
  expect(readFileSync(join(w.dir, 'klyth-host-id'), 'utf8')).toBe(HOST)
})

for (const namespace of ['klyth', 'styx']) for (const fault of ['failLock', 'throwLock'] as const) {
  test(`${fault} on ${namespace} releases acquired locks and never reads the keyring`, async () => {
    const w = world({ [fault]: namespace })
    expect(await w.run()).toBe(1)
    expect(w.calls).toEqual([])
    expect(w.log).toEqual(namespace === 'klyth' ? ['take:klyth'] : ['take:klyth', 'take:styx', 'release:klyth'])
    expect(w.said()).not.toContain(KEY)
  })
}

test('a safe retry verifies the partial destination before retiring the source', async () => {
  const w = world({ readback: 'transient-other-key' })
  expect(await w.run('--retire-source')).toBe(1)
  expect(w.items).toEqual({ 'styx:acme': KEY, 'klyth:acme': KEY })
  const retry = world({ destination: w.items['klyth:acme'] })
  expect(await retry.run('--retire-source')).toBe(0)
  expect(retry.items).toEqual({ 'klyth:acme': KEY })
  expect(retry.calls.some(c => c.input)).toBe(false)
})

for (const value of ['', 'v1|broken', 'zz1|broken', 'api-key\n', 'bad key', 'non-ascii-€']) {
  test(`invalid complete record is rejected (${JSON.stringify(value)})`, async () => {
    const w = world({ source: value })
    expect(await w.run('--retire-source')).toBe(1)
    expect(w.said()).toContain(value.includes('|') ? 'looks like a sign-in record; nothing stored' : 'not a recognized credential record')
    expect(w.items).toEqual({ 'styx:acme': value })
  })
}

test('migration flags require explicit source and stopped-runtime acknowledgment without echoing input', async () => {
  for (const input of [[], ['migrate', 'acme'], ['migrate', 'acme', '--from', 'styx'], ['migrate', 'acme', '--from', 'klyth', '--runtimes-stopped'], [...args, '--retire-source', '--retire-source'], [...args, KEY], [...args, '--write-config'], [...args, '--from', 'styx']]) {
    const w = world()
    expect(await cli(input, w.io)).toBe(2)
    expect([w.calls, w.log]).toEqual([[], []])
    expect(w.said()).not.toContain(KEY)
  }
  const w = world()
  await cli(['migrate'], w.io)
  expect(w.said()).toContain('both old and new runtimes and all other auth commands are stopped')
})

test('Linux migration is unsupported before lookup, locks or writes, while ordinary secret-tool commands stay namespaced', async () => {
  const w = world({ linux: true })
  expect(await w.run()).toBe(1)
  expect(w.said()).toContain('unsupported')
  expect([w.calls, w.log]).toEqual([[], []])
  const store = secretTool('/synthetic/secret-tool')
  expect(store.read('acme')).toEqual(['/synthetic/secret-tool', 'lookup', 'service', 'klyth', 'provider', 'acme'])
  expect(store.create).toBeUndefined()
})

test('lookups distinguish found, missing and backend errors; unknown Linux diagnostics fail closed', async () => {
  for (const store of [keychain('styx'), keychain(), secretTool('/fake')]) {
    expect(await lookup(async () => ({ exitCode: 0, stdout: `${V1}\n` }), store, 'acme')).toEqual({ status: 'found', value: V1 })
    for (const result of [{ exitCode: 51, stdout: '' }, { exitCode: 127, stdout: '' }, { exitCode: 1, stdout: '', stderr: 'locked' }]) expect(await lookup(async () => result, store, 'acme')).toEqual({ status: 'error' })
  }
  expect(await lookup(async () => ({ exitCode: 44, stdout: '' }), keychain(), 'acme')).toEqual({ status: 'missing' })
  expect(await lookup(async () => ({ exitCode: 1, stdout: '', stderr: '' }), secretTool('/fake'), 'acme')).toEqual({ status: 'error' })
  expect(await lookup(async () => ({ exitCode: 1, stdout: '' }), secretTool('/fake'), 'acme')).toEqual({ status: 'error' })
})

test('Linux absence needs a successful empty metadata search for the exact namespace and provider', async () => {
  const empty = { exitCode: 0, stdout: '', stderr: '' }
  for (const namespace of ['styx', 'klyth']) for (const provider of ['acme', 'other']) {
    for (const [result, status] of [
      [empty, 'missing'],
      [{ exitCode: 0, stdout: '[/1]\nlabel = locked item\n', stderr: '' }, 'error'],
      [{ exitCode: 0, stdout: '', stderr: 'secret-tool: synthetic backend failure' }, 'error'],
      [{ exitCode: 0, stdout: '' }, 'error'],
      [{ exitCode: 1, stdout: '', stderr: '' }, 'error'],
      [{ exitCode: 127, stdout: '', stderr: '' }, 'error'],
    ] as const) {
      const calls: (readonly string[])[] = []
      const run: Run = async argv => {
        calls.push(argv)
        return argv[1] === 'lookup' ? { exitCode: 1, stdout: '', stderr: '' } : result
      }
      expect(await lookup(run, secretTool('/synthetic/secret-tool', namespace), provider)).toEqual({ status })
      expect(calls).toEqual([
        ['/synthetic/secret-tool', 'lookup', 'service', namespace, 'provider', provider],
        ['/synthetic/secret-tool', 'search', '--all', 'service', namespace, 'provider', provider],
      ])
    }
  }
  expect(await lookup(async argv => {
    if (argv[1] === 'search') throw new Error(KEY)
    return { exitCode: 1, stdout: '', stderr: '' }
  }, secretTool('/synthetic/secret-tool'), 'acme')).toEqual({ status: 'error' })
})

test('ordinary login variants and list cannot treat a failed lookup as absence or contact a provider', async () => {
  for (const platform of ['darwin', 'linux']) for (const flags of [[], ['--chatgpt'], ['import']]) {
    const w = world()
    w.io.platform = platform
    w.io.run = async () => ({ exitCode: platform === 'darwin' ? 51 : 1, stdout: '', stderr: KEY })
    w.io.readKey = async () => flags[0] === 'import' ? V1 : KEY
    expect(await cli(['login', 'acme', ...(flags[0] === 'import' ? [] : flags)], w.io)).toBe(1)
    expect(w.said()).toContain('lookup failed')
    expect(w.said()).not.toContain(KEY)
    expect(await cli(['list', 'acme'], w.io)).toBe(platform === 'linux' ? 0 : 1)
    expect(w.out).toEqual(platform === 'linux' ? ['acme: presence unknown (tool available) in the secret-tool'] : [])
  }
})

test('ordinary token and list consult Klyth only, never a populated legacy namespace', async () => {
  const w = world({ source: V1 })
  expect(await cli(['token', 'acme'], w.io)).toBe(1)
  expect(await cli(['list', 'acme'], w.io)).toBe(0)
  expect(w.log).toEqual(['read:klyth:acme', 'read:klyth:acme'])
  expect(w.items).toEqual({ 'styx:acme': V1 })
  expect(w.out).toEqual(['acme: no item in the macOS Keychain'])
})

for (const problem of ['missing', 'malformed', 'wide-mode', 'symlink', 'directory', 'oversize', 'destination-conflict', 'destination-symlink', 'destination-mode', 'parent-symlink']) {
  test(`host identity ${problem} prevents credential copy and retirement`, async () => {
    const w = world({ source: V1 }), source = join(w.dir, 'styx-host-id'), destination = join(w.dir, 'klyth-host-id')
    if (problem === 'directory') mkdirSync(source)
    else if (problem === 'symlink') { writeFileSync(join(w.dir, 'elsewhere'), HOST, { mode: 0o600 }); symlinkSync(join(w.dir, 'elsewhere'), source) }
    else if (problem !== 'missing') writeFileSync(source, problem === 'malformed' ? 'not-a-host' : problem === 'oversize' ? 'a'.repeat(65) : HOST, { mode: 0o600 })
    if (problem === 'wide-mode') chmodSync(source, 0o644)
    if (problem === 'destination-conflict') writeFileSync(destination, OTHER_HOST, { mode: 0o600 })
    if (problem === 'destination-symlink') symlinkSync(source, destination)
    if (problem === 'destination-mode') writeFileSync(destination, HOST, { mode: 0o644 })
    if (problem === 'parent-symlink') { const link = join(folder(), 'linked'); symlinkSync(w.dir, link); w.io.configPath = join(link, 'klyth.json') }
    expect(await w.run('--retire-source')).toBe(1)
    expect(w.said()).toContain('host identity')
    expect(w.items).toEqual({ 'styx:acme': V1 })
    if (problem === 'destination-conflict') expect(readFileSync(destination, 'utf8')).toBe(OTHER_HOST)
  })
}

test('host migration is idempotent, preserves exact new bytes and never replaces a raced destination', () => {
  const dir = folder()
  writeFileSync(join(dir, 'styx-host-id'), HOST, { mode: 0o600 })
  migrateHostIdentity(dir, 'styx', 'klyth')
  const before = lstatSync(join(dir, 'klyth-host-id'))
  migrateHostIdentity(dir, 'styx', 'klyth')
  expect(lstatSync(join(dir, 'klyth-host-id')).ino).toBe(before.ino)
  const raced = folder()
  writeFileSync(join(raced, 'styx-host-id'), HOST, { mode: 0o600 })
  const original = fs.linkSync
  const spy = spyOn(fs, 'linkSync').mockImplementation((from, to) => { writeFileSync(to, OTHER_HOST, { mode: 0o600 }); original(from, to) })
  try { expect(() => migrateHostIdentity(raced, 'styx', 'klyth')).toThrow('did not verify') } finally { spy.mockRestore() }
  expect(readFileSync(join(raced, 'klyth-host-id'), 'utf8')).toBe(OTHER_HOST)
})

test('coordinator refuses unexpected namespaces rather than turning into a general keyring copier', async () => {
  const w = world()
  expect((await migrate({ ...w.io, hostIdentity: () => {} }, 'acme', keychain('other'), keychain(), false)).ok).toBe(false)
  expect([w.log, w.calls]).toEqual([[], []])
})

test('reserved complete and malformed sign-in records cannot migrate as API keys', async () => {
  for (const value of ['zz1|client|refresh|1800003600||access', 'zz1|broken', 'v1|broken', 'v1|client|refresh|soon||access']) {
    const w = world({ source: value })
    expect(await w.run('--retire-source')).toBe(1)
    expect(w.items).toEqual({ 'styx:acme': value })
    expect(w.calls.some(call => call.input !== undefined)).toBe(false)
    expect(w.said()).toContain('looks like a sign-in record; nothing stored')
  }
})
