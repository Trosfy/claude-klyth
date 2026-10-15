// One private, credential-generation-bound setup handoff per provider.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { isObject } from '../hooks/config'
import { knownClient, knownMethod } from '../hooks/extra-client'
import type { SavedCredential } from './auth-operation'
import type { ChatGptIo } from './chatgpt'
import type { ExtraClientId } from './extras'
import { inPrivateDirectory, readPrivate, syncDirectory } from './private-file'
import { configLocation, SetupError } from './setup-config'

export type PendingCredential = SavedCredential & { version: 1; root: string; target: string; handle: string; expiresAt: number; consumed: boolean }
const HASH = /^[a-f0-9]{64}$/
const HANDLE = /^[a-f0-9]{32}$/
function valid(v: unknown, io: Pick<ChatGptIo, 'extraSignIn'>): v is PendingCredential {
  if (!isObject(v) || Object.keys(v).some(k => !['provider', 'method', 'clientId', 'fingerprint', 'headers', 'version', 'root', 'target', 'handle', 'expiresAt', 'consumed'].includes(k))) return false
  if (v['version'] !== 1 || typeof v['provider'] !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(v['provider']) || v['provider'] === 'native' || !knownMethod(io.extraSignIn?.client, v['method'])) return false
  if (typeof v['clientId'] !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7b\x7d\x7e]{1,256}$/.test(v['clientId']) || typeof v['fingerprint'] !== 'string' || !HASH.test(v['fingerprint']) || typeof v['handle'] !== 'string' || !HANDLE.test(v['handle'])) return false
  if (typeof v['root'] !== 'string' || !v['root'].startsWith('/') || typeof v['target'] !== 'string' || !v['target'].startsWith('/') || typeof v['expiresAt'] !== 'number' || !Number.isSafeInteger(v['expiresAt']) || typeof v['consumed'] !== 'boolean') return false
  if (v['headers'] !== undefined && (!isObject(v['headers']) || Object.entries(v['headers']).some(([k, value]) => !io.extraSignIn?.headerKeys.includes(k) || typeof value !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(value)))) return false
  return v['method'] === io.extraSignIn?.client.method || v['headers'] === undefined
}
function writeSlot(provider: string, record: PendingCredential): void {
  const name = `${provider}.json`, temporary = `${provider}.pending`
  try { readPrivate(name, 8192) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  try {
    const s = lstatSync(temporary)
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o777) !== 0o600) throw new Error('unsafe pending slot')
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.uid !== process.getuid!() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1) throw new Error('unsafe pending slot')
    fchmodSync(fd, 0o600)
    // Opening without truncation allows the ownership checks to finish before mutation.
    const text = JSON.stringify(record)
    writeFileSync(fd, text)
    ftruncateSync(fd, Buffer.byteLength(text))
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temporary, name)
  syncDirectory()
}
export function publishPending(io: Pick<ChatGptIo, 'configPath' | 'random' | 'now' | 'extraSignIn'>, saved: SavedCredential): PendingCredential {
  const location = configLocation(io.configPath)
  const record: PendingCredential = { ...saved, ...(saved.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(saved.headers).filter(([, v]) => v !== undefined)) }), version: 1, root: location.root, target: location.target, handle: Buffer.from(io.random(16)).toString('hex'), expiresAt: io.now() + 15 * 60_000, consumed: false }
  if (!valid(record, io)) throw new SetupError('handoff-failed')
  inPrivateDirectory(location.root, ['klyth', 'setup'], () => writeSlot(saved.provider, record))
  return record
}
export function readPending(io: Pick<ChatGptIo, 'configPath' | 'now' | 'extraSignIn'>, provider: string, handle: string, client: 'official' | ExtraClientId): PendingCredential {
  try {
    if (!knownClient(io.extraSignIn?.client, client) || !/^[a-z][a-z0-9-]{0,31}$/.test(provider) || provider === 'native' || !HANDLE.test(handle)) throw new Error('invalid handoff')
    const location = configLocation(io.configPath)
    const record: unknown = inPrivateDirectory(location.root, ['klyth', 'setup'], () => JSON.parse(readPrivate(`${provider}.json`, 8192)), false)
    if (!valid(record, io) || record.provider !== provider || record.handle !== handle || record.root !== location.root || record.target !== location.target || record.expiresAt <= io.now() || record.method !== (client === 'official' ? 'v1' : io.extraSignIn?.client.method)) throw new Error('invalid handoff')
    return record
  } catch { throw new SetupError('credential-conflict') }
}
export function consumePending(io: Pick<ChatGptIo, 'configPath' | 'now' | 'extraSignIn'>, record: PendingCredential): void {
  const current = readPending(io, record.provider, record.handle, record.method === 'v1' ? 'official' : io.extraSignIn!.client.id as ExtraClientId)
  if (current.fingerprint !== record.fingerprint) throw new SetupError('credential-conflict')
  inPrivateDirectory(record.root, ['klyth', 'setup'], () => writeSlot(record.provider, { ...record, consumed: true }))
}
