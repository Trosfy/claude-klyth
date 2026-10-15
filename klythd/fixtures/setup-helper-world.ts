// Auth entry points over synthetic credentials and offline fixtures.
import { expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelperRuntime } from '../../hooks/helper-runtime'
import { createSetupController } from '../../hooks/setup-controller'
import type { SetupConnection, SetupEvent, SetupRequest } from '../../hooks/setup-protocol'
import { setupFrames } from '../../hooks/setup-protocol'
import { secretTool } from '../../scripts/credential-store'
import type { SetupIo } from '../../scripts/setup'
import { runSetup } from '../../scripts/setup'

const scratch = process.env['KLYTH_TEST_SCRATCH'] ?? tmpdir()
const model = { id: 'chosen-id', contextWindow: 10000, maxOutputTokens: 1000 }
const connection: SetupConnection = { provider: 'custom', kind: 'openai', baseUrl: 'https://service.invalid/v1', allowHttp: false, auth: { kind: 'none' } }
const provider = { kind: connection.kind, baseUrl: connection.baseUrl, auth: 'none', models: { 'chosen-id': { contextWindow: 10000, maxOutputTokens: 1000 } } }
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
function world(raw?: unknown) {
  mkdirSync(scratch, { recursive: true })
  const dir = realpathSync(mkdtempSync(join(scratch, 'setup-'))), configPath = join(dir, 'klyth.json')
  if (raw !== undefined) writeFileSync(configPath, typeof raw === 'string' ? raw : JSON.stringify(raw))
  const opened: string[] = []
  const events: SetupEvent[] = [], items: Record<string, string> = {}, calls: string[][] = [], held = new Set<string>()
  const frames = setupFrames(event => events.push(event))
  let now = 1800000000000, counter = 0, callback: ((url: URL) => string) | undefined, authorize: URL | undefined
  const io: SetupIo = {
    platform: 'linux', configPath, store: secretTool('/fake/secret-tool'), 
    run: async (argv, input) => {
      calls.push([...argv]); const p = argv[argv.indexOf('provider') + 1]!
      if (argv[1] === 'store') { expect(held.has(p)).toBe(true); items[p] = input!; return { exitCode: 0, stdout: '' } }
      if (argv[1] === 'search') return { exitCode: 0, stdout: '', stderr: '' }
      return p in items ? { exitCode: 0, stdout: items[p]! } : { exitCode: 1, stdout: '', stderr: '' }
    },
    out: () => { throw new Error('prose forbidden') }, err: () => { throw new Error('stderr forbidden') },
    write: line => {
      const at = Math.floor(line.length / 2); frames.feed(line.slice(0, at)); frames.feed(line.slice(at))
      const event = events.at(-1)
      if (event?.type === 'browser-challenge' && !io.signal?.aborted) {
        authorize = new URL(event.authorizeUrl)
        callback!(new URL(`http://127.0.0.1:1455/auth/callback?state=${authorize.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`))
      }
    },
    tokenCommand: p => ['/immutable/klyth', 'auth', 'token', p],
    runHelper: async () => { throw new Error('unexpected helper') },
    now: () => now, sleep: async ms => { now += ms }, random: n => new Uint8Array(n).fill(++counter),
    listen: (_port, cb) => { callback = cb; return { url: 'http://127.0.0.1:1455/auth/callback', close: () => {} } },
    open: url => { opened.push(url) },
    readLine: async () => { throw new Error('callback paste forbidden') },
    lock: p => ({ path: `fake/${p}`, take: () => { if (held.has(p)) return false; held.add(p); return true }, holder: () => undefined, steal: () => false, release: () => { held.delete(p) } }),
    shield: async work => work(), pid: process.pid, alive: () => false, stdoutIsTTY: false, hostIdPath: join(dir, 'host-id'), pipe: async () => false,
    fetch: async (url, init) => {
      expect(init.redirect).toBe('error')
      if (url.endsWith('/models') || url.includes('/models?')) return Response.json({ data: [{ id: 'chosen-id' }] })
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope: 'chatgpt.tokens.use.direct', id_token: jwt({ iss: 'https://auth.openai.com', aud: 'fixture-client', nonce: authorize?.searchParams.get('nonce'), exp: now / 1000 + 600, email: 'secret-claim@example.invalid' }) })
    },
  }
  return { io, dir, events, items, calls, held, opened, advance: (ms: number) => { now += ms }, raw: () => JSON.parse(readFileSync(io.configPath, 'utf8')) }
}
const failed = (w: ReturnType<typeof world>) => w.events.find(e => e.type === 'failed')
const save = (w: ReturnType<typeof world>, c = connection, expectedRevision: string | null = null, extra = {}) => runSetup({ version: 1, action: 'save', connection: c, expectedRevision, model, ...extra }, w.io)

function nativeSetup(w: ReturnType<typeof world>) {
  const requests: SetupRequest[] = []
  const runtime = createHelperRuntime({
    root: join(import.meta.dir, '..', '..'), home: w.dir, configDir: w.dir,
    setTimer: () => () => {}, exists: async () => false, read: async () => '',
    run: async () => ({ exitCode: 0, stdout: `${process.execPath}\n` }),
    spawn: async (_argv, options) => {
      const request = JSON.parse(options.input) as SetupRequest, chunks: string[] = []
      requests.push(request)
      const exit = await runSetup(request, { ...w.io, signal: options.signal, write: line => { w.io.write(line); chunks.push(line) } })
      return { stdout: (async function* () { for (const line of chunks) { yield line.slice(0, 9); yield line.slice(9) } })(), exited: Promise.resolve(exit), cancel: () => {} }
    },
  })
  const controller = createSetupController({
    extraClient: w.io.extraSignIn?.client,
    helperReady: () => runtime.ready(), installHelper: async () => {}, invoke: (request, emit, signal) => runtime.invoke(request, emit, signal),
    keyCommand: () => '/fake/klyth auth login api-key custom', reopenBrowser: () => {}, copySignInLink: async () => false,
    reload: async () => true, useModel: async () => true, now: async () => w.io.now(), after: () => ({ cancel: () => {} }),
  })
  const flush = async () => { for (let n = 0; n < 1000; n++) await Promise.resolve() }
  return { controller, requests, flush }
}

export { connection, failed, jwt, model, nativeSetup, provider, save, scratch, world }
