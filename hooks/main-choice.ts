// Main's explicit selection belongs to one engine session, not to the next conversation opened.
// The durable record contains identity checks only; provider approval remains a separate trust key.
import { fingerprint } from './config'
import { resolve } from './names'
import type { Session } from './session'

export type MainChoice = { version: 1; sessionId: string; label: string; target: string; provider: string } | { version: 1; sessionId: string; label: null }
export type MainChoicePort = {
  sessionId(): Promise<string>
  get(key: string): Promise<unknown>
  set(key: string, value: MainChoice): Promise<void>
  main(): Promise<string | null | undefined>
  setMain(target: string | null): Promise<void>
  toast(text: string): void
}
const BLOCKED = '!klyth-main-choice-blocked'
const bounded = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v)
export function mainChoiceKey(id: string): string {
  if (!bounded(id)) throw new Error('invalid engine session id')
  return `main-choice:v1:${id}`
}
async function providerIdentity(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('')
}
export async function choiceFor(s: Session, id: string, label: string | null): Promise<MainChoice> {
  mainChoiceKey(id)
  if (label === null) return { version: 1, sessionId: id, label: null }
  const t = s.loaded.config === undefined ? undefined : resolve(s.loaded.config, label)
  if (!bounded(label) || t?.kind !== 'remote' || !bounded(t.target)) throw new Error('selected model is not configured')
  return { version: 1, sessionId: id, label, target: t.target, provider: await providerIdentity(fingerprint(t.provider)) }
}
async function validChoice(s: Session, id: string, raw: unknown): Promise<MainChoice> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('invalid saved route record')
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || r.sessionId !== id || !(r.label === null || bounded(r.label))) throw new Error('invalid saved route version or session binding')
  const keys = r.label === null ? ['version', 'sessionId', 'label'] : ['version', 'sessionId', 'label', 'target', 'provider']
  if (Object.keys(r).length !== keys.length || Object.keys(r).some(k => !keys.includes(k))) throw new Error('invalid saved route fields')
  if (r.label !== null && (!bounded(r.target) || typeof r.provider !== 'string' || !/^[a-f0-9]{64}$/.test(r.provider))) throw new Error('invalid saved target or provider identity')
  const current = await choiceFor(s, id, r.label as string | null)
  if (current.label !== null && (r.target !== current.target || r.provider !== current.provider)) throw new Error('saved model or provider changed')
  return current
}
const enqueue = <T>(s: Session, fn: () => Promise<T>): Promise<T> => {
  const pending = s.mainChoiceQueue.then(fn)
  s.mainChoiceQueue = pending.then(() => undefined, () => undefined)
  return pending
}

// Called only by explicit selection. A rejected/full store cannot produce a successful route switch.
export function persistMainChoice(io: MainChoicePort, s: Session, label: string | null): Promise<void> {
  const revision = ++s.mainChoiceRevision
  const loaded = s.loaded
  const id = io.sessionId()
  return enqueue(s, async () => {
    const sessionId = await id
    const record = await choiceFor(s, sessionId, label)
    if (loaded !== s.loaded || revision !== s.mainChoiceRevision) throw new Error('route selection changed while saving')
    await io.set(mainChoiceKey(sessionId), record) // The public store rejects totals above 4 MiB; never evict another session.
    if (await io.sessionId() !== sessionId || loaded !== s.loaded || revision !== s.mainChoiceRevision) throw new Error('session changed while saving route')
    if (label !== null || (await io.main()) != null) await io.setMain(label)
    s.mainChoiceError = undefined
    s.mainChoiceSession = sessionId
  })
}

// Startup/resume/reload must finish restoration before automatic eligibility can inspect main.
export function restoreMainChoice(io: MainChoicePort, s: Session): Promise<void> {
  const revision = ++s.mainChoiceRevision
  const loaded = s.loaded
  const id = io.sessionId()
  return enqueue(s, async () => {
    let target: string | null = null
    let error: string | undefined
    const sessionId = await id
    try {
      const raw = await io.get(mainChoiceKey(sessionId))
      if (raw !== undefined) target = (await validChoice(s, sessionId, raw)).label
    } catch {
      target = BLOCKED
      error = 'klyth: saved main route could not be restored (invalid record, changed model/provider/config, or unavailable store). No native/provider fallback; fix config and /klyth reload, or explicitly select /model <target> or /model native/sonnet'
    }
    if (await io.sessionId() !== sessionId || loaded !== s.loaded || revision !== s.mainChoiceRevision) return
    if (s.mainChoiceSession !== sessionId) s.pin = null
    s.mainChoiceSession = sessionId
    s.mainChoiceError = error
    s.main = target
    if ((await io.main()) !== target && !(target === null && (await io.main()) === undefined)) await io.setMain(target)
    if (error !== undefined) io.toast(error)
  })
}
