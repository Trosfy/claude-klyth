// Auth entry points over synthetic credentials and offline fixtures.
import { afterAll } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Io } from '../../scripts/auth'
import { cli } from '../../scripts/auth'
import type { Ports } from '../../scripts/chatgpt'

const KEY = 'sk-klyth-test-0123456789abcdef'
const SECURITY = '/usr/bin/security'
const TOOL = '/usr/bin/secret-tool'
const READ = [SECURITY, 'find-generic-password', '-s', 'klyth', '-a', 'acme', '-w']
const LOOKUP = [TOOL, 'lookup', 'service', 'klyth', 'provider', 'acme']
const SEARCH = [TOOL, 'search', '--all', 'service', 'klyth', 'provider', 'acme']
const PROVIDER = { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: { command: ['/bin/true'], ttlSeconds: 60 }, models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } }
// A ChatGPT sign-in item whose access token has an hour left at the fake clock.
const SIGN_IN = 'v1|app-client-placeholder|rt-placeholder-refresh|1800003600||at-placeholder-access'
const TOKEN_COMMAND = [process.execPath, join(import.meta.dir, '..', '..', 'scripts', 'auth.ts'), 'token', 'acme']
const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))

// What `security -i` makes of a line (observed on macOS): spaces split it, `"` quotes, `\` escapes the next character.
function tokens(text: string): string[] {
  const out: string[] = []
  let cur: string | undefined
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '\\') cur = (cur ?? '') + (text[++i] ?? '')
    else if (c === '"') ((quoted = !quoted), (cur ??= ''))
    else if (/\s/.test(c) && !quoted) (cur !== undefined && out.push(cur), (cur = undefined))
    else cur = (cur ?? '') + c
  }
  return cur === undefined ? out : [...out, cur]
}

type Call = { argv: readonly string[]; input?: string }
// A CLI run over a fake keyring (`items`: namespace + account → key) as `security` or `secret-tool` would keep it. `readBack`
// replaces what the key reads back as; `refuse` makes the store fail.
function world(o: { platform?: string; tool?: boolean; key?: string; config?: unknown; readBack?: string; refuse?: boolean; locked?: boolean; items?: Record<string, string>; tty?: boolean; fetch?: Ports['fetch'] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'klyth-auth-')))
  dirs.push(dir)
  const configPath = join(dir, 'klyth.json')
  if (o.config !== undefined) writeFileSync(configPath, JSON.stringify(o.config))
  const items: Record<string, string> = Object.fromEntries(Object.entries(o.items ?? {}).map(([p, value]) => [`klyth:${p}`, value]))
  const locked = new Set(o.locked ? Object.keys(items) : [])
  const h = { calls: [] as Call[], out: [] as string[], err: [] as string[], asked: 0, items, ports: [] as number[], opened: [] as string[], fetched: [] as string[] }
  const answer = async (argv: readonly string[], input?: string) => {
    const [bin, verb] = argv
    const account = argv[argv.indexOf(bin === SECURITY ? '-a' : 'provider') + 1] ?? ''
    const itemKey = `${argv[argv.indexOf(bin === SECURITY ? '-s' : 'service') + 1]}:${account}`
    if (o.refuse && (verb === '-i' || verb === 'store')) return { exitCode: 51, stdout: '' }
    if (bin === SECURITY && verb === '-i') {
      const t = tokens((input ?? '').split('\n')[0] ?? '')
      const at = (flag: string) => t[t.indexOf(flag) + 1]
      if (t[0] !== 'add-generic-password' || t.length !== 10 || at('-s') !== 'klyth' || at('-l') !== `klyth ${at('-a')}`) return { exitCode: 2, stdout: '' }
      items[`${at('-s')}:${at('-a')}`] = at('-w') as string
      return { exitCode: 0, stdout: '' }
    }
    // A dismissed lookup unlock is silent; a later store prompt can succeed and replace that same item.
    if (verb === 'lookup' && locked.has(itemKey)) return { exitCode: 1, stdout: '' }
    if (verb === 'store') return (locked.delete(itemKey), (items[itemKey] = input ?? ''), { exitCode: 0, stdout: '' })
    if (verb === 'delete-generic-password' || verb === 'clear') return { exitCode: itemKey in items ? (delete items[itemKey], 0) : bin === SECURITY ? 44 : 1, stdout: '' }
    if (verb === 'search') {
      if (!(itemKey in items)) return { exitCode: 0, stdout: '' }
      // libsecret 0.21.7 search prints metadata even when retrieving the locked secret fails; it still exits 0.
      const secret = locked.has(itemKey) ? '' : `secret = ${items[itemKey]}\n`
      const namespace = argv[argv.indexOf('service') + 1]
      return { exitCode: 0, stdout: `[/1]\nlabel = ${namespace} ${account}\n${secret}created = 2026-01-01 00:00:00\nmodified = 2026-01-01 00:00:00\n`, stderr: `${locked.has(itemKey) ? 'secret-tool: synthetic locked-item retrieval error\n' : ''}attribute.service = ${namespace}\nattribute.provider = ${account}\n` }
    }
    if (!(itemKey in items)) return { exitCode: bin === SECURITY ? 44 : 1, stdout: '' }
    const secret = o.readBack ?? (items[itemKey] as string)
    return { exitCode: 0, stdout: bin === SECURITY ? (argv.includes('-w') ? `${secret}\n` : `keychain: "login"\n    "acct"<blob>="${account}"\n`) : secret }
  }
  // The ChatGPT ports: no network unless `fetch` is given, and a listener that finds its port busy, so a --chatgpt
  // login ends at once.
  const ports: Ports = {
    fetch: (url, init) => (h.fetched.push(url), o.fetch ? o.fetch(url, init) : Promise.reject(new Error('no network in this spec'))),
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    random: n => new Uint8Array(n),
    listen: port => (h.ports.push(port), new Error('EADDRINUSE')),
    open: url => void h.opened.push(url),
    readLine: async () => undefined,
    lock: name => ({ path: join(dir, `${name}.lock`), take: () => true, holder: () => undefined, steal: () => false, release: () => {} }),
    shield: work => work(),
    pid: 4242,
    alive: () => false,
    stdoutIsTTY: o.tty ?? false,
    hostIdPath: join(dir, 'klyth-host-id'),
    pipe: async () => true,
  }
  const io: Io & Ports = {
    platform: o.platform ?? 'darwin',
    which: n => (n === 'secret-tool' ? (o.tool ? TOOL : undefined) : n === 'op' ? '/opt/homebrew/bin/op' : undefined),
    run: async (argv, input) => (h.calls.push({ argv, ...(input === undefined ? {} : { input }) }), answer(argv, input).then(result => ({ stderr: '', ...result }))),
    readKey: async () => (h.asked++, o.key ?? `${KEY}\n`),
    configPath,
    
    out: l => void h.out.push(l),
    err: l => void h.err.push(l),
    ...ports,
  }
  return { h, io, dir, configPath, cli: (...args: string[]) => cli(args, io), said: () => [...h.out, ...h.err].join('\n') }
}


export { Call, dirs, KEY, LOOKUP, PROVIDER, READ, SEARCH, SECURITY, SIGN_IN, TOKEN_COMMAND, tokens, TOOL, world }
