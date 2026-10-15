// Auth-only config commits preserve unrelated changes and compare fields owned by the auth patch.
import { chmodSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isObject, parseConfig } from '../hooks/config'
import type { Ports } from './chatgpt'
import { acquire, fileLock } from './chatgpt'

export function readAuthConfig(path: string): Record<string, unknown> {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (e) { if ((e as { code?: string }).code === 'ENOENT') return {}; throw new Error('could not read config') }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('existing config is not valid JSON; nothing changed') }
  if (!isObject(raw)) throw new Error('existing config must be an object; nothing changed')
  return raw
}
export const authProviders = (config: Record<string, unknown>): Record<string, unknown> => isObject(config['providers']) ? config['providers'] : {}
export function validateAuthConfig(config: Record<string, unknown>, retiredProvider?: string): void {
  const normalized = { ...config, providers: Object.fromEntries(Object.entries(authProviders(config)).map(([id, p]) => {
    if (!isObject(p) || id !== retiredProvider) return [id, p]
    const { apiKeyEnv: _retired, ...rest } = p
    return [id, rest]
  })) }
  if (parseConfig(JSON.stringify(normalized)).config === undefined) throw new Error('existing config is invalid; fix it before --write-config')
}
export function commitAuthConfig(io: Pick<Ports, 'pid' | 'alive' | 'now'>, path: string, prior: Record<string, unknown>, id: string, command: readonly string[], ttl?: number, headers?: Record<string, string | undefined>): string {
  const target = realpathSync(path)
  const lock = fileLock(`${target}.locks`, 'auth-config')
  if (acquire(io, lock) !== true) throw new Error('config is busy; retry')
  try {
    if (realpathSync(path) !== target) throw new Error('config target changed; retry')
    const fresh = readAuthConfig(path)
    validateAuthConfig(fresh, id)
    const affected = (p: unknown) => isObject(p) ? [p['kind'], p['baseUrl'], p['auth'], p['apiKeyEnv'], isObject(p['headers']) ? Object.entries(p['headers']).filter(([k]) => k.toLowerCase() === 'user-agent') : [], headers === undefined ? undefined : Object.keys(headers).map(k => [k, isObject(p['headers']) ? p['headers'][k] : undefined])] : p
    const provider = authProviders(fresh)[id]
    if (!isObject(provider) || JSON.stringify(affected(provider)) !== JSON.stringify(affected(authProviders(prior)[id]))) throw new Error('selected provider changed while waiting; retry with fresh consent')
    const { apiKeyEnv: _retired, auth, ...rest } = provider
    const ttlSeconds = (isObject(auth) ? auth['ttlSeconds'] : undefined) ?? ttl
    const merged = headers === undefined && rest['headers'] === undefined ? {} : { headers: Object.fromEntries(Object.entries({ ...(isObject(rest['headers']) ? rest['headers'] : {}), ...headers }).filter(([k, v]) => k.toLowerCase() !== 'user-agent' && v !== undefined)) }
    const next = { ...fresh, providers: { ...authProviders(fresh), [id]: { ...rest, ...merged, auth: { command, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) } } } }
    validateAuthConfig(next)
    const text = `${JSON.stringify(next, null, 2)}\n`
    const tmp = `${target}.${io.pid}.tmp`
    const mode = statSync(target).mode & 0o777
    writeFileSync(tmp, text, { mode, flag: 'wx' })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
    if (readFileSync(target, 'utf8') !== text) throw new Error('config readback changed; check configuration')
    return target
  } finally { lock.release() }
}
