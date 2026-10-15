// Setup commits a complete provider while preserving fresh, unrelated configuration.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isObject, parseConfig } from '../hooks/config'
import type { SetupConnection, SetupFailure, SetupProviderSummary, SetupRequest } from '../hooks/setup-protocol'
import { authProviders } from './auth-config'
import type { Ports } from './chatgpt'
import { acquire, fileLock } from './chatgpt'

export class SetupError extends Error {
  constructor(readonly code: SetupFailure) { super(code) }
}
export const revisionOf = (value: unknown): string | null => value === undefined ? null : createHash('sha256').update(JSON.stringify(value)).digest('hex')
export type ConfigLocation = { root: string; target: string; exists: boolean; mode: number }
export function configLocation(path: string): ConfigLocation {
  const root = realpathSync(dirname(resolve(path)))
  const absolute = join(root, basename(path))
  let found
  try { found = lstatSync(absolute) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return { root, target: absolute, exists: false, mode: 0o600 }
  }
  const target = realpathSync(absolute)
  const stat = lstatSync(target)
  if ((!found.isFile() && !found.isSymbolicLink()) || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new SetupError('invalid-config')
  return { root, target, exists: true, mode: stat.mode & 0o777 }
}
function configFrom(text: string | undefined): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(text ?? '{}')
    if (!isObject(raw) || parseConfig(JSON.stringify(raw)).config === undefined) throw new Error('invalid')
    return raw
  } catch { throw new SetupError('invalid-config') }
}
export function readSetupConfig(path: string): Record<string, unknown> {
  try { return configFrom(readFileIfPresent(configLocation(path).target)) }
  catch { throw new SetupError('invalid-config') }
}
export function inspectProviders(raw: Record<string, unknown>): SetupProviderSummary[] {
  const parsed = parseConfig(JSON.stringify(raw)).config!
  const entries = Object.entries(authProviders(raw))
  if (entries.length > 100) throw new SetupError('invalid-config')
  return entries.map(([id, p]) => {
    const provider = parsed.providers[id]!
    const models = Object.values(provider.models)
    if (models.length > 100) throw new SetupError('invalid-config')
    return { id, kind: provider.kind, baseUrl: provider.baseUrl, allowHttp: provider.allowHttp, configuredAuth: provider.auth !== 'none', revision: revisionOf(p)!, models: models.map(m => ({ id: m.id, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens })) }
  })
}
export function checkConnection(connection: SetupConnection): void {
  // A validation-only model exercises the existing endpoint and authentication rules.
  const p = { kind: connection.kind, baseUrl: connection.baseUrl, allowHttp: connection.allowHttp, auth: connection.auth.kind === 'none' ? 'none' : { command: ['/validation-only'] }, models: { validation: { contextWindow: 10000, maxOutputTokens: 1 } } }
  if (parseConfig(JSON.stringify({ providers: { [connection.provider]: p } })).config === undefined) throw new SetupError('invalid-request')
}
export function existingSource(raw: Record<string, unknown>, connection: SetupConnection): Record<string, unknown> | undefined {
  if (connection.auth.kind !== 'existing') return undefined
  const p = authProviders(raw)[connection.auth.provider]
  if (!isObject(p) || revisionOf(p) !== connection.auth.revision || p['auth'] === 'none' || !isObject(p['auth'])) throw new SetupError('config-conflict')
  return p
}
export function checkSelected(raw: Record<string, unknown>, connection: SetupConnection): Record<string, unknown> | undefined {
  const p = authProviders(raw)[connection.provider]
  if (p === undefined) return undefined
  if (!isObject(p) || p['kind'] !== connection.kind || typeof p['baseUrl'] !== 'string' || new URL(p['baseUrl']).href.replace(/\/+$/, '') !== new URL(connection.baseUrl).href.replace(/\/+$/, '') || (p['allowHttp'] ?? false) !== connection.allowHttp) throw new SetupError('config-conflict')
  return p
}
export type SaveRequest = Extract<SetupRequest, { action: 'save' }>
function patch(raw: Record<string, unknown>, request: SaveRequest, auth: unknown, headers?: Record<string, string | undefined>) {
  const c = request.connection, previous = checkSelected(raw, c) ?? {}
  const models = isObject(previous['models']) ? previous['models'] : {}
  const candidate = models[request.model.id]
  const oldModel = isObject(candidate) ? candidate : {}
  const { id, name: _name, ...limits } = request.model
  if (isObject(auth) && auth['ttlSeconds'] === undefined && isObject(previous['auth']) && previous['auth']['ttlSeconds'] !== undefined) auth = { ...auth, ttlSeconds: previous['auth']['ttlSeconds'] }
  const provider = { ...previous, kind: c.kind, baseUrl: c.baseUrl, ...(c.allowHttp ? { allowHttp: true } : {}), auth,
    ...(headers === undefined && c.auth.kind !== 'chatgpt' ? {} : { headers: Object.fromEntries(Object.entries({ ...(isObject(previous['headers']) ? previous['headers'] : {}), ...headers }).filter(([k, v]) => v !== undefined && (c.auth.kind !== 'chatgpt' || k.toLowerCase() !== 'user-agent'))) }),
    models: { ...models, [id]: { ...oldModel, ...limits } } }
  const target = `${c.provider}/${id}`
  const aliases = isObject(raw['aliases']) ? raw['aliases'] : {}
  const alias = request.alias === undefined ? undefined : aliases[request.alias]
  if (alias !== undefined && alias !== target && (!isObject(alias) || alias['target'] !== target)) throw new SetupError('config-conflict')
  const next = { ...raw, providers: { ...authProviders(raw), [c.provider]: provider }, ...(request.alias === undefined ? {} : { aliases: { ...aliases, [request.alias]: alias ?? target } }) }
  if (parseConfig(JSON.stringify(next)).config === undefined) throw new SetupError('invalid-config')
  return { next, provider, target }
}
export function saveSetupConfig(io: Pick<Ports, 'pid' | 'alive' | 'now'>, path: string, request: SaveRequest, auth: unknown, headers?: Record<string, string | undefined>, retryApplied = false): string {
  const location = configLocation(path), lock = fileLock(`${location.target}.locks`, 'auth-config')
  if (acquire(io, lock) !== true) throw new SetupError('config-conflict')
  try {
    const current = configLocation(path)
    if (current.target !== location.target || current.root !== location.root) throw new SetupError('config-conflict')
    const priorText = readFileIfPresent(current.target)
    const raw = configFrom(priorText)
    existingSource(raw, request.connection)
    const result = patch(raw, request, auth, headers)
    if (revisionOf(authProviders(raw)[request.connection.provider]) !== request.expectedRevision) {
      if (!retryApplied || JSON.stringify(authProviders(raw)[request.connection.provider]) !== JSON.stringify(result.provider)) throw new SetupError('config-conflict')
    }
    const text = `${JSON.stringify(result.next, null, 2)}\n`
    if (priorText !== text) {
      const tmp = `${current.target}.${io.pid}.${randomBytes(8).toString('hex')}.tmp`
      let created = false
      try {
        const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, current.mode)
        created = true
        try { fchmodSync(fd, current.mode); writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
        if (configLocation(path).target !== current.target || readFileIfPresent(current.target) !== priorText) throw new SetupError('config-conflict')
        if (current.exists) renameSync(tmp, current.target)
        else linkSync(tmp, current.target)
        const dir = openSync(dirname(current.target), constants.O_RDONLY | constants.O_DIRECTORY)
        try { fsyncSync(dir) } finally { closeSync(dir) }
      } finally { if (created) { try { unlinkSync(tmp) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } } }
    }
    const readback = readFileIfPresent(current.target)
    if (readback !== text || parseConfig(readback).config === undefined) throw new SetupError('save-failed')
    return result.target
  } finally { lock.release() }
}
function readFileIfPresent(path: string): string | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { if (!fstatSync(fd).isFile() || fstatSync(fd).uid !== process.getuid!()) throw new Error('not a file'); return readFileSync(fd, 'utf8') } finally { closeSync(fd) }
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
