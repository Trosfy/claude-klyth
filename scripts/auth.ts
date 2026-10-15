// Credential admission and auth operations over injected keyring and sign-in ports.
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { configPath as productConfigPath } from '../hooks/product'

import { isObject } from '../hooks/config'
import { isUsableKey } from '../klythd/auth'
import { commitAuthConfig, authProviders as providersOf, readAuthConfig, validateAuthConfig } from './auth-config'
import type { Ports } from './chatgpt'
import { exportItem, importItem, isSignIn, login, mutateCredential, ports, reservedRecord, RESOURCE, token, tokenCommand } from './chatgpt'
import type { Run } from './credential-store'
import { credentialPresence, keychain, lookup, secretTool } from './credential-store'
import type { ExtraSignIn } from './extra-sign-in'
import type { ExtraClientId, ExtraMethod } from './extras'
import { extraSignIn } from './extras'
import { MIGRATE_USAGE, migrateCli } from './migrate'

export type { Run, Store } from './credential-store'

export type Io = { platform: string; which(name: string): string | undefined; run: Run; readKey(): Promise<string>; configPath: string; out(line: string): void; err(line: string): void; extraSignIn?: ExtraSignIn<ExtraClientId, ExtraMethod>; env?: Readonly<Record<string, string | undefined>> }
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/ // config.ts's provider ids

const line = (command: readonly string[], ttl?: number) => `  "auth": { "command": ${JSON.stringify(command)}${ttl === undefined ? '' : `, "ttlSeconds": ${ttl}`} }`
export async function cli(args: readonly string[], io: Io & Ports): Promise<number> {
  if (args[0] === 'migrate') return migrateCli(args.slice(1), io)
  const at = args.indexOf('--port')
  const rest = at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)]
  const [cmd, p, ...extra] = rest.filter(a => !a.startsWith('--'))
  const flags = rest.filter(a => a.startsWith('--'))
  const [write, chatgpt, device, browser] = [flags.includes('--write-config'), flags.includes('--chatgpt'), flags.some(flag => io.extraSignIn?.cliFlags.includes(flag)), !flags.includes('--no-browser')]
  const port = at < 0 ? 1455 : /^\d{1,5}$/.test(args[at + 1] ?? '') ? Number(args[at + 1]) : 0
  // Nothing typed is echoed: an argument given by mistake could be a key.
  const usage = (why: string) => (io.err(`klyth auth: ${why}. This is the legacy form. Use klyth auth --help.
Migration: ${MIGRATE_USAGE}`), 2)
  if (cmd === 'login' && (p === 'api-key' && extra.length > 0 || flags.includes('--provider'))) {
    const method = p === 'api-key' ? 'api-key <provider>' : 'chatgpt --provider <provider>'
    return usage(`Use klyth auth login ${method}`)
  }
  if (extra.length > 0 || flags.some(f => f !== '--write-config' && f !== '--chatgpt' && !io.extraSignIn?.cliFlags.includes(f) && f !== '--no-browser')) return usage('unexpected arguments')
  if (cmd !== 'login' && cmd !== 'logout' && cmd !== 'list' && cmd !== 'token' && cmd !== 'export' && cmd !== 'import') return usage('expected login, logout, list, token or export')
  if ((write || chatgpt) && cmd !== 'login' && cmd !== 'import') return usage('--write-config and --chatgpt belong to login')
  if ((at >= 0 || !browser) && !chatgpt) return usage('--port and --no-browser belong to login --chatgpt')
  if (device && io.extraSignIn === undefined) return usage('device sign-in is unavailable')
  if (device && (!chatgpt || at >= 0 || !browser)) return usage('--device belongs to login --chatgpt, without --port or --no-browser')
  if (port < 1 || port > 65535) return usage('--port takes a port number from 1 to 65535')
  if (p === undefined ? cmd !== 'list' : !ID_RE.test(p)) return usage('a provider id is lowercase letters, digits and dashes')
  // A ChatGPT sign-in or refresh with a bad identity override sends nothing; export and a piped item send nothing anyway.
  const identity = io.extraSignIn?.authUserAgent(io.env ?? {}) ?? {}
  if ('error' in identity && (chatgpt || cmd === 'token')) return io.err(`klyth auth: ${identity.error}`), 1

  const tool = io.platform === 'linux' ? io.which('secret-tool') : undefined
  const store = io.platform === 'darwin' ? keychain() : tool === undefined ? undefined : secretTool(tool)
  const plain = cmd === 'login' && !chatgpt
  if (store === undefined) {
    io.err(`klyth auth: no keyring here (no macOS Keychain, no secret-tool)${plain ? `; keep the key in your own tool and set, under providers.${p} in ${io.configPath}:` : cmd === 'logout' || cmd === 'list' ? `; nothing to ${cmd}` : '; a ChatGPT sign-in needs one'}`)
    if (plain) for (const argv of [[io.which('pass') ?? '/usr/bin/pass', 'show', `klyth/${p}`], [io.which('op') ?? '/usr/local/bin/op', 'read', `op://Private/klyth ${p}/credential`]]) io.out(line(argv))
    return 1
  }
  const signIn = { ...io, store }
  if (cmd === 'token') return token(signIn, p as string)
  if (cmd === 'export') return exportItem(signIn, p as string)
  let config: Record<string, unknown>
  try { config = readAuthConfig(io.configPath) } catch (e) { if (cmd === 'logout') config = {}; else return io.err(`klyth auth: ${(e as Error).message}`), 1 }
  if (cmd === 'list') {
    const names = p === undefined ? Object.keys(providersOf(config)) : [p]
    if (names.length === 0) return io.err(`klyth auth: no providers in ${io.configPath}. Use klyth auth status <provider>.`), 1
    let failed = false
    for (const n of names) {
      const held = await credentialPresence(io.run, store, n)
      if (held.status === 'error') { io.err(`klyth auth: lookup failed in the ${store.name}; no absence inferred`); failed = true }
      else io.out(`${n}: ${held.status === 'unknown' ? 'presence unknown (tool available)' : held.status === 'found' ? 'item' : 'no item'} in the ${store.name}`)
    }
    return failed ? 1 : 0
  }
  const id = p as string
  if (cmd === 'logout') {
    const prior = await lookup(io.run, store, id)
    let gone = false
    const failed = await mutateCredential(signIn, id, prior, async () => {
      const result = await io.run(store.del(id))
      if (result.exitCode !== 0 && !(await store.missing(result, io.run, id))) return `removal failed in the ${store.name}; item status unknown`
      gone = result.exitCode === 0
      return undefined
    })
    if (failed !== undefined) return io.err(`klyth auth: ${failed}`), 1
    io.out(gone ? `${id}: item removed from the ${store.name}; auth.command in ${io.configPath} is unchanged` : `${id}: no item in the ${store.name}`)
    return gone ? 0 : 1
  }

  // login: the config is checked before anything is stored, so a failure leaves nothing half done.
  const provider = providersOf(config)[id]
  if (write && !isObject(provider)) return io.err(`klyth auth: providers.${id} is not in ${io.configPath} (or the file is missing or not JSON); Run /klyth setup first`), 1
  if (write) { try { validateAuthConfig(config, id) } catch (e) { return io.err(`klyth auth: ${(e as Error).message}`), 1 } }
  const configError = chatgpt && isObject(provider) ? io.extraSignIn?.configCheck(provider, device) : undefined
  if (configError !== undefined) return io.err(`klyth auth: ${configError}`), 1
  if (write && chatgpt && !device && isObject(provider) && (provider['baseUrl'] !== RESOURCE || provider['kind'] !== 'openai-responses')) return io.err('klyth auth: selected provider does not match the official ChatGPT backend; Run /klyth setup first'), 1
  // The auth line (and the provider headers a device sign-in needs; one given as undefined is removed) for
  // klyth.json, printed, or written under --write-config.
  const finish = (command: readonly string[], ttl?: number, headers?: Record<string, string | undefined>) => {
    if (!write) return io.out(`set, under providers.${id} in ${io.configPath} (See klyth auth --help. Use --write to update config.):\n${line(command, ttl)}${headers === undefined ? '' : `,\n  "headers": ${JSON.stringify(headers)}`}`), 0
    try {
      return io.out(`wrote providers.${id}.auth.command${headers === undefined ? '' : ' and headers'} to ${commitAuthConfig(io, io.configPath, config, id, command, ttl, headers)}`), 0
    } catch (e) { return io.err(`klyth auth: sign-in/key saved; configuration not changed: ${(e as Error).message}`), 1 }
  }
  if (device) {
    const headers = await io.extraSignIn!.deviceLogin(signIn, id)
    return typeof headers === 'number' ? headers : finish((io.tokenCommand ?? tokenCommand)(id), 600, headers)
  }
  if (chatgpt) return (await login(signIn, id, { port, browser })) || finish((io.tokenCommand ?? tokenCommand)(id), 600)
  const held = await lookup(io.run, store, id)
  if (held.status === 'error') return io.err(`klyth auth: lookup failed in the ${store.name}; nothing stored`), 1
  let key: string
  try { key = (await io.readKey()).trim() } catch { return io.err('klyth auth: could not read a hidden key; nothing stored'), 1 }
  if (cmd === 'import' && !isSignIn(key)) return io.err('klyth auth: Invalid sign-in record. Nothing stored.'), 1
  if (isSignIn(key)) {
    const failed = await importItem(signIn, id, key, held)
    if (failed !== undefined) return io.err(`klyth auth: ${failed}`), 1
    io.out(`${id}: ChatGPT sign-in stored in the ${store.name} (service klyth, account ${id}) and read back intact`)
    return finish((io.tokenCommand ?? tokenCommand)(id), 600)
  }
  if (reservedRecord(key)) return io.err('klyth auth: looks like a sign-in record; nothing stored'), 1
  if (!isUsableKey(key)) return io.err('klyth auth: the key must be 1 to 4096 visible ASCII characters with no spaces; nothing stored'), 1
  const add = store.add(id, key)
  if (typeof add === 'string') return io.err(`klyth auth: ${add}`), 1
  if (held.status === 'found' && reservedRecord(held.value)) return io.err(`klyth auth: ${id} holds a ChatGPT sign-in. Run klyth auth logout ${id} first, or klyth auth login chatgpt --provider ${id}`), 1
  const failed = await mutateCredential(signIn, id, held, async () => {
    const added = await io.run(add.argv, add.input)
    if (added.exitCode !== 0) return `the ${store.name} refused the key (exit ${added.exitCode}); unlock it, then retry`
    const back = await io.run(store.read(id))
    return back.exitCode === 0 && back.stdout.trim() === key ? undefined : `stored, but reading ${id} back did not give the same key (exit ${back.exitCode}). Run klyth auth logout ${id}. Then run klyth auth login api-key ${id}.`
  })
  if (failed !== undefined) return io.err(`klyth auth: ${failed}`), 1
  io.out(`${id}: key stored in the ${store.name} (service klyth, account ${id}) and read back intact`)
  return finish(store.read(id))
}

// The key from stdin; on a terminal, one line typed with echo off.
export async function readKey(options: { stty?: string } = {}): Promise<string> {
  if (!process.stdin.isTTY) return await Bun.stdin.text()
  const stty = (arg: string) => Bun.spawnSync([options.stty ?? '/bin/stty', arg], { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' })
  const original = stty('-g')
  if (original.exitCode !== 0 || !original.stdout.toString().trim()) throw new Error('could not read terminal state')
  const state = original.stdout.toString().trim()
  let restored = false
  const restore = () => { if (!restored) { restored = true; stty(state) } }
  const interrupt = () => { restore(); process.exit(130) }
  const terminate = () => { restore(); process.exit(143) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    if (stty('-echo').exitCode !== 0) throw new Error('could not suppress terminal echo')
    process.stderr.write('Key (hidden): ')
    for await (const typed of console) return typed
    return ''
  } finally {
    restore()
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    process.stderr.write('\n')
  }
}

export const run: Run = async (argv, input) => {
  try {
    const child = Bun.spawn([...argv], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer))
    return { exitCode, stdout, stderr }
  } catch {
    return { exitCode: 127, stdout: '', stderr: '' }
  }
}

if (import.meta.main) {
  const configPath = productConfigPath(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'))
  const io = { platform: process.platform, which: (n: string) => Bun.which(n) ?? undefined, run, readKey, configPath, out: console.log, err: console.error, extraSignIn, env: process.env }
  process.exit(await cli(process.argv.slice(2), { ...io, ...ports(dirname(configPath), process.platform) }))
}
