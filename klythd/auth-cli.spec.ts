// Core auth entry-point behavior over shared offline worlds.
import { expect, test } from 'bun:test'
import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig } from '../hooks/config'
import { run } from '../scripts/auth'
import { KEY, LOOKUP, PROVIDER, READ, SEARCH, SECURITY, SIGN_IN, TOKEN_COMMAND, TOOL, tokens, world } from './fixtures/auth-cli-world'

test('login on macOS checks the item it replaces, stores the key through security -i, reads it back, and prints the auth.command line without writing the config', async () => {
  const w = world({ config: { providers: { acme: PROVIDER } } })
  const before = readFileSync(w.configPath, 'utf8')
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.calls).toEqual([
    { argv: READ },
    { argv: READ },
    { argv: [SECURITY, '-i'], input: `add-generic-password -U -s klyth -a "acme" -l "klyth acme" -w "${KEY}"\n` },
    { argv: READ },
  ])
  expect(w.h.items).toEqual({ 'klyth:acme': KEY })
  expect(w.h.out.at(-1)).toContain(`  "auth": { "command": ${JSON.stringify(READ)} }`)
  expect(readFileSync(w.configPath, 'utf8')).toBe(before)
  for (const c of w.h.calls) expect(c.argv.join('\n')).not.toContain(KEY)
  expect(w.said()).not.toContain(KEY)
})

test('every character but " and \\ stays literal in the line security -i reads, so the key reads back intact', async () => {
  for (const key of ['sk-sp$ecial#;!&`~*?(){}[]<>|\'%^=+,:@/', '-dash-first', "it's", 'a=b', '$HOME', '${x}', '~/x', '*', '#hash']) {
    const w = world({ key })
    expect(await w.cli('login', 'acme')).toBe(0)
    expect(tokens(w.h.calls[2]?.input ?? '').at(-1)).toBe(key)
    expect(w.h.items).toEqual({ 'klyth:acme': key })
  }
})

test('a key holding " or \\ is refused before anything runs: security -i would read it as quoting or an escape', async () => {
  for (const key of ['sk-with"quote', 'sk-with\\backslash', 'sk-ends-with-backslash\\', 'sk-"', 'sk-\\"', 'sk-a\\"b']) {
    const naive = tokens(`add-generic-password -U -s klyth -a "acme" -l "klyth acme" -w "${key}"\n`)
    expect(naive.at(-1) === key && naive.length === 10).toBe(false)
    const w = world({ key })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.calls).toEqual([{ argv: READ }])
    expect(w.h.err.join('\n')).toContain('nothing stored')
    expect(w.said()).not.toContain(key)
  }
})

test('a key that is empty, holds a space, control or non-ASCII character, or is over 4 KiB is refused before anything runs; stdin whitespace is trimmed', async () => {
  for (const key of ['', ' \n', 'two words', 'a\tb', 'a\u0007b', 'a​b', 'sk-€', 'k'.repeat(4097)]) {
    const w = world({ key })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.calls).toEqual([{ argv: READ }])
    expect(w.h.err.join('\n')).toContain('nothing stored')
  }
  const w = world({ platform: 'linux', tool: true, key: `\r\n  ${'k'.repeat(4096)} \r\n` })
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.items).toEqual({ 'klyth:acme': 'k'.repeat(4096) })
})

test('on macOS a key whose security -i line would pass 4000 bytes is refused before anything runs, naming the size: security -i runs the rest of a longer line as a command of its own', async () => {
  const room = 4000 - Buffer.byteLength('add-generic-password -U -s klyth -a "acme" -l "klyth acme" -w ""\n')
  const fits = world({ key: 'k'.repeat(room) })
  expect(await fits.cli('login', 'acme')).toBe(0)
  expect(Buffer.byteLength(fits.h.calls[2]?.input ?? '')).toBe(4000)
  expect(fits.h.items).toEqual({ 'klyth:acme': 'k'.repeat(room) })
  const over = world({ key: 'k'.repeat(room + 1) })
  expect(await over.cli('login', 'acme')).toBe(1)
  expect([over.h.err, over.h.calls, over.h.items]).toEqual([['klyth auth: storing acme takes a 4001-byte security -i line, over its 4000-byte limit; nothing stored'], [{ argv: READ }], {}])
})

test('a refused store, or a key that does not read back, fails with one line and no key in it', async () => {
  const refused = world({ refuse: true })
  expect(await refused.cli('login', 'acme')).toBe(1)
  expect(refused.h.err).toEqual(['klyth auth: the macOS Keychain refused the key (exit 51); unlock it, then retry'])
  expect(refused.h.calls).toHaveLength(3)
  const differs = world({ readBack: 'sk-something-else' })
  expect(await differs.cli('login', 'acme')).toBe(1)
  expect(differs.h.err).toHaveLength(1)
  expect(differs.h.err[0]).toContain('reading acme back did not give the same key')
  expect(differs.h.out.join('\n')).not.toContain('key stored')
  for (const w of [refused, differs]) expect(w.said()).not.toContain(KEY)
})

test('login on Linux with secret-tool stores the key on its stdin and prints the lookup line', async () => {
  const w = world({ platform: 'linux', tool: true, config: { providers: { acme: PROVIDER } } })
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.calls).toEqual([{ argv: LOOKUP }, { argv: SEARCH }, { argv: LOOKUP }, { argv: SEARCH }, { argv: [TOOL, 'store', '--label=klyth acme', 'service', 'klyth', 'provider', 'acme'], input: KEY }, { argv: LOOKUP }])
  expect(w.h.out.at(-1)).toContain(`  "auth": { "command": ${JSON.stringify(LOOKUP)} }`)
  for (const c of w.h.calls) expect(c.argv.join('\n')).not.toContain(KEY)
})

for (const method of ['v1', 'zz1']) {
  test(`Linux login cannot replace a locked ${method} sign-in after a silent dismissed unlock`, async () => {
    const original = SIGN_IN.replace(/^v1/, method)
    const w = world({ platform: 'linux', tool: true, locked: true, items: { acme: original } })
    const code = await w.cli('login', 'acme')
    expect(w.h.items).toEqual({ 'klyth:acme': original })
    expect(code).toBe(1)
    expect(w.h.calls).toEqual([{ argv: LOOKUP }, { argv: SEARCH }])
    expect(w.h.out).toEqual([])
    expect(w.h.err).toEqual(['klyth auth: lookup failed in the secret-tool; nothing stored'])
    expect(w.said()).not.toContain(original)
    expect(w.said()).not.toContain(KEY)
  })
}

test('Linux list cannot claim a locked sign-in is absent after a silent dismissed unlock', async () => {
  const w = world({ platform: 'linux', tool: true, locked: true, items: { acme: SIGN_IN } })
  expect(await w.cli('list', 'acme')).toBe(0)
  expect(w.h.out).toEqual(['acme: presence unknown (tool available) in the secret-tool'])
  expect(w.h.err).toEqual([])
  expect(w.h.calls).toEqual([])
  expect(w.h.items).toEqual({ 'klyth:acme': SIGN_IN })
})

test('Linux OAuth login and import stop after a silent dismissed unlock, before provider calls or writes', async () => {
  for (const flags of [['--chatgpt'], []]) {
    const w = world({ platform: 'linux', tool: true, locked: true, items: { acme: SIGN_IN }, key: SIGN_IN })
    expect(await w.cli('login', 'acme', ...flags)).toBe(1)
    expect(w.h.items).toEqual({ 'klyth:acme': SIGN_IN })
    expect(w.h.calls).toEqual([{ argv: LOOKUP }, { argv: SEARCH }])
    expect([w.h.fetched, w.h.opened, w.h.ports, w.h.out]).toEqual([[], [], [], []])
    expect(w.h.err).toEqual(['klyth auth: lookup failed in the secret-tool; nothing stored'])
  }
})

test('Linux first-time login and list establish absence only for the requested namespace and provider', async () => {
  const w = world({ platform: 'linux', tool: true, items: { other: SIGN_IN } })
  w.h.items['styx:acme'] = SIGN_IN
  expect(await w.cli('list', 'acme')).toBe(0)
  expect(w.h.out).toEqual(['acme: presence unknown (tool available) in the secret-tool'])
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.items).toEqual({ 'styx:acme': SIGN_IN, 'klyth:other': SIGN_IN, 'klyth:acme': KEY })
  expect(w.h.calls.filter(c => c.argv[1] === 'search')).toEqual([{ argv: SEARCH }, { argv: SEARCH }])
  expect(w.said()).not.toContain(SIGN_IN)
})

test('with no keyring, login prints the pass and op read lines, exits 1 and never reads the key; logout and list say there is nothing', async () => {
  for (const platform of ['linux', 'freebsd']) {
    const w = world({ platform })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.out).toEqual([`  "auth": { "command": ["/usr/bin/pass","show","klyth/acme"] }`, `  "auth": { "command": ["/opt/homebrew/bin/op","read","op://Private/klyth acme/credential"] }`])
    expect(w.h.err[0]).toContain('no keyring here')
    expect([w.h.asked, w.h.calls]).toEqual([0, []])
    for (const verb of ['logout', 'list']) {
      const v = world({ platform })
      expect(await v.cli(verb, 'acme')).toBe(1)
      expect([v.h.out, v.h.calls]).toEqual([[], []])
    }
  }
})

test('--write-config sets providers.<p>.auth.command, keeps ttlSeconds and the rest, drops apiKeyEnv, and leaves a config that validates', async () => {
  const w = world({ config: { aliases: { m: { target: 'acme/m' } }, providers: { acme: { ...PROVIDER, apiKeyEnv: 'OLD', auth: { command: ['/bin/true'], ttlSeconds: 60 } }, other: PROVIDER } } })
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  const text = readFileSync(w.configPath, 'utf8')
  const parsed = parseConfig(text)
  expect(parsed.errors).toEqual([])
  expect(parsed.config?.providers['acme']?.auth).toEqual({ command: READ, ttlSeconds: 60 })
  expect(parsed.config?.providers['other']?.auth).toEqual(PROVIDER.auth)
  expect(Object.keys(JSON.parse(text).providers.acme)).toEqual(['kind', 'baseUrl', 'models', 'auth'])
  expect(parsed.config?.aliases['m']?.target).toBe('acme/m')
  expect(text.endsWith('}\n')).toBe(true)
  expect(w.h.out.at(-1)).toContain(`wrote providers.acme.auth.command to `)
  expect(w.said()).not.toContain(KEY)
})

test('--write-config turns a keyless provider ("auth": "none") into one with the key helper, as the keyless 401 line asks', async () => {
  const w = world({ config: { aliases: { m: { target: 'acme/m' } }, providers: { acme: { ...PROVIDER, auth: 'none' } } } })
  expect(parseConfig(readFileSync(w.configPath, 'utf8')).config?.providers['acme']?.auth).toBe('none')
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  const parsed = parseConfig(readFileSync(w.configPath, 'utf8'))
  expect(parsed.errors).toEqual([])
  expect(parsed.config?.providers['acme']?.auth).toEqual({ command: READ, ttlSeconds: 300 })
})

test('--write-config checks the config first: a missing file or provider stores nothing and never asks for the key', async () => {
  for (const config of [undefined, { providers: { other: PROVIDER } }, { providers: [] }]) {
    const w = world(config === undefined ? {} : { config })
    expect(await w.cli('login', 'acme', '--write-config')).toBe(1)
    expect([w.h.asked, w.h.calls]).toEqual([0, []])
    expect(w.h.err[0]).toContain('providers.acme is not in')
  }
  const broken = world()
  writeFileSync(broken.configPath, '{ not json')
  expect(await broken.cli('login', 'acme', '--write-config')).toBe(1)
  expect(readFileSync(broken.configPath, 'utf8')).toBe('{ not json')
})

test('--write-config rewrites through a symlink and keeps the file mode', async () => {
  const w = world()
  const real = join(w.dir, 'dotfiles-klyth.json')
  writeFileSync(real, JSON.stringify({ providers: { acme: PROVIDER } }))
  chmodSync(real, 0o600)
  symlinkSync(real, w.configPath)
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  expect(lstatSync(w.configPath).isSymbolicLink()).toBe(true)
  expect(statSync(real).mode & 0o777).toBe(0o600)
  chmodSync(real, 0o660)
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  expect(statSync(real).mode & 0o777).toBe(0o660)
  expect(parseConfig(readFileSync(real, 'utf8')).config?.providers['acme']?.auth).toMatchObject({ command: READ })
})

test('logout deletes the item through security or secret-tool, and says so when there is none', async () => {
  const mac = world({ items: { acme: KEY } })
  expect(await mac.cli('logout', 'acme')).toBe(0)
  expect(mac.h.calls).toEqual([{ argv: READ }, { argv: READ }, { argv: [SECURITY, 'delete-generic-password', '-s', 'klyth', '-a', 'acme'] }])
  expect(mac.h.items).toEqual({})
  expect(await mac.cli('logout', 'acme')).toBe(1)
  expect(mac.h.out.at(-1)).toBe('acme: no item in the macOS Keychain')
  const linux = world({ platform: 'linux', tool: true, items: { acme: KEY } })
  expect(await linux.cli('logout', 'acme')).toBe(0)
  expect(linux.h.calls).toEqual([{ argv: LOOKUP }, { argv: LOOKUP }, { argv: [TOOL, 'clear', 'service', 'klyth', 'provider', 'acme'] }])
  expect(await linux.cli('logout', 'acme')).toBe(1)
  expect(linux.h.calls.slice(3)).toEqual([{ argv: LOOKUP }, { argv: SEARCH }, { argv: LOOKUP }, { argv: SEARCH }, { argv: [TOOL, 'clear', 'service', 'klyth', 'provider', 'acme'] }, { argv: SEARCH }])
  expect(linux.h.out.at(-1)).toBe('acme: no item in the secret-tool')
  const failed = world({ platform: 'linux', tool: true })
  failed.io.run = async () => ({ exitCode: 1, stdout: '', stderr: '' })
  expect(await failed.cli('logout', 'acme')).toBe(1)
  expect(failed.h.out).toEqual([])
  expect(failed.h.err).toEqual(['klyth auth: lookup failed in the secret-tool; nothing stored'])
})

test('list names each configured provider with or without an item, running only attribute lookups and printing no value', async () => {
  const w = world({ items: { acme: KEY }, config: { providers: { acme: PROVIDER, other: PROVIDER } } })
  expect(await w.cli('list')).toBe(0)
  expect(w.h.out).toEqual(['acme: item in the macOS Keychain', 'other: no item in the macOS Keychain'])
  expect(w.h.calls.map(c => c.argv)).toEqual([READ.slice(0, -1), [...READ.slice(0, 5), 'other']])
  expect(w.said()).not.toContain(KEY)
  const one = world({ platform: 'linux', tool: true, items: { acme: KEY } })
  expect(await one.cli('list', 'acme')).toBe(0)
  expect(one.h.out).toEqual(['acme: presence unknown (tool available) in the secret-tool'])
  expect(one.said()).not.toContain(KEY)
  const none = world()
  expect(await none.cli('list')).toBe(1)
})

test('a v1| sign-in on stdin is stored unchanged and read back, and its auth line is the token command with ttlSeconds 600, never security -w', async () => {
  const w = world({ key: `${SIGN_IN}\n`, items: { acme: KEY } })
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.calls).toEqual([{ argv: READ }, { argv: READ }, { argv: [SECURITY, '-i'], input: `add-generic-password -U -s klyth -a "acme" -l "klyth acme" -w "${SIGN_IN}"\n` }, { argv: READ }])
  expect(w.h.items).toEqual({ 'klyth:acme': SIGN_IN })
  expect(w.h.out).toEqual([
    'acme: ChatGPT sign-in stored in the macOS Keychain (service klyth, account acme) and read back intact',
    `set, under providers.acme in ${w.configPath} (or rerun with --write-config):\n  "auth": { "command": ${JSON.stringify(TOKEN_COMMAND)}, "ttlSeconds": 600 }`,
  ])
  expect(w.said()).not.toContain(JSON.stringify(READ))
  for (const secret of ['rt-placeholder-refresh', 'at-placeholder-access']) expect(JSON.stringify([w.h.out, w.h.err, w.h.calls.map(c => c.argv)])).not.toContain(secret)
  for (const bad of ['v1|a|b', 'v1|app|rt|soon||at', 'v1|app|rt|1||', 'v1|app|r"t|1||at']) {
    const v = world({ key: bad })
    expect(await v.cli('login', 'acme')).toBe(1)
    expect([v.h.err, v.h.calls]).toEqual([[bad.split('|').length === 6 ? 'klyth auth: the piped ChatGPT sign-in is not a usable v1| item; nothing stored' : 'klyth auth: looks like a sign-in record; nothing stored'], [{ argv: READ }]])
  }
})

test('a plain key never overwrites a ChatGPT sign-in: login reads the item first and refuses, storing nothing', async () => {
  for (const [platform, tool, read] of [['darwin', false, READ], ['linux', true, LOOKUP]] as const) {
    const w = world({ platform, tool, items: { acme: SIGN_IN } })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.err).toEqual(['klyth auth: acme holds a ChatGPT sign-in; run logout first, or login --chatgpt'])
    expect([w.h.calls, w.h.items]).toEqual([[{ argv: read }], { 'klyth:acme': SIGN_IN }])
    expect(w.said()).not.toContain(KEY)
  }
})

test('the ChatGPT verbs and flags reach scripts/chatgpt.ts: --port and --no-browser reach the listener and opener, token prints the access token, export refuses a terminal', async () => {
  const login = world()
  expect(await login.cli('login', 'acme', '--chatgpt', '--port', '1460', '--no-browser')).toBe(1)
  expect([login.h.ports, login.h.err, login.h.asked]).toEqual([[1460], ['klyth auth: 127.0.0.1:1460 is in use; retry with --port <n>'], 0])
  const fallback = world()
  expect(await fallback.cli('login', 'acme', '--chatgpt')).toBe(1)
  expect(fallback.h.ports).toEqual([1455])
  const token = world({ items: { acme: SIGN_IN } })
  expect(await token.cli('token', 'acme')).toBe(0)
  expect([token.h.out, token.h.err, token.h.calls]).toEqual([['at-placeholder-access'], [], [{ argv: READ }]])
  const exported = world({ items: { acme: SIGN_IN }, tty: true })
  expect(await exported.cli('export', 'acme')).toBe(2)
  expect(exported.h.items).toEqual({ 'klyth:acme': SIGN_IN })
  for (const args of [['token', 'acme'], ['login', 'acme', '--chatgpt']]) {
    const none = world({ platform: 'linux' })
    expect(await none.cli(...args)).toBe(1)
    expect([none.h.out, none.h.err, none.h.calls]).toEqual([[], ['klyth auth: no keyring here (no macOS Keychain, no secret-tool); a ChatGPT sign-in needs one'], []])
  }
})

test('a misuse exits 2 with the usage and never echoes an argument: a key typed on the command line is not repeated', async () => {
  const cases = [
    ['login', 'acme', KEY], ['login', 'acme', '--key', KEY], ['login'], ['login', 'Acme'], ['list', '--bogus'], ['logout', 'acme', '--write-config'], ['list', '--write-config'], ['frobnicate'], [],
    ['logout', 'acme', '--chatgpt'], ['list', '--chatgpt'], ['token', 'acme', '--chatgpt'], ['export', 'acme', '--write-config'], ['token'], ['export'], ['token', 'acme', KEY],
    ['login', 'acme', '--port', '1460'], ['login', 'acme', '--no-browser'], ['login', 'acme', '--chatgpt', '--port'], ['login', 'acme', '--chatgpt', '--port', '0'], ['login', 'acme', '--chatgpt', '--port', '65536'], ['login', 'acme', '--chatgpt', '--port', KEY],
  ]
  for (const args of cases) {
    const w = world()
    expect(await w.cli(...args)).toBe(2)
    expect(w.h.err.join('\n')).toContain('usage: bun run auth login|logout <provider>')
    expect(w.said()).not.toContain(KEY)
    expect([w.h.asked, w.h.calls, w.h.ports]).toEqual([0, [], []])
  }
})

test('the real runner gives a command its stdin, returns stdout and the exit code, and answers 127 for one that cannot start; the script exits 2 on misuse', async () => {
  expect(await run(['/bin/cat'], 'a b\n$HOME')).toEqual({ exitCode: 0, stdout: 'a b\n$HOME', stderr: '' })
  expect(await run(['/bin/sh', '-c', 'exit 3'])).toEqual({ exitCode: 3, stdout: '', stderr: '' })
  expect(await run(['/no/such/tool'])).toEqual({ exitCode: 127, stdout: '', stderr: '' })
  const w = world()
  expect(await w.cli('login', 'acme', KEY)).toBe(2)
  expect(w.said()).not.toContain(KEY)
  expect(w.said()).toContain('unexpected arguments')
})

test('key input holds no refresh lock and rejects a credential changed before commit', async () => {
  const w = world({ items: { acme: KEY } })
  let held = false
  w.io.lock = () => ({ path: 'fake', take: () => (held = true), holder: () => undefined, steal: () => false, release: () => { held = false } })
  w.io.readKey = async () => { expect(held).toBe(false); w.h.items['klyth:acme'] = 'changed-key'; return KEY }
  expect(await w.cli('login', 'acme')).toBe(1)
  expect(w.h.items['klyth:acme']).toBe('changed-key')
  expect(w.said()).toContain('credential changed while waiting')
  expect(held).toBe(false)
  expect(w.h.calls.some(c => c.input !== undefined)).toBe(false)
})

test('config commit preserves concurrent unrelated changes but refuses changed selected fields and malformed JSON', async () => {
  for (const change of ['unrelated', 'models', 'selected', 'malformed']) {
    const w = world({ config: { providers: { acme: PROVIDER } } })
    w.io.readKey = async () => {
      writeFileSync(w.configPath, change === 'malformed' ? '{broken' : JSON.stringify({ providers: { acme: change === 'selected' ? { ...PROVIDER, baseUrl: 'https://changed.invalid/v1' } : change === 'models' ? { ...PROVIDER, models: { updated: { contextWindow: 2000, maxOutputTokens: 200 } } } : PROVIDER, other: PROVIDER } }))
      return KEY
    }
    expect(await w.cli('login', 'acme', '--write-config')).toBe(change === 'unrelated' || change === 'models' ? 0 : 1)
    expect(w.h.items['klyth:acme']).toBe(KEY)
    if (change === 'unrelated' || change === 'models') {
      const providers = JSON.parse(readFileSync(w.configPath, 'utf8')).providers
      expect(providers.other).toEqual(PROVIDER)
      if (change === 'models') expect(providers.acme.models).toEqual({ updated: { contextWindow: 2000, maxOutputTokens: 200 } })
    }
    else expect(w.said()).toContain('configuration not changed')
  }
  const w = world()
  writeFileSync(w.configPath, '{broken')
  expect(await w.cli('login', 'acme')).toBe(1)
  expect([w.h.asked, w.h.calls]).toEqual([0, []])
})

test('explicit compiled token command port replaces only the legacy token argv', async () => {
  const w = world({ key: SIGN_IN })
  w.io.tokenCommand = id => ['/immutable/helper', 'auth', 'token', id]
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.said()).toContain('["/immutable/helper","auth","token","acme"]')
  expect(w.said()).not.toContain('auth.ts')
})

test('actual PTY hidden input fails before prompt when echo-off fails and restores state on SIGTERM', async () => {
  const w = world()
  const fake = join(w.dir, 'stty-refuses')
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "-echo" ]; then exit 1; fi\nexec /bin/stty "$1"\n', { mode: 0o700 })
  const python = Bun.which('python3')
  if (!python) throw new Error('python3 is required for the isolated PTY boundary test')
  const harness = `import os, pty, subprocess, sys, termios, select, time, signal
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
code = 'const {readKey}=await import('+repr(sys.argv[2])+');try {await readKey({stty:'+repr(sys.argv[3])+'});} catch {console.error("HIDDEN-REFUSED");process.exit(1)}'
p = subprocess.Popen([sys.argv[1], '-e', code], stdin=slave, stdout=slave, stderr=slave)
output = b''
deadline = time.monotonic()+3
while time.monotonic()<deadline:
 if select.select([master],[],[],0.05)[0]: output += os.read(master,4096)
 if sys.argv[4]=='signal' and b'Key (hidden):' in output:
  p.send_signal(signal.SIGTERM)
  break
 if p.poll() is not None: break
try: p.wait(timeout=2)
except subprocess.TimeoutExpired:
 p.kill();p.wait();raise RuntimeError('hidden input did not finish')
after = termios.tcgetattr(slave)
assert before == after, 'terminal state not restored'
if sys.argv[4]=='failure':
 assert b'HIDDEN-REFUSED' in output and b'Key (hidden):' not in output, output
 assert p.returncode==1, p.returncode
else: assert p.returncode==143, p.returncode
os.close(master);os.close(slave)
`
  for (const [stty, mode] of [[fake, 'failure'], ['/bin/stty', 'signal']]) {
    const child = Bun.spawn([python, '-I', '-c', harness, process.execPath, join(import.meta.dir, '..', 'scripts', 'auth.ts'), stty as string, mode as string], { stdout: 'pipe', stderr: 'pipe' })
    const diagnostic = await new Response(child.stderr).text()
    expect(diagnostic).toBe('')
    expect(await child.exited).toBe(0)
  }
})

test('reserved sign-in records never become API keys, including incomplete and unknown methods', async () => {
  for (const value of ['zz1|client|refresh|1800003600||access', 'zz1|broken', 'v1|broken', 'v1|client|refresh|soon||access', 'v1|client|refresh|1800003600||']) {
    const w = world({ key: value })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.items).toEqual({})
    expect(w.h.calls.some(call => call.input !== undefined)).toBe(false)
    expect(w.h.err.join('\n')).toContain('nothing stored')
  }
})

test('legacy device selection without an injected extra fails before any effects', async () => {
  const w = world()
  expect(w.io.extraSignIn).toBeUndefined()
  expect(await w.cli('login', 'acme', '--chatgpt', '--device')).toBe(2)
  expect([w.h.calls, w.h.asked, w.h.ports, w.h.fetched]).toEqual([[], 0, [], []])
})

test('terminal sign-in rewrite removes every User-Agent case and keeps unrelated headers', async () => {
  for (const name of ['User-Agent', 'user-agent', 'uSeR-aGeNt']) {
    const provider = { ...PROVIDER, headers: { [name]: 'stale/1', 'X-Team': 'blue' } }
    const w = world({ config: { providers: { acme: provider } }, key: SIGN_IN })
    expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
    expect(JSON.parse(readFileSync(w.configPath, 'utf8')).providers.acme.headers).toEqual({ 'X-Team': 'blue' })
  }
})


test('login rewrite refuses a User-Agent changed after configuration consent', async () => {
  const selected = { ...PROVIDER, headers: { 'uSeR-aGeNt': 'stale/1', 'X-Team': 'blue' } }
  const w = world({ config: { providers: { acme: selected } }, key: SIGN_IN })
  w.io.readKey = async () => {
    writeFileSync(w.configPath, JSON.stringify({ providers: { acme: { ...selected, headers: { 'uSeR-aGeNt': 'fresh/2', 'X-Team': 'blue' } } } }))
    return SIGN_IN
  }
  expect(await w.cli('login', 'acme', '--write-config')).toBe(1)
  expect(w.h.err.join(' ')).toContain('selected provider changed while waiting')
  expect(JSON.parse(readFileSync(w.configPath, 'utf8')).providers.acme.headers['uSeR-aGeNt']).toBe('fresh/2')
})
