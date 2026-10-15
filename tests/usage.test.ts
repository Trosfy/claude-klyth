import { expect, test } from 'claude-code/testing'

import { finalEvidence, partitionedUsage } from '../hooks/usage-evidence'
import { createBackend } from '../hooks/backend'
import type { Host } from '../hooks/backend'
import { fingerprint, parseConfig } from '../hooks/config'
import { createUsageEnvelope, interruptPending, reduceUsage, usageTokenFor } from '../hooks/usage-ledger'
import { jsonBytes, validateUsageEnvelope } from '../hooks/usage-ledger-codec'
import type { PendingUsage, UsageEnvelope, UsagePurpose, UsageSnapshot, UsageToken } from '../hooks/usage-ledger'
import { createUsageLifetime, UsageOwnershipConflict } from '../hooks/usage-lifetime'
import type { UsagePort } from '../hooks/usage-lifetime'
import type { UsageExecutionSummary } from '../hooks/usage-evidence'
import { valueUsage } from '../hooks/pricing'
import { usageText } from '../hooks/usage-view'
import type { StepWire } from '../hooks/protocol'
import { createStepper } from '../klythd/step'
import { klyth, start, step, world } from './world'

const FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }
const measurement = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => finalEvidence(partitionedUsage({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }, 'anthropic', FIELDS))
const execId = (sequence: number) => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
const requestId = (sessionId: string, generation: number, sequence: number) => `${sessionId}:${generation}:${sequence}`
const pendingFor = (sessionId: string, sequence: number, purpose: UsagePurpose = 'step', owner: 'main' | 'child' = 'main'): PendingUsage => ({
  requestId: requestId(sessionId, 1, sequence), sessionId, generation: 1, sequence, purpose, owner, target: 'pending', startedAt: 1000, executions: {},
})
const snapshot = (target: string, pricing?: UsageSnapshot['pricing'], label = target, cache?: UsageSnapshot['cache']): UsageSnapshot => ({ target, label, ...(pricing === undefined ? {} : { pricing }), ...(cache === undefined ? {} : { cache }) })
function recorded(envelope: UsageEnvelope, sequence: number, evidence: ReturnType<typeof measurement>, price: UsageSnapshot['pricing'], target = 'acme/model-a', cache?: UsageSnapshot['cache'], outcome: UsageExecutionSummary['outcome'] = 'success', attemptOutcome: UsageExecutionSummary['attempts'][number]['outcome'] = 'success') {
  const pending = pendingFor(envelope.activeSessionId, sequence)
  let next = reduceUsage(envelope, { type: 'begin', pending })
  const token: UsageToken = { id: pending.requestId, sessionId: pending.sessionId, generation: pending.generation, sequence }
  const executionId = execId(sequence)
  next = reduceUsage(next, { type: 'dispatch', token, executionId, snapshot: snapshot(target, price, 'fast', cache) })
  const summary: UsageExecutionSummary = { type: 'usage_summary', requestId: token.id, executionId, outcome, attempts: [{ sequence: 1, outcome: attemptOutcome, evidence }] }
  next = reduceUsage(next, { type: 'summary', token, summary })
  return reduceUsage(next, { type: 'settle', token, at: 2000 })
}

const price = (rates: NonNullable<UsageSnapshot['pricing']>['perMillionTokens']) => ({ currency: 'USD' as const, perMillionTokens: rates })

test('partial category valuation keeps the known output subtotal separate from fully priceable attempts', () => {
  const start = createUsageEnvelope('session-a', 1000)
  const end = recorded(start, 1, measurement(20, 10), price({ output: 4 }))
  const current = end.sessions[0]!
  expect([current.costUsd, current.hasKnownCost, current.costFullyPricedAttempts, current.costIncompleteAttempts]).toEqual([0.00004, true, 0, 1])
  expect(usageText(current).join('\n')).toContain('Estimated cost: At least $0.00004. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
})

test('failed executions with final usage are priced, while successful executions without usage stay unpriced', () => {
  const failed = recorded(createUsageEnvelope('session-failed', 1000), 1, measurement(0, 5), price({ output: 4 }), 'acme/model-a', undefined, 'failure', 'responseError').sessions[0]!
  expect([failed.costUsd, failed.executions.failure, Object.values(failed.buckets)[0]?.outcomes.responseError, failed.costFullyPricedAttempts]).toEqual([0.00002, 1, 1, 1])
  const pending = pendingFor('session-success-no-usage', 1)
  let envelope = reduceUsage(createUsageEnvelope('session-success-no-usage', 1000), { type: 'begin', pending })
  const token = { id: pending.requestId, sessionId: pending.sessionId, generation: pending.generation, sequence: pending.sequence }
  const executionId = execId(1)
  envelope = reduceUsage(envelope, { type: 'dispatch', token, executionId, snapshot: snapshot('acme/model-a', price({ input: 1, output: 4 })) })
  envelope = reduceUsage(envelope, { type: 'summary', token, summary: { type: 'usage_summary', requestId: token.id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success' }] } })
  envelope = reduceUsage(envelope, { type: 'settle', token, at: 2000 })
  const success = envelope.sessions[0]!
  expect([success.executions.success, success.completedAttempts, success.missingUsageAttempts, success.costFullyPricedAttempts]).toEqual([1, 1, 1, 0])
})

test('dispatch-time rates preserve historical cost without creating price-history rows', () => {
  let envelope = createUsageEnvelope('session-rates', 1000)
  envelope = recorded(envelope, 1, measurement(10, 0), price({ input: 1 }))
  envelope = recorded(envelope, 2, measurement(10, 0), price({ input: 2 }))
  const current = envelope.sessions[0]!
  expect(Math.abs(current.costUsd - 0.00003) < 1e-18).toBe(true)
  expect([current.logicalRequests, Object.keys(current.buckets).length]).toEqual([2, 1])
  const report = usageText(current).join('\n')
  expect(report).toContain('$0.00003')
  expect(report).not.toContain('rate snapshot')
})

test('cache reuse is token weighted, and zero-token denominators stay unavailable', () => {
  let envelope = createUsageEnvelope('session-cache', 1000)
  envelope = recorded(envelope, 1, measurement(5, 1, 5), undefined)
  envelope = recorded(envelope, 2, measurement(30, 1, 0), undefined)
  expect([envelope.sessions[0]?.cacheReadTokens, envelope.sessions[0]?.cacheInputTokens, envelope.sessions[0]?.cacheEligibleAttempts]).toEqual([5, 40, 2])
  expect(usageText(envelope.sessions[0]!).join('\n')).toContain('Input tokens from cache: 12.5%. 5 of 40 input tokens came from cache across 2 provider calls.')
  const empty = recorded(createUsageEnvelope('session-empty', 1000), 1, measurement(0, 0), undefined)
  expect(usageText(empty.sessions[0]!).join('\n')).toContain('Input tokens from cache: Not available. 1 provider call reported zero input tokens.')
})

test('cache-read pricing has an independent positive-token oracle', () => {
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 }, 'anthropic', FIELDS))
  expect(valueUsage(evidence, price({ cacheRead: 0.5 }))).toEqual({ value: 0.00004, hasKnown: true, complete: true, overflow: false })
})

test('scalar cache-write pricing has an independent aggregate-write oracle', () => {
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 40 }, 'anthropic', FIELDS))
  expect(valueUsage(evidence, price({ cacheWrite: 3 }))).toEqual({ value: 0.00012, hasKnown: true, complete: true, overflow: false })
})

test('scalar pricing values every reported category once and does not add reasoning twice', () => {
  const fields = { ...FIELDS, reasoning: 'reasoning_tokens' }
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 40, reasoning_tokens: 7 }, 'anthropic', fields))
  expect(valueUsage(evidence, price({ input: 2, output: 5, cacheRead: 0.5, cacheWrite: 3 }))).toEqual({ value: 0.00025, hasKnown: true, complete: true, overflow: false })
})

test('observed mixed-TTL cache writes use their literal separate-rate oracle', () => {
  const fields = { ...FIELDS, cacheWrite5m: 'cache_creation_5m_input_tokens', cacheWrite1h: 'cache_creation_1h_input_tokens', reasoning: 'reasoning_tokens' }
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 40, cache_creation_5m_input_tokens: 10, cache_creation_1h_input_tokens: 30, reasoning_tokens: 7 }, 'anthropic', fields))
  expect(valueUsage(evidence, price({ input: 2, output: 5, cacheRead: 0.5, cacheWrite: { '5m': 3, '1h': 6 } }))).toEqual({ value: 0.00034, hasKnown: true, complete: true, overflow: false })
})

test('known zero counts need no rates, an explicit zero rate values positive usage, and unknown counts stay unidentified', () => {
  const zero = recorded(createUsageEnvelope('session-zero', 1000), 1, measurement(0, 0), undefined).sessions[0]!
  expect([zero.costUsd, zero.hasKnownCost, zero.costFullyPricedAttempts]).toEqual([0, true, 1])
  const free = recorded(createUsageEnvelope('session-free', 1000), 1, measurement(12, 0), price({ input: 0 })).sessions[0]!
  expect([free.costUsd, free.hasKnownCost, free.costFullyPricedAttempts]).toEqual([0, true, 1])
  let unknown = createUsageEnvelope('session-unknown', 1000)
  const pending = pendingFor('session-unknown', 1)
  unknown = reduceUsage(unknown, { type: 'begin', pending })
  const token = { id: pending.requestId, sessionId: pending.sessionId, generation: pending.generation, sequence: pending.sequence }
  const executionId = execId(1)
  unknown = reduceUsage(unknown, { type: 'dispatch', token, executionId, snapshot: snapshot('acme/model-a', price({ input: 0, output: 0 })) })
  unknown = reduceUsage(unknown, { type: 'summary', token, summary: { type: 'usage_summary', requestId: token.id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: finalEvidence(partitionedUsage({}, 'anthropic', FIELDS)) }] } })
  unknown = reduceUsage(unknown, { type: 'settle', token, at: 2000 })
  expect([unknown.sessions[0]?.costUsd, unknown.sessions[0]?.hasKnownCost, unknown.sessions[0]?.costFullyPricedAttempts]).toEqual([0, false, 0])
  expect(usageText(unknown.sessions[0]!).join('\n')).toContain('Estimated cost: Not available. Some token counts are missing. Run another request to check usage data.')
  const unpriced = recorded(createUsageEnvelope('session-unpriced', 1000), 1, measurement(12, 4, 2, 1), undefined).sessions[0]!
  expect([unpriced.hasKnownCost, unpriced.costIncompleteAttempts]).toEqual([false, 1])
  expect(usageText(unpriced).join('\n')).toContain('Estimated cost: Not available. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
})

test('a requested cache TTL does not identify the billed cache-write variant', () => {
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 }, 'anthropic', FIELDS))
  const current = recorded(createUsageEnvelope('session-ttl', 1000), 1, evidence, price({ cacheWrite: { '1h': 1 } }), 'acme/model-a', '1h').sessions[0]!
  expect([current.costUsd, current.hasKnownCost, current.costFullyPricedAttempts, current.costIncompleteAttempts]).toEqual([0, true, 0, 1])
  expect(usageText(current).join('\n')).toContain('Estimated cost: At least $0. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
})

test('duplicate, missing and old-generation terminal actions cannot add a request twice', () => {
  const start = createUsageEnvelope('session-dedup', 1000)
  const pending = pendingFor('session-dedup', 1)
  let envelope = reduceUsage(start, { type: 'begin', pending })
  const token = { id: pending.requestId, sessionId: pending.sessionId, generation: pending.generation, sequence: pending.sequence }
  const executionId = execId(1)
  envelope = reduceUsage(envelope, { type: 'dispatch', token, executionId, snapshot: snapshot('acme/model-a', price({ output: 4 })) })
  const summary: UsageExecutionSummary = { type: 'usage_summary', requestId: token.id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measurement(20, 10) }] }
  envelope = reduceUsage(envelope, { type: 'summary', token, summary })
  envelope = reduceUsage(envelope, { type: 'summary', token, summary })
  envelope = reduceUsage(envelope, { type: 'settle', token, at: 2000 })
  const settled = envelope
  envelope = reduceUsage(envelope, { type: 'settle', token, at: 2001 })
  expect(envelope).toEqual(settled)
  expect(envelope.sessions[0]?.logicalRequests).toBe(1)
  const interrupted = interruptPending(start, 2000, 1)
  const late = reduceUsage(interrupted, { type: 'summary', token, summary })
  expect(late).toBe(interrupted)
})

test('untrusted model identities stay complete in state and are escaped in text', () => {
  const target = 'acme/model\nforged\u0001'
  const envelope = recorded(createUsageEnvelope('session-identity', 1000), 1, measurement(0, 0), undefined, target)
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
  const report = usageText(envelope.sessions[0]!).join('\n')
  expect(report).toContain('acme/model\\u000aforged\\u0001')
  expect(report.split('\n').some(line => line.includes('forged\u0001'))).toBe(false)
})

test('pricing overflow stays finite and marks accumulated token totals partial', () => {
  const huge = Number.MAX_SAFE_INTEGER
  const evidence = measurement(0, huge)
  let envelope = recorded(createUsageEnvelope('session-overflow', 1000), 1, evidence, price({ output: Number.MAX_VALUE }))
  envelope = recorded(envelope, 2, evidence, price({ output: Number.MAX_VALUE }))
  const current = envelope.sessions[0]!
  expect(Number.isFinite(current.costUsd)).toBe(true)
  expect(current.arithmeticOverflow).toBe(true)
  expect(current.warnings.trackingGap).toBe(true)
  expect(usageText(current).join('\n')).toContain('Those totals are incomplete')
})

test('a refused daemon execution with no attempts stays distinct from zero cost', () => {
  const pending = pendingFor('session-refused', 1)
  const token = { id: pending.requestId, sessionId: pending.sessionId, generation: pending.generation, sequence: pending.sequence }
  const executionId = execId(1)
  let envelope = reduceUsage(createUsageEnvelope('session-refused', 1000), { type: 'begin', pending })
  envelope = reduceUsage(envelope, { type: 'dispatch', token, executionId, snapshot: snapshot('acme/model-a') })
  envelope = reduceUsage(envelope, { type: 'summary', token, summary: { type: 'usage_summary', requestId: token.id, executionId, outcome: 'refused', attempts: [] } })
  envelope = reduceUsage(envelope, { type: 'settle', token, at: 2000 })
  const session = envelope.sessions[0]!
  expect(session.executions.refused).toBe(1)
  expect(session.completedAttempts).toBe(0)
  expect(session.requestsWithoutExecution).toBe(0)
  expect(usageText(session).join('\n')).toContain('Runs: completed 0, failed 0, refused 1, stopped 0')
  expect(usageText(session).join('\n')).toContain('Estimated cost: Not available. No provider calls have usage data. Run another request through Klyth.')
  const refusedBeforeDaemon = pendingFor('session-host-refusal', 1)
  let noExecution = reduceUsage(createUsageEnvelope('session-host-refusal', 1000), { type: 'begin', pending: refusedBeforeDaemon })
  noExecution = reduceUsage(noExecution, { type: 'settle', token: { id: refusedBeforeDaemon.requestId, sessionId: refusedBeforeDaemon.sessionId, generation: 1, sequence: 1 }, at: 2000 })
  expect(noExecution.sessions[0]?.requestsWithoutExecution).toBe(1)
  expect(noExecution.sessions[0]?.unknownExecutions).toBe(0)
})

test('actual concurrency bounds pending admission without imposing completed-history limits', () => {
  let envelope = createUsageEnvelope('session-cap', 1000)
  for (let sequence = 1; sequence <= 64; sequence++) envelope = reduceUsage(envelope, { type: 'begin', pending: pendingFor('session-cap', sequence) })
  expect(Object.keys(envelope.sessions[0]!.pending)).toHaveLength(64)
  expect(usageTokenFor(envelope, 65)).toBeUndefined()
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
  const future = { ...envelope, version: 3 }
  expect(validateUsageEnvelope(future)).toBeUndefined()
})

test('overlapping dispatches beyond the former checkpoint limit retain every measured contribution', () => {
  const sessionId = 'session-byte-cap'
  let envelope = createUsageEnvelope(sessionId, 1000)
  const admit = (current: UsageEnvelope, sequence: number, target: string) => {
    const pending = { ...pendingFor(sessionId, sequence), target }
    const token: UsageToken = { id: pending.requestId, sessionId, generation: 1, sequence }
    return { envelope: reduceUsage(current, { type: 'begin', pending }), token }
  }
  for (let sequence = 1; sequence <= 140; sequence++) {
    const target = `p/${String(sequence).padStart(3, '0')}${'x'.repeat(480)}`
    const admitted = admit(envelope, sequence, target)
    envelope = reduceUsage(admitted.envelope, { type: 'dispatch', token: admitted.token, executionId: execId(sequence), snapshot: snapshot(target, price({ input: 1, output: 1 }), target) })
    envelope = reduceUsage(envelope, { type: 'summary', token: admitted.token, summary: { type: 'usage_summary', requestId: admitted.token.id, executionId: execId(sequence), outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measurement(10, 1) }] } })
    envelope = reduceUsage(envelope, { type: 'settle', token: admitted.token, at: 2000 })
  }
  const pending: UsageToken[] = []
  for (let sequence = 141; sequence <= 142; sequence++) {
    const target = `p/${String(sequence).padStart(3, '0')}${'y'.repeat(480)}`
    const admitted = admit(envelope, sequence, target)
    envelope = reduceUsage(admitted.envelope, { type: 'dispatch', token: admitted.token, executionId: execId(sequence), snapshot: snapshot(target, price({ input: 1, output: 1 }), target) })
    pending.push(admitted.token)
  }
  const lastTarget = `p/143${'y'.repeat(480)}`
  const last = admit(envelope, 143, lastTarget)
  envelope = last.envelope
  pending.push(last.token)
  const nearLimitBytes = jsonBytes(envelope.sessions[0])
  expect(Object.keys(envelope.sessions[0]!.pending)).toHaveLength(3)
  expect(nearLimitBytes).toBeGreaterThan(190_000)
  envelope = reduceUsage(envelope, { type: 'dispatch', token: last.token, executionId: execId(143), snapshot: snapshot(lastTarget, price({ input: 1, output: 1 }), lastTarget) })
  expect([Object.keys(envelope.sessions[0]!.pending).length, envelope.sessions[0]!.untrackedRequests]).toEqual([3, 0])
  for (const token of pending) {
    const summary: UsageExecutionSummary = {
      type: 'usage_summary', requestId: token.id, executionId: execId(token.sequence), outcome: 'success',
      attempts: Array.from({ length: 10 }, (_, index) => ({ sequence: index + 1, outcome: 'success', evidence: measurement(20, 10) })),
    }
    envelope = reduceUsage(envelope, { type: 'summary', token, summary })
  }
  for (const token of pending) envelope = reduceUsage(envelope, { type: 'settle', token, at: 3000 })
  const session = envelope.sessions[0]!
  expect([session.unknownExecutions, session.requestsWithoutExecution, session.untrackedRequests]).toEqual([0, 0, 0])
  expect(session.logicalRequests + session.untrackedRequests).toBe(143)
  expect(Object.keys(session.pending)).toHaveLength(0)
  expect(session.completedAttempts).toBe(170)
  expect(Math.abs(session.costUsd - 0.00244)).toBeLessThan(1e-15)
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
})

function fakePort() {
  let id = 'session-one'
  let stateValue: unknown
  let stateVersion = 0
  let blockWrites = false
  let releaseBlocked: (() => void) | undefined
  let blockedWrites = 0
  let storeUnavailable = false
  const timers: { fn: () => void; active: boolean }[] = []
  const store = new Map<string, unknown>()
  const commit = (value: UsageEnvelope, ifVersion: number) => {
    if (ifVersion !== stateVersion) throw new UsageOwnershipConflict('state CAS conflict')
    stateValue = structuredClone(value)
    stateVersion++
    return stateVersion
  }
  const port: UsagePort = {
    sessionId: async () => id,
    now: async () => 1000,
    state: async () => ({ value: stateValue, version: stateVersion }),
    setState: async (value, ifVersion) => {
      if (blockWrites) {
        blockWrites = false
        blockedWrites++
        return await new Promise<number>((resolve, reject) => { releaseBlocked = () => { try { resolve(commit(value, ifVersion)) } catch (error) { reject(error) } } })
      }
      return commit(value, ifVersion)
    },
    storeGet: async key => { if (storeUnavailable) throw new Error('store read failed'); return store.get(key) },
    storeSet: async (key, value) => { if (storeUnavailable) throw new Error('store write failed'); store.set(key, structuredClone(value)) },
    after: (_ms, fn) => { const timer = { fn, active: true }; timers.push(timer); return { cancel: () => { timer.active = false } } },
    context: async () => 42,
    log: () => {},
  }
  return {
    port,
    get state() { return stateValue as UsageEnvelope | undefined },
    get version() { return stateVersion },
    get blockedWrites() { return blockedWrites },
    setSession(value: string) { id = value },
    disposeState() { stateValue = undefined; stateVersion = 0 },
    loadState(value: unknown, version: number) { stateValue = value; stateVersion = version },
    failStore() { storeUnavailable = true },
    block() { blockWrites = true },
    unblock() { blockWrites = false; releaseBlocked?.(); releaseBlocked = undefined },
    expireTimers() { for (const timer of timers.splice(0)) if (timer.active) timer.fn() },
    store,
  }
}

test('memory-only checkpoint recovery folds summaries, interrupts dead pending work, and admits new work', async () => {
  let checkpoint = createUsageEnvelope('session-memory-only', 1000)
  for (let sequence = 1; sequence <= 64; sequence++) {
    const pending = pendingFor('session-memory-only', sequence)
    const token: UsageToken = { id: pending.requestId, sessionId: pending.sessionId, generation: pending.generation, sequence }
    const executionId = execId(sequence)
    checkpoint = reduceUsage(checkpoint, { type: 'begin', pending })
    checkpoint = reduceUsage(checkpoint, { type: 'dispatch', token, executionId, snapshot: snapshot('acme/model-a', price({ input: 1, output: 4 })) })
    checkpoint = reduceUsage(checkpoint, { type: 'summary', token, summary: { type: 'usage_summary', requestId: token.id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measurement(20, 10) }] } })
  }
  expect(validateUsageEnvelope(checkpoint)).toEqual(checkpoint)
  let stateWrites = 0
  let checkpointWrites = 0
  const port: UsagePort = {
    sessionId: async () => 'session-memory-only', now: async () => 2000,
    state: async () => { throw new Error('host-state read failed') },
    setState: async () => { stateWrites++; throw new Error('memory-only restore must not write host state') },
    storeGet: async () => checkpoint,
    storeSet: async () => { checkpointWrites++; throw new Error('memory-only restore must not write checkpoint') },
    after: (_ms, _fn) => ({ cancel: () => {} }), context: async () => 42, log: () => {},
  }
  const life = createUsageLifetime()
  await life.start(port)
  const admitted = life.observer.begin({ purpose: 'step', owner: 'main', target: 'acme/model-a' })
  const session = life.snapshot()!.sessions[0]!
  expect(admitted).toBe('session-memory-only:2:1')
  expect(Math.abs(session.costUsd - 0.00384)).toBeLessThan(1e-15)
  expect([session.completedAttempts, session.unknownExecutions, Object.keys(session.pending).length]).toEqual([64, 0, 1])
  expect([session.warnings.recovered, session.warnings.persistenceFailure, session.warnings.trackingGap]).toEqual([true, true, true])
  expect([stateWrites, checkpointWrites]).toEqual([0, 0])
  expect(validateUsageEnvelope(life.snapshot())).toBeDefined()
})

const waitForTurns = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const observeRequest = (life: ReturnType<typeof createUsageLifetime>, sequence: number, evidence: ReturnType<typeof measurement>) => {
  const id = life.observer.begin({ purpose: 'step', owner: 'main', target: 'fast' })
  if (id === undefined) throw new Error('request admission failed')
  const executionId = execId(sequence)
  life.observer.dispatch(id, executionId, { target: 'acme/model-a', label: 'fast', pricing: price({ output: 4 }) })
  life.observer.summary(id, { type: 'usage_summary', requestId: id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence }] })
  life.observer.settle(id, 'complete')
  return id
}

test('the shared observer accounts without waiting for host-state publication', async () => {
  const f = fakePort()
  const life = createUsageLifetime()
  await life.start(f.port)
  await waitForTurns()
  f.block()
  const started = performance.now()
  observeRequest(life, 1, measurement(20, 10))
  expect(performance.now() - started).toBeLessThan(50)
  expect(life.snapshot()?.sessions[0]?.costUsd).toBe(0.00004)
  expect(f.state?.sessions[0]?.logicalRequests ?? 0).toBe(0)
  f.unblock()
  await life.end(f.port)
})

test('warm clear reseeds a cleared state map and routes late evidence to its captured session', async () => {
  const f = fakePort()
  const life = createUsageLifetime()
  await life.start(f.port)
  const request = life.observer.begin({ purpose: 'step', owner: 'child', target: 'fast' })
  if (request === undefined) throw new Error('request admission failed')
  const executionId = execId(1)
  life.observer.dispatch(request, executionId, { target: 'acme/model-a', label: 'fast', pricing: price({ output: 4 }) })
  await waitForTurns()
  await life.end(f.port)
  f.setSession('session-two')
  f.disposeState()
  await life.resume(f.port)
  life.observer.summary(request, { type: 'usage_summary', requestId: request, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measurement(20, 10) }] })
  life.observer.settle(request, 'complete')
  life.observer.settle(request, 'complete')
  await waitForTurns()
  const state = life.snapshot()!
  expect(state.activeSessionId).toBe('session-two')
  expect(state.sessions.find(s => s.id === 'session-one')?.costUsd).toBe(0.00004)
  expect(state.sessions.find(s => s.id === 'session-two')?.logicalRequests).toBe(0)
  expect(state.sessions.find(s => s.id === 'session-two')?.warnings.trackingGap).toBe(false)
  expect(f.state?.activeSessionId).toBe('session-two')
})

test('late callbacks survive more than four sessions without changing the active session', async () => {
  const f = fakePort()
  const life = createUsageLifetime()
  await life.start(f.port)
  const request = life.observer.begin({ purpose: 'step', owner: 'child', target: 'fast' })
  if (request === undefined) throw new Error('request admission failed')
  const executionId = execId(1)
  life.observer.dispatch(request, executionId, { target: 'acme/model-a', label: 'fast' })
  await life.end(f.port)
  for (const id of ['session-two', 'session-three', 'session-four', 'session-five']) {
    f.setSession(id)
    f.disposeState()
    await life.resume(f.port)
    if (id !== 'session-five') await life.end(f.port)
  }
  life.observer.summary(request, { type: 'usage_summary', requestId: request, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measurement(20, 10) }] })
  life.observer.settle(request, 'complete')
  const state = life.snapshot()!
  expect(state.sessions).toHaveLength(5)
  expect(state.sessions.find(session => session.id === 'session-one')?.completedAttempts).toBe(1)
  expect(state.sessions.find(session => session.id === 'session-one')?.totals.totalInput.count).toBe(20)
  expect(state.sessions.find(session => session.id === 'session-five')?.warnings.trackingGap).toBe(false)
  expect(state.sessions.find(session => session.id === 'session-five')?.logicalRequests).toBe(0)
})

test('cold checkpoint recovery carries its warning and code reload interrupts old pending work once', async () => {
  const f = fakePort()
  const first = createUsageLifetime()
  await first.start(f.port)
  const request = first.observer.begin({ purpose: 'compaction', owner: 'main', target: 'fast' })
  if (request === undefined) throw new Error('request admission failed')
  const executionId = execId(1)
  first.observer.dispatch(request, executionId, { target: 'acme/model-a', label: 'fast' })
  await waitForTurns()
  await first.end(f.port)
  f.disposeState()
  const resumed = createUsageLifetime()
  await resumed.start(f.port)
  const session = resumed.snapshot()?.sessions[0]
  expect(session?.unknownExecutions).toBe(1)
  expect(session?.pending).toEqual({})
  expect(session?.warnings.recovered).toBe(true)
  expect(usageText(session!).join('\n')).toContain('Klyth read a saved usage record. Recent requests may be missing.')
  first.observer.summary(request, { type: 'usage_summary', requestId: request, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measurement(20, 10) }] })
  first.observer.settle(request, 'complete')
  await waitForTurns()
  expect(resumed.snapshot()?.sessions[0]?.unknownExecutions).toBe(1)
  expect(resumed.snapshot()?.sessions[0]?.costUsd).toBe(0)
})

test('a checkpoint without the current session starts a fresh observation window', async () => {
  const f = fakePort()
  const first = createUsageLifetime()
  await first.start(f.port)
  observeRequest(first, 1, measurement(20, 10))
  await first.end(f.port)
  f.setSession('session-new')
  f.disposeState()
  const resumed = createUsageLifetime()
  await resumed.start(f.port)
  const current = resumed.snapshot()?.sessions.find(s => s.id === 'session-new')
  expect(current?.logicalRequests).toBe(0)
  expect(current?.warnings.earlierUnavailable).toBe(true)
  expect(current?.warnings.recovered).toBe(false)
  expect(usageText(current!).join('\n')).toContain('This record excludes earlier usage. See Usage count start for the start time.')
})

test('future checkpoints and failed store writes remain visible without overwriting the stored value', async () => {
  const future = { version: 3, futureField: true }
  const corrupt = fakePort()
  corrupt.store.set('usage:v1', future)
  const memoryOnly = createUsageLifetime()
  await memoryOnly.start(corrupt.port)
  expect(corrupt.store.get('usage:v1')).toBe(future)
  expect(memoryOnly.snapshot()?.sessions[0]?.warnings.persistenceFailure).toBe(true)
  expect(usageText(memoryOnly.snapshot()!.sessions[0]!).join('\n')).toContain('Klyth could not save usage.')

  const failed = fakePort()
  const life = createUsageLifetime()
  await life.start(failed.port)
  observeRequest(life, 1, measurement(20, 10))
  failed.failStore()
  await life.end(failed.port)
  expect(life.snapshot()?.sessions[0]?.costUsd).toBe(0.00004)
  expect(life.snapshot()?.sessions[0]?.warnings.persistenceFailure).toBe(true)
  expect(usageText(life.snapshot()!.sessions[0]!).join('\n')).toContain('Klyth could not save usage.')
})

test('a blocked old CAS cannot overwrite a newer owner after its timeout', async () => {
  const f = fakePort()
  const old = createUsageLifetime()
  await old.start(f.port)
  f.block()
  observeRequest(old, 1, measurement(20, 10))
  const ending = old.end(f.port)
  await waitForTurns()
  expect(f.blockedWrites).toBeGreaterThan(0)
  f.expireTimers()
  await ending
  const fresh = createUsageLifetime()
  await fresh.start(f.port)
  const owner = fresh.snapshot()?.ownerGeneration
  f.unblock()
  await waitForTurns()
  expect(f.state?.ownerGeneration).toBe(owner)
  expect(fresh.snapshot()?.sessions[0]?.costUsd).toBe(0)
})

test('real backend sends after owner replacement but the interrupted request stays coverage-qualified', async () => {
  const f = fakePort()
  const old = createUsageLifetime()
  await old.start(f.port)
  await waitForTurns()
  let releaseLookup!: (result: Awaited<ReturnType<Host['run']>>) => void
  let enterLookup!: () => void
  const lookupEntered = new Promise<void>(resolve => { enterLookup = resolve })
  const lookup = new Promise<Awaited<ReturnType<Host['run']>>>(resolve => { releaseLookup = resolve })
  let sends = 0
  const stopDaemons: (() => void)[] = []
  const response = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  const stepper = createStepper({ version: '0.2.0',
    post: async () => {
      sends++
      return { status: 200, body: (async function* () { yield new TextEncoder().encode(response); return undefined })(), cancel: () => {} }
    },
    run: async () => { throw new Error('auth helper is not expected for auth:none') }, sleep: async () => {}, now: () => 1000, log: () => {},
  })
  const bunResult = { exitCode: 0, stdout: '/synthetic/bun\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  const host = (blocked: boolean): Host => ({
    root: '/synthetic', debug: () => {},
    run: async () => {
      if (blocked) { enterLookup(); return lookup }
      return bunResult
    },
    sleep: (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    spawn: request => (async function* () {
      if (request.argv[0] === '/synthetic/bun') {
        yield { stream: 'stdout', text: 'ready /synthetic/socket token\n' }
        await new Promise<void>(resolve => { stopDaemons.push(resolve) })
        return { code: 0, signal: null }
      }
      const wire = JSON.parse(request.input ?? '{}') as StepWire
      for await (const event of stepper.stepWithAccounting(wire, new AbortController().signal)) yield { stream: 'stdout', text: `${JSON.stringify(event)}\n` }
      return { code: 0, signal: null }
    })(),
  })
  const configText = JSON.stringify({ providers: { p: { kind: 'openai', auth: 'none', baseUrl: 'https://synthetic.invalid/v1', models: { m: { contextWindow: 10_000, maxOutputTokens: 1000, pricing: { currency: 'USD', perMillionTokens: { input: 1, output: 4 } } } } } } })
  const config = parseConfig(configText).config!
  const approved = [fingerprint(config.providers['p']!)]
  const request = { target: 'p/m', system: 'synthetic', transcript: [], tools: [], who: 'main', accounting: { purpose: 'step' as const, owner: 'main' as const } }
  const oldBackend = createBackend(old.observer)(host(true))
  await oldBackend.configure({ configText, approved })
  const oldIterator = oldBackend.step(request, new AbortController().signal)[Symbol.asyncIterator]()
  const first = oldIterator.next()
  await lookupEntered
  await waitForTurns()
  expect(Object.keys(f.state?.sessions[0]?.pending ?? {})).toHaveLength(1)

  const fresh = createUsageLifetime()
  await fresh.start(f.port)
  releaseLookup(bunResult)
  let chunk = await first
  while (!chunk.done) chunk = await oldIterator.next()
  await waitForTurns()

  const currentBackend = createBackend(fresh.observer)(host(false))
  await currentBackend.configure({ configText, approved })
  for await (const _event of currentBackend.step(request, new AbortController().signal)) { /* consume the synthetic response */ }
  await waitForTurns()
  const current = fresh.snapshot()!.sessions[0]!
  const report = (await fresh.text(f.port)).join('\n')
  expect([sends, current.completedAttempts, current.unknownExecutions, current.requestsWithoutExecution, current.untrackedRequests]).toEqual([2, 1, 0, 0, 1])
  expect(current.warnings.trackingGap).toBe(true)
  expect(report).toContain('Estimated cost: At least $0.00006. Some usage data is missing. Open Session details.')
  expect(report).toContain('Provider calls with complete cost estimates: 1 of 1')
  await fresh.end(f.port)
  for (const stop of stopDaemons) stop()
})

test('usage text reads local totals and makes no additional provider request', async ($, on) => {
  const w = world(on, { routes: { child1: { target: 'acme/model-a', label: 'fast' } } })
  await start($)
  await $.command.run({ command: 'model', args: 'fast', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($, { turnId: 'usage-turn', index: 0 })
  await step($, { turnId: 'child-turn', index: 0, agentId: 'child1' })
  const requests = w.requests.length
  const helperRuns = w.runs.filter(argv => argv[0] === '/usr/bin/security').length
  const wire = w.wires[0] as unknown as StepWire
  expect(wire.req.accounting).toEqual({ purpose: 'step', owner: 'main' })
  expect((w.wires[1] as unknown as StepWire).req.accounting).toEqual({ purpose: 'step', owner: 'child' })
  expect(wire.accounting).toMatchObject({ requestId: expect.any(String), executionId: expect.any(String) })
  expect(await klyth($, 'usage text')).toEqual({})
  expect(w.requests).toHaveLength(requests)
  expect(w.runs.filter(argv => argv[0] === '/usr/bin/security')).toHaveLength(helperRuns)
  expect(w.transcript.join('\n')).toContain('Klyth usage: routed work in this session')
  expect(w.transcript.join('\n')).toContain('Requests with records: 2')
  expect(w.transcript.join('\n')).toContain('Provider calls with input and output counts: 2 of 2')
  const before = w.transcript.length
  await klyth($, 'usage unexpected')
  expect(w.transcript.slice(before)).toEqual(['Use `/klyth usage` or `/klyth usage text`.'])
  expect(w.requests).toHaveLength(requests)
})
