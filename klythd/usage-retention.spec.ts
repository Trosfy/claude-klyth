import { expect, test } from 'bun:test'
import { activateUsageSession, createUsageEnvelope, reduceUsage } from '../hooks/usage-ledger'
import { validateUsageEnvelope } from '../hooks/usage-ledger-codec'
import { createUsageLifetime } from '../hooks/usage-lifetime'
import type { UsagePort } from '../hooks/usage-lifetime'
import { applyUsageRetention, bindUsageTranscript, observeUsageTranscripts } from '../hooks/usage-retention'

const confirmedSession = () => {
  const envelope = bindUsageTranscript(createUsageEnvelope('old-session', 1000), 'old-session', '/synthetic/old-session.jsonl')
  return applyUsageRetention(envelope, [{ sessionId: 'old-session', path: '/synthetic/old-session.jsonl', exists: true }])
}

test('existing host transcripts retain usage regardless of age and session count', async () => {
  let envelope = confirmedSession()
  for (let session = 1; session <= 12; session++) envelope = activateUsageSession(envelope, `session-${session}`, 9_000_000_000)
  const paths: string[] = []
  const observations = await observeUsageTranscripts(envelope, async path => { paths.push(path); return true })
  const retained = applyUsageRetention(envelope, observations)
  expect(retained.sessions).toHaveLength(13)
  expect(retained.sessions.find(session => session.id === 'old-session')?.startedAt).toBe(1000)
  expect(paths).toEqual(['/synthetic/old-session.jsonl'])
  expect(validateUsageEnvelope(retained)).toEqual(retained)
})

test('only confirmed missing inactive transcripts without pending work retire their usage records', async () => {
  const bound = confirmedSession()
  const token = { id: 'old-session:1:1', sessionId: 'old-session', generation: 1, sequence: 1 }
  const pending = reduceUsage(bound, { type: 'begin', pending: { requestId: token.id, sessionId: token.sessionId, generation: 1, sequence: 1, target: 'p/a', purpose: 'step', owner: 'main', startedAt: 1000, executions: {} } })
  const inactivePending = activateUsageSession(pending, 'new-session', 2000)
  const missing = await observeUsageTranscripts(inactivePending, async () => false)
  expect(applyUsageRetention(inactivePending, missing).sessions).toHaveLength(2)
  const settled = reduceUsage(inactivePending, { type: 'settle', token, at: 3000 })
  const retired = applyUsageRetention(settled, missing)
  expect(retired.sessions.map(session => session.id)).toEqual(['new-session'])
  expect(retired.activeSessionId).toBe('new-session')
  expect(validateUsageEnvelope(retired)).toEqual(retired)
  expect(applyUsageRetention(bound, missing).sessions).toHaveLength(1)
})

test('new paths, unbound records and filesystem errors are not evidence of deletion', async () => {
  const bound = bindUsageTranscript(createUsageEnvelope('old-session', 1000), 'old-session', '/synthetic/not-written-yet.jsonl')
  const inactive = activateUsageSession(bound, 'new-session', 2000)
  const missing = await observeUsageTranscripts(inactive, async () => false)
  expect(applyUsageRetention(inactive, missing).sessions).toHaveLength(2)
  const errors = await observeUsageTranscripts(activateUsageSession(confirmedSession(), 'new-session', 2000), async () => { throw new Error('unavailable host filesystem') })
  expect(errors).toEqual([])
  expect(applyUsageRetention(inactive, errors)).toBe(inactive)
  expect(bindUsageTranscript(inactive, 'old-session', '/synthetic/wrong-owner.jsonl')).toBe(inactive)
  expect(bindUsageTranscript(inactive, 'new-session', 'relative-path')).toBe(inactive)
})

test('lifecycle binds only the engine path, confirms it, and cleans missing inactive records on clear', async () => {
  let id = 'session-one'
  let value: unknown
  let version = 0
  const existing = new Set(['/synthetic/session-one.jsonl'])
  const checked: string[] = []
  const port: UsagePort = {
    sessionId: async () => id, now: async () => 1000,
    state: async () => ({ value, version }),
    setState: async (next, ifVersion) => { if (ifVersion !== version) throw new Error('unexpected CAS'); value = structuredClone(next); return ++version },
    storeGet: async () => undefined, storeSet: async () => {}, after: () => ({ cancel() {} }), context: async () => undefined, log: () => {},
    transcriptExists: async path => { checked.push(path); return existing.has(path) },
  }
  const life = createUsageLifetime()
  await life.start(port)
  await life.bindTranscript(port, 'session-one', '/synthetic/session-one.jsonl')
  expect(life.snapshot()!.sessions[0]!.transcript?.confirmed).toBe(true)
  // Compaction reuses the same identity and does not reset its binding or totals.
  await life.bindTranscript(port, 'session-one', '/synthetic/session-one.jsonl')
  expect(life.snapshot()!.activeSessionId).toBe('session-one')
  await life.end(port)
  id = 'session-two'
  value = undefined
  version = 0
  existing.clear()
  await life.resume(port)
  expect(life.snapshot()!.sessions.map(session => session.id)).toEqual(['session-two'])
  expect(checked).toEqual(['/synthetic/session-one.jsonl', '/synthetic/session-one.jsonl'])
})
