import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { cli as legacyCli } from '../scripts/auth'
import { cli as newCli } from '../scripts/cli'
import { world as tokenWorld, item, S, NEW_REFRESH } from './fixtures/chatgpt-cli-world'
import { exportItem } from '../scripts/chatgpt'
import { keychain } from '../scripts/credential-store'
import { validConfig, world } from './fixtures/cli-world'

const record = 'v1|client|refresh|4102444800||synthetic-access'

test('real export output imports through the new grammar with the same writer lock and token command', async () => {
  const source = world({ items: { alpha: record }, tty: false })
  let pipe = '', locked = false
  source.io.pipe = async text => { pipe = text; return true }
  expect(await exportItem({ ...source.io, store: keychain() }, 'alpha')).toBe(0)
  expect(source.items).toEqual({})
  const target = world({ stdin: pipe, tty: false, config: validConfig })
  target.io.lock = () => ({ path: '/synthetic/writer.lock', take: () => { locked = true; return true }, holder: () => undefined, steal: () => false, release: () => { locked = false } })
  const run = target.io.run
  target.io.run = async (argv, input) => { if (input) expect(locked).toBe(true); return run(argv, input) }
  target.io.tokenCommand = p => ['/stable/klyth', 'auth', 'token', p]
  expect(await target.run('auth', 'import', 'alpha', '--write')).toBe(0)
  expect(target.items).toEqual({ alpha: record })
  expect(JSON.parse(readFileSync(target.configPath, 'utf8')).providers.alpha.auth).toEqual({ command: ['/stable/klyth', 'auth', 'token', 'alpha'], ttlSeconds: 600 })
  expect(locked).toBe(false)
  expect(target.said()).not.toContain(record)
})

test('import refuses malformed records, unavailable keyrings, invalid config and invalid grammar without storing', async () => {
  for (const value of ['sk-plain-key', 'v1|broken', '{broken}']) {
    const w = world({ stdin: value, tty: false })
    expect(await w.run('auth', 'import', 'alpha')).toBe(1); expect(w.items).toEqual({})
  }
  const unavailable = world({ platform: 'linux', tty: false, stdin: record })
  expect(await unavailable.run('auth', 'import', 'alpha')).toBe(1); expect(unavailable.stdinReads).toBe(0)
  for (const config of ['{}', '{broken', '{"providers":{"alpha":{}}}']) {
    const w = world({ config, stdin: record, tty: false })
    expect(await w.run('auth', 'import', 'alpha', '--write')).toBe(1)
    expect(w.items).toEqual({}); expect(w.stdinReads).toBe(0)
  }
  for (const args of [[], ['native'], ['alpha', '--unknown'], ['alpha', '--write', '--write']]) {
    const w = world({ tty: false, stdin: record })
    expect(await w.run('auth', 'import', ...args)).toBe(2); expect(w.stdinReads).toBe(0)
  }
})

test('import reports failed keyring readback and does not commit config', async () => {
  const w = world({ config: validConfig, stdin: record, tty: false })
  const run = w.io.run; let wrote = false
  w.io.run = async (argv, input) => { if (input) wrote = true; if (wrote && input === undefined) return { exitCode: 44, stdout: '' }; return run(argv, input) }
  expect(await w.run('auth', 'import', 'alpha', '--write')).toBe(1)
  expect(w.said()).toContain('did not give the same sign-in')
  expect(readFileSync(w.configPath, 'utf8')).toBe(validConfig)
})

test('import reports a config commit conflict after storing and preserves the intervening config', async () => {
  const w = world({ config: validConfig, stdin: record, tty: false })
  const changed = JSON.stringify({ providers: { alpha: { ...JSON.parse(validConfig).providers.alpha, auth: { command: ['/other/helper'] } } } })
  w.io.shield = async work => { const result = await work(); writeFileSync(w.configPath, changed); return result }
  expect(await w.run('auth', 'import', 'alpha', '--write')).toBe(1)
  expect(w.items['alpha']).toBe(record)
  expect(w.said()).toContain('configuration not changed')
  expect(readFileSync(w.configPath, 'utf8')).toBe(changed)
})

test('legacy usage redirects new grammar but preserves a provider named chatgpt', async () => {
  for (const args of [['login', 'api-key', 'alpha'], ['login', 'chatgpt', '--provider', 'alpha']]) {
    const w = world()
    expect(await legacyCli(args, w.io)).toBe(2)
    expect(w.said()).toContain('Use klyth auth login')
    expect(w.said()).toContain('This is the legacy form. Use klyth auth --help.')
    expect(w.calls).toEqual([])
  }
  const w = world()
  expect(await legacyCli(['login', 'chatgpt'], w.io)).toBe(0)
})

for (const entry of ['new', 'legacy'] as const) {
  test(`${entry} import readback failure renders runnable logout and sign-in commands`, async () => {
    const w = world({ stdin: record, tty: false })
    w.io.readKey = w.io.readStdin!
    const run = w.io.run; let wrote = false
    w.io.run = async (argv, input) => { if (input) wrote = true; if (wrote && input === undefined) return { exitCode: 44, stdout: '' }; return run(argv, input) }
    expect(await (entry === 'new' ? w.run('auth', 'import', 'alpha') : legacyCli(['login', 'alpha'], w.io))).toBe(1)
    expect(w.err).toEqual(['klyth auth: Stored, but reading alpha back did not give the same sign-in (exit 44). Run klyth auth logout alpha. Then run klyth auth login chatgpt --provider alpha.'])
  })

  test(`${entry} export deletion failure renders the source logout command and retains the sign-in`, async () => {
    const w = world({ items: { alpha: record }, tty: false })
    const run = w.io.run; let piped = ''
    w.io.run = (argv, input) => argv[1] === 'delete-generic-password' ? Promise.resolve({ exitCode: 51, stdout: '' }) : run(argv, input)
    w.io.pipe = async text => { piped = text; return true }
    expect(await (entry === 'new' ? w.run('auth', 'export', 'alpha') : legacyCli(['export', 'alpha'], w.io))).toBe(1)
    expect(w.err).toEqual(['klyth auth: alpha: sign-in written, but removing it from the macOS Keychain failed. Run klyth auth logout alpha before this machine refreshes it'])
    expect(piped).toBe(`${record}\n`); expect(w.items).toEqual({ alpha: record })
  })

  test(`${entry} refresh without an access token names the token response, not the refresh token`, async () => {
    const w = tokenWorld({ items: { chatgpt: item({ expiresAt: S - 1 }) }, answer: () => Response.json({ refresh_token: NEW_REFRESH }) })
    expect(await (entry === 'new' ? newCli(['auth', 'token', 'chatgpt'], w.io) : w.cli('token', 'chatgpt'))).toBe(1)
    expect(w.h.err).toEqual(['klyth auth: ChatGPT sent no usable token response. Run klyth auth login chatgpt --provider chatgpt'])
    expect(w.h.out).toEqual([])
    expect(w.h.items).toEqual({ 'klyth:chatgpt': item({ expiresAt: S - 1 }) })
  })
}
