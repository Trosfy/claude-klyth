// Public executable grammar for Klyth auth and local diagnostics.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from '../.claude-plugin/plugin.json' with { type: 'json' }
import { parseConfig } from '../hooks/config'
import { knownClient } from '../hooks/extra-client'
import { configPath as productConfigPath } from '../hooks/product'
import { SETUP_FRAME_MAX } from '../hooks/setup-protocol'
import { startDaemon } from '../klythd/main'
import type { Io as AuthIo } from './auth'
import { cli as authCli, readKey, run } from './auth'
import { officialClientChanged } from './auth-operation'
import type { Ports } from './chatgpt'
import { ports as chatgptPorts, parseItem, reservedRecord } from './chatgpt'
import { credentialPresence, keychain, secretTool } from './credential-store'
import type { ExtraClientId, ExtraMethod } from './extras'
import { extraSignIn } from './extras'
import { setupEntry } from './setup'

declare const KLYTH_COMPILED: boolean
declare const KLYTH_VERSION: string

export type CliIo = AuthIo & Ports & { readStdin?(): Promise<string>; stdinIsTTY?: boolean }
type ConfigState = { status: 'valid' | 'missing' | 'invalid'; providers: readonly string[]; modelCount: number }
type KeyringState = { status: 'available' | 'unavailable' | 'unsupported'; tool?: 'security' | 'secret-tool' }
type PresenceState = 'present' | 'absent' | 'unknown' | 'error' | 'unavailable'
type LoginPolicy = { provider: string; method: 'api-key' | 'official' | ExtraClientId }
type CredentialIdentity = { method: 'v1' | ExtraMethod; clientId: string }

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/
const VERSION = typeof KLYTH_VERSION === 'string' ? KLYTH_VERSION : manifest.version
const isCompiled = () => typeof KLYTH_COMPILED !== 'undefined' && KLYTH_COMPILED
const validId = (id: string) => ID_RE.test(id) && id !== 'native'
const line = (io: CliIo, text: string) => io.out(text)
const fail = (io: CliIo, message: string, code = 2) => (io.err(`klyth: ${message}`), code)
const helpRequested = (args: readonly string[]) => args.includes('--help') || args[0] === 'help' || args.at(-1) === 'help'

export function tokenCommandFor(provider: string, runtime: { compiled: boolean; executable: string; cliPath: string }): readonly string[] {
  return runtime.compiled
    ? [runtime.executable, 'auth', 'token', provider]
    : [runtime.executable, runtime.cliPath, 'auth', 'token', provider]
}

function runtimeTokenCommand(provider: string): readonly string[] {
  const compiled = isCompiled()
  return tokenCommandFor(provider, {
    compiled,
    executable: process.execPath,
    cliPath: compiled ? '' : fileURLToPath(import.meta.url),
  })
}

function rootHelp(short = false): string {
  return short
    ? 'Klyth — local auth and diagnostics\nUsage: klyth <command>\nRun klyth --help for commands.'
    : 'Klyth — local auth and diagnostics\n\nUsage: klyth <command>\n\nCommands:\n  auth     Sign in, inspect, or manage provider credentials\n  doctor   Check local configuration, helper version, and keyring tools\n\nOptions:\n  --help      Show help\n  --version   Show version'
}

const AUTH_HELP = 'Usage: klyth auth <command>\n\nCommands:\n  login      Sign in with ChatGPT or store an API key\n  status     Show local config validity and credential presence\n  logout     Remove a stored credential\n  token      Print a current ChatGPT access token for a helper\n  export     Move a ChatGPT sign-in through a pipe\n  migrate    Explicitly migrate a legacy credential\n\nRun klyth auth <command> --help for command help.'
const LOGIN_HELP = 'Usage: klyth auth login <method> [options]\n\nMethods:\n  chatgpt                Official ChatGPT browser sign-in (default)\n  api-key <provider-id>  Store an API key from a hidden prompt or explicit stdin\n\nChatGPT options:\n  --client official      Select the official registered-app flow (default)\n  --provider <id>        Provider/keyring ID (default: chatgpt)\n  --write, --write-config  Update auth.command on an existing provider\n  --port <n>             Callback port (official flow only; default: 1455)\n  --no-browser           Do not open the authorization page\n\nWithout --write, login stores the credential and prints the config change needed; it never edits config.\nAPI keys are never accepted as command-line arguments.'
const API_KEY_HELP = 'Usage: klyth auth login api-key <provider-id> [--write] [--stdin]\n\nReads an API key from a hidden terminal prompt. In non-interactive use, --stdin is required and explicitly reads the key from stdin. No key option or positional secret is accepted. --write updates auth.command only on an existing valid provider; without it, a key may be stored for an ID not yet in config. A stored ChatGPT credential is not replaced; run klyth auth logout <provider-id> first or choose another provider.'
const CHATGPT_HELP = 'Usage: klyth auth login chatgpt [--client official] [--provider <id>] [--write|--write-config] [--port <n>] [--no-browser] A credential for a different method or client is not replaced; run klyth auth logout <provider-id> first or choose another provider.'
const STATUS_HELP = 'Usage: klyth auth status [provider-id] [--json]\n\nChecks local config validity and credential presence where metadata-only lookup is supported. Linux reports presence as unknown without invoking secret-tool lookup.'
const LOGOUT_HELP = 'Usage: klyth auth logout <provider-id>\n\nRemoves only the named provider credential. It does not edit config.'
const TOKEN_HELP = 'Usage: klyth auth token <provider-id>\n\nPrints only the current ChatGPT access token to stdout. Exit codes 3 and 4 retain their refresh meanings.'
const EXPORT_HELP = 'Usage: klyth auth export <provider-id>\n\nMoves a ChatGPT sign-in through stdout. It refuses to write the credential to a terminal.'
const MIGRATE_HELP = 'Usage: klyth auth migrate <provider-id> --from styx --runtimes-stopped [--retire-source]\n\nMigration is explicit and requires all old and new auth runtimes to be stopped.'

function helpText(args: readonly string[], io: CliIo): string {
  if (args[0] !== 'login') {
    return ({ status: STATUS_HELP, logout: LOGOUT_HELP, token: TOKEN_HELP, export: EXPORT_HELP, migrate: MIGRATE_HELP } as Record<string, string>)[args[0] ?? ''] ?? AUTH_HELP
  }
  return args[1] === 'api-key' ? API_KEY_HELP : (args[1] === 'chatgpt' ? CHATGPT_HELP : LOGIN_HELP) + (io.extraSignIn?.help ?? '')
}

function inspectConfig(path: string): ConfigState {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (error) {
    return (error as { code?: string }).code === 'ENOENT' ? { status: 'missing', providers: [], modelCount: 0 } : { status: 'invalid', providers: [], modelCount: 0 }
  }
  try {
    const parsed = parseConfig(text)
    if (parsed.config === undefined) return { status: 'invalid', providers: [], modelCount: 0 }
    const providers = Object.values(parsed.config.providers)
    return { status: 'valid', providers: Object.keys(parsed.config.providers), modelCount: providers.reduce((total, provider) => total + Object.keys(provider.models).length, 0) }
  } catch {
    return { status: 'invalid', providers: [], modelCount: 0 }
  }
}

function keyring(io: CliIo): { store?: ReturnType<typeof keychain>; state: KeyringState } {
  if (io.platform === 'darwin') {
    const tool = io.which('security') ?? (existsSync('/usr/bin/security') ? '/usr/bin/security' : undefined)
    return tool === undefined
      ? { state: { status: 'unavailable', tool: 'security' } }
      : { store: keychain(), state: { status: 'available', tool: 'security' } }
  }
  if (io.platform === 'linux') {
    const tool = io.which('secret-tool')
    return tool === undefined
      ? { state: { status: 'unavailable', tool: 'secret-tool' } }
      : { store: secretTool(tool), state: { status: 'available', tool: 'secret-tool' } }
  }
  return { state: { status: 'unsupported' } }
}

function doctor(io: CliIo, args: readonly string[]): number {
  if (helpRequested(args)) return line(io, 'Usage: klyth doctor [--json]\n\nChecks local config validity, helper version, and keyring tool availability. It does not read credentials or contact a provider.'), 0
  if (args.some(arg => arg !== '--json') || args.filter(arg => arg === '--json').length > 1) return fail(io, 'usage: klyth doctor [--json]')
  const config = inspectConfig(io.configPath)
  const ring = keyring(io).state
  const report = {
    version: 1,
    cliVersion: VERSION,
    runtime: isCompiled() ? 'compiled' : 'source',
    platform: io.platform,
    config: { status: config.status, providers: config.providers.length, models: config.modelCount },
    keyring: ring,
  }
  if (args.includes('--json')) line(io, JSON.stringify(report))
  else {
    line(io, `Klyth ${VERSION} (${report.runtime}) on ${io.platform}`)
    line(io, `config: ${config.status} (${config.providers.length} providers, ${config.modelCount} models)`)
    line(io, `keyring tool: ${ring.status}${ring.tool === undefined ? '' : ` (${ring.tool})`}`)
  }
  return config.status === 'invalid' || ring.status !== 'available' ? 1 : 0
}

async function status(io: CliIo, args: readonly string[]): Promise<number> {
  const json = args.includes('--json')
  const ids = args.filter(arg => arg !== '--json')
  if (ids.length > 1 || args.filter(arg => arg === '--json').length > 1 || ids.some(id => !validId(id))) return fail(io, 'usage: klyth auth status [provider-id] [--json]')
  const config = inspectConfig(io.configPath)
  const ring = keyring(io)
  const selected = ids.length === 1 ? ids : config.providers
  const configured = new Set(config.providers)
  const entries: { id: string; configured: boolean; presence: PresenceState }[] = []
  if (config.status !== 'invalid') {
    for (const id of selected) {
      let presence: PresenceState = 'unavailable'
      if (ring.store !== undefined) {
        const result = await credentialPresence(io.run, ring.store, id)
        presence = result.status === 'found' ? 'present' : result.status === 'missing' ? 'absent' : result.status
      }
      entries.push({ id, configured: configured.has(id), presence })
    }
  }
  const report = { config: config.status, keyring: ring.state, providers: entries }
  if (json) line(io, JSON.stringify(report))
  else {
    line(io, `config: ${config.status}`)
    line(io, `keyring: ${ring.state.status}${ring.state.tool === undefined ? '' : ` (${ring.state.tool})`}`)
    if (config.status === 'invalid') line(io, 'provider status unavailable; fix the local config before retrying')
    else if (entries.length === 0) line(io, 'no configured providers')
    else for (const entry of entries) line(io, `${entry.id}: ${entry.configured ? 'configured' : 'not configured'}; credential ${entry.presence}`)
  }
  return config.status === 'invalid' || ring.state.status !== 'available' || entries.some(entry => entry.presence === 'error') ? 1 : 0
}

function usageError(io: CliIo, message: string): number {
  return fail(io, `${message}\n${CHATGPT_HELP}${io.extraSignIn?.help ?? ''}`)
}

function chatgptArgs(args: readonly string[], io: CliIo): { provider: string; write: boolean; device: boolean; port: number; browser: boolean } | undefined {
  let client = 'official'
  let provider: string | undefined
  let write = false, port = 1455, browser = true, device = false
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--client') {
      if (seen.has(arg) || args[i + 1] === undefined) return undefined
      seen.add(arg); client = args[++i] as string
      if (!knownClient(io.extraSignIn?.client, client)) return undefined
    } else if (arg === '--provider') {
      if (seen.has(arg) || args[i + 1] === undefined) return undefined
      seen.add(arg); provider = args[++i] as string
    } else if (arg === '--write' || arg === '--write-config') {
      if (write) return undefined
      write = true
    } else if (arg === '--port') {
      if (seen.has(arg) || args[i + 1] === undefined || !/^\d{1,5}$/.test(args[i + 1] as string)) return undefined
      seen.add(arg); port = Number(args[++i])
      if (port < 1 || port > 65535) return undefined
    } else if (arg === '--no-browser') {
      if (seen.has(arg)) return undefined
      seen.add(arg); browser = false
    } else if (io.extraSignIn?.cliFlags.includes(arg)) {
      if (seen.has(arg)) return undefined
      seen.add(arg); device = true
    } else return undefined
  }
  if (!device && client !== 'official' || device && (io.extraSignIn === undefined || client !== io.extraSignIn.client.id)) return undefined
  if (device && (seen.has('--port') || seen.has('--no-browser'))) return undefined
  const id = provider ?? (device ? io.extraSignIn!.client.defaultProviderId : 'chatgpt')
  return validId(id) ? { provider: id, write, device, port, browser } : undefined
}

function apiKeyArgs(args: readonly string[]): { provider: string; write: boolean; stdin: boolean } | undefined {
  const positionals: string[] = []
  let write = false, stdin = false
  for (const arg of args) {
    if (arg === '--write' || arg === '--write-config') {
      if (write) return undefined
      write = true
    } else if (arg === '--stdin') {
      if (stdin) return undefined
      stdin = true
    } else if (arg.startsWith('-')) return undefined
    else positionals.push(arg)
  }
  return positionals.length === 1 && validId(positionals[0] as string)
    ? { provider: positionals[0] as string, write, stdin }
    : undefined
}

function terminalInput(io: CliIo): boolean {
  return io.stdinIsTTY ?? io.stdoutIsTTY
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function permitsExisting(value: string, policy: LoginPolicy, io: CliIo): boolean {
  if (policy.method === 'api-key') return !reservedRecord(value)
  const item = parseItem(value, io.extraSignIn)
  if (item === undefined) return false
  if (policy.method === 'official') return item.method === 'v1'
  return io.extraSignIn !== undefined && item.method === io.extraSignIn.client.method && item.clientId === io.extraSignIn.clientId(io.env ?? {})
}

async function invokeLegacy(io: CliIo, args: readonly string[], stdin = false, policy?: LoginPolicy): Promise<number> {
  let legacyImport = false, replacementBlocked = false, expectedState: string | undefined
  let existing: CredentialIdentity | undefined
  const store = policy === undefined ? undefined : keyring(io).store
  const readArgv = store === undefined || policy === undefined ? undefined : store.read(policy.provider)
  const replacementMessage = () => `klyth auth: ${policy?.provider ?? 'provider'} already holds a credential for a different method or client; run klyth auth logout ${policy?.provider ?? '<provider>'} first or choose another provider; credential not replaced`
  const rejectChangedClient = (url: URL): URL => {
    if (policy?.method !== 'official' || existing?.method !== 'v1' || !officialClientChanged(url, expectedState, existing.clientId)) return url
    replacementBlocked = true
    const refused = new URL(url)
    refused.searchParams.set('error', 'credential_client_changed')
    refused.searchParams.delete('error_description')
    return refused
  }
  const adapted: CliIo = {
    ...io,
    tokenCommand: io.tokenCommand ?? runtimeTokenCommand,
    err: message => io.err(legacyImport ? 'klyth auth: looks like a sign-in record; nothing stored; credential-record import remains available only through the legacy bun run auth path' : replacementBlocked ? replacementMessage() : message),
    out: message => {
      if (policy?.method === 'official' && message.startsWith('https://auth.openai.com/api/accounts/authorize?')) {
        try { expectedState = new URL(message).searchParams.get('state') ?? undefined } catch {}
      }
      io.out(message)
    },
    run: async (argv, input) => {
      const result = await io.run(argv, input)
      if (readArgv !== undefined && policy !== undefined && !replacementBlocked && !legacyImport && input === undefined && sameArgv(argv, readArgv) && existing === undefined) {
        if (result.exitCode === 0) {
          const value = result.stdout.trim()
          const item = parseItem(value, io.extraSignIn)
          if (!permitsExisting(value, policy, io)) {
            replacementBlocked = true
            return { exitCode: 51, stdout: '', stderr: '' }
          }
          if (item !== undefined) existing = { method: item.method, clientId: item.clientId }
        }
      }
      return result
    },
    listen: (port, onCallback) => io.listen(port, url => onCallback(rejectChangedClient(url))),
    readLine: async () => {
      const value = await io.readLine()
      if (value === undefined) return undefined
      try { return rejectChangedClient(new URL(value.trim())).href } catch { return value }
    },
    readKey: async () => {
      if (stdin && io.readStdin === undefined) throw new Error('explicit stdin input is unavailable')
      if (!stdin && !terminalInput(io)) throw new Error('interactive key input requires a terminal')
      const value = stdin ? await io.readStdin?.() : await io.readKey()
      if (stdin && reservedRecord(value?.trim() ?? '')) {
        legacyImport = true
        throw new Error('credential-record import uses the legacy auth interface')
      }
      return value ?? ''
    },
  }
  return authCli(args, adapted)
}

async function auth(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length === 0) return line(io, AUTH_HELP), 0
  if (helpRequested(args)) {
    const topic = args[0] === 'help' ? args.slice(1) : args.filter(arg => arg !== '--help' && arg !== 'help')
    return line(io, helpText(topic, io)), 0
  }
  const [command, ...rest] = args
  if (command === 'login') {
    if (rest.length === 0) return line(io, LOGIN_HELP + (io.extraSignIn?.help ?? '')), 0
    if (rest[0] === 'chatgpt') {
      const options = chatgptArgs(rest.slice(1), io)
      if (options === undefined) return usageError(io, 'invalid ChatGPT login options; no sign-in was started')
      if (!terminalInput(io)) return fail(io, 'ChatGPT login needs an interactive terminal; run it from a terminal', 1)
      const legacy = ['login', options.provider, '--chatgpt', ...(options.device ? io.extraSignIn!.cliFlags : []), ...(options.write ? ['--write-config'] : []), ...(options.device ? [] : ['--port', String(options.port), ...(!options.browser ? ['--no-browser'] : [])])]
      return invokeLegacy(io, legacy, false, { provider: options.provider, method: options.device ? io.extraSignIn!.client.id as ExtraClientId : 'official' })
    }
    if (rest[0] === 'api-key') {
      const options = apiKeyArgs(rest.slice(1))
      if (options === undefined) return fail(io, `invalid API-key login options\n${API_KEY_HELP}`)
      if (!options.stdin && !terminalInput(io)) return fail(io, 'non-interactive API-key login requires --stdin; no input was read', 1)
      const legacy = ['login', options.provider, ...(options.write ? ['--write-config'] : [])]
      return invokeLegacy(io, legacy, options.stdin, { provider: options.provider, method: 'api-key' })
    }
    return usageError(io, 'choose chatgpt or api-key')
  }
  if (command === 'status') return status(io, rest)
  if (command === 'logout' || command === 'token' || command === 'export') {
    if (rest.length !== 1 || !validId(rest[0] as string)) return fail(io, `usage: klyth auth ${command} <provider-id>`)
    return invokeLegacy(io, [command, rest[0] as string])
  }
  if (command === 'migrate') return invokeLegacy(io, ['migrate', ...rest])
  return fail(io, AUTH_HELP)
}

export async function cli(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length === 0) return line(io, rootHelp(true)), 0
  if (args[0] === '--help' || args[0] === 'help') return line(io, rootHelp()), 0
  if (args[0] === '--version') return args.length === 1 ? (line(io, `klyth ${VERSION}`), 0) : fail(io, 'usage: klyth --version')
  if (args[0] === 'auth') return auth(args.slice(1), io)
  if (args[0] === 'doctor') return doctor(io, args.slice(1))
  return fail(io, rootHelp())
}

function runtimeIo(): CliIo {
  const config = productConfigPath(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'))
  const base: AuthIo = {
    platform: process.platform,
    which: name => Bun.which(name) ?? undefined,
    run,
    readKey,
    configPath: config,
    out: console.log,
    err: console.error,
    extraSignIn, env: process.env,
  }
  return {
    ...base,
    ...chatgptPorts(dirname(config), process.platform),
    tokenCommand: runtimeTokenCommand,
    readStdin: async () => await Bun.stdin.text(),
    stdinIsTTY: process.stdin.isTTY === true,
  }
}

async function entry(args: readonly string[]): Promise<number | undefined> {
  if (args[0] === '__daemon' && args.length === 1) { startDaemon(); return undefined }
  if (args[0] === '__setup') {
    let input: unknown
    if (args.length === 1 && !process.stdin.isTTY) {
      let size = 0
      const chunks: Uint8Array[] = []
      try {
        for await (const chunk of Bun.stdin.stream()) {
          size += chunk.length
          if (size > SETUP_FRAME_MAX) throw new Error('setup request too large')
          chunks.push(chunk)
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch { input = undefined }
    }
    return setupEntry(input, productConfigPath(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')), runtimeTokenCommand)
  }
  return cli(args, runtimeIo())
}

if (import.meta.main) {
  const result = await entry(process.argv.slice(2))
  if (result !== undefined) process.exit(result)
}
