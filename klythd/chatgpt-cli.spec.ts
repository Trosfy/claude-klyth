// Core auth entry-point behavior over shared offline worlds.
import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticate } from '../scripts/auth-login'
import type { AuthChallenge } from '../scripts/auth-operation'
import type { Holder, LockPort } from '../scripts/chatgpt'
import { fileLock, ports } from '../scripts/chatgpt'
import { ACCESS, CLIENT, DEAD_LINE, dirs, EMAIL, hold, item, jwt, KLYTH_UA, LONG, MODELS_URL, NEW_ACCESS, NEW_REFRESH, NOW, Opts, REFRESH, ROTATED, S, SCOPE, signIn, TOKEN_URL, TOKENS, tooLong, world } from './fixtures/chatgpt-cli-world'

test('login sends every authorize parameter, exchanges the code with PKCE, stores the item, reads it back and prints no token', async () => {
  const w = world()
  expect(await signIn(w)).toBe(0)
  const q = w.authorize().searchParams
  expect(w.authorize().origin + w.authorize().pathname).toBe('https://auth.openai.com/api/accounts/authorize')
  expect([...q.keys()].sort()).toEqual(['agent_name_hint', 'client_id', 'code_challenge', 'code_challenge_method', 'ext_agent_host_id', 'nonce', 'redirect_uri', 'resource', 'response_type', 'scope', 'state'])
  expect(Object.fromEntries(['response_type', 'client_id', 'agent_name_hint', 'redirect_uri', 'scope', 'resource', 'code_challenge_method'].map(k => [k, q.get(k)]))).toEqual({
    response_type: 'code',
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'klyth',
    redirect_uri: 'http://127.0.0.1:1455/auth/callback',
    scope: SCOPE,
    resource: 'https://api.openai.com/v1',
    code_challenge_method: 'S256',
  })
  expect(q.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  for (const k of ['state', 'nonce', 'code_challenge']) expect(q.get(k)?.length).toBeGreaterThanOrEqual(43)
  expect(new Set([q.get('state'), q.get('nonce')]).size).toBe(2)
  expect(w.h.opened).toEqual([w.authorize().href])
  const exchange = w.h.forms[0] as URLSearchParams
  expect([...exchange.keys()].sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource'])
  expect(Object.fromEntries(exchange)).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT, code: 'code-placeholder', redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1' })
  expect(createHash('sha256').update(exchange.get('code_verifier') ?? '').digest('base64url')).toBe(q.get('code_challenge') as string)
  expect((w.h.inits[0]?.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded')
  expect(w.h.items).toEqual({ 'klyth:chatgpt': item() })
  expect(w.h.log.slice(w.h.log.indexOf('close'), w.h.log.indexOf('close') + 7)).toEqual(['close', `fetch ${TOKEN_URL}`, 'shield in', 'read', 'write', 'read', 'shield out'])
  expect(w.h.out).toContain(`chatgpt: signed in as ${EMAIL} (client ${CLIENT}); sign-in stored in the macOS Keychain; access token ${ACCESS.length} chars, item ${item().length} chars`)
  expect(w.h.pages).toEqual(['klyth: sign-in received; return to the terminal'])
  expect(w.h.err).toEqual([])
  for (const t of TOKENS) expect(w.shown()).not.toContain(t)
})

test('a second login uses the saved client id with no agent_name_hint, and the host id is made once (0600) and kept after logout', async () => {
  const w = world()
  expect(await signIn(w)).toBe(0)
  const host = w.authorize().searchParams.get('ext_agent_host_id')
  expect(readFileSync(join(w.dir, 'klyth-host-id'), 'utf8')).toBe(`${host}\n`)
  expect(statSync(join(w.dir, 'klyth-host-id')).mode & 0o777).toBe(0o600)
  expect(await w.cli('logout', 'chatgpt')).toBe(0)
  w.h.out.length = 0
  expect(await signIn(w)).toBe(0)
  expect([w.authorize().searchParams.get('client_id'), w.authorize().searchParams.get('ext_agent_host_id')]).toEqual(['dynamic_agent_client', host])
  w.h.out.length = 0
  const done = w.cli('login', 'chatgpt', '--chatgpt')
  await w.callback({ code: 'code-placeholder' })
  expect(await done).toBe(0)
  const q = w.authorize().searchParams
  expect([q.get('client_id'), q.get('agent_name_hint'), q.get('ext_agent_host_id')]).toEqual([CLIENT, null, host])
  expect(w.h.forms.filter(f => f.get('grant_type') === 'authorization_code').at(-1)?.get('client_id')).toBe(CLIENT)
})

test("a callback with another sign-in's state is answered and the listener keeps waiting; the right one then completes", async () => {
  const w = world()
  const done = w.cli('login', 'chatgpt', '--chatgpt')
  await w.callback({ state: 'another-sign-in', code: 'code-other', client_id: 'app-other' })
  await Bun.sleep(5)
  expect(w.h.forms).toEqual([])
  expect(w.h.log).not.toContain('close')
  await w.callback({ code: 'code-placeholder', client_id: CLIENT })
  expect(await done).toBe(0)
  expect(w.h.pages).toEqual(['klyth: not this sign-in; close this page', 'klyth: sign-in received; return to the terminal'])
  expect(w.h.forms[0]?.get('code')).toBe('code-placeholder')
})

test('a callback with error= ends the login at once with one line, and nothing is fetched or stored', async () => {
  const w = world()
  const done = w.cli('login', 'chatgpt', '--chatgpt')
  await w.callback({ error: 'access_denied', error_description: 'The user declined\u001b[2J' })
  expect(await done).toBe(1)
  expect(w.h.err).toEqual(['klyth auth: ChatGPT refused the sign-in (access_denied: The user declined?[2J)'])
  expect([w.h.forms, w.h.items, w.h.log.includes('close')]).toEqual([[], {}, true])
})

test('a pasted callback URL completes the sign-in; a pasted URL with another state, or no URL, is refused', async () => {
  const w = world()
  const done = w.cli('login', 'chatgpt', '--chatgpt', '--no-browser')
  await w.listening()
  await w.paste(`  http://127.0.0.1:1455/auth/callback?code=code-placeholder&state=${w.authorize().searchParams.get('state')}&client_id=${CLIENT}  `)
  expect(await done).toBe(0)
  expect(w.h.opened).toEqual([])
  expect(w.h.items).toEqual({ 'klyth:chatgpt': item() })
  for (const line of ['http://127.0.0.1:1455/auth/callback?code=code-placeholder&state=another-sign-in', 'code-placeholder']) {
    const v = world()
    const refused = v.cli('login', 'chatgpt', '--chatgpt')
    await v.paste(line)
    expect(await refused).toBe(1)
    expect(v.h.err).toEqual(["klyth auth: the pasted URL's state does not match this sign-in; run login again"])
    expect([v.h.forms, v.h.items]).toEqual([[], {}])
  }
})

test('the end of stdin leaves the listener waiting', async () => {
  const w = world()
  const done = w.cli('login', 'chatgpt', '--chatgpt')
  await w.paste(undefined)
  await Bun.sleep(5)
  expect(w.h.log).not.toContain('close')
  await w.callback({ code: 'code-placeholder', client_id: CLIENT })
  expect(await done).toBe(0)
})

test('nothing is stored unless the plan scope was granted and the ID token has this nonce, the client id as aud, the issuer and a future exp', async () => {
  const cases: [Opts, string][] = [
    [{ grant: { scope: 'openid profile email offline_access' } }, 'klyth auth: ChatGPT plan usage was not granted; run login again and allow klyth to use your plan'],
    [{ grant: { scope: undefined } }, 'klyth auth: ChatGPT plan usage was not granted; run login again and allow klyth to use your plan'],
    [{ claims: { nonce: 'another-nonce' } }, "klyth auth: ChatGPT's ID token failed its nonce check; nothing stored; run login again"],
    [{ claims: { aud: 'dynamic_agent_client' } }, "klyth auth: ChatGPT's ID token failed its aud check; nothing stored; run login again"],
    [{ claims: { iss: 'https://auth.example.invalid' } }, "klyth auth: ChatGPT's ID token failed its iss check; nothing stored; run login again"],
    [{ claims: { exp: S - 1 } }, "klyth auth: ChatGPT's ID token failed its exp check; nothing stored; run login again"],
    [{ grant: { id_token: 'not-a-jwt' } }, "klyth auth: ChatGPT's ID token failed its format check; nothing stored; run login again"],
  ]
  for (const [opts, line] of cases) {
    const w = world(opts)
    expect(await signIn(w)).toBe(1)
    expect(w.h.err).toEqual([line])
    expect(w.h.items).toEqual({})
    expect(w.h.log).not.toContain('write')
    expect(w.shown()).not.toContain(EMAIL)
  }
  const listed = world({ claims: { aud: ['another-client', CLIENT] } })
  expect(await signIn(listed)).toBe(0)
})

test('an item field holding |, " or \\ is refused before anything is written: from the callback or from the token answer', async () => {
  for (const client_id of ['app|client', 'app"client', '']) {
    const w = world()
    const done = w.cli('login', 'chatgpt', '--chatgpt')
    await w.callback({ code: 'code-placeholder', client_id })
    expect(await done).toBe(1)
    expect(w.h.err).toEqual(['klyth auth: the callback carried no usable code or client id; run login again'])
    expect(w.h.forms).toEqual([])
  }
  for (const grant of [{ refresh_token: 'rt|split' }, { access_token: 'at"quote' }, { refresh_token: undefined }, { earliest_refresh_at: 'a\\b' }]) {
    const w = world({ grant })
    expect(await signIn(w)).toBe(1)
    expect(w.h.err).toEqual(['klyth auth: ChatGPT\'s token answer cannot be stored (a token is missing or holds |, " or \\); run login again'])
    expect(w.h.items).toEqual({})
  }
})

test('a refused exchange, a refused store and an item that does not read back each end with one line and no token', async () => {
  const refused = world({ answer: () => Response.json({ error: 'invalid_grant', error_description: 'code expired' }, { status: 400 }) })
  expect(await signIn(refused)).toBe(1)
  expect(refused.h.err).toEqual(['klyth auth: ChatGPT refused the sign-in (invalid_grant: code expired)'])
  const locked = world({ refuseWrite: true })
  expect(await signIn(locked)).toBe(1)
  expect(locked.h.err).toEqual(['klyth auth: the macOS Keychain refused the sign-in (exit 51); unlock it, then retry'])
  const differs = world({ readBack: 'v1|something|else|1||x' })
  expect(await signIn(differs)).toBe(1)
  expect(differs.h.err).toEqual(['klyth auth: Stored, but reading chatgpt back did not give the same sign-in (exit 0). Run klyth auth logout chatgpt. Then run klyth auth login chatgpt --provider chatgpt.'])
  for (const w of [refused, locked, differs]) for (const t of TOKENS) expect(w.shown()).not.toContain(t)
})

test('login lists the models shown in ChatGPT, falls back to data[].id, and says when they cannot be listed', async () => {
  const shown = world()
  expect(await signIn(shown)).toBe(0)
  expect(shown.h.out).toContain('models on this plan (name, then the id for klyth.json):')
  expect(shown.h.out).toContain('  Model A  model-a')
  expect(shown.h.out.join('\n')).not.toContain('model-b')
  expect((shown.h.inits.at(-1)?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${ACCESS}`)
  for (const [models, line] of [[{ data: [{ id: 'model-c' }] }, '  model-c'], [{ nothing: true }, 'could not list models; copy ids from ChatGPT'], [undefined, 'could not list models; copy ids from ChatGPT']] as const) {
    const w = world()
    const base = w.io.fetch
    w.io.fetch = async (url, init) => (url === MODELS_URL ? (models === undefined ? Promise.reject(new Error('offline')) : Response.json(models)) : base(url, init))
    expect(await signIn(w)).toBe(0)
    expect(w.h.out).toContain(line)
  }
})

test('--write-config writes the bun and scripts/auth.ts paths with token <provider> and ttlSeconds 600, keeping a ttl already set', async () => {
  const provider = { kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', auth: 'none', models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } }
  const command = [process.execPath, join(import.meta.dir, '..', 'scripts', 'auth.ts'), 'token', 'chatgpt']
  const w = world({ config: { providers: { chatgpt: provider } } })
  expect(await signIn(w, '--write-config')).toBe(0)
  expect(JSON.parse(readFileSync(w.configPath, 'utf8')).providers.chatgpt.auth).toEqual({ command, ttlSeconds: 600 })
  expect(w.h.out.at(-1)).toBe(`wrote providers.chatgpt.auth.command to ${realpathSync(w.configPath)}`)
  const kept = world({ config: { providers: { chatgpt: { ...provider, auth: { command: ['/bin/true'], ttlSeconds: 120 } } } } })
  expect(await signIn(kept, '--write-config')).toBe(0)
  expect(JSON.parse(readFileSync(kept.configPath, 'utf8')).providers.chatgpt.auth).toEqual({ command, ttlSeconds: 120 })
  const printed = world()
  expect(await signIn(printed)).toBe(0)
  expect(printed.h.out.at(-1)).toBe(`set, under providers.chatgpt in ${printed.configPath} (See klyth auth --help. Use --write to update config.):\n  "auth": { "command": ${JSON.stringify(command)}, "ttlSeconds": 600 }`)
  const missing = world()
  expect(await missing.cli('login', 'chatgpt', '--chatgpt', '--write-config')).toBe(1)
  expect(missing.h.ports).toEqual([])
})

test('a busy port ends with the --port line; --port and --no-browser reach the listener and the opener', async () => {
  const busy = world({ busy: true })
  expect(await busy.cli('login', 'chatgpt', '--chatgpt', '--port', '1460')).toBe(1)
  expect(busy.h.err).toEqual(['klyth auth: 127.0.0.1:1460 is in use; retry with --port <n>'])
  expect(busy.h.ports).toEqual([1460])
  const w = world()
  const done = w.cli('login', 'chatgpt', '--chatgpt', '--no-browser', '--port', '1461')
  await w.callback({ code: 'code-placeholder', client_id: CLIENT })
  expect(await done).toBe(0)
  expect(w.h.opened).toEqual([])
  expect(w.authorize().searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1461/auth/callback')
  expect(w.h.out).toContain('No browser here? Forward the port (ssh -L 1461:127.0.0.1:1461 <this host>), or sign in on any device and paste the URL your browser lands on:')
})

test('token prints a stored token with 15 minutes or more left at once: no fetch, no lock, stdout exactly the token', async () => {
  for (const expiresAt of [S + 3600, S + 900]) {
    const w = world({ items: { chatgpt: item({ expiresAt }) } })
    expect(await w.cli('token', 'chatgpt')).toBe(0)
    expect([w.h.out, w.h.err, w.h.forms, readdirSync(w.dir)]).toEqual([[ACCESS], [], [], []])
  }
})

test('token under 15 minutes refreshes with resource, writes and reads back the rotated item inside the shield, then prints the new token', async () => {
  const w = world({ items: { chatgpt: item({ expiresAt: S + 899 }) } })
  expect(await w.cli('token', 'chatgpt')).toBe(0)
  expect(w.h.out).toEqual([NEW_ACCESS])
  expect(Object.fromEntries(w.h.forms[0] ?? [])).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: REFRESH, resource: 'https://api.openai.com/v1' })
  expect(w.h.inits[0]?.signal).toBeInstanceOf(AbortSignal)
  expect(w.h.log).toEqual(['read', 'read', 'shield in', `fetch ${TOKEN_URL}`, 'write', 'read', 'shield out', 'out'])
  expect(w.h.items).toEqual({ 'klyth:chatgpt': ROTATED })
  expect(readdirSync(w.dir)).toEqual([])
  expect(JSON.stringify([w.h.err, w.h.argv])).not.toContain(NEW_ACCESS)
  for (const t of TOKENS) expect(JSON.stringify([w.h.err, w.h.argv])).not.toContain(t)
})

test('a refresh answer with no refresh token keeps the old one', async () => {
  const w = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, answer: () => Response.json({ access_token: NEW_ACCESS, expires_in: 3600 }) })
  expect(await w.cli('token', 'chatgpt')).toBe(0)
  expect(w.h.items['klyth:chatgpt']).toBe(item({ access: NEW_ACCESS, expiresAt: S + 3600 }))
})

test('a write that fails after a successful refresh still prints the new token, exits 0 and warns', async () => {
  const w = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, refuseWrite: true })
  expect(await w.cli('token', 'chatgpt')).toBe(0)
  expect(w.h.out).toEqual([NEW_ACCESS])
  expect(w.h.err).toEqual(['klyth auth: The refresh succeeded. Klyth could not store the sign-in. Before the next refresh, run klyth auth login chatgpt --provider chatgpt'])
})

test('an item too long for one security -i line is never written: login stores nothing, and a refresh keeps the stored item and exits 1 printing no token', async () => {
  const login = world({ grant: { access_token: LONG } })
  expect(await signIn(login)).toBe(1)
  expect([login.h.err, login.h.items, login.h.log.includes('write')]).toEqual([[tooLong('chatgpt', item({ access: LONG }))], {}, false])
  const held = item({ expiresAt: S + 60 })
  const refresh = world({ items: { chatgpt: held }, answer: () => Response.json({ access_token: LONG, refresh_token: NEW_REFRESH, expires_in: 3600 }) })
  expect(await refresh.cli('token', 'chatgpt')).toBe(1)
  expect([refresh.h.out, refresh.h.err, refresh.h.items, refresh.h.log.includes('write')]).toEqual([[], [tooLong('chatgpt', item({ refresh: NEW_REFRESH, access: LONG }))], { 'klyth:chatgpt': held }, false])
  expect(readdirSync(refresh.dir)).toEqual([])
})

test('a lock held by a live pid gives the current token with no fetch; one held by a dead pid is stolen and refreshed', async () => {
  const live = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, alive: 777 })
  hold(live.dir, 777)
  expect(await live.cli('token', 'chatgpt')).toBe(0)
  expect([live.h.out, live.h.forms]).toEqual([[ACCESS], []])
  expect(readFileSync(join(live.dir, 'chatgpt.lock'), 'utf8')).toBe('777\n')
  const dead = world({ items: { chatgpt: item({ expiresAt: S + 60 }) } })
  hold(dead.dir, 778)
  expect(await dead.cli('token', 'chatgpt')).toBe(0)
  expect([dead.h.out, dead.h.forms.length, dead.h.items]).toEqual([[NEW_ACCESS], 1, { 'klyth:chatgpt': ROTATED }])
  expect(readdirSync(dead.dir)).toEqual([])
})

test('a lock 30 s old is stolen and refreshed even when its pid is alive (another process after a reboot); a younger one is left to its holder', async () => {
  const stale = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, alive: 777 })
  hold(stale.dir, 777, 30_000)
  expect(await stale.cli('token', 'chatgpt')).toBe(0)
  expect([stale.h.out, stale.h.forms.length, stale.h.items]).toEqual([[NEW_ACCESS], 1, { 'klyth:chatgpt': ROTATED }])
  expect(readdirSync(stale.dir)).toEqual([])
  const recent = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, alive: 777 })
  hold(recent.dir, 777, 29_000)
  expect(await recent.cli('token', 'chatgpt')).toBe(0)
  expect([recent.h.out, recent.h.forms]).toEqual([[ACCESS], []])
  expect(readFileSync(join(recent.dir, 'chatgpt.lock'), 'utf8')).toBe('777\n')
})

test('a lock file that cannot be made ends token and export with one line, before any fetch', async () => {
  for (const verb of ['token', 'export']) {
    const w = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, lock: fileLock('/dev/null/klyth', 'chatgpt') })
    expect(await w.cli(verb, 'chatgpt')).toBe(1)
    expect([w.h.out, w.h.forms, w.h.piped, w.h.items]).toEqual([[], [], [], { 'klyth:chatgpt': item({ expiresAt: S + 60 }) }])
    expect(w.h.err).toHaveLength(1)
    expect(w.h.err[0]).toStartWith('klyth auth: could not take the refresh lock (')
  }
})

test('an expired token under a live holder is read again every 250 ms for up to 3 s for its write, then exits 1 naming the lock file', async () => {
  const w = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, alive: 777 })
  hold(w.dir, 777)
  const sleep = w.io.sleep
  w.io.sleep = async ms => {
    await sleep(ms)
    // The holder's write lands during the second wait.
    if (w.h.slept.length === 2) w.h.items['klyth:chatgpt'] = ROTATED
  }
  expect(await w.cli('token', 'chatgpt')).toBe(0)
  expect([w.h.out, w.h.forms, w.h.slept]).toEqual([[NEW_ACCESS], [], [250, 250]])
  const gone = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, alive: 777 })
  hold(gone.dir, 777)
  expect(await gone.cli('token', 'chatgpt')).toBe(1)
  expect(gone.h.slept).toEqual(Array<number>(12).fill(250))
  expect([gone.h.out, gone.h.err]).toEqual([[], [`klyth auth: another klyth refresh is running (lock chatgpt.lock in ${gone.dir}); retry`]])
  // Under the home folder the lock shows as ~/…, in runs short enough that klythd does not mask them.
  const lock: LockPort = { path: join(homedir(), '.cache', 'klyth', 'chatgpt.lock'), take: () => false, holder: () => ({ pid: 777, at: NOW }), steal: () => false, release: () => {} }
  const home = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, alive: 777, lock })
  expect(await home.cli('token', 'chatgpt')).toBe(1)
  expect(home.h.err).toEqual(['klyth auth: another klyth refresh is running (lock chatgpt.lock in ~/.cache/klyth); retry'])
})

test('earliest_refresh_at in seconds, ms or ISO 8601: in the future, a valid token is printed and an expired one exits 4; unreadable is noted and ignored', async () => {
  const at = NOW + 120_000
  for (const earliest of [String(at / 1000), String(at), new Date(at).toISOString()]) {
    const valid = world({ items: { chatgpt: item({ expiresAt: S + 60, earliest }) } })
    expect(await valid.cli('token', 'chatgpt')).toBe(0)
    expect([valid.h.out, valid.h.forms]).toEqual([[ACCESS], []])
    const expired = world({ items: { chatgpt: item({ expiresAt: S - 1, earliest }) } })
    expect(await expired.cli('token', 'chatgpt')).toBe(4)
    expect([expired.h.out, expired.h.err, expired.h.forms]).toEqual([[], [`klyth auth: ChatGPT refuses a refresh until ${new Date(at).toISOString()}; retry then`], []])
  }
  const past = world({ items: { chatgpt: item({ expiresAt: S + 60, earliest: String(S - 10) }) } })
  expect(await past.cli('token', 'chatgpt')).toBe(0)
  expect(past.h.out).toEqual([NEW_ACCESS])
  const unreadable = world({ items: { chatgpt: item({ expiresAt: S + 60, earliest: 'soon' }) } })
  expect(await unreadable.cli('token', 'chatgpt')).toBe(0)
  expect([unreadable.h.out, unreadable.h.err]).toEqual([[NEW_ACCESS], ["klyth auth: chatgpt's earliest_refresh_at is unreadable; refreshing anyway"]])
})

test('each refresh error that ends a sign-in exits 3 with the login line and keeps the item; invalid_client clears the client id', async () => {
  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
    for (const body of [{ error: code, error_description: 'refused' }, { error: { code, message: 'refused' } }]) {
      const w = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, answer: () => Response.json(body, { status: 401 }) })
      expect(await w.cli('token', 'chatgpt')).toBe(3)
      expect([w.h.out, w.h.err, w.h.items]).toEqual([[], [DEAD_LINE], { 'klyth:chatgpt': item({ expiresAt: S + 60 }) }])
    }
  }
  const w = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, answer: () => Response.json({ error: 'invalid_client' }, { status: 401 }) })
  expect(await w.cli('token', 'chatgpt')).toBe(3)
  expect(w.h.items).toEqual({ 'klyth:chatgpt': item({ clientId: '', expiresAt: S - 1 }) })
  expect(await w.cli('token', 'chatgpt')).toBe(3)
  expect(w.h.forms).toHaveLength(1)
  const done = w.cli('login', 'chatgpt', '--chatgpt')
  await w.listening()
  expect(w.authorize().searchParams.get('client_id')).toBe('dynamic_agent_client')
  await w.callback({ error: 'access_denied' })
  expect(await done).toBe(1)
})

test('a refresh refused as too early is handled as a future earliest_refresh_at; another failure gives a valid token with a note, else exit 1', async () => {
  const early = { error: 'refresh_too_early', earliest_refresh_at: S + 120 }
  const expired = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, answer: () => Response.json(early, { status: 400 }) })
  expect(await expired.cli('token', 'chatgpt')).toBe(4)
  expect(expired.h.err).toEqual([`klyth auth: ChatGPT refuses a refresh until ${new Date(NOW + 120_000).toISOString()}; retry then`])
  const valid = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, answer: () => Response.json(early, { status: 400 }) })
  expect([await valid.cli('token', 'chatgpt'), valid.h.out]).toEqual([0, [ACCESS]])
  const down = world({ items: { chatgpt: item({ expiresAt: S + 60 }) }, answer: () => new Response('upstream down', { status: 503 }) })
  expect([await down.cli('token', 'chatgpt'), down.h.out, down.h.err]).toEqual([0, [ACCESS], ['klyth auth: the ChatGPT refresh failed (HTTP 503); retry']])
  const dead = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, answer: () => new Response('upstream down', { status: 503 }) })
  expect([await dead.cli('token', 'chatgpt'), dead.h.out, dead.h.err]).toEqual([1, [], ['klyth auth: the ChatGPT refresh failed (HTTP 503); retry']])
})

test('a refresh with no answer within 5 s ends with one line', async () => {
  const hang = (_url: string, _form: URLSearchParams, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
  const w = world({ items: { chatgpt: item({ expiresAt: S - 1 }) }, answer: hang })
  const t0 = Date.now()
  expect(await w.cli('token', 'chatgpt')).toBe(1)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(4900)
  expect(Date.now() - t0).toBeLessThan(7000)
  expect([w.h.out, w.h.err, w.h.items]).toEqual([[], ['klyth auth: the ChatGPT refresh failed (no answer within 5 s); retry'], { 'klyth:chatgpt': item({ expiresAt: S - 1 }) }])
}, 10_000)

test('token with no item, or an item that is a plain key, exits 1 with one line', async () => {
  const none = world()
  expect(await none.cli('token', 'chatgpt')).toBe(1)
  expect(none.h.err).toEqual(['klyth auth: no ChatGPT sign-in readable for chatgpt in the macOS Keychain (locked, or none stored). Run klyth auth login chatgpt --provider chatgpt'])
  const key = world({ items: { chatgpt: 'sk-placeholder-key' } })
  expect(await key.cli('token', 'chatgpt')).toBe(1)
  expect(key.h.err).toEqual(["klyth auth: chatgpt's item in the macOS Keychain is not a ChatGPT sign-in. Run klyth auth login chatgpt --provider chatgpt"])
  expect(key.shown()).not.toContain('sk-placeholder-key')
})

test('export refuses a terminal; down a pipe it writes the item, then removes the local one; a broken pipe keeps it', async () => {
  const tty = world({ items: { chatgpt: item() }, tty: true })
  expect(await tty.cli('export', 'chatgpt')).toBe(2)
  expect(tty.h.err).toEqual([`klyth auth: Export prints your ChatGPT refresh token. First run ssh <host> '"$HOME/.local/bin/klyth" --version'. Then pipe it: klyth auth export chatgpt | ssh <host> '"$HOME/.local/bin/klyth" auth import chatgpt'`])
  expect([tty.h.piped, tty.h.items]).toEqual([[], { 'klyth:chatgpt': item() }])
  const w = world({ items: { chatgpt: item() } })
  expect(await w.cli('export', 'chatgpt')).toBe(0)
  expect(w.h.piped).toEqual([`${item()}\n`])
  expect(w.h.log).toEqual(['shield in', 'read', 'shield out', 'pipe', 'shield in', 'read', 'delete', 'shield out'])
  expect([w.h.items, w.h.out, w.h.err]).toEqual([{}, [], ['klyth auth: chatgpt: sign-in moved; its item is removed from the macOS Keychain']])
  expect(readdirSync(w.dir)).toEqual([])
  const broken = world({ items: { chatgpt: item() }, pipe: false })
  expect(await broken.cli('export', 'chatgpt')).toBe(1)
  expect([broken.h.items, broken.h.err]).toEqual([{ 'klyth:chatgpt': item() }, ['klyth auth: the pipe closed before the whole sign-in was written; chatgpt stays in the macOS Keychain']])
  const busy = world({ items: { chatgpt: item() }, alive: 777 })
  hold(busy.dir, 777)
  expect(await busy.cli('export', 'chatgpt')).toBe(1)
  expect([busy.h.piped, busy.h.items, busy.h.err]).toEqual([[], { 'klyth:chatgpt': item() }, [`klyth auth: another klyth refresh is running (lock chatgpt.lock in ${busy.dir}); retry`]])
  // What export wrote, piped to plain login elsewhere, is the sign-in there.
  const there = world({ key: w.h.piped[0] as string })
  expect(await there.cli('login', 'chatgpt')).toBe(0)
  expect(await there.cli('token', 'chatgpt')).toBe(0)
  expect(there.h.out.at(-1)).toBe(ACCESS)
  for (const t of TOKENS) expect(JSON.stringify([w.h.out, w.h.err, w.h.argv, there.h.err, there.h.argv])).not.toContain(t)
})

test('export holds the lock to read the item and to remove it, not while the pipe is written; an item a refresh changes meanwhile stays, and the copy sent is called stale', async () => {
  const w = world({ items: { chatgpt: item() } })
  let lockedWhilePiped: boolean | undefined
  w.io.pipe = async text => ((lockedWhilePiped = existsSync(join(w.dir, 'chatgpt.lock'))), w.h.piped.push(text), true)
  expect(await w.cli('export', 'chatgpt')).toBe(0)
  expect([lockedWhilePiped, w.h.piped, w.h.items]).toEqual([false, [`${item()}\n`], {}])
  const stale = "klyth auth: the sign-in changed while it was written (a refresh ran), so the copy sent is stale; chatgpt stays in the macOS Keychain; export again"
  const refreshed = world({ items: { chatgpt: item() } })
  refreshed.io.pipe = async () => ((refreshed.h.items['klyth:chatgpt'] = ROTATED), true)
  expect(await refreshed.cli('export', 'chatgpt')).toBe(1)
  expect([refreshed.h.items, refreshed.h.err, readdirSync(refreshed.dir)]).toEqual([{ 'klyth:chatgpt': ROTATED }, [stale], []])
  // A refresh still holding the lock when export comes to remove the item will change it.
  const refreshing = world({ items: { chatgpt: item() }, alive: 777 })
  refreshing.io.pipe = async () => (hold(refreshing.dir, 777), true)
  expect(await refreshing.cli('export', 'chatgpt')).toBe(1)
  expect([refreshing.h.items, refreshing.h.err]).toEqual([{ 'klyth:chatgpt': item() }, [stale]])
})

test('the file lock: link creation fails while held, the holder is its pid and when it was taken, a steal replaces only the lock it saw, and release removes only its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-lock-'))
  dirs.push(dir)
  const cache = join(dir, 'cache')
  // One port per process, as each `token` run makes its own.
  const [a, b, c] = [fileLock(cache, 'acme'), fileLock(cache, 'acme'), fileLock(cache, 'acme')]
  expect(a.path).toBe(join(cache, 'acme.lock'))
  expect(a.take(101)).toBe(true)
  expect(b.take(102)).toBe(false)
  const seen = a.holder() as Holder
  expect(seen).toEqual({ pid: 101, at: statSync(a.path).mtimeMs })
  // 102 and 103 both saw 101's lock: 102 replaces it in one step, then 103 finds another lock and leaves it.
  expect(b.steal(seen, 102)).toBe(true)
  expect(b.holder()?.pid).toBe(102)
  expect(c.steal(seen, 103)).toBe(false)
  expect(c.holder()?.pid).toBe(102)
  // 101's release leaves the lock that replaced its own.
  a.release()
  expect(c.holder()?.pid).toBe(102)
  b.release()
  expect(c.holder()).toBeUndefined()
  expect(c.steal(seen, 103)).toBe(false)
  expect(c.take(103)).toBe(true)
  c.release()
  expect(readdirSync(cache)).toEqual([])
  expect(statSync(cache).mode & 0o777).toBe(0o700)
})

test('a steal of a lock that is no longer the one it saw moves nothing, even while a third process takes the lock between its steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-lock-'))
  dirs.push(dir)
  const cache = join(dir, 'cache')
  const [dead, b, c, third] = [fileLock(cache, 'acme'), fileLock(cache, 'acme'), fileLock(cache, 'acme'), fileLock(cache, 'acme')]
  expect(dead.take(100)).toBe(true)
  // B and C both saw 100's abandoned lock; C steals it first.
  const seen = b.holder() as Holder
  expect(c.steal(seen, 300)).toBe(true)
  // Right after B's first link or rename, a third process tries to take the lock.
  let took: boolean | undefined
  const race = () => void (took === undefined && ((took = false), (took = third.take(400))))
  const [link, rename] = [fs.linkSync, fs.renameSync]
  const spies = [spyOn(fs, 'linkSync').mockImplementation((from, to) => (link(from, to), race())), spyOn(fs, 'renameSync').mockImplementation((from, to) => (rename(from, to), race()))]
  try {
    expect(b.steal(seen, 200)).toBe(false)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  expect([took, b.holder()?.pid]).toEqual([false, 300])
  c.release()
  expect(readdirSync(cache)).toEqual([])
})

test('the real listener serves GET /auth/callback on 127.0.0.1 only, 404s other paths, and reports a busy port as an Error', async () => {
  const seen: string[] = []
  const real = ports(tmpdir(), process.platform)
  const first = real.listen(0, url => (seen.push(url.search), 'page text'))
  if (first instanceof Error) throw first
  expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  const res = await fetch(`${first.url}?state=s&code=c`)
  expect([res.status, await res.text(), seen]).toEqual([200, 'page text', ['?state=s&code=c']])
  expect((await fetch(first.url.replace('/auth/callback', '/other'))).status).toBe(404)
  expect(real.listen(Number(new URL(first.url).port), () => '')).toBeInstanceOf(Error)
  first.close()
})

test('two token processes on one expiring item: one refresh reaches the server, both print a valid token, the item rotates once, and SIGTERM to the holder mid-POST loses nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-chatgpt-2p-'))
  dirs.push(dir)
  const forms: URLSearchParams[] = []
  const termed: number[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      forms.push(new URLSearchParams(await req.text()))
      // The holder's pid is in the lock; it gets SIGTERM while this answer is held back.
      const pid = Number(readFileSync(join(dir, 'chatgpt.lock'), 'utf8'))
      process.kill(pid, 'SIGTERM')
      termed.push(pid)
      await Bun.sleep(1000)
      return Response.json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, token_type: 'Bearer', expires_in: 3600 })
    },
  })
  try {
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(join(dir, 'klyth-chatgpt.item'), item({ expiresAt: now + 300 }))
    const driver = join(import.meta.dir, 'fixtures', 'chatgpt-driver.ts')
    const procs = [0, 1].map(() => Bun.spawn([process.execPath, driver, dir, `http://127.0.0.1:${server.port}`], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }))
    const runs = await Promise.all(procs.map(async p => ({ pid: p.pid, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited })))
    expect(forms).toHaveLength(1)
    expect(Object.fromEntries(forms[0] ?? [])).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: REFRESH, resource: 'https://api.openai.com/v1' })
    expect(runs.map(r => [r.code, r.err])).toEqual([
      [0, ''],
      [0, ''],
    ])
    for (const r of runs) expect([`${ACCESS}\n`, `${NEW_ACCESS}\n`]).toContain(r.out)
    expect(runs.find(r => r.pid === termed[0])?.out).toBe(`${NEW_ACCESS}\n`)
    const rotated = readFileSync(join(dir, 'klyth-chatgpt.item'), 'utf8')
    expect(rotated.replace(/\|\d+\|/, '|<expires>|')).toBe(item({ refresh: NEW_REFRESH, access: NEW_ACCESS }).replace(/\|\d+\|/, '|<expires>|'))
    expect(readdirSync(dir).sort()).toEqual(['klyth-chatgpt.item'])
  } finally {
    void server.stop(true)
  }
}, 15_000)


test('native browser cancellation closes its listener and never reads callback paste or commits', async () => {
  const w = world()
  const controller = new AbortController()
  let pasted = false
  w.io.readLine = async () => { pasted = true; return undefined }
  const result = await authenticate({ ...w.io, signal: controller.signal, store: (await import('../scripts/credential-store')).keychain(), env: {} }, 'chatgpt', { client: 'official', browser: false, challenge: () => controller.abort() })
  expect(result).toEqual({ status: 'cancelled' })
  expect(pasted).toBe(false)
  expect(w.h.log).toContain('close')
  expect([w.h.items, w.h.out, w.h.err, w.h.urls]).toEqual([{}, [], [], []])
})

test('native official browser operation shares PKCE/registration and returns ID-only models without invented limits', async () => {
  const w = world()
  let challenge: Extract<AuthChallenge, { type: 'browser-challenge' }> | undefined
  let callback: ((url: URL) => string) | undefined
  const listen = w.io.listen
  w.io.listen = (port, cb) => { callback = cb; return listen(port, cb) }
  w.io.fetch = async url => url === MODELS_URL ? Response.json({ data: [{ id: 'model-id-only' }] }) : Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE, id_token: jwt({ iss: 'https://auth.openai.com', aud: CLIENT, nonce: new URL(challenge?.authorizeUrl as string).searchParams.get('nonce'), exp: S + 600 }) })
  let pasted = false
  w.io.readLine = async () => { pasted = true; return undefined }
  const done = authenticate({ ...w.io, store: (await import('../scripts/credential-store')).keychain(), env: {} }, 'chatgpt', { client: 'official', browser: false, challenge: c => {
    if (c.type !== 'browser-challenge') throw new Error('wrong challenge')
    challenge = c
    const q = new URL(c.authorizeUrl).searchParams
    expect(q.get('client_id')).toBe('dynamic_agent_client')
    expect(q.get('code_challenge_method')).toBe('S256')
    callback?.(new URL(`http://127.0.0.1/auth/callback?${new URLSearchParams({ state: q.get('state') as string, code: 'code-placeholder', client_id: CLIENT })}`))
  } })
  const result = await done
  expect(result.status).toBe('saved')
  if (result.status !== 'saved') throw new Error('expected saved')
  expect(result.models).toEqual([{ id: 'model-id-only' }])
  expect([pasted, w.h.out, w.h.err]).toEqual([false, [], []])
})

test('sign-in classification is structural but method admission requires registration', async () => {
  const { isSignIn, parseItem, klythAgent } = await import('../scripts/chatgpt')
  const record = 'zz1|client|refresh|1800003600||access'
  expect(isSignIn(record)).toBe(true)
  expect(isSignIn('v1|broken')).toBe(false)
  expect(isSignIn('Upper|client|refresh|1800003600||access')).toBe(false)
  expect(parseItem(record)).toBeUndefined()
  expect(parseItem(item())?.method).toBe('v1')
  expect(klythAgent()).toBe(KLYTH_UA)
})
