import { expect, test } from 'claude-code/testing'
import type { ExtraClient } from '../hooks/extra-client'
import { createHelperRuntime } from '../hooks/helper-runtime'
import type { HelperRuntimePort } from '../hooks/helper-runtime'
import type { SetupEvent } from '../hooks/setup-protocol'
import { setupFrames } from '../hooks/setup-protocol'

const sha = 'a'.repeat(64)
const binary = `/home/example/.local/share/klyth/helpers/${sha}/klyth`
const manifest = { schemaVersion: 1, protocolVersion: 1, releaseVersion: '1.2.3', artifacts: { 'linux-glibc-x64': { url: 'https://example.invalid/v1.2.3/klyth-linux-glibc-x64', sha256: sha, size: 42 } } }
function fixture(options: { source?: boolean; missing?: boolean; invalid?: boolean; integrity?: boolean; probe?: string; bun?: boolean; chunks?: string[]; exit?: number; extraClient?: ExtraClient } = {}) {
  let installed = !options.missing
  const runs: { argv: readonly string[]; timeoutMs: number; env: Record<string, string> }[] = []
  const spawned: { argv: readonly string[]; input: string; env: Record<string, string>; timeoutMs: number }[] = []
  let cancelled = 0
  const io: HelperRuntimePort = {
    extraClient: options.extraClient,
    root: '/mod with spaces', home: '/home/example', configDir: '/config custom',
    setTimer: () => () => {},
    exists: async path => path.endsWith('helper.json') ? !options.source : path === binary && installed,
    read: async () => options.invalid ? '{broken' : JSON.stringify(manifest),
    run: async (argv, init) => {
      runs.push({ argv, ...init })
      if (argv[1]?.endsWith('install-helper.sh')) { installed = true; return { exitCode: 0, stdout: '{"status":"installed"}\n' } }
      if (argv[2]?.includes('command -v bun')) return { exitCode: options.bun === false ? 1 : 0, stdout: options.bun === false ? '' : '/absolute/bun\n' }
      if (argv[3] === 'klyth-verify') return { exitCode: options.integrity === false ? 1 : 0, stdout: options.integrity === false ? 'raw-secret' : 'verified\n' }
      return { exitCode: 0, stdout: options.probe ?? 'Linux\nx86_64\nglibc 2.36\n' }
    },
    spawn: async (argv, init) => {
      spawned.push({ argv, ...init })
      return { stdout: (async function* () { for (const chunk of options.chunks ?? ['{"version":1,"type":"done"}\n']) yield chunk })(), exited: Promise.resolve(options.exit ?? 0), cancel: () => { cancelled++ } }
    },
  }
  return { io, runs, spawned, runtime: createHelperRuntime(io), cancelled: () => cancelled }
}

test('source runtime disables cwd Bun configuration and creates a safely quoted hidden terminal command', async () => {
  const f = fixture({ source: true })
  expect(await f.runtime.inspect()).toEqual({ ready: true, mode: 'source', path: '/absolute/bun' })
  expect(await f.runtime.daemonArgv()).toEqual(['/absolute/bun', '--config=/dev/null', '--no-env-file', '/mod with spaces/klythd/main.ts'])
  expect(f.runtime.keyCommand('acme')).toBe("'env' 'BUN_OPTIONS=' 'CLAUDE_CONFIG_DIR=/config custom' '/absolute/bun' '--config=/dev/null' '--no-env-file' '/mod with spaces/scripts/cli.ts' 'auth' 'login' 'api-key' 'acme'")
  await f.runtime.invoke({ version: 1, action: 'inspect' }, () => {}, new AbortController().signal)
  expect(f.spawned[0]?.argv).toEqual(['/absolute/bun', '--config=/dev/null', '--no-env-file', '/mod with spaces/scripts/cli.ts', '__setup'])
  expect(f.spawned[0]?.env).toEqual({ BUN_OPTIONS: '', CLAUDE_CONFIG_DIR: '/config custom', HOME: '/home/example' })
})

test('compiled runtime verifies immutable size/hash before executing helper and daemon', async () => {
  const f = fixture()
  expect(await f.runtime.ready()).toBe(true)
  expect(await f.runtime.daemonArgv()).toEqual([binary, '__daemon'])
  await f.runtime.invoke({ version: 1, action: 'presence', provider: 'acme' }, () => {}, new AbortController().signal)
  expect(f.spawned[0]?.argv).toEqual([binary, '__setup'])
  const verify = f.runs.filter(call => call.argv[3] === 'klyth-verify')
  expect(verify.length).toBe(3)
  expect(verify[0]?.argv.slice(4)).toEqual(['/home/example', binary, '42', sha])
  expect(verify[0]?.argv[2]).toContain('shasum -a 256')
  expect(verify[0]?.argv[2]).toContain('[ ! -L "$1" ]')
  expect(f.runs.some(call => call.argv[1]?.endsWith('install-helper.sh'))).toBe(false)
})

test('missing compiled helper installs only with explicit consent using the shipped bootstrap then re-verifies', async () => {
  const f = fixture({ missing: true })
  expect(await f.runtime.ready()).toBe(false)
  await expect(f.runtime.install(false)).rejects.toThrow('explicit consent')
  expect(f.runs.some(call => call.argv[1]?.endsWith('install-helper.sh'))).toBe(false)
  expect((await f.runtime.install(true)).ready).toBe(true)
  expect(f.runs.find(call => call.argv[1]?.endsWith('install-helper.sh'))?.argv).toEqual(['/bin/sh', '/mod with spaces/scripts/install-helper.sh', manifest.artifacts['linux-glibc-x64'].url, sha, '42', binary])
  expect(f.spawned).toEqual([])
})

test('invalid manifest, unsupported libc, digest failure, and missing source Bun fail without fallback or execution', async () => {
  for (const option of [{ invalid: true }, { probe: 'Linux\nx86_64\nmusl\n' }, { integrity: false }]) {
    const f = fixture(option)
    await expect(f.runtime.ready()).rejects.toThrow()
    expect(f.runs.some(call => call.argv[2]?.includes('command -v bun'))).toBe(false)
    expect(f.spawned).toEqual([])
  }
  const badRequest = fixture()
  await expect(badRequest.runtime.invoke({ version: 2, action: 'inspect' } as never, () => {}, new AbortController().signal)).rejects.toThrow('Invalid setup request')
  expect(badRequest.runs).toEqual([])
  const source = fixture({ source: true, bun: false })
  expect(await source.runtime.inspect()).toEqual({ ready: false, mode: 'source', reason: 'Install Bun for this source checkout, or use a released helper build' })
  await expect(source.runtime.install(true)).rejects.toThrow('Source checkout has no release manifest')
})

test('split helper producer frames pass the actual decoder and never expose unvalidated output', async () => {
  const events: SetupEvent[] = [{ version: 1, type: 'browser-challenge', authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture', expiresAt: 1800000000000 }, { version: 1, type: 'credentials-saved', handle: 'a'.repeat(32) }, { version: 1, type: 'done' }]
  const wire = events.map(event => JSON.stringify(event) + '\n').join('')
  const chunks = [wire.slice(0, 13), wire.slice(13, 101), wire.slice(101)]
  const expected: SetupEvent[] = []
  const decoder = setupFrames(e => expected.push(e))
  chunks.forEach(c => decoder.feed(c)); decoder.end()
  const f = fixture({ chunks })
  const received: SetupEvent[] = []
  await f.runtime.invoke({ version: 1, action: 'login', provider: 'chatgpt', client: 'official' }, e => received.push(e), new AbortController().signal)
  expect(received).toEqual(expected)
  expect(f.spawned[0]?.input).toBe('{"version":1,"action":"login","provider":"chatgpt","client":"official"}\n')
})

test('malformed, oversized, incomplete, post-done output and nonzero exit cancel with fixed safe errors', async () => {
  for (const option of [{ chunks: ['raw-token-placeholder\n'] }, { chunks: ['x'.repeat(65537)] }, { chunks: ['{'] }, { chunks: ['{"version":1,"type":"done"}\n{"version":1,"type":"done"}\n'] }, { exit: 1 }]) {
    const f = fixture(option)
    const seen: SetupEvent[] = []
    await expect(f.runtime.invoke({ version: 1, action: 'inspect' }, e => seen.push(e), new AbortController().signal)).rejects.toThrow('Setup helper failed')
    expect(f.cancelled()).toBe(1)
    expect(JSON.stringify(seen)).not.toContain('raw-token-placeholder')
  }
})

test('abort cancels session-owned child and rejects late events; browser reopen accepts only auth profile URLs', async () => {
  const f = fixture({ source: true })
  const abort = new AbortController()
  let release: () => void = () => {}
  f.io.spawn = async () => ({ stdout: (async function* () { await new Promise<void>(resolve => { release = resolve }); yield '{"version":1,"type":"done"}\n' })(), exited: Promise.resolve(0), cancel: () => release() })
  const events: SetupEvent[] = []
  const work = f.runtime.invoke({ version: 1, action: 'inspect' }, e => events.push(e), abort.signal)
  for (let n = 0; n < 20; n++) await Promise.resolve()
  abort.abort()
  await expect(work).rejects.toThrow('Setup cancelled')
  expect(events).toEqual([])
  await f.runtime.openBrowser('https://auth.openai.com/api/accounts/authorize?state=placeholder')
  expect(f.runs.at(-1)?.argv.at(-1)).toBe('https://auth.openai.com/api/accounts/authorize?state=placeholder')
  const before = f.runs.length
  await expect(f.runtime.openBrowser('https://untrusted.invalid/callback?token=placeholder')).rejects.toThrow('Invalid authorization browser URL')
  expect(f.runs.length).toBe(before)
  expect(() => f.runtime.keyCommand('acme;echo')).toThrow('Invalid provider identifier')
})


test('fixed OAuth deadline cancels a stalled child and cleans its injected timer', async () => {
  const f = fixture({ source: true })
  let deadline: (() => void) | undefined
  let removed = false, cancelled = false
  f.io.setTimer = (callback, ms) => { expect(ms).toBe(960000); deadline = callback; return () => { removed = true } }
  f.io.spawn = async () => ({ stdout: (async function* () { await new Promise(() => {}) })(), exited: new Promise(() => {}), cancel: () => { cancelled = true } })
  const work = f.runtime.invoke({ version: 1, action: 'inspect' }, () => {}, new AbortController().signal)
  for (let n = 0; n < 20 && !deadline; n++) await Promise.resolve()
  if (!deadline) throw new Error('deadline not armed')
  deadline()
  await expect(work).rejects.toThrow('Setup helper failed')
  expect([removed, cancelled]).toEqual([true, true])
})

test('validated failures complete only with their documented exit and a terminal done', async () => {
  const done: SetupEvent = { version: 1, type: 'done' }
  for (const [code, exit] of [['models-unavailable', 1], ['cancelled', 130]] as const) {
    const events: SetupEvent[] = [{ version: 1, type: 'failed', code }, done]
    const f = fixture({ chunks: events.map(e => JSON.stringify(e) + '\n'), exit })
    const seen: SetupEvent[] = []
    await f.runtime.invoke({ version: 1, action: 'inspect' }, e => seen.push(e), new AbortController().signal)
    expect(seen).toEqual(events); expect(f.cancelled()).toBe(0)
  }
  const failure: SetupEvent = { version: 1, type: 'failed', code: 'models-unavailable' }
  for (const [events, exit] of [
    [[done], 1], [[done], 130], [[failure, done], 0], [[failure, done], 130], [[failure, done], 2],
    [[{ version: 1, type: 'failed', code: 'cancelled' }, done], 1], [[failure], 1], [[failure, failure, done], 1],
  ] as const) {
    const f = fixture({ chunks: events.map(e => JSON.stringify(e) + '\n'), exit })
    await expect(f.runtime.invoke({ version: 1, action: 'inspect' }, () => {}, new AbortController().signal)).rejects.toThrow('Setup helper failed')
    expect(f.cancelled()).toBe(1)
  }
})

test('a test-local client drives the core device challenge and browser seam; unregistered pages never open', async () => {
  const extra: ExtraClient = { id: 'fixture', method: 'fixture1', label: 'Fixture client', baseUrl: 'https://fixture.invalid/v1', verificationUrl: 'https://fixture.invalid/device', failureText: 'Fixture unavailable', defaultProviderId: 'fixture', requestHeaders: () => ({}) }
  const challenge: SetupEvent = { version: 1, type: 'device-challenge', verificationUrl: extra.verificationUrl, userCode: 'CODE-123', expiresAt: 1000 }
  const f = fixture({ extraClient: extra, chunks: [JSON.stringify(challenge) + '\n' + '{"version":1,"type":"done"}\n'] })
  const events: SetupEvent[] = []
  await f.runtime.invoke({ version: 1, action: 'login', provider: 'fixture', client: 'official' }, event => events.push(event), new AbortController().signal)
  expect(events).toEqual([challenge, { version: 1, type: 'done' }])
  await f.runtime.openBrowser(extra.verificationUrl)
  expect(f.runs.at(-1)?.argv.at(-1)).toBe(extra.verificationUrl)
  for (const url of ['https://unregistered.invalid/device', `${extra.verificationUrl}?state=bad`, `${extra.verificationUrl}#bad`, 'https://user@fixture.invalid/device', 'https://fixture.invalid/other']) {
    const count = f.runs.length
    await expect(f.runtime.openBrowser(url)).rejects.toThrow('Invalid authorization browser URL')
    expect(f.runs).toHaveLength(count)
  }
  const plain = fixture()
  await expect(plain.runtime.openBrowser(extra.verificationUrl)).rejects.toThrow('Invalid authorization browser URL')
  expect(plain.runs).toEqual([])
})
