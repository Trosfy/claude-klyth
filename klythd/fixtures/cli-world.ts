// Auth entry points over synthetic credentials and offline fixtures.
import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliIo } from '../../scripts/cli'
import { cli } from '../../scripts/cli'
import type { Run } from '../../scripts/credential-store'

const KEY = 'sk-synthetic-cli-key'
const SECURITY = '/usr/bin/security'
const NOW = 1_800_000_000_000
const PROVIDER = { kind: 'openai', baseUrl: 'https://api.example.invalid/v1', auth: 'none', models: { model: { contextWindow: 1000, maxOutputTokens: 100 } } }
const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

type Options = { env?: CliIo['env']; platform?: string; tty?: boolean; config?: string; items?: Record<string, string>; secretTool?: boolean; stdin?: string; oauth?: boolean; pasteCallback?: boolean }
function world(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-cli-'))
  dirs.push(dir)
  const configPath = join(dir, 'klyth.json')
  if (options.config !== undefined) writeFileSync(configPath, options.config)
  const items: Record<string, string> = { ...(options.items ?? {}) }
  const calls: { argv: readonly string[]; input?: string }[] = []
  const out: string[] = [], err: string[] = [], fetches: string[] = [], listeners: number[] = []
  let keyReads = 0, stdinReads = 0
  let callback: ((url: URL) => string) | undefined
  const run: Run = async (argv, input) => {
    calls.push({ argv, ...(input === undefined ? {} : { input }) })
    const id = argv[argv.indexOf('-a') + 1] ?? argv[argv.indexOf('provider') + 1] ?? ''
    if (argv[1] === '-i') {
      const value = / -a "([a-z][a-z0-9-]{0,31})" -l "[^"]+" -w "([^"\\]+)"\n$/.exec(input ?? '')
      if (!value) return { exitCode: 51, stdout: '' }
      items[value[1] as string] = value[2] as string
      return { exitCode: 0, stdout: '' }
    }
    if (argv[1] === 'delete-generic-password' || argv[1] === 'clear') {
      if (!(id in items)) return { exitCode: argv[0] === SECURITY ? 44 : 1, stdout: '' }
      delete items[id]
      return { exitCode: 0, stdout: '' }
    }
    if (argv.includes('-w') || argv[1] === 'lookup') return id in items ? { exitCode: 0, stdout: `${items[id]}\n` } : { exitCode: argv[0] === SECURITY ? 44 : 1, stdout: '' }
    return id in items ? { exitCode: 0, stdout: 'keychain item metadata\n' } : { exitCode: argv[0] === SECURITY ? 44 : 1, stdout: '' }
  }
  const io: CliIo = {
    platform: options.platform ?? 'darwin',
    which: name => name === 'security' ? SECURITY : name === 'secret-tool' && options.secretTool ? '/usr/bin/secret-tool' : undefined,
    run,
    readKey: async () => (keyReads++, `${KEY}\n`),
    readStdin: async () => (stdinReads++, `${options.stdin ?? KEY}\n`),
    configPath,
    out: value => { out.push(value) },
    err: value => { err.push(value) },
    env: options.env,
    fetch: async url => {
      fetches.push(url)
      if (options.oauth && url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const authorizeUrl = out.find(value => value.startsWith('https://auth.openai.com/api/accounts/authorize?')) ?? ''
        const nonce = new URL(authorizeUrl).searchParams.get('nonce')
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
        const idToken = `${encode({ alg: 'none' })}.${encode({ iss: 'https://auth.openai.com', aud: 'client-placeholder', nonce, exp: NOW / 1000 + 3600, email: 'user@example.invalid' })}.signature`
        return Response.json({ access_token: 'access-synthetic-token', refresh_token: 'refresh-synthetic-token', id_token: idToken, expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' })
      }
      if (options.oauth && url === 'https://api.openai.com/v1/models') return Response.json({ data: [] })
      return Response.json({ error: 'invalid_client' }, { status: 400 })
    },
    now: () => NOW,
    sleep: async () => {},
    random: count => new Uint8Array(count).fill(7),
    listen: (port, onCallback) => {
      listeners.push(port)
      if (!options.oauth) return new Error('synthetic occupied port')
      callback = onCallback
      return { url: `http://127.0.0.1:${port}/auth/callback`, close: () => {} }
    },
    open: url => {
      if (!options.oauth || callback === undefined) return
      const state = new URL(url).searchParams.get('state') ?? ''
      callback(new URL(`http://127.0.0.1:1455/auth/callback?state=${state}&code=code-placeholder&client_id=client-placeholder`))
    },
    readLine: async () => {
      if (!options.pasteCallback) return undefined
      const authorizeUrl = out.find(value => value.startsWith('https://auth.openai.com/api/accounts/authorize?')) ?? ''
      const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
      return `http://127.0.0.1:1455/auth/callback?state=${state}&code=code-placeholder&client_id=client-placeholder`
    },
    lock: name => ({ path: `/synthetic/${name}.lock`, take: () => true, holder: () => undefined, steal: () => false, release: () => {} }),
    shield: work => work(),
    pid: 42,
    alive: () => false,
    stdoutIsTTY: options.tty ?? true,
    stdinIsTTY: options.tty ?? true,
    hostIdPath: join(dir, 'host-id'),
    pipe: async () => true,
  }
  return { io, calls, out, err, fetches, listeners, items, configPath, get keyReads() { return keyReads }, get stdinReads() { return stdinReads }, said: () => [...out, ...err].join('\n'), run: (...args: string[]) => cli(args, io) }
}

const validConfig = JSON.stringify({ providers: { alpha: PROVIDER } })


export { dirs, KEY, NOW, Options, PROVIDER, SECURITY, validConfig, world }
