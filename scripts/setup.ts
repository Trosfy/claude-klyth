// Internal setup operations emit only the shared, validated nonsecret JSONL protocol.
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { isObject, parseConfig } from '../hooks/config'
import type { SetupConnection, SetupEvent, SetupFailure, SetupModel } from '../hooks/setup-protocol'
import { SETUP_FRAME_MAX, setupEvent, setupRequest } from '../hooks/setup-protocol'
import { isUsableKey } from '../klythd/auth'
import { run } from './auth'
import { authProviders } from './auth-config'
import { authenticate } from './auth-login'
import type { ChatGptIo } from './chatgpt'
import { acquire, parseItem, ports, reservedRecord, RESOURCE } from './chatgpt'
import { credentialPresence, keychain, lookup, secretTool } from './credential-store'
import { extraSignIn } from './extras'
import { checkConnection, checkSelected, configLocation, existingSource, inspectProviders, readSetupConfig, saveSetupConfig, SetupError } from './setup-config'
import type { PendingCredential } from './setup-pending'
import { consumePending, publishPending, readPending } from './setup-pending'

export type SetupIo = ChatGptIo & {
  write(line: string): void
  tokenCommand(provider: string): readonly string[]
  runHelper(argv: readonly string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr?: string }>
}
type HelperProcess = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal: 'SIGKILL'): void }
// Only the explicitly selected metadata credential helper uses this bounded, shell-free runner.
export async function runSetupHelper(argv: readonly string[], timeoutMs = 5000, signal?: AbortSignal, spawn: (argv: readonly string[]) => HelperProcess = args => Bun.spawn([...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (signal?.aborted || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SetupError('models-unavailable')
  const child = spawn(argv), stdout = child.stdout.getReader(), stderr = child.stderr.getReader()
  const chunks: Uint8Array[] = []
  let failed = false
  const stop = () => {
    if (failed) return
    failed = true
    chunks.length = 0
    try { child.kill('SIGKILL') } catch {}
    // Closing both pipes also releases reads held open by inherited child descriptors.
    void Promise.all([stdout.cancel(), stderr.cancel()]).catch(() => {})
  }
  const timer = setTimeout(stop, Math.min(timeoutMs, 5000))
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const read = async (reader: typeof stdout, limit: number, retain: boolean) => {
    let size = 0
    try {
      while (!failed) {
        const part = await reader.read()
        if (part.done || failed) break
        size += part.value.byteLength
        if (size > limit) { stop(); break }
        if (retain) chunks.push(part.value)
      }
    } catch { stop() }
  }
  const drained = Promise.all([read(stdout, 64 * 1024, true), read(stderr, 16 * 1024, false)])
  try {
    const [, exitCode] = await Promise.all([drained, child.exited])
    if (failed) throw new SetupError('models-unavailable')
    return { exitCode, stdout: Buffer.concat(chunks).toString('utf8'), stderr: '' }
  } catch {
    stop()
    await Promise.allSettled([drained, child.exited])
    throw new SetupError('models-unavailable')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    await Promise.all([stdout.cancel(), stderr.cancel()]).catch(() => {})
    stdout.releaseLock(); stderr.releaseLock()
  }
}
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
function officialEndpoint(io: SetupIo, connection: SetupConnection) {
  if (connection.auth.kind !== 'chatgpt') return
  if (connection.kind !== 'openai-responses' || connection.baseUrl !== (connection.auth.client === 'official' ? RESOURCE : io.extraSignIn?.client.baseUrl) || connection.allowHttp) throw new SetupError('invalid-request')
}
async function withPending<T>(io: SetupIo, connection: SetupConnection, work: (record: PendingCredential, value: string) => Promise<T>): Promise<T> {
  if (connection.auth.kind !== 'chatgpt') throw new SetupError('invalid-request')
  const lock = io.lock(connection.provider)
  if (acquire(io, lock) !== true) throw new SetupError('credential-conflict')
  try {
    const record = readPending(io, connection.provider, connection.auth.handle, connection.auth.client)
    if (record.consumed) throw new SetupError('credential-conflict')
    const stored = await lookup(io.run, io.store, connection.provider)
    if (stored.status !== 'found' || fingerprint(stored.value) !== record.fingerprint) throw new SetupError('credential-conflict')
    const item = parseItem(stored.value, io.extraSignIn)
    if (item === undefined || item.method !== record.method || item.clientId !== record.clientId) throw new SetupError('credential-conflict')
    if (io.signal?.aborted) throw new SetupError('cancelled')
    return await work(record, stored.value)
  } finally { lock.release() }
}
function modelRows(body: unknown): SetupModel[] {
  if (!isObject(body)) return []
  const list = Array.isArray(body['data']) ? body['data'] : Array.isArray(body['models']) ? body['models'] : []
  const out: SetupModel[] = []
  for (const row of list.slice(0, 100)) {
    if (!isObject(row) || (row['visibility'] !== undefined && row['visibility'] !== 'list')) continue
    const id = row['id'] ?? row['slug']
    if (typeof id !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(id) || out.some(m => m.id === id)) continue
    const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
    const contextWindow = number(row['context_window']), maxOutputTokens = number(row['max_output_tokens'])
    out.push({ id, ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) })
  }
  return out
}
// This wrapper bounds both headers and streaming body reads; no redirect can forward a credential.
export function boundedFetch(fetcher: ChatGptIo['fetch'], operationSignal?: AbortSignal): ChatGptIo['fetch'] {
  return async (url, init) => {
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), ...(operationSignal ? [operationSignal] : []), AbortSignal.timeout(30_000)])
    const res = await fetcher(url, { ...init, redirect: 'error', signal })
    if (res.status >= 300 && res.status < 400 || res.url && new URL(res.url).origin !== new URL(url).origin) throw new Error('redirect refused')
    if (Number(res.headers.get('content-length')) > 256 * 1024) throw new Error('response too large')
    const reader = res.body?.getReader(), chunks: Uint8Array[] = []
    let size = 0
    const aborted = () => { void reader?.cancel() }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      while (reader) {
        if (signal.aborted) throw new Error('cancelled')
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 256 * 1024) throw new Error('response too large')
        chunks.push(part.value)
      }
      if (signal.aborted) throw new Error('cancelled')
      return new Response(Buffer.concat(chunks), { status: res.status, headers: res.headers })
    } finally { signal.removeEventListener('abort', aborted); await reader?.cancel().catch(() => {}) }
  }
}
async function discover(io: SetupIo, connection: SetupConnection): Promise<SetupModel[]> {
  if (connection.kind === 'bedrock') throw new SetupError('models-unavailable')
  const raw = readSetupConfig(io.configPath)
  checkSelected(raw, connection)
  const source = existingSource(raw, connection)
  let secret: string | undefined, headers: Record<string, string> = {}
  const parsed = parseConfig(JSON.stringify(raw)).config!
  const policy = source === undefined ? parsed.providers[connection.provider] : connection.auth.kind === 'existing' ? parsed.providers[connection.auth.provider] : undefined
  if (policy) headers = { ...policy.headers }
  if (connection.auth.kind === 'chatgpt') {
    await withPending(io, connection, async (record, value) => {
      const item = parseItem(value, io.extraSignIn)!
      if (item.expiresAt * 1000 <= io.now()) throw new SetupError('models-unavailable')
      secret = item.access
      headers = { ...headers, ...Object.fromEntries(Object.entries(record.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...(record.method !== 'v1' ? io.extraSignIn?.setupDiscover(io.env ?? {}).headers : {}) }
    })
  } else if (connection.auth.kind === 'keyring') {
    const found = await lookup(io.run, io.store, connection.provider)
    if (found.status !== 'found' || reservedRecord(found.value) || !isUsableKey(found.value)) throw new SetupError('keyring-unavailable')
    secret = found.value
  } else if (connection.auth.kind === 'existing') {
    if (!policy || policy.auth === 'none') throw new SetupError('config-conflict')
    const result = await io.runHelper(policy.auth.command, 5000)
    if (result.exitCode !== 0 || result.stdout.length > 65536 || !isUsableKey(result.stdout.trim())) throw new SetupError('models-unavailable')
    secret = result.stdout.trim()
  }
  if (secret !== undefined) {
    if (policy?.authHeader === 'x-api-key' || (!policy && connection.kind === 'anthropic')) headers['x-api-key'] = secret
    else headers['authorization'] = `Bearer ${secret}`
  }
  if (connection.kind === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  const url = `${connection.baseUrl.replace(/\/+$/, '')}/models${connection.auth.kind === 'chatgpt' && connection.auth.client !== 'official' ? io.extraSignIn!.setupDiscover(io.env ?? {}).suffix : ''}`
  const response = await io.fetch(url, { headers, signal: io.signal })
  if (!response.ok) throw new SetupError('models-unavailable')
  return modelRows(await response.json())
}
function eventLine(event: SetupEvent): string {
  const checked = setupEvent(event)
  if (!checked) throw new SetupError('helper-failed')
  const text = `${JSON.stringify(checked)}\n`
  if (Buffer.byteLength(text) > SETUP_FRAME_MAX) throw new SetupError('helper-failed')
  return text
}
export async function runSetup(input: unknown, original: SetupIo): Promise<number> {
  const emit = (event: SetupEvent) => original.write(eventLine(event))
  let failure: SetupFailure | undefined, savedCredential = false, handoffReady = false
  const request = setupRequest(input)
  try {
    if (!request) throw new SetupError('invalid-request')
    if (original.signal?.aborted) throw new SetupError('cancelled')
    const io: SetupIo = { ...original, fetch: boundedFetch(original.fetch, original.signal), out: () => {}, err: () => {}, readLine: async () => undefined }
    if (request.action === 'inspect') {
      const raw = readSetupConfig(io.configPath)
      emit({ version: 1, type: 'inspection', providers: inspectProviders(raw), aliases: Object.keys(isObject(raw['aliases']) ? raw['aliases'] : {}) })
    }
    else if (request.action === 'presence') emit({ version: 1, type: 'presence', ...(io.store.name === 'unavailable' ? { status: 'error' as const } : await credentialPresence(io.run, io.store, request.provider)) })
    else if (request.action === 'login') {
      const extra = request.client === 'official' ? undefined : io.extraSignIn
      if (request.client !== 'official' && (extra?.client.id !== request.client || extra.clientId(io.env ?? {}) === undefined)) throw new SetupError('extra-client-unavailable')
      const clientId = extra?.clientId(io.env ?? {})
      const identity = io.extraSignIn?.authUserAgent(io.env ?? {}) ?? {}
      if ('error' in identity) throw new SetupError('invalid-request')
      if (io.store.name === 'unavailable') throw new SetupError('keyring-unavailable')
      readSetupConfig(io.configPath)
      const location = configLocation(io.configPath)
      const selected = authProviders(readSetupConfig(io.configPath))[request.provider]
      if (isObject(selected) && (selected['kind'] !== 'openai-responses' || selected['baseUrl'] !== (request.client === 'official' ? RESOURCE : extra?.client.baseUrl))) throw new SetupError('config-conflict')
      const before = await lookup(io.run, io.store, request.provider)
      if (before.status === 'error') throw new SetupError('keyring-unavailable')
      if (before.status === 'found') {
        const item = parseItem(before.value, io.extraSignIn)
        if (!item || item.method !== (request.client === 'official' ? 'v1' : extra?.client.method) || request.client !== 'official' && item.clientId !== clientId) throw new SetupError('credential-conflict')
      }
      let firstRead = true, replacementConflict = false
      const guardedRun: SetupIo['run'] = async (argv, input) => {
        const result = await io.run(argv, input)
        if (firstRead && JSON.stringify(argv) === JSON.stringify(io.store.read(request.provider))) {
          firstRead = false
          if (before.status === 'found' ? result.exitCode !== 0 || result.stdout.replace(/\n$/, '') !== before.value : result.exitCode === 0) {
            replacementConflict = true
            return { exitCode: 1, stdout: '', stderr: 'credential-conflict' }
          }
        }
        return result
      }
      const result = await authenticate({ ...io, run: guardedRun, operation: { credentialsSaved: saved => {
        savedCredential = true
        if (configLocation(io.configPath).root !== location.root || configLocation(io.configPath).target !== location.target) throw new SetupError('handoff-failed')
        const record = publishPending(io, saved)
        handoffReady = true
        emit({ version: 1, type: 'credentials-saved', handle: record.handle })
      } } }, request.provider, { client: request.client, existingClientId: before.status === 'found' ? parseItem(before.value, io.extraSignIn)?.clientId : undefined, browser: false, challenge: challenge => emit({ version: 1, ...challenge }) })
      if (replacementConflict || result.status === 'credential-conflict') throw new SetupError('credential-conflict')
      if (result.status !== 'saved') throw new SetupError(result.status === 'cancelled' ? 'cancelled' : 'auth-failed')
      const models = result.models.filter(m => setupEvent({ version: 1, type: 'models', models: [m] }) !== undefined).slice(0, 100)
      emit({ version: 1, type: 'models', models: [...new Map(models.map(m => [m.id, m])).values()] })
      if (models.length === 0) throw new SetupError('models-unavailable')
    } else {
      checkConnection(request.connection)
      officialEndpoint(io, request.connection)
      if (request.action === 'models') {
        const models = await discover(io, request.connection)
        emit({ version: 1, type: 'models', models })
        if (models.length === 0) throw new SetupError('models-unavailable')
      } else {
        const commit = (auth: unknown, record?: PendingCredential) => {
          if (io.signal?.aborted) throw new SetupError('cancelled')
          const headers = record !== undefined && record.method !== 'v1' ? io.extraSignIn!.configHeaders(record.headers) : record?.headers
          return saveSetupConfig(io, io.configPath, request, auth, headers, record !== undefined)
        }
        let target: string
        if (request.connection.auth.kind === 'chatgpt') target = await withPending(io, request.connection, async record => {
          const target = commit({ command: io.tokenCommand(request.connection.provider) }, record)
          emit({ version: 1, type: 'saved', target })
          try { consumePending(io, record) } catch { throw new SetupError('save-failed') }
          return target
        })
        else {
          const raw = readSetupConfig(io.configPath), source = existingSource(raw, request.connection)
          const auth = request.connection.auth.kind === 'none' ? 'none' : request.connection.auth.kind === 'keyring' ? { command: io.store.read(request.connection.provider) } : source!['auth']
          const lock = io.lock(request.connection.provider)
          if (acquire(io, lock) !== true) throw new SetupError('credential-conflict')
          try { target = commit(auth) } finally { lock.release() }
        }
        if (request.connection.auth.kind !== 'chatgpt') emit({ version: 1, type: 'saved', target })
      }
    }
  } catch (e) {
    failure = savedCredential && !handoffReady ? 'handoff-failed' : e instanceof SetupError ? e.code : original.signal?.aborted ? 'cancelled' : request?.action === 'models' ? 'models-unavailable' : request?.action === 'save' ? 'save-failed' : 'helper-failed'
    emit({ version: 1, type: 'failed', code: failure })
  } finally { emit({ version: 1, type: 'done' }) }
  return failure === undefined ? 0 : failure === 'cancelled' ? 130 : 1
}
export function runtimeSetupIo(configPath: string, tokenCommand: SetupIo['tokenCommand'], signal?: AbortSignal): SetupIo {
  const identity = extraSignIn?.authUserAgent(process.env) ?? {}
  if ('error' in identity) throw new SetupError('invalid-request')
  const store = process.platform === 'darwin' ? keychain() : process.platform === 'linux' && Bun.which('secret-tool') ? secretTool(Bun.which('secret-tool')!) : undefined
  const unavailable = { name: 'unavailable', namespace: 'klyth', find: () => [], read: () => { throw new SetupError('keyring-unavailable') }, add: () => 'keyring-unavailable', del: () => [], missing: () => false }
  return { ...ports(dirname(configPath), process.platform), platform: process.platform, configPath, store: store ?? unavailable, extraSignIn, env: process.env, signal, run, runHelper: (argv, timeout) => runSetupHelper(argv, timeout, signal), tokenCommand, out: () => {}, err: () => {}, write: line => { process.stdout.write(line) } }
}
export async function setupEntry(request: unknown, configPath: string, tokenCommand: SetupIo['tokenCommand']): Promise<number> {
  const abort = new AbortController(), cancel = () => abort.abort()
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  try {
    if (!setupRequest(request)) { process.stdout.write(eventLine({ version: 1, type: 'failed', code: 'invalid-request' }) + eventLine({ version: 1, type: 'done' })); return 1 }
    return await runSetup(request, runtimeSetupIo(configPath, tokenCommand, abort.signal))
  } catch (e) {
    const code = e instanceof SetupError ? e.code : 'helper-failed'
    process.stdout.write(eventLine({ version: 1, type: 'failed', code }) + eventLine({ version: 1, type: 'done' }))
    return 1
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
}
