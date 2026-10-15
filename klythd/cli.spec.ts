// Core auth entry-point behavior over shared offline worlds.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { tokenCommandFor } from '../scripts/cli'
import { KEY, NOW, SECURITY, validConfig, world } from './fixtures/cli-world'

test('root and auth help plus version do not inspect config, keyring, or identity', async () => {
  const w = world({ config: '{ malformed and private: "secret-marker"' })
  for (const args of [[], ['--help'], ['auth'], ['auth', '--help'], ['auth', 'help', 'status'], ['auth', 'login', '--help'], ['auth', 'login', 'chatgpt', '--help'], ['auth', 'login', 'chatgpt', 'help'], ['auth', 'login', 'api-key', '--help'], ['auth', 'status', '--help'], ['auth', 'logout', '--help'], ['auth', 'token', '--help'], ['auth', 'export', '--help'], ['auth', 'migrate', '--help'], ['doctor', '--help']]) {
    expect(await w.run(...args)).toBe(0)
  }
  expect(await w.run('--version')).toBe(0)
  expect(w.out.some(line => line.includes('setup'))).toBe(false)
  expect(w.said()).not.toContain('secret-marker')
  expect([w.calls, w.fetches, w.listeners, w.keyReads, w.stdinReads]).toEqual([[], [], [], 0, 0])
})

test('doctor JSON is a bounded local summary and never reads credentials or runs tools', async () => {
  const w = world({ platform: 'linux', secretTool: true, config: validConfig })
  expect(await w.run('doctor', '--json')).toBe(0)
  expect(JSON.parse(w.out[0] as string)).toEqual({
    version: 1,
    cliVersion: expect.any(String),
    runtime: 'source',
    platform: 'linux',
    config: { status: 'valid', providers: 1, models: 1 },
    keyring: { status: 'available', tool: 'secret-tool' },
  })
  expect([w.calls, w.fetches, w.listeners]).toEqual([[], [], []])
})

test('doctor hides malformed config details and rejects unknown or repeated options before reading config', async () => {
  const invalid = world({ platform: 'linux', secretTool: true, config: '{"providers":{"alpha":{"secret":"sk-doctor-secret"}}}' })
  expect(await invalid.run('doctor', '--json')).toBe(1)
  expect(JSON.parse(invalid.out[0] as string).config).toEqual({ status: 'invalid', providers: 0, models: 0 })
  expect(invalid.said()).not.toContain('sk-doctor-secret')
  for (const args of [['--unknown-secret'], ['--json', '--json']]) {
    const w = world({ config: '{not-json}' })
    expect(await w.run('doctor', ...args)).toBe(2)
    expect([w.calls, w.fetches, w.listeners]).toEqual([[], [], []])
  }
})

test('API-key login requires explicit stdin when non-interactive and never consumes implicit stdin', async () => {
  const piped = world({ tty: false })
  expect(await piped.run('auth', 'login', 'api-key', 'alpha')).toBe(1)
  expect([piped.calls, piped.keyReads, piped.stdinReads]).toEqual([[], 0, 0])
  expect(piped.said()).toContain('requires --stdin')

  const argument = world({ tty: false })
  expect(await argument.run('auth', 'login', 'api-key', 'alpha', KEY)).toBe(2)
  expect(argument.said()).not.toContain(KEY)
  expect([argument.calls, argument.stdinReads]).toEqual([[], 0])
})

test('explicit API-key stdin stores only through the keyring and never appears in argv or output', async () => {
  const w = world({ tty: false })
  expect(await w.run('auth', 'login', 'api-key', 'alpha', '--stdin')).toBe(0)
  expect(w.stdinReads).toBe(1)
  expect(w.items['alpha']).toBe(KEY)
  expect(w.calls.some(call => call.input?.includes(KEY))).toBe(true)
  expect(JSON.stringify([w.calls.map(call => call.argv), w.out, w.err])).not.toContain(KEY)
})

test('API-key --write updates only an existing provider and fails before reading a key when absent', async () => {
  const configured = world({ config: validConfig })
  expect(await configured.run('auth', 'login', 'api-key', 'alpha', '--write')).toBe(0)
  const auth = JSON.parse(readFileSync(configured.configPath, 'utf8')).providers.alpha.auth
  expect(auth.command).toEqual([SECURITY, 'find-generic-password', '-s', 'klyth', '-a', 'alpha', '-w'])
  expect(auth.ttlSeconds).toBeUndefined()

  const missing = world()
  expect(await missing.run('auth', 'login', 'api-key', 'alpha', '--write')).toBe(1)
  expect([missing.calls, missing.keyReads, missing.stdinReads]).toEqual([[], 0, 0])
})

test('API-key grammar rejects duplicates, misplaced flags, extra arguments, and native IDs without effects', async () => {
  for (const args of [
    ['auth', 'login', 'api-key', 'native'],
    ['auth', 'login', 'api-key', 'alpha', '--write', '--write-config'],
    ['auth', 'login', 'api-key', 'alpha', '--stdin', '--stdin'],
    ['auth', 'login', 'api-key', 'alpha', '--port', '1234'],
    ['auth', 'login', 'api-key', 'alpha', 'extra'],
  ]) {
    const w = world()
    expect(await w.run(...args)).toBe(2)
    expect([w.calls, w.keyReads, w.stdinReads]).toEqual([[], 0, 0])
  }
})

test('non-TTY OAuth login is refused before any keyring, callback, or network operation', async () => {
  const w = world({ tty: false })
  expect(await w.run('auth', 'login', 'chatgpt')).toBe(1)
  expect(w.said()).toContain('interactive terminal')
  expect([w.calls, w.fetches, w.listeners, w.keyReads, w.stdinReads]).toEqual([[], [], [], 0, 0])
})

test('auth status uses metadata-only presence and never prints key values', async () => {
  const mac = world({ config: validConfig, items: { alpha: KEY } })
  expect(await mac.run('auth', 'status', 'alpha', '--json')).toBe(0)
  const report = JSON.parse(mac.out[0] as string)
  expect(report).toEqual({ config: 'valid', keyring: { status: 'available', tool: 'security' }, providers: [{ id: 'alpha', configured: true, presence: 'present' }] })
  expect(mac.calls).toHaveLength(1)
  expect(mac.calls[0]?.argv).not.toContain('-w')
  expect(mac.said()).not.toContain(KEY)

  const linux = world({ platform: 'linux', secretTool: true, config: validConfig, items: { alpha: KEY } })
  expect(await linux.run('auth', 'status', 'alpha', '--json')).toBe(0)
  expect(JSON.parse(linux.out[0] as string).providers).toEqual([{ id: 'alpha', configured: true, presence: 'unknown' }])
  expect([linux.calls, linux.fetches]).toEqual([[], []])
})

test('status usage errors and invalid config never disclose parser details or read stored credentials', async () => {
  const invalid = world({ config: '{"providers":{"alpha":{"apiKey":"sk-status-secret"}}}' })
  expect(await invalid.run('auth', 'status', '--json')).toBe(1)
  expect(JSON.parse(invalid.out[0] as string)).toEqual({ config: 'invalid', keyring: { status: 'available', tool: 'security' }, providers: [] })
  expect(invalid.said()).not.toContain('sk-status-secret')
  expect(invalid.calls).toEqual([])
  for (const args of [['auth', 'status', 'native'], ['auth', 'status', 'alpha', 'beta'], ['auth', 'status', '--json', '--json']]) {
    const w = world()
    expect(await w.run(...args)).toBe(2)
    expect([w.calls, w.fetches]).toEqual([[], []])
  }
})

test('legacy auth receives official login and emits the compiled immutable token argv', async () => {
  const executable = '/opt/klyth/0.1.0/klyth'
  const expected = [executable, 'auth', 'token', 'chatgpt']
  const w = world({ oauth: true })
  w.io.tokenCommand = id => tokenCommandFor(id, { compiled: true, executable, cliPath: '/checkout/scripts/cli.ts' })
  expect(await w.run('auth', 'login', 'chatgpt')).toBe(0)
  expect(w.listeners).toEqual([1455])
  expect(w.fetches).toContain('https://auth.openai.com/api/accounts/oauth/token')
  expect(w.out.join('\n')).toContain(JSON.stringify(expected))
  expect(w.items['chatgpt']).toMatch(/^v1\\|/)
  expect(tokenCommandFor('alpha', { compiled: true, executable: '/opt/klyth/klyth', cliPath: '/checkout/scripts/cli.ts' })).toEqual(['/opt/klyth/klyth', 'auth', 'token', 'alpha'])
  expect(tokenCommandFor('alpha', { compiled: false, executable: '/opt/homebrew/bin/bun', cliPath: '/checkout/scripts/cli.ts' })).toEqual(['/opt/homebrew/bin/bun', '/checkout/scripts/cli.ts', 'auth', 'token', 'alpha'])
  expect(w.said()).not.toContain('access-synthetic-token')
  expect(w.said()).not.toContain('refresh-synthetic-token')
})

test('new API-key grammar does not import legacy credential-record stdin', async () => {
  const record = 'v1|client|refresh|1800003600||access'
  const w = world({ tty: false, stdin: record })
  expect(await w.run('auth', 'login', 'api-key', 'alpha', '--stdin')).toBe(1)
  expect(w.items).toEqual({})
  expect(w.said()).toContain('klyth auth import <provider-id>')
  expect(w.said()).not.toContain('refresh')
})

test('auth token passes through the legacy refresh exit codes 3 and 4', async () => {
  const dead = world({ items: { alpha: 'v1|client|refresh|1||access' } })
  expect(await dead.run('auth', 'token', 'alpha')).toBe(3)
  const early = world({ items: { alpha: `v1|client|refresh|1|${(NOW + 60_000) / 1000}|access` } })
  expect(await early.run('auth', 'token', 'alpha')).toBe(4)
})

test('unknown clients and absent extra help expose no optional sign-in flow', async () => {
  const w = world()
  expect(await w.run('auth', 'login', 'chatgpt', '--client', 'zz-test')).toBe(2)
  expect([w.calls, w.fetches, w.listeners]).toEqual([[], [], []])
  for (const args of [['auth', 'login', '--help'], ['auth', 'login', 'chatgpt', '--help']]) {
    const help = world()
    expect(await help.run(...args)).toBe(0)
    expect(help.said()).not.toContain('--device')
  }
})

test('reserved sign-in records are rejected by stdin admission and existing-key replacement policy', async () => {
  const { permitsExisting } = await import('../scripts/cli')
  for (const value of ['zz1|client|refresh|1800003600||access', 'zz1|broken', 'v1|broken', 'v1|client|refresh|soon||access']) {
    const w = world({ tty: false, stdin: value })
    expect(await w.run('auth', 'login', 'api-key', 'alpha', '--stdin')).toBe(1)
    expect(w.items).toEqual({})
    expect(w.calls.some(call => call.input !== undefined)).toBe(false)
    expect(permitsExisting(value, { provider: 'alpha', method: 'api-key' }, w.io)).toBe(false)
    const existing = world({ tty: false, items: { alpha: value } })
    expect(await existing.run('auth', 'login', 'api-key', 'alpha', '--stdin')).toBe(1)
    expect(existing.stdinReads).toBe(0)
    expect(existing.items).toEqual({ alpha: value })
  }
})
