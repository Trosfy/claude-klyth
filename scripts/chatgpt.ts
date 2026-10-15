// OAuth sign-in, keyring records and refresh locks for ChatGPT providers.
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { CREDENTIAL_NAMESPACE, hostIdentityPath, klythUserAgent, refreshLockDirectory } from '../hooks/product'

import manifest from '../.claude-plugin/plugin.json' with { type: 'json' }
import { isObject } from '../hooks/config'
import { knownMethod } from '../hooks/extra-client'
import { redact } from '../hooks/redact'
import type { Io, Store } from './auth'
import type { AuthOperationOptions, ModelDescriptor } from './auth-operation'
import { OFFICIAL_PROFILE } from './chatgpt-profiles'
import type { Lookup } from './credential-store'
import { lookup } from './credential-store'
import type { ExtraSignIn } from './extra-sign-in'
import type { ExtraClientId, ExtraMethod } from './extras'

// A lock as found: the pid in it and when it was taken (epoch ms).
export type Holder = { pid: number; at: number }
// The lock file's primitives: `path` is the lock file, `take` links a file holding `pid` as the lock (false when one
// exists), `holder` reads it, `steal` replaces it with one holding `pid` while it is still the lock `seen` (false
// once it is another), `release` removes it while this process holds it.
export type LockPort = { path: string; take(pid: number): boolean; holder(): Holder | undefined; steal(seen: Holder, pid: number): boolean; release(): void }
// `listen` serves GET /auth/callback on 127.0.0.1 (the page shows what `onCallback` returns); `readLine` gives one
// non-blank stdin line, undefined at its end; `shield` runs `work` with SIGTERM ignored; `pipe` writes stdout and
// says whether all of it was written; `sleep` waits between device-code polls and between reads of a held item.
export type Ports = AuthOperationOptions & {
  fetch(url: string, init: RequestInit): Promise<Response>
  now(): number
  sleep(ms: number): Promise<void>
  random(bytes: number): Uint8Array
  listen(port: number, onCallback: (url: URL) => string): { url: string; close(): void } | Error
  open(url: string): void
  readLine(): Promise<string | undefined>
  lock(name: string, namespace?: string): LockPort
  shield<T>(work: () => Promise<T>): Promise<T>
  pid: number
  alive(pid: number): boolean
  stdoutIsTTY: boolean
  hostIdPath: string
  pipe(text: string): Promise<boolean>
}
export type ChatGptIo = Pick<Io, 'run' | 'out' | 'err' | 'configPath' | 'platform' | 'extraSignIn' | 'env'> & Ports & { store: Store }

const ISSUER = OFFICIAL_PROFILE.issuer
// The API a Sign in with ChatGPT token is for: the `resource` it is issued for, and the provider's baseUrl.
export const RESOURCE = OFFICIAL_PROFILE.resource
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const DYNAMIC = OFFICIAL_PROFILE.clientId
const AHEAD_MS = 15 * 60_000 // a token with less left is refreshed
const REFRESH_MS = 5_000
const STALE_MS = 30_000 // keyring calls are bounded at 5 s; critical sections finish below this deadline
const LOGIN_FETCH_MS = 30_000
const WAIT_MS = 5 * 60_000
// One item field: visible ASCII without |, " or \ (security -i reads the last two as quoting and an escape).
export const FIELD = /^[\x21\x23-\x5b\x5d-\x7b\x7d\x7e]*$/
// The refresh errors that end a sign-in (the item is kept, so the next login reuses its client id).
const DEAD = /invalid_grant|invalid_refresh_token|refresh_token_expired|token_expired|refresh_token_invalidated|refresh_token_reused/
type Method = 'v1' | ExtraMethod
const methodPolicy = (io: ChatGptIo, method: Method, p = '') => method === 'v1' ? { url: OFFICIAL_PROFILE.tokenUrl, refresh: { resource: RESOURCE }, login: `klyth auth login chatgpt --provider ${p}` } : { url: io.extraSignIn!.refresh.tokenUrl, refresh: io.extraSignIn!.refresh.fields, login: io.extraSignIn!.refresh.loginHint(p) }

// The keyring item: <method>|<client id>|<refresh token>|<expires at, epoch s>|<earliest_refresh_at as given>|<access token>.
type Item = { method: Method; clientId: string; refresh: string; expiresAt: number; earliest: string; access: string }
export type Answer = { status: number; text: string; body: Record<string, unknown> } | { failed: string }
type Back = { code: string; clientId: string | null } | { fail: string }

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
// A server's text made safe for one terminal line.
const clean = (v: unknown) => String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 160)
const fresh = (i: Item, now: number) => i.expiresAt * 1000 - now >= AHEAD_MS
const valid = (i: Item, now: number) => i.expiresAt * 1000 > now
const format = (i: Item) => [i.method, i.clientId, i.refresh, String(i.expiresAt), i.earliest, i.access].join('|')
export const who = (claims: Record<string, unknown>) => clean(claims['email'] ?? claims['sub'] ?? 'an account with no email')
export const isSignIn = (value: string) => /^[a-z][a-z0-9]{0,15}$/.test(value.split('|')[0] ?? '') && value.split('|').length === 6
export const reservedRecord = (value: string) => value.includes('|') && /^[a-z][a-z0-9]{0,15}$/.test(value.slice(0, value.indexOf('|')))

export function parseItem(value: string, extra?: ExtraSignIn<ExtraClientId, ExtraMethod>): Item | undefined {
  const f = value.split('|')
  if (f.length !== 6 || !f.every(x => FIELD.test(x))) return undefined
  const [method, clientId, refresh, expires, earliest, access] = f as [string, string, string, string, string, string]
  return knownMethod(extra?.client, method) && refresh !== '' && access !== '' && /^\d{1,12}$/.test(expires) ? { method, clientId, refresh, expiresAt: Number(expires), earliest, access } : undefined
}

// The key command klythd runs for a ChatGPT provider.
export const tokenCommand = (p: string) => [process.execPath, join(import.meta.dir, 'auth.ts'), 'token', p]

// The provider's item, or the line saying why there is none.
async function readItem(io: ChatGptIo, p: string): Promise<Item | string> {
  const r = await io.run(io.store.read(p))
  if (r.exitCode !== 0) return `no ChatGPT sign-in readable for ${p} in the ${io.store.name} (locked, or none stored). Run klyth auth login chatgpt --provider ${p}`
  return parseItem(r.stdout.trim(), io.extraSignIn) ?? `${p}'s item in the ${io.store.name} is not a ChatGPT sign-in. Run klyth auth login chatgpt --provider ${p}`
}

// Writes the item and reads it back: undefined once it reads back intact, else the failure line and whether the
// stored item is untouched (the store refused the item before writing it, as too long for security -i).
async function save(io: ChatGptIo, p: string, value: string): Promise<{ line: string; untouched: boolean } | undefined> {
  const add = io.store.add(p, value)
  if (typeof add === 'string') return { line: add, untouched: true }
  const added = await io.run(add.argv, add.input)
  if (added.exitCode !== 0) return { line: `the ${io.store.name} refused the sign-in (exit ${added.exitCode}); unlock it, then retry`, untouched: false }
  const back = await io.run(io.store.read(p))
  return back.exitCode === 0 && back.stdout.trim() === value ? undefined : { line: `Stored, but reading ${p} back did not give the same sign-in (exit ${back.exitCode}). Run klyth auth logout ${p}. Then run ${methodPolicy(io, parseItem(value, io.extraSignIn)?.method ?? 'v1', p).login}.`, untouched: false }
}

// Stores a piped item (export's output) unchanged; the failure line, or undefined.
export async function importItem(io: ChatGptIo, p: string, value: string, prior?: Lookup): Promise<string | undefined> {
  if (parseItem(value, io.extraSignIn) === undefined) return `the piped ChatGPT sign-in is not a usable ${value.split('|')[0]}| item; nothing stored`
  const held = prior ?? await lookup(io.run, io.store, p)
  return mutateCredential(io, p, held, async () => (await save(io, p, value))?.line)
}

// All current writers share the retained token helper's refresh lock. Run ports must bound each keyring call.
export async function mutateCredential(io: ChatGptIo, p: string, prior: Lookup, work: () => Promise<string | undefined>): Promise<string | undefined> {
  if (prior.status === 'error') return `lookup failed in the ${io.store.name}; nothing stored`
  if (io.signal?.aborted) return 'operation cancelled; nothing stored'
  const lock = io.lock(p)
  const got = acquire(io, lock)
  if (got !== true) return typeof got === 'string' ? got : busy(lock)
  try {
    return await io.shield(async () => {
      const current = await lookup(io.run, io.store, p)
      if (current.status !== prior.status || (current.status === 'found' && prior.status === 'found' && current.value !== prior.value)) return 'credential changed while waiting; retry after stopping other credential writers'
      if (io.signal?.aborted) return 'operation cancelled; nothing stored'
      return work()
    })
  } finally { lock.release() }
}

// klyth's own User-Agent: klyth/<version in .claude-plugin/plugin.json>.
declare const KLYTH_VERSION: string
export const klythAgent = () => klythUserAgent(typeof KLYTH_VERSION === 'string' ? KLYTH_VERSION : manifest.version)

const authIdentity = (io: ChatGptIo) => { const value = io.extraSignIn?.authUserAgent(io.env ?? {}) ?? {}; if ('error' in value) throw new Error(value.error); return value }

// A POST to auth.openai.com, form-encoded or JSON, as klyth (or the auth User-Agent override), bounded at `ms`.
export async function post(io: ChatGptIo, url: string, fields: Record<string, string>, ms: number, as: 'form' | 'json' = 'form'): Promise<Answer> {
  try {
    const type = as === 'json' ? 'application/json' : 'application/x-www-form-urlencoded'
    const res = await io.fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': type, accept: 'application/json', 'user-agent': authIdentity(io).userAgent ?? klythAgent() }, body: as === 'json' ? JSON.stringify(fields) : new URLSearchParams(fields).toString(), signal: io.signal ? AbortSignal.any([io.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {}
    return { status: res.status, text, body: isObject(body) ? body : {} }
  } catch (err) {
    return { failed: err instanceof Error && err.name === 'TimeoutError' ? `no answer within ${ms / 1000} s` : 'could not reach auth.openai.com' }
  }
}

// An OAuth error answer as `<code>: <description>`, masked; '' when it carries neither.
function describe(body: Record<string, unknown>): string {
  const e = body['error']
  const parts = [isObject(e) ? (e['code'] ?? e['type']) : e, body['error_description'] ?? (isObject(e) ? e['message'] : undefined)]
  return redact(clean(parts.filter(x => typeof x === 'string' && x !== '').join(': ')))
}

// The item a token answer makes under `base`'s method and client (a missing refresh token keeps `base.refresh`);
// undefined when a token is missing or holds a character the item cannot.
function itemOf(t: Record<string, unknown>, base: Pick<Item, 'method' | 'clientId' | 'refresh'>, now: number): Item | undefined {
  const [access, next, life, at] = [t['access_token'], t['refresh_token'] ?? base.refresh, t['expires_in'], t['earliest_refresh_at']]
  const earliest = typeof at === 'number' || typeof at === 'string' ? String(at) : ''
  if (typeof access !== 'string' || typeof next !== 'string' || access === '' || next === '' || ![access, next, earliest].every(f => FIELD.test(f))) return undefined
  return { method: base.method, clientId: base.clientId, refresh: next, expiresAt: Math.floor(now / 1000) + (typeof life === 'number' && life > 0 ? Math.floor(life) : 3600), earliest, access }
}

// The claims of a JWT, read without checking its signature: klyth grants nothing on the identity, and the code
// was exchanged over TLS with PKCE.
function claimsOf(jwt: unknown): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'))
    return isObject(v) ? v : undefined
  } catch {
    return undefined
  }
}

// The ID token's claims once it is for `clientId` (aud), from OpenAI (iss) and current (exp), and, on a Sign in with
// ChatGPT login (`nonce` given), once the answer grants plan usage and the nonce is this sign-in's; else the failure
// line. A device-code sign-in has neither a nonce nor the plan scope.
export function verify(t: Record<string, unknown>, clientId: string, now: number, nonce?: string): Record<string, unknown> | string {
  const scope = t['scope']
  if (nonce !== undefined && (typeof scope !== 'string' || !scope.split(' ').includes(PLAN_SCOPE))) return 'ChatGPT plan usage was not granted; run login again and allow klyth to use your plan'
  const c = claimsOf(t['id_token'])
  const aud = c?.['aud']
  const exp = c?.['exp']
  const bad =
    c === undefined ? 'format' : nonce !== undefined && c['nonce'] !== nonce ? 'nonce' : aud !== clientId && !(Array.isArray(aud) && aud.includes(clientId)) ? 'aud' : c['iss'] !== ISSUER ? 'iss' : typeof exp === 'number' && exp * 1000 > now ? undefined : 'exp'
  return bad === undefined ? c ?? {} : `ChatGPT's ID token failed its ${bad} check; nothing stored; run login again`
}

// The first non-empty item-safe string `pick` finds in the ID token's claims, else in the access token's; `pick`
// gets the claims and the object OpenAI nests under https://api.openai.com/auth ({} when absent).
export function fromClaims(t: Record<string, unknown>, pick: (c: Record<string, unknown>, auth: Record<string, unknown>) => unknown[]): string | undefined {
  for (const c of [claimsOf(t['id_token']), claimsOf(t['access_token'])]) {
    const auth = c?.['https://api.openai.com/auth']
    const found = c === undefined ? undefined : pick(c, isObject(auth) ? auth : {}).find(v => typeof v === 'string' && v !== '' && FIELD.test(v))
    if (typeof found === 'string') return found
  }
  return undefined
}

// Exchanges a sign-in's code at its method's token endpoint, checks the answer with `check`, and only then stores
// the item it makes and reads it back: what `check` gave and the item, or the failure line.
export async function redeem<T extends object>(io: ChatGptIo, p: string, prior: Lookup, method: Method, clientId: string, form: Record<string, string>, check: (t: Record<string, unknown>) => T | string, headers?: (got: T) => Record<string, string | undefined>): Promise<{ got: T; item: Item; value: string } | string> {
  const ex = await post(io, methodPolicy(io, method).url, { grant_type: 'authorization_code', client_id: clientId, ...form }, LOGIN_FETCH_MS)
  if ('failed' in ex) return `could not finish the sign-in (${ex.failed}); run login again`
  if (ex.status !== 200) return `ChatGPT refused the sign-in (${describe(ex.body) || `HTTP ${ex.status}`})`
  const got = check(ex.body)
  if (typeof got === 'string') return got
  const item = itemOf(ex.body, { method, clientId, refresh: '' }, io.now())
  if (item === undefined) return `ChatGPT's token answer cannot be stored (a token is missing or holds |, " or \\); run login again`
  const value = format(item)
  return await mutateCredential(io, p, prior, async () => {
    const failed = (await save(io, p, value))?.line
    if (failed === undefined) io.operation?.credentialsSaved?.({ provider: p, method, clientId, fingerprint: createHash('sha256').update(value).digest('hex'), ...(headers === undefined ? {} : { headers: headers(got) }) })
    return failed
  }) ?? { got, item, value }
}

// The host id sent with every sign-in: made once (urn:uuid:<v4>, mode 0600) and kept across logouts.
function hostId(io: ChatGptIo): string {
  try {
    const saved = readFileSync(io.hostIdPath, 'utf8').trim()
    if (/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved)) return saved
  } catch {}
  const b = io.random(16)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const h = Buffer.from(b).toString('hex')
  const id = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  writeFileSync(io.hostIdPath, `${id}\n`, { mode: 0o600 })
  return id
}

// What a callback or pasted URL means for this sign-in; undefined when its state is another sign-in's.
function outcome(url: URL, state: string): Back | undefined {
  const q = url.searchParams
  if (q.get('state') !== state) return undefined
  const error = q.get('error')
  return error === null ? { code: q.get('code') ?? '', clientId: q.get('client_id') } : { fail: `ChatGPT refused the sign-in (${clean(error)}: ${clean(q.get('error_description') ?? '')})` }
}

// Signs in through the browser or a pasted URL, then stores the item; 0 once it reads back intact.
export async function login(io: ChatGptIo, p: string, o: { port: number; browser: boolean }): Promise<number> {
  const fail = (why: string) => (io.err(`klyth auth: ${why}`), 1)
  const held = await lookup(io.run, io.store, p)
  if (held.status === 'error') return fail(`lookup failed in the ${io.store.name}; nothing stored`)
  let host: string
  try {
    host = hostId(io)
  } catch {
    return fail(`could not write ${io.hostIdPath}`)
  }
  const saved = held.status === 'found' ? parseItem(held.value, io.extraSignIn) : undefined
  const inUse = saved !== undefined && saved.method === 'v1' && saved.clientId !== '' ? saved.clientId : DYNAMIC
  const [state, nonce, verifier] = [b64url(io.random(32)), b64url(io.random(32)), b64url(io.random(32))]
  let settle: (b: Back) => void = () => {}
  const back = new Promise<Back>(resolve => (settle = resolve))
  const listener = io.listen(o.port, url => {
    const b = outcome(url, state)
    if (b === undefined) return 'klyth: not this sign-in; close this page'
    settle(b)
    return 'fail' in b ? 'klyth: the sign-in was refused; see the terminal' : 'klyth: sign-in received; return to the terminal'
  })
  if (listener instanceof Error) return fail(`127.0.0.1:${o.port} is in use; retry with --port <n>`)
  const q = new URLSearchParams({ response_type: 'code', client_id: inUse, redirect_uri: listener.url, scope: OFFICIAL_PROFILE.scope, resource: RESOURCE, state, nonce })
  q.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()))
  q.set('code_challenge_method', 'S256')
  q.set('ext_agent_host_id', host)
  if (inUse === DYNAMIC) q.set('agent_name_hint', 'klyth')
  const url = `${OFFICIAL_PROFILE.authorizeUrl}?${q}`
  try {
    if (io.operation) io.operation.challenge?.({ type: 'browser-challenge', authorizeUrl: url, expiresAt: io.now() + WAIT_MS })
    else {
      io.out('Open this URL to sign in:')
      io.out(url)
      io.out(`No browser here? Forward the port (ssh -L ${o.port}:127.0.0.1:${o.port} <this host>), or sign in on any device and paste the URL your browser lands on:`)
    }
    if (o.browser) io.open(url)
  } catch { listener.close(); return fail('could not present the browser sign-in; retry with --no-browser') }
  if (!io.operation) void io.readLine().then(
    line => {
      if (line === undefined) return
      const pasted = URL.canParse(line.trim()) ? outcome(new URL(line.trim()), state) : undefined
      settle(pasted ?? { fail: "the pasted URL's state does not match this sign-in; run login again" })
    },
    () => {},
  )
  const timer = setTimeout(() => settle({ fail: 'the sign-in did not complete within 5 minutes; run login again' }), WAIT_MS)
  const cancel = () => settle({ fail: 'operation cancelled' })
  io.signal?.addEventListener('abort', cancel, { once: true })
  if (io.signal?.aborted) cancel()
  const r = await back.finally(() => { clearTimeout(timer); listener.close(); io.signal?.removeEventListener('abort', cancel) })
  if ('fail' in r) return fail(r.fail)

  const clientId = r.clientId ?? (inUse === DYNAMIC ? '' : inUse)
  if (r.code === '' || !FIELD.test(r.code) || clientId === '' || !FIELD.test(clientId)) return fail('the callback carried no usable code or client id; run login again')
  const done = await redeem(io, p, held, 'v1', clientId, { code: r.code, code_verifier: verifier, redirect_uri: listener.url, resource: RESOURCE }, t => verify(t, clientId, io.now(), nonce))
  if (typeof done === 'string') return fail(done)
  if (!io.operation) io.out(`${p}: signed in as ${who(done.got)} (client ${clientId}); sign-in stored in the ${io.store.name}; access token ${done.item.access.length} chars, item ${done.value.length} chars`)
  await listModels(io, done.item.access)
  return 0
}

// Prints the plan's models (display name, then the id klyth.json takes, then the context window when listed), or says
// they could not be listed.
export async function listModels(io: ChatGptIo, access: string, url = `${RESOURCE}/models`, headers: Record<string, string> = {}) {
  let rows: string[] = []
  let models: ModelDescriptor[] = []
  try {
    const res = await io.fetch(url, { redirect: 'error', headers: { 'user-agent': klythAgent(), ...headers, authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(LOGIN_FETCH_MS) })
    const body: unknown = res.ok ? await res.json() : undefined
    const list = (key: string) => (isObject(body) && Array.isArray(body[key]) ? (body[key] as unknown[]).filter(isObject) : [])
    const entries: Record<string, unknown>[] = list('models').length > 0 ? list('models').filter(m => m['visibility'] === 'list').map(m => ({ ...m, id: m['slug'] })) : list('data')
    models = entries.slice(0, 100).flatMap(m => {
      const id = m['id']
      if (typeof id !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(id)) return []
      const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
      const contextWindow = number(m['context_window']), maxOutputTokens = number(m['max_output_tokens'])
      return [{ id, ...(typeof m['display_name'] === 'string' ? { name: clean(m['display_name']) } : {}), ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) }]
    })
    const window = (m: Record<string, unknown>) =>
      typeof m['context_window'] === 'number' ? `  (context ${m['context_window']}${typeof m['max_context_window'] === 'number' ? `, up to ${m['max_context_window']}` : ''})` : ''
    rows = list('models').length > 0
      ? list('models').filter(m => m['visibility'] === 'list' && typeof m['slug'] === 'string').map(m => `  ${clean(m['display_name'] ?? m['slug'])}  ${clean(m['slug'])}${window(m)}`)
      : list('data').filter(m => typeof m['id'] === 'string').map(m => `  ${clean(m['id'])}`)
  } catch {}
  if (io.operation) return void io.operation.models?.(models)
  if (rows.length === 0) return io.out('could not list models; copy ids from ChatGPT')
  io.out('models on this plan (name, then the id for klyth.json):')
  for (const row of rows) io.out(row)
}

// earliest_refresh_at in ms: integer epoch seconds (ms when over 10^12) or ISO 8601; undefined when absent, NaN when
// unreadable.
function earliestOf(raw: string): number | undefined {
  if (raw === '') return undefined
  if (/^\d+$/.test(raw)) return Number(raw) > 1e12 ? Number(raw) : Number(raw) * 1000
  return /^\d{4}-\d\d-\d\dT/.test(raw) ? Date.parse(raw) : NaN
}

// Takes the lock by linking a file holding this pid. A lock whose holder is dead, or that is STALE_MS old (after a
// reboot its pid may be another process's), is stolen, by one process only. False while a live process holds a recent
// lock; the failure line when the lock file cannot be made.
export function acquire(io: Pick<Ports, 'pid' | 'alive' | 'now'>, lock: LockPort): boolean | string {
  try {
    for (let tries = 0; tries < 3; tries++) {
      if (lock.take(io.pid)) return true
      const held = lock.holder()
      if (held === undefined) continue
      if (io.alive(held.pid) && io.now() - held.at < STALE_MS) return false
      if (lock.steal(held, io.pid)) return true
    }
    return false
  } catch (err) {
    return `could not take the refresh lock (${clean(err instanceof Error ? err.message : err)})`
  }
}

// The line for a lock another process holds. The file shows as `<name>.lock in <folder>` with the home folder as ~,
// so no run of it is long enough for klythd to mask it as a credential.
function busy(lock: LockPort): string {
  const [dir, home] = [dirname(lock.path), homedir()]
  return `another klyth refresh is running (lock ${basename(lock.path)} in ${dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir}); retry`
}

type Out = { access: string; note?: string } | { exit: number; note: string }

// The lock holder's part: re-reads the item, then, with SIGTERM ignored from the POST to the read-back, refreshes
// and writes the rotated item.
async function renew(io: ChatGptIo, p: string): Promise<Out> {
  const it = await readItem(io, p)
  if (typeof it === 'string') return { exit: 1, note: it }
  const m = methodPolicy(io, it.method, p)
  const now = io.now()
  const current = (note: string): Out => (valid(it, now) ? { access: it.access, note } : { exit: 1, note })
  const dead: Out = { exit: 3, note: `The ChatGPT sign-in expired or ChatGPT revoked it. Run ${m.login}` }
  const refuses = (at: number | undefined): Out => (valid(it, now) ? { access: it.access } : { exit: 4, note: `ChatGPT refuses a refresh until ${at === undefined || Number.isNaN(at) ? 'later' : new Date(at).toISOString()}; retry then` })
  if (fresh(it, now)) return { access: it.access }
  if (it.clientId === '') return valid(it, now) ? { access: it.access } : dead
  const notBefore = earliestOf(it.earliest)
  if (notBefore !== undefined && Number.isNaN(notBefore)) io.err(`klyth auth: ${p}'s earliest_refresh_at is unreadable; refreshing anyway`)
  if (notBefore !== undefined && notBefore > now) return refuses(notBefore)
  const r = await io.shield(async () => {
    const a = await post(io, m.url, { grant_type: 'refresh_token', client_id: it.clientId, refresh_token: it.refresh, ...m.refresh }, REFRESH_MS)
    const next = 'failed' in a || a.status !== 200 ? undefined : itemOf(a.body, it, io.now())
    return { a, next, unsaved: next === undefined ? undefined : await save(io, p, format(next)) }
  })
  const { a, next, unsaved } = r
  if (next !== undefined) {
    if (unsaved === undefined) return { access: next.access }
    // Refused before any write (too long for the store): the stored item stays as it was, and no token is printed.
    if (unsaved.untouched) return { exit: 1, note: unsaved.line }
    return { access: next.access, note: `The refresh succeeded. Klyth could not store the sign-in. Before the next refresh, run ${m.login}` }
  }
  if ('failed' in a) return current(`the ChatGPT refresh failed (${a.failed}); retry`)
  if (a.status === 200) return { exit: 1, note: `ChatGPT sent no usable token response. Run ${m.login}` }
  if (a.text.includes('invalid_client')) return it.method !== 'v1' ? { exit: 3, note: io.extraSignIn!.refresh.refusedClient(p) } : (await save(io, p, format({ ...it, clientId: '' })), dead)
  if (DEAD.test(a.text)) return dead
  if (/earliest_refresh|too.early/i.test(a.text)) return refuses(earliestOf(String(a.body['earliest_refresh_at'] ?? '')))
  return current(`the ChatGPT refresh failed (HTTP ${a.status}${describe(a.body) === '' ? '' : `: ${describe(a.body)}`}); retry`)
}

// Prints a current access token and nothing else on stdout (exit 0): the stored one while 15 minutes are left,
// else one refreshed under the provider's lock; while a live process holds a recent lock, the stored one if still
// valid. Exit 1 generic, 3 when the sign-in is dead, 4 when ChatGPT refuses a refresh until later.
export async function token(io: ChatGptIo, p: string): Promise<number> {
  const first = await readItem(io, p)
  if (typeof first === 'string') return io.err(`klyth auth: ${first}`), 1
  if (fresh(first, io.now())) return io.out(first.access), 0
  const lock = io.lock(p)
  const got = acquire(io, lock)
  if (typeof got === 'string') return io.err(`klyth auth: ${got}`), 1
  let r: Out
  if (got) r = await renew(io, p).finally(() => lock.release())
  else {
    // The holder writes within its 5 s bound; an expired token waits up to 3 s for that write.
    let it: Item | string = first
    for (let tries = 0; typeof it === 'string' || !valid(it, io.now()); tries++) {
      if (tries === 12) return io.err(`klyth auth: ${busy(lock)}`), 1
      await io.sleep(250)
      it = await readItem(io, p)
    }
    r = { access: it.access }
  }
  if (r.note !== undefined) io.err(`klyth auth: ${r.note}`)
  return 'access' in r ? (io.out(r.access), 0) : r.exit
}

// Moves the item out: read under the refresh lock, written to a pipe (never a terminal) without it, then removed here,
// under the lock again, once the whole write completed and only while the item is still the one written.
export async function exportItem(io: ChatGptIo, p: string): Promise<number> {
  const fail = (why: string) => (io.err(`klyth auth: ${why}`), 1)
  if (io.stdoutIsTTY) return io.err(`klyth auth: Export prints your ChatGPT refresh token. First run ssh <host> '"$HOME/.local/bin/klyth" --version'. Then pipe it: klyth auth export ${p} | ssh <host> '"$HOME/.local/bin/klyth" auth import ${p}'`), 2
  const lock = io.lock(p)
  // `work` under the lock; `held` is the answer while another process holds it.
  const locked = async <T>(held: string, work: () => Promise<T>): Promise<T | string> => {
    const got = acquire(io, lock)
    if (got !== true) return got || held
    try {
      return await io.shield(work)
    } finally {
      lock.release()
    }
  }
  const it = await locked(busy(lock), () => readItem(io, p))
  if (typeof it === 'string') return fail(it)
  const value = format(it)
  if (!(await io.pipe(`${value}\n`))) return fail(`the pipe closed before the whole sign-in was written; ${p} stays in the ${io.store.name}`)
  const changed = `the sign-in changed while it was written (a refresh ran), so the copy sent is stale; ${p} stays in the ${io.store.name}; export again`
  const gone = await locked(changed, async () => {
    const now = await io.run(io.store.read(p))
    if (now.exitCode !== 0 || now.stdout.trim() !== value) return changed
    return (await io.run(io.store.del(p))).exitCode === 0 ? undefined : `${p}: sign-in written, but removing it from the ${io.store.name} failed. Run klyth auth logout ${p} before this machine refreshes it`
  })
  if (gone !== undefined) return fail(gone)
  io.err(`klyth auth: ${p}: sign-in moved; its item is removed from the ${io.store.name}`)
  return 0
}

// The lock as files in `dir`: <name>.lock holds the holder's pid, and its mtime is when it was taken.
export function fileLock(dir: string, name: string): LockPort {
  const path = join(dir, `${name}.lock`)
  let mine: number | undefined // the pid this port holds the lock as
  const held = (file: string): Holder | undefined => {
    try {
      const pid = Number(readFileSync(file, 'utf8').trim())
      return Number.isInteger(pid) && pid > 0 ? { pid, at: statSync(file).mtimeMs } : undefined
    } catch {
      return undefined
    }
  }
  const remove = (file: string) => {
    try {
      unlinkSync(file)
    } catch {}
  }
  // Puts a file holding `pid` in place as the lock with `put` (link: only where none is; rename: over the one there).
  const place = (pid: number, put: (own: string, to: string) => void) => {
    const own = `${path}.${pid}`
    writeFileSync(own, `${pid}\n`, { mode: 0o600 })
    try {
      put(own, path)
      mine = pid
    } finally {
      remove(own)
    }
  }
  return {
    path,
    take(pid) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        return place(pid, linkSync), true
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') return false
        throw err
      }
    },
    holder: () => held(path),
    steal(seen, pid) {
      // A second link to the lock, named after the lock as seen, lets one process at a time steal that lock and leaves
      // the lock where it is. While that link is still the lock seen, the lock is replaced by this process's in one
      // rename: no process takes a lock that exists, and one stealing another lock finds its link is not that lock, so
      // none changes the lock in between. Once it is another lock, nothing is moved.
      const claim = `${path}.stale.${seen.pid}.${seen.at}`
      try {
        linkSync(path, claim)
      } catch {
        return false
      }
      try {
        const now = held(claim)
        if (now?.pid !== seen.pid || now.at !== seen.at) return false
        return place(pid, renameSync), true
      } finally {
        remove(claim)
      }
    },
    release() {
      // A lock stolen from this process as stale is another's now, and stays.
      if (mine !== undefined && held(path)?.pid === mine) remove(path)
      mine = undefined
    },
  }
}

// Runs bounded credential commits with termination signals ignored so rotation cannot be cut before storage.
export async function shield<T>(work: () => Promise<T>): Promise<T> {
  const ignore = () => {}
  process.on('SIGTERM', ignore)
  process.on('SIGINT', ignore)
  try {
    return await work()
  } finally {
    process.off('SIGTERM', ignore)
    process.off('SIGINT', ignore)
  }
}

// The real ports; locks live in ~/.cache/klyth and the host id beside the config.
export function ports(configDir: string, platform: string): Ports {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: ms => Bun.sleep(ms),
    random: n => crypto.getRandomValues(new Uint8Array(n)),
    listen(port, onCallback) {
      try {
        const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: req => (new URL(req.url).pathname === '/auth/callback' && req.method === 'GET' ? new Response(onCallback(new URL(req.url))) : new Response('not found', { status: 404 })) })
        return { url: `http://127.0.0.1:${server.port}/auth/callback`, close: () => void server.stop(true) }
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err))
      }
    },
    open(url) {
      const bin = platform === 'darwin' ? '/usr/bin/open' : Bun.which('xdg-open')
      try {
        if (bin) Bun.spawn([bin, url], { stdio: ['ignore', 'ignore', 'ignore'] })
      } catch {}
    },
    async readLine() {
      for await (const line of console) if (line.trim() !== '') return line
      return undefined
    },
    lock: (name, namespace = CREDENTIAL_NAMESPACE) => fileLock(refreshLockDirectory(homedir(), namespace), name),
    shield,
    pid: process.pid,
    alive(pid) {
      try {
        return process.kill(pid, 0), true
      } catch (err) {
        return (err as { code?: string }).code === 'EPERM'
      }
    },
    stdoutIsTTY: process.stdout.isTTY === true,
    hostIdPath: hostIdentityPath(configDir),
    async pipe(text) {
      try {
        return (await Bun.write(Bun.stdout, text)) === Buffer.byteLength(text)
      } catch {
        return false
      }
    },
  }
}
