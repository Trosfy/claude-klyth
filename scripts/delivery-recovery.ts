// An append-only private journal. Exclusive numbered slots serialize capacity reservations without deletion.
import { recoveryParts } from '../hooks/product'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, opendirSync, readFileSync } from 'node:fs'
import { inPrivateDirectory, publishPrivate, readPrivate, syncDirectory } from './private-file'
import { validBackup, recoveryIdentity, type RecoveryBackup, type RecoveryRecord, type RecoveryRequest, type RecoveryReply, type RecoveryAttempt } from '../hooks/delivery-recovery'

const MAX_RECORDS = 128, MAX_BYTES = 8 * 1024 * 1024, MAX_BACKUP = 400 * 1024
// Reserved before forwarding a send: one outcome, one dismissal and eight bounded restore attempts.
const RECEIPT_RESERVE = 8192, MAX_ATTEMPTS = 8
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
const json = (value: unknown) => JSON.stringify(value) + '\n'
const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'
const collision = (err: unknown) => (err as NodeJS.ErrnoException).code === 'EEXIST'
const fields = (b: RecoveryBackup) => JSON.stringify([b.sessionId, b.sender, b.toolUseId, b.recipient, b.address, b.text])
function recordId(session: string, sender: string, call: string): string { return hash(JSON.stringify([session, sender, call])) }
function readJson(name: string, bound: number): unknown { return JSON.parse(readPrivate(name, bound)) }
function optional(name: string): unknown {
  try { return readJson(name, 512) } catch (err) { if (missing(err)) return undefined; throw err }
}
function receipt(name: string, data: unknown): void {
  const text = json(data)
  if (bytes(text) > 512) throw new Error('receipt bounds exceeded')
  publishPrivate(`${name}.json`, text)
}
function evidence(name: string): unknown {
  // A completed pending file is recovery evidence even if publication was interrupted.
  return optional(`${name}.json`) ?? optional(`${name}.pending`)
}
function entries(limit: number): string[] {
  const dir = opendirSync('.'), names: string[] = []
  try {
    for (let item = dir.readSync(); item !== null; item = dir.readSync()) {
      if (names.length >= limit) throw new Error('private directory listing bound exceeded')
      names.push(item.name)
    }
    return names
  } finally { dir.closeSync() }
}
function ledger(): { backup: RecoveryBackup; size: number; name: string }[] {
  const names = entries(MAX_RECORDS * 3).filter(name => /^slot-[0-9]+\.(pending|json)$/.test(name))
  if (names.length > MAX_RECORDS * 2) throw new Error('recovery listing bound exceeded')
  const slots = [...new Set(names.map(name => Number(name.match(/^slot-([0-9]+)/)![1])))].sort((a, b) => a - b)
  if (slots.length > MAX_RECORDS || slots.some((slot, index) => slot !== index)) throw new Error('invalid recovery reservation sequence')
  return slots.map(slot => {
    const name = `slot-${slot}.${existsSync(`slot-${slot}.json`) ? 'json' : 'pending'}`
    const text = readPrivate(name, MAX_BACKUP), backup: unknown = JSON.parse(text)
    if (!validBackup(backup) || backup.id !== recordId(backup.sessionId, backup.sender, backup.toolUseId) || bytes(backup.text) > 65_536) throw new Error('corrupt recovery backup')
    return { backup, size: bytes(text) + RECEIPT_RESERVE, name }
  })
}
type Receipt = { kind: 'outcome'; outcome: RecoveryRecord['outcome'] }
  | { kind: 'claim'; token: string; epoch: string }
  | { kind: 'finish'; token: string; status: 'refused' | 'restored'; uuid?: string }
  | { kind: 'dismiss' }
function readRecord(b: RecoveryBackup): { record: RecoveryRecord; next: number } {
  const names = entries(37).filter(name => /^receipt-[0-9]+\.(json|pending)$/.test(name))
  const indices = [...new Set(names.map(name => Number(name.match(/^receipt-([0-9]+)/)![1])))].sort((a, b) => a - b)
  if (indices.length > 18 || indices.some((index, position) => index !== position)) throw new Error('invalid receipt sequence')
  let outcome: RecoveryRecord['outcome'] = 'unknown', observed = false, dismissed = false
  const attempts: RecoveryAttempt[] = []
  for (const index of indices) {
    const event = evidence(`receipt-${index}`) as Receipt
    if (!event || typeof event !== 'object') throw new Error('corrupt recovery receipt')
    if (event.kind === 'outcome') {
      if (observed || !['queued', 'refused', 'unknown'].includes(event.outcome)) throw new Error('corrupt send observation')
      observed = true; outcome = event.outcome
    } else if (event.kind === 'claim') {
      if (dismissed || attempts.some(attempt => attempt.status === 'restored') || attempts.length >= MAX_ATTEMPTS || !recoveryIdentity(event.token) || !recoveryIdentity(event.epoch)) throw new Error('corrupt restore claim')
      attempts.push({ number: attempts.length, token: event.token, epoch: event.epoch, status: 'unknown' })
    } else if (event.kind === 'finish') {
      const attempt = attempts[attempts.length - 1]
      if (!attempt || attempt.token !== event.token || attempt.status !== 'unknown' || !['refused', 'restored'].includes(event.status) || (event.status === 'restored' && (!event.uuid || !recoveryIdentity(event.uuid)))) throw new Error('corrupt restore receipt')
      attempt.status = event.status
      if (event.uuid !== undefined) attempt.uuid = event.uuid
    } else if (event.kind === 'dismiss') {
      if (dismissed || attempts.some(attempt => attempt.status === 'restored')) throw new Error('corrupt dismissal')
      dismissed = true
    } else throw new Error('unknown recovery receipt')
  }
  const state = { backup: b, outcome, dismissed, attempts }
  return { record: { ...state, revision: hash(JSON.stringify({ ...state, receiptCount: indices.length })) }, next: indices.length }
}
function withRecord<T>(configDir: string, b: RecoveryBackup, action: () => T): T {
  return inPrivateDirectory(configDir, recoveryParts(b.sessionId, b.recipient, b.id), action)
}
function canonical(configDir: string, b: RecoveryBackup, source: string): void {
  withRecord(configDir, b, () => {
    try { linkSync(source, 'backup.json'); syncDirectory() } catch (err) { if (!collision(err)) throw err }
    const existing = readJson('backup.json', MAX_BACKUP)
    if (!validBackup(existing) || fields(existing) !== fields(b)) throw new Error('conflicting recovery backup')
  })
}
export function recoveryStorage(input: RecoveryRequest & { configDir: string; sessionId: string }): RecoveryReply {
  const { configDir, sessionId } = input
  if (!recoveryIdentity(sessionId)) throw new Error('invalid recovery session')
  let entered = false
  try {
    return inPrivateDirectory(configDir, recoveryParts(sessionId), () => {
      entered = true
      const sessionDir = process.cwd()
      if (input.action === 'capture') {
        if (!recoveryIdentity(input.sender) || !recoveryIdentity(input.recipient) || typeof input.toolUseId !== 'string' || !input.toolUseId || input.toolUseId.length > 256 || typeof input.address !== 'string' || input.address.length > 128 || typeof input.text !== 'string' || !input.text || bytes(input.text) > 65_536) throw new Error('unsupported recovery payload')
        const b: RecoveryBackup = { version: 1, id: recordId(sessionId, input.sender, input.toolUseId), sessionId, sender: input.sender, recipient: input.recipient, toolUseId: input.toolUseId, address: input.address, text: input.text, capturedAt: new Date().toISOString() }
        const text = json(b), size = bytes(text) + RECEIPT_RESERVE
        for (let retry = 0; retry <= MAX_RECORDS; retry++) {
          const entries = ledger(), existing = entries.find(entry => entry.backup.id === b.id)
          if (entries.some(entry => entry.backup.sessionId !== sessionId)) throw new Error('wrong-session backup')
          if (existing) {
            if (fields(existing.backup) !== fields(b)) throw new Error('conflicting same-call backup')
            canonical(configDir, existing.backup, `${sessionDir}/${existing.name}`)
            return { id: b.id }
          }
          if (entries.length >= MAX_RECORDS || entries.reduce((sum, entry) => sum + entry.size, size) > MAX_BYTES) throw new Error('recovery session capacity reached; earlier backups retained')
          const name = `slot-${entries.length}.json`
          try { publishPrivate(name, text) } catch (err) { if (collision(err)) continue; throw err }
          canonical(configDir, b, `${sessionDir}/${name}`)
          return { id: b.id }
        }
        throw new Error('recovery reservation contention')
      }
      const entries = ledger()
      if (entries.some(entry => entry.backup.sessionId !== sessionId)) throw new Error('wrong-session backup')
      const selected = input.action === 'list' ? entries : entries.filter(entry => entry.backup.id === input.id)
      const records = selected.map(entry => {
        canonical(configDir, entry.backup, `${sessionDir}/${entry.name}`)
        return withRecord(configDir, entry.backup, () => readRecord(entry.backup).record)
      })
      if (input.action === 'list') return { records: records.map(record => ({ ...record, backup: { ...record.backup, text: '' } })) }
      if (!/^[a-f0-9]{64}$/.test(input.id)) throw new Error('invalid recovery id')
      const record = records.find(item => item.backup.id === input.id)
      if (!record) throw new Error('no current-session recovery record')
      if (input.action === 'get') return { record }
      return withRecord(configDir, record.backup, () => {
        // All transitions reserve the next immutable receipt slot. A competing state change wins that slot,
        // invalidating a reviewed restore/dismiss rather than racing a separate claim file.
        for (let retry = 0; retry < 19; retry++) {
          const { record: current, next } = readRecord(record.backup)
          let event: Receipt
          if (input.action === 'outcome') {
            if (!['queued', 'refused', 'unknown'].includes(input.outcome)) throw new Error('invalid send observation')
            const old = Array.from({ length: next }, (_, index) => evidence(`receipt-${index}`) as Receipt).find(item => item.kind === 'outcome')
            if (old) { if (old.kind !== 'outcome' || old.outcome !== input.outcome) throw new Error('conflicting send observation'); return {} }
            event = { kind: 'outcome', outcome: input.outcome }
          } else if (input.action === 'finish') {
            const attempt = current.attempts[current.attempts.length - 1]
            if (!attempt || attempt.token !== input.token || attempt.status !== 'unknown') throw new Error('restore attempt changed')
            if (!['refused', 'restored'].includes(input.status) || (input.status === 'restored' && (!input.uuid || !recoveryIdentity(input.uuid)))) throw new Error('invalid restore result')
            event = { kind: 'finish', token: input.token, status: input.status, ...(input.uuid === undefined ? {} : { uuid: input.uuid }) }
          } else {
            if (current.revision !== input.revision || current.dismissed || current.attempts.some(attempt => attempt.status === 'restored')) throw new Error('recovery state changed; review again')
            if (input.action === 'dismiss') event = { kind: 'dismiss' }
            else {
              if (!recoveryIdentity(input.epoch) || current.attempts.length >= MAX_ATTEMPTS) throw new Error('restore attempt bounds exceeded')
              const last = current.attempts[current.attempts.length - 1]
              if (last?.status === 'unknown' && last.epoch === input.epoch) throw new Error('restore attempt still active or uncertain in this host lifetime')
              event = { kind: 'claim', token: randomUUID(), epoch: input.epoch }
            }
          }
          if (next >= 18) throw new Error('receipt capacity reached')
          try { receipt(`receipt-${next}`, event) }
          catch (err) {
            if (!collision(err) || input.action === 'claim' || input.action === 'dismiss') throw err
            continue
          }
          return event.kind === 'claim' ? { token: event.token } : {}
        }
        throw new Error('receipt contention')
      })
    }, input.action === 'capture')
  } catch (err) {
    if (input.action === 'list' && !entered && missing(err)) return { records: [] }
    throw err
  }
}

if ((import.meta as { main?: boolean }).main) {
  try { console.log(JSON.stringify(recoveryStorage(JSON.parse(readFileSync(0, 'utf8'))))) }
  catch { console.error('Private recovery journal unavailable, corrupt, full, or changed. Existing evidence is retained.'); process.exitCode = 1 }
}
