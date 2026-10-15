import { expect, test } from 'claude-code/testing'
import { launcherText } from '../hooks/launcher'
import { installLauncher } from '../hooks/launcher-session'
import type { LauncherPort } from '../hooks/launcher-session'
import { createHelperRuntime } from '../hooks/helper-runtime'
import type { HelperRuntimePort } from '../hooks/helper-runtime'
import { SETUP_PANE } from '../hooks/setup-pane'
import { HOME, klyth, start, world } from './world'

function fixture(status = 'installed', path = '/home/example/.local/bin:/usr/bin') {
  const runs: readonly string[][] = [], toasts: string[] = [], logs: string[] = []
  const calls = runs as string[][]
  const io: LauncherPort = {
    home: async () => '/home/example', root: '/release space', version: async () => '0.2.1', path: async () => path,
    exists: async () => false, read: async () => { throw Error('missing') },
    run: async argv => { calls.push([...argv]); return { exitCode: 0, stdout: argv[0] === '/bin/sh' ? '/bun\n' : JSON.stringify({ status }) } },
    toast: text => { toasts.push(text) }, debug: text => { logs.push(text) },
  }
  return { io, runs, toasts, logs }
}

test('launcher inputs reject relative paths, quotes, controls, and nonnumeric versions', () => {
  for (const path of ['relative', "/home/a'b", '/home/a\nb', '/home/a\u0000b', '/home/a\u007fb']) {
    expect(launcherText(path, '/root', '0.2.1')).toBeUndefined()
    expect(launcherText('/home/example', path, '0.2.1')).toBeUndefined()
  }
  for (const version of ['01.2.3', '1.2', '1.2.3-next', '1000000000.0.0']) expect(launcherText('/home/example', '/root', version)).toBeUndefined()
  expect(launcherText('/home space', '/root space', '0.2.10')).toContain("KLYTH_LAUNCHER='/home space/.local/bin/klyth'")
})

test('equal launcher text and a present record skip all processes', async () => {
  const f = fixture(); f.io.read = async path => { if (path.endsWith('helper.json')) throw Error('missing'); return path.endsWith('/bin/klyth') ? launcherText('/home/example', '/release space', '0.2.1')! : '' }
  expect(await installLauncher(f.io)).toBe('/home/example/.local/bin/klyth')
  expect(f.runs).toEqual([]); expect(f.toasts).toEqual([])
})

test('only installed toasts, with a PATH-specific notice, and only owned statuses enter setup', async () => {
  for (const path of ['/home/example/.local/bin:/usr/bin', '/usr/bin']) {
    const f = fixture('installed', path)
    expect(await installLauncher(f.io)).toBe('/home/example/.local/bin/klyth')
    expect(f.toasts).toEqual([path.startsWith('/home') ? 'Klyth installed the klyth command in ~/.local/bin. Type klyth --help in a terminal.' : 'Klyth installed the klyth command in ~/.local/bin. Add ~/.local/bin to your PATH to use it.'])
    expect(f.runs[1]).toEqual(['/bun', '--config=/dev/null', '--no-env-file', '/release space/scripts/install-launcher.ts', '/home/example', '/release space', '0.2.1'])
  }
  for (const status of ['updated', 'current', 'older', 'foreign', 'removed', 'busy', 'skipped']) {
    const f = fixture(status)
    expect(await installLauncher(f.io)).toBe(['updated', 'current', 'older'].includes(status) ? '/home/example/.local/bin/klyth' : undefined)
    expect(f.toasts).toEqual([]); expect(f.logs).toEqual([`klyth launcher: ${status}`])
  }
  const f = fixture(); f.io.run = async () => { throw Error('failure') }
  expect(await installLauncher(f.io)).toBeUndefined(); expect(f.toasts).toEqual([])
})

test('setup awaits the session install promise and builds an environment for each invocation', async () => {
  let release = (_path: string) => {}, spawned = 0
  const launcher = new Promise<string>(resolve => { release = resolve })
  const envs: Record<string, string>[] = []
  const io: HelperRuntimePort = {
    launcher, home: '/home/example', root: '/release', configDir: '/config', setTimer: () => () => {},
    exists: async () => false, read: async () => '', run: async () => ({ exitCode: 0, stdout: '/bun\n' }),
    spawn: async (_argv, options) => { spawned++; envs.push(options.env); return { stdout: (async function* () { yield '{"version":1,"type":"done"}\n' })(), exited: Promise.resolve(0), cancel: () => {} } },
  }
  const runtime = createHelperRuntime(io)
  const pending = runtime.invoke({ version: 1, action: 'inspect' }, () => {}, new AbortController().signal)
  for (let i = 0; i < 40; i++) await Promise.resolve()
  expect(spawned).toBe(0)
  release('/home/example/.local/bin/klyth'); await pending
  await runtime.invoke({ version: 1, action: 'inspect' }, () => {}, new AbortController().signal)
  expect(envs.map(env => env['KLYTH_LAUNCHER'])).toEqual(['/home/example/.local/bin/klyth', '/home/example/.local/bin/klyth'])
  expect(envs[0] === envs[1]).toBe(false)
})

test('session start returns while installation is delayed and setup receives that installation', async ($, on) => {
  let release = () => {}, fire = () => {}, entered = false
  const setupEnvs: unknown[] = []
  on('fs.read', { path: /\/\.claude-plugin\/plugin.json$/ }, () => ({ value: '{"version":"0.2.1"}' }))
  on('process.run', { argv: /\/scripts\/install-launcher.ts$/ }, async () => {
    entered = true
    await new Promise<void>(resolve => { release = resolve })
    return { value: { exitCode: 0, stdout: '{"status":"installed"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', { input: /^\{"version":1,"action":/ }, async function* (_$, e) {
    setupEnvs.push(e.env); yield { stream: 'stdout', text: '{"version":1,"type":"done"}\n' }; return { value: { code: 0, signal: null } }
  })
  on('clock.after', { ms: 0 }, () => new Promise(resolve => { fire = () => resolve({ value: undefined }) }))
  on('clock.after', { ms: 10000 }, (_$, _e, next) => new Promise(resolve => next.signal.addEventListener('abort', () => resolve({ value: undefined }), { once: true })))
  on('clock.after', { ms: 960000 }, (_$, _e, next) => new Promise(resolve => next.signal.addEventListener('abort', () => resolve({ value: undefined }), { once: true })))
  on('ui.open', { id: SETUP_PANE }, () => ({ value: { isPlaced: true } }))
  world(on)
  await start($)
  expect(entered).toBe(false)
  fire()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(entered).toBe(true)
  await klyth($, 'setup')
  for (let i = 0; i < 500; i++) await Promise.resolve()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(setupEnvs).toEqual([])
  release()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(setupEnvs).toEqual([expect.objectContaining({ KLYTH_LAUNCHER: `${HOME}/.local/bin/klyth` })])
})

test('setup bounds an install promise that never settles and falls back to the source argv', async () => {
  let timeout = () => {}, env: Record<string, string> = {}
  const io: HelperRuntimePort = {
    launcher: new Promise(() => {}), home: '/home/example', root: '/release', configDir: '/config',
    setTimer: (fn, ms) => { if (ms === 10000) timeout = fn; return () => {} },
    exists: async () => false, read: async () => '', run: async () => ({ exitCode: 0, stdout: '/bun\n' }),
    spawn: async (_argv, options) => { env = options.env; return { stdout: (async function* () { yield '{"version":1,"type":"done"}\n' })(), exited: Promise.resolve(0), cancel: () => {} } },
  }
  const pending = createHelperRuntime(io).invoke({ version: 1, action: 'inspect' }, () => {}, new AbortController().signal)
  for (let i = 0; i < 40; i++) await Promise.resolve()
  timeout(); await pending
  expect(env['HOME']).toBe('/home/example'); expect(env['KLYTH_LAUNCHER']).toBeUndefined()
})
