// Auth entry points over synthetic credentials and offline fixtures.
import { afterAll, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Io, Run } from '../../scripts/auth'
import { cli } from '../../scripts/auth'
import type { LockPort, Ports } from '../../scripts/chatgpt'
import { fileLock } from '../../scripts/chatgpt'

const SECURITY = '/usr/bin/security'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const MODELS_URL = 'https://api.openai.com/v1/models'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const CLIENT = 'app-client-placeholder-1'
const ACCESS = 'at-placeholder-access-1'
const REFRESH = 'rt-placeholder-refresh-1'
const NEW_ACCESS = 'at-placeholder-access-2'
const NEW_REFRESH = 'rt-placeholder-refresh-2'
const EMAIL = 'user@example.invalid'
const NOW = 1_800_000_000_000
const S = NOW / 1000
const TOKENS = [ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH]
const DEAD_LINE = 'klyth auth: the ChatGPT sign-in expired or was revoked; run bun run auth login chatgpt --chatgpt'
const KLYTH_UA = `klyth/${JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version}`
const LONG = 'a'.repeat(4000)
// The refusal of a value whose line to `security -i` (as the fake below reads it) would pass 4000 bytes.
const tooLong = (p: string, value: string) => `klyth auth: storing ${p} takes a ${Buffer.byteLength(`add-generic-password -U -s klyth -a "${p}" -l "klyth ${p}" -w "${value}"\n`)}-byte security -i line, over its 4000-byte limit; nothing stored`
const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature-placeholder`
type Fields = { method: string; clientId: string; refresh: string; expiresAt: number; earliest: string; access: string }
const item = (o: Partial<Fields> = {}) => [o.method ?? 'v1', o.clientId ?? CLIENT, o.refresh ?? REFRESH, String(o.expiresAt ?? S + 3600), o.earliest ?? '', o.access ?? ACCESS].join('|')
const ROTATED = item({ refresh: NEW_REFRESH, access: NEW_ACCESS, expiresAt: S + 3600 })
// The device sign-in's access token is a JWT, so the account id can be read from it.
// A lock file in `dir` held by `pid`, taken `age` ms before the fake clock's now.
const hold = (dir: string, pid: number, age = 0) => {
  writeFileSync(join(dir, 'chatgpt.lock'), `${pid}\n`)
  utimesSync(join(dir, 'chatgpt.lock'), (NOW - age) / 1000, (NOW - age) / 1000)
}

type Opts = {
  items?: Record<string, string>
  config?: unknown
  key?: string
  claims?: Record<string, unknown>
  grant?: Record<string, unknown>
  answer?: (url: string, form: URLSearchParams, init: RequestInit) => Response | Promise<Response>
  refuseWrite?: boolean
  readBack?: string
  busy?: boolean
  alive?: number
  tty?: boolean
  pipe?: boolean
  lock?: LockPort
  // Environment supplied to the optional sign-in client.
  env?: Record<string, string>
}
// A CLI run over a fake Keychain (`items`: namespace + account → value) and fake ports; `h.log` keeps the order of reads, writes,
// fetches, the shield and output.
function world(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-chatgpt-'))
  dirs.push(dir)
  const configPath = join(dir, 'klyth.json')
  if (o.config !== undefined) writeFileSync(configPath, JSON.stringify(o.config))
  const items: Record<string, string> = Object.fromEntries(Object.entries(o.items ?? {}).map(([p, value]) => [`klyth:${p}`, value]))
  const h = { log: [] as string[], argv: [] as string[][], out: [] as string[], err: [] as string[], opened: [] as string[], pages: [] as string[], piped: [] as string[], ports: [] as number[], forms: [] as URLSearchParams[], inits: [] as RequestInit[], urls: [] as string[], slept: [] as number[], items }
  let onCallback: ((url: URL) => string) | undefined
  let paste: (line: string | undefined) => void = () => {}
  let seq = 0
  // The clock moves only when the code under test sleeps.
  let clock = NOW
  const run: Run = async (argv, input) => {
    h.argv.push([...argv])
    const [, verb] = argv
    if (verb === '-i') {
      h.log.push('write')
      const m = /^add-generic-password -U -s klyth -a "([^"]*)" -l "klyth [^"]*" -w "([^"]*)"\n$/.exec(input ?? '')
      if (o.refuseWrite || m === null) return { exitCode: 51, stdout: '' }
      items[`klyth:${m[1]}`] = m[2] as string
      return { exitCode: 0, stdout: '' }
    }
    const account = argv[argv.indexOf('-a') + 1] ?? ''
    const itemKey = `${argv[argv.indexOf('-s') + 1]}:${account}`
    if (verb === 'delete-generic-password') return h.log.push('delete'), { exitCode: itemKey in items ? (delete items[itemKey], 0) : 44, stdout: '' }
    if (argv.includes('-w')) h.log.push('read')
    if (!(itemKey in items)) return { exitCode: 44, stdout: '' }
    return { exitCode: 0, stdout: argv.includes('-w') ? `${o.readBack ?? items[itemKey]}\n` : 'keychain: "login"\n' }
  }
  const authorize = () => new URL(h.out[h.out.indexOf('Open this URL to sign in:') + 1] ?? 'http://none.invalid/')
  const grant = () => ({ access_token: ACCESS, refresh_token: REFRESH, id_token: jwt({ iss: 'https://auth.openai.com', aud: CLIENT, nonce: authorize().searchParams.get('nonce'), exp: S + 600, sub: 'user-placeholder', email: EMAIL, ...o.claims }), token_type: 'Bearer', expires_in: 3600, scope: SCOPE, ...o.grant })
  const answer = (url: string, form: URLSearchParams) => {
    if (url === MODELS_URL) return Response.json({ models: [{ slug: 'model-a', display_name: 'Model A', visibility: 'list' }, { slug: 'model-b', display_name: 'Model B', visibility: 'hide' }] })
    if (form.get('grant_type') === 'authorization_code') return Response.json(grant())
    return Response.json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, token_type: 'Bearer', expires_in: 3600, scope: SCOPE })
  }
  const io: Io & Ports = {
    platform: 'darwin',
    which: () => undefined,
    run,
    readKey: async () => o.key ?? '',
    configPath,
    out: line => void (h.log.push('out'), h.out.push(line)),
    err: line => void h.err.push(line),
    async fetch(url, init) {
      const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
      h.log.push(`fetch ${url}`)
      h.forms.push(form)
      h.inits.push(init)
      h.urls.push(url)
      return (o.answer ?? answer)(url, form, init)
    },
    now: () => clock,
    sleep: async ms => void (h.slept.push(ms), (clock += ms)),
    random: n => Uint8Array.from({ length: n }, () => seq++ & 0xff),
    listen(port, cb) {
      h.ports.push(port)
      if (o.busy) return new Error('EADDRINUSE')
      onCallback = cb
      return { url: `http://127.0.0.1:${port}/auth/callback`, close: () => void h.log.push('close') }
    },
    open: url => void h.opened.push(url),
    readLine: () => new Promise(resolve => (paste = resolve)),
    lock: name => o.lock ?? fileLock(dir, name),
    async shield(work) {
      h.log.push('shield in')
      try {
        return await work()
      } finally {
        h.log.push('shield out')
      }
    },
    pid: 4242,
    alive: pid => pid === o.alive,
    stdoutIsTTY: o.tty ?? false,
    hostIdPath: join(dir, 'klyth-host-id'),
    pipe: async text => (h.log.push('pipe'), h.piped.push(text), o.pipe ?? true),
    env: o.env,
  }
  const listening = async () => {
    for (let i = 0; i < 500 && (onCallback === undefined || !h.out.includes('Open this URL to sign in:')); i++) await Bun.sleep(2)
    expect(onCallback).toBeDefined()
  }
  return {
    h,
    io,
    dir,
    configPath,
    authorize,
    cli: (...args: string[]) => cli(args, io),
    listening,
    // Calls the listener as the browser would, with this sign-in's state unless `query` sets one.
    callback: async (query: Record<string, string>) => {
      await listening()
      const url = new URL('http://127.0.0.1/auth/callback')
      for (const [k, v] of Object.entries({ state: authorize().searchParams.get('state') ?? '', ...query })) url.searchParams.set(k, v)
      h.pages.push(onCallback?.(url) ?? '')
    },
    paste: async (line: string | undefined) => (await listening(), paste(line)),
    // Output lines and argv, where no token may appear.
    shown: () => JSON.stringify([h.out, h.err, h.argv, h.opened, h.pages]),
  }
}

// A login through the browser callback that completes with the issued client id.
async function signIn(w: ReturnType<typeof world>, ...flags: string[]) {
  const done = w.cli('login', 'chatgpt', '--chatgpt', ...flags)
  await w.callback({ code: 'code-placeholder', client_id: CLIENT })
  return done
}


export { ACCESS, b64, CLIENT, DEAD_LINE, dirs, EMAIL, Fields, hold, item, jwt, KLYTH_UA, LONG, MODELS_URL, NEW_ACCESS, NEW_REFRESH, NOW, Opts, REFRESH, ROTATED, S, SCOPE, SECURITY, signIn, TOKEN_URL, TOKENS, tooLong, world }
