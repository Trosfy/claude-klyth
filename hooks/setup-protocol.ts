// The native setup/helper boundary: only nonsecret requests, bounded progress and configuration summaries.
import { isObject } from './config'
import { knownClient, verificationPage, type ExtraClient } from './extra-client'
import { extraClient } from './extras'
import type { ExtraClientId } from './extras'
import type { Kind } from './kinds'

// Changes to FAILURES require a protocol bump once helper binaries ship.
export const SETUP_PROTOCOL = 1
export const SETUP_FRAME_MAX = 64 * 1024
export type SetupModel = { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }
export type SetupProviderSummary = { id: string; kind: Kind; baseUrl: string; allowHttp: boolean; configuredAuth: boolean; revision: string; models: SetupModel[] }
export type SetupConnection = {
  provider: string
  kind: Kind
  baseUrl: string
  allowHttp: boolean
  auth: { kind: 'none' | 'keyring' } | { kind: 'existing'; provider: string; revision: string } | { kind: 'chatgpt'; client: 'official' | ExtraClientId; handle: string }
}
export type SetupRequest =
  | { version: 1; action: 'inspect' }
  | { version: 1; action: 'presence'; provider: string }
  | { version: 1; action: 'login'; provider: string; client: 'official' | ExtraClientId }
  | { version: 1; action: 'models'; connection: SetupConnection }
  | { version: 1; action: 'save'; connection: SetupConnection; expectedRevision: string | null; model: SetupModel; alias?: string }
export type SetupEvent =
  | { version: 1; type: 'inspection'; providers: SetupProviderSummary[]; aliases: string[] }
  | { version: 1; type: 'presence'; status: 'found' | 'missing' | 'unknown' | 'error' }
  | { version: 1; type: 'browser-challenge'; authorizeUrl: string; expiresAt: number }
  | { version: 1; type: 'device-challenge'; verificationUrl: string; userCode: string; expiresAt: number }
  | { version: 1; type: 'credentials-saved'; handle: string }
  | { version: 1; type: 'models'; models: SetupModel[] }
  | { version: 1; type: 'saved'; target: string }
  | { version: 1; type: 'failed'; code: SetupFailure }
  | { version: 1; type: 'done' }
export type SetupFailure = 'invalid-request' | 'invalid-config' | 'config-conflict' | 'credential-conflict' | 'keyring-unavailable' | 'auth-failed' | 'cancelled' | 'models-unavailable' | 'save-failed' | 'helper-failed' | 'handoff-failed' | 'policy-blocked' | 'extra-client-unavailable'

const ID = /^[a-z][a-z0-9-]{0,31}$/
const HASH = /^[a-f0-9]{64}$/
const HANDLE = /^[a-f0-9]{32}$/
const KINDS: readonly unknown[] = ['openai', 'openai-responses', 'anthropic', 'bedrock']
const FAILURES: readonly unknown[] = ['invalid-request', 'invalid-config', 'config-conflict', 'credential-conflict', 'keyring-unavailable', 'auth-failed', 'cancelled', 'models-unavailable', 'save-failed', 'helper-failed', 'handoff-failed', 'policy-blocked', 'extra-client-unavailable']
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\p{Cc}\p{Cf}]/u.test(v)
const id = (v: unknown): v is string => typeof v === 'string' && v !== 'native' && ID.test(v)
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k))
const client = (v: unknown) => knownClient(extraClient, v)
const revision = (v: unknown) => typeof v === 'string' && HASH.test(v)

function endpoint(v: unknown): v is string {
  if (!text(v, 2048)) return false
  try {
    const u = new URL(v)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' && u.search === '' && u.hash === ''
  } catch { return false }
}
function model(v: unknown): v is SetupModel {
  return isObject(v) && keys(v, ['id', 'name', 'contextWindow', 'maxOutputTokens']) && text(v['id']) &&
    (v['name'] === undefined || text(v['name'])) && (v['contextWindow'] === undefined || count(v['contextWindow'])) &&
    (v['maxOutputTokens'] === undefined || count(v['maxOutputTokens']))
}
const models = (v: unknown): v is SetupModel[] => Array.isArray(v) && v.length <= 100 && v.every(model) && new Set(v.map(m => m.id)).size === v.length
function connection(v: unknown): v is SetupConnection {
  if (!isObject(v) || !keys(v, ['provider', 'kind', 'baseUrl', 'allowHttp', 'auth']) || !id(v['provider']) || !KINDS.includes(v['kind']) || !endpoint(v['baseUrl']) || typeof v['allowHttp'] !== 'boolean') return false
  if (v['baseUrl'].startsWith('http:') && !v['allowHttp']) return false
  const a = v['auth']
  if (!isObject(a)) return false
  if (a['kind'] === 'none' || a['kind'] === 'keyring') return keys(a, ['kind'])
  if (a['kind'] === 'existing') return keys(a, ['kind', 'provider', 'revision']) && id(a['provider']) && revision(a['revision'])
  return a['kind'] === 'chatgpt' && keys(a, ['kind', 'client', 'handle']) && client(a['client']) && typeof a['handle'] === 'string' && HANDLE.test(a['handle'])
}

// The helper validates the operation before reaching a keyring, endpoint or file mutation.
export function setupRequest(v: unknown): SetupRequest | undefined {
  if (!isObject(v) || v['version'] !== SETUP_PROTOCOL) return undefined
  const a = v['action']
  const shape = (extra: string[]) => keys(v, ['version', 'action', ...extra])
  if (a === 'inspect' && shape([])) return v as SetupRequest
  if (a === 'presence' && shape(['provider']) && id(v['provider'])) return v as SetupRequest
  if (a === 'login' && shape(['provider', 'client']) && id(v['provider']) && client(v['client'])) return v as SetupRequest
  if (a === 'models' && shape(['connection']) && connection(v['connection'])) return v as SetupRequest
  if (a === 'save' && shape(['connection', 'expectedRevision', 'model', 'alias']) && connection(v['connection']) &&
    (v['expectedRevision'] === null || revision(v['expectedRevision'])) && model(v['model']) && count(v['model'].contextWindow) && count(v['model'].maxOutputTokens) &&
    (v['alias'] === undefined || (text(v['alias'], 64) && /^[a-z][a-z0-9.-]*$/.test(v['alias']) && !v['alias'].includes('..')))) return v as SetupRequest
  return undefined
}
function provider(v: unknown): v is SetupProviderSummary {
  return isObject(v) && keys(v, ['id', 'kind', 'baseUrl', 'allowHttp', 'configuredAuth', 'revision', 'models']) && id(v['id']) && KINDS.includes(v['kind']) &&
    endpoint(v['baseUrl']) && typeof v['allowHttp'] === 'boolean' && typeof v['configuredAuth'] === 'boolean' && revision(v['revision']) && models(v['models'])
}
function challengeUrl(v: unknown, path: string): boolean {
  if (!text(v, 8192)) return false
  try { const u = new URL(v); return u.origin === 'https://auth.openai.com' && u.pathname === path && u.username === '' && u.password === '' && u.hash === '' } catch { return false }
}
export function setupEvent(v: unknown, extra: ExtraClient | undefined = extraClient): SetupEvent | undefined {
  if (!isObject(v) || v['version'] !== SETUP_PROTOCOL) return undefined
  const t = v['type']
  const shape = (extra: string[]) => keys(v, ['version', 'type', ...extra])
  if (t === 'inspection' && shape(['providers', 'aliases']) && Array.isArray(v['aliases']) && v['aliases'].length <= 1000 && v['aliases'].every(a => text(a, 64)) && new Set(v['aliases']).size === v['aliases'].length && Array.isArray(v['providers']) && v['providers'].length <= 100 && v['providers'].every(provider) && new Set(v['providers'].map(p => p.id)).size === v['providers'].length) return v as SetupEvent
  if (t === 'presence' && shape(['status']) && ['found', 'missing', 'unknown', 'error'].includes(String(v['status']))) return v as SetupEvent
  if (t === 'browser-challenge' && shape(['authorizeUrl', 'expiresAt']) && challengeUrl(v['authorizeUrl'], '/api/accounts/authorize') && count(v['expiresAt'])) return v as SetupEvent
  if (t === 'device-challenge' && shape(['verificationUrl', 'userCode', 'expiresAt']) && verificationPage(extra, v['verificationUrl']) && text(v['userCode'], 64) && /^[A-Za-z0-9-]+$/.test(v['userCode']) && count(v['expiresAt'])) return v as SetupEvent
  if (t === 'credentials-saved' && shape(['handle']) && typeof v['handle'] === 'string' && HANDLE.test(v['handle'])) return v as SetupEvent
  if (t === 'models' && shape(['models']) && models(v['models'])) return v as SetupEvent
  if (t === 'saved' && shape(['target']) && text(v['target'], 600)) return v as SetupEvent
  if (t === 'failed' && shape(['code']) && FAILURES.includes(v['code'])) return v as SetupEvent
  if (t === 'done' && shape([])) return v as SetupEvent
  return undefined
}

// Process output arrives in arbitrary chunks; never pass unvalidated stdout/stderr into a native view.
export function setupFrames(emit: (event: SetupEvent) => void, extra: ExtraClient | undefined = extraClient) {
  let pending = '', total = 0
  return {
    feed(chunk: string) {
      if ((total += chunk.length) > 512 * 1024) throw new Error('setup output exceeded its bound')
      pending += chunk
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        if (at > SETUP_FRAME_MAX) throw new Error('setup frame exceeded its bound')
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        let event: SetupEvent | undefined
        try { event = setupEvent(JSON.parse(line), extra) } catch {}
        if (event === undefined) throw new Error('invalid setup event')
        emit(event)
      }
      if (pending.length > SETUP_FRAME_MAX) throw new Error('setup frame exceeded its bound')
    },
    end() { if (pending !== '') throw new Error('incomplete setup event') },
  }
}
