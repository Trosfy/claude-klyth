import { expect, test } from 'bun:test'
import { fingerprint, parseConfig } from '../hooks/config'
import { activateUsageSession, createUsageEnvelope, interruptPending, reduceUsage } from '../hooks/usage-ledger'
import type { PendingUsage, UsageEnvelope, UsagePurpose, UsageSnapshot, UsageToken } from '../hooks/usage-ledger'
import { emptyUsageTotals, jsonBytes, validateUsageEnvelope } from '../hooks/usage-ledger-codec'
import { finalEvidence, partitionedUsage, validateUsageSummary } from '../hooks/usage-evidence'
import type { UsageExecutionSummary } from '../hooks/usage-evidence'
import { createUsageLifetime, UsageOwnershipConflict } from '../hooks/usage-lifetime'
import type { UsagePort } from '../hooks/usage-lifetime'
import { usageText, usageView } from '../hooks/usage-view'
import { createStepper } from './step'

const executionId = (sequence: number) => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
const pricing = { currency: 'USD' as const, perMillionTokens: { input: 1, output: 1 } }
const fields = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }
const evidence = finalEvidence(partitionedUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'anthropic', fields))

function admit(envelope: UsageEnvelope, sequence: number, snapshot: UsageSnapshot, purpose: UsagePurpose = 'step', owner: 'main' | 'child' = 'main') {
  const token: UsageToken = { id: `${envelope.activeSessionId}:${envelope.ownerGeneration}:${sequence}`, sessionId: envelope.activeSessionId, generation: envelope.ownerGeneration, sequence }
  const pending: PendingUsage = { requestId: token.id, sessionId: token.sessionId, generation: token.generation, sequence, purpose, owner, target: snapshot.target, startedAt: 1000, executions: {} }
  let next = reduceUsage(envelope, { type: 'begin', pending })
  next = reduceUsage(next, { type: 'dispatch', token, executionId: executionId(sequence), snapshot })
  return { envelope: next, token }
}
function complete(envelope: UsageEnvelope, token: UsageToken) {
  const summary: UsageExecutionSummary = { type: 'usage_summary', requestId: token.id, executionId: executionId(token.sequence), outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence }] }
  const next = reduceUsage(envelope, { type: 'summary', token, summary })
  return reduceUsage(next, { type: 'settle', token, at: 2000 })
}
function hostPort(initial?: UsageEnvelope) {
  let state: unknown = initial
  let version = 10
  let stateFailure = false
  let storeFailure = false
  let stored: unknown
  let storeWrites = 0
  const logs: string[] = []
  const port: UsagePort = {
    sessionId: async () => initial?.activeSessionId ?? 'session', now: async () => 3000,
    state: async () => ({ value: state, version }),
    setState: async (value, ifVersion) => {
      if (ifVersion !== version) throw new UsageOwnershipConflict('stale owner')
      if (stateFailure) throw new Error('synthetic state capacity failure')
      state = structuredClone(value)
      return ++version
    },
    storeGet: async () => stored,
    storeSet: async (_key, value) => { storeWrites++; if (storeFailure) throw new Error('synthetic shared-store quota'); stored = structuredClone(value) },
    after: (_ms, _fn) => ({ cancel() {} }), context: async () => undefined, log: text => logs.push(text),
  }
  return { port, logs, get state() { return state }, get stored() { return stored }, get storeWrites() { return storeWrites }, failState() { stateFailure = true }, failStore() { storeFailure = true } }
}
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function observe(life: ReturnType<typeof createUsageLifetime>, sequence: number) {
  const id = life.observer.begin({ purpose: 'step', owner: 'main', target: 'p/a' })!
  life.observer.dispatch(id, executionId(sequence), { target: 'p/a', label: 'p/a', pricing })
  life.observer.summary(id, { type: 'usage_summary', requestId: id, executionId: executionId(sequence), outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence }] })
  life.observer.settle(id, 'complete')
}

async function producerCheckpoint(history: number) {
  const modelIds = Array.from({ length: history }, (_, index) => `${index + 1}${'x'.repeat(12)}`)
  const models = Object.fromEntries(modelIds.map(model => [model, { contextWindow: 10_000, maxOutputTokens: 1000, pricing }]))
  const configText = JSON.stringify({ providers: { p: { kind: 'anthropic', baseUrl: 'https://synthetic.invalid', auth: 'none', models } } })
  const provider = parseConfig(configText).config!.providers.p!
  const response = [
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  let sends = 0
  const stepper = createStepper({ version: '0.2.0',
    post: async () => { sends++; return { status: 200, body: (async function* () { yield new TextEncoder().encode(response); return undefined })(), cancel() {} } },
    run: async () => { throw new Error('no credential helper allowed') }, now: () => 1000, sleep: async () => {}, log: () => {},
  })
  let envelope = createUsageEnvelope('s', 1000)
  for (let sequence = 1; sequence <= history; sequence++) {
    const target = `p/${modelIds[sequence - 1]}`
    const admitted = admit(envelope, sequence, { target, label: target, pricing })
    envelope = admitted.envelope
    let summary: UsageExecutionSummary | undefined
    const wire = { token: 'synthetic', configText, approved: [fingerprint(provider)], accounting: { requestId: admitted.token.id, executionId: executionId(sequence) }, req: { target, system: 'not retained', transcript: [], tools: [], who: 'main', accounting: { purpose: 'step' as const, owner: 'main' as const } } }
    for await (const event of stepper.stepWithAccounting(wire, new AbortController().signal)) if (event.type === 'usage_summary') summary = validateUsageSummary(event)
    expect(summary).toBeDefined()
    envelope = reduceUsage(envelope, { type: 'summary', token: admitted.token, summary: summary! })
    envelope = reduceUsage(envelope, { type: 'settle', token: admitted.token, at: 2000 })
  }
  const pending: UsageToken[] = []
  const purposes: UsagePurpose[] = ['step', 'classifier', 'compaction']
  for (const purpose of purposes) for (const owner of ['main', 'child'] as const) {
    const sequence = history + pending.length + 1
    const target = `p/${sequence}`
    const admitted = admit(envelope, sequence, { target, label: target, pricing }, purpose, owner)
    envelope = admitted.envelope
    pending.push(admitted.token)
  }
  expect(sends).toBe(history)
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
  return { envelope, pending }
}

for (const history of [20, 249]) test(`real producer preserves ${history} measured requests through six terminal folds and repeated owner claims`, async () => {
  const { envelope, pending } = await producerCheckpoint(history)
  let settled = envelope
  for (const token of pending) settled = reduceUsage(settled, { type: 'settle', token, at: 3000 })
  const interrupted = interruptPending(envelope, 3000, 1)
  for (const result of [settled, interrupted]) {
    expect(Object.keys(result.sessions[0]!.pending)).toHaveLength(0)
    expect(result.sessions[0]!.completedAttempts).toBe(history)
    expect(result.sessions[0]!.costUsd).toBeCloseTo(history * 0.000002, 14)
    expect(result.sessions[0]!.unknownExecutions).toBe(6)
    expect(validateUsageEnvelope(result)).toEqual(result)
  }
  const host = hostPort(envelope)
  for (let claim = 0; claim < 3; claim++) {
    const life = createUsageLifetime()
    await life.start(host.port)
    expect(life.snapshot()!.sessions[0]!.completedAttempts).toBe(history)
    expect(life.snapshot()!.sessions[0]!.costUsd).toBeCloseTo(history * 0.000002, 14)
    expect(Object.keys(life.snapshot()!.sessions[0]!.pending)).toHaveLength(0)
    expect(validateUsageEnvelope(host.state)).toBeDefined()
  }
})

test('completed model accounting has no artificial row or session-byte cutoff', () => {
  let envelope = createUsageEnvelope('session-buckets', 1000)
  const measured = finalEvidence(partitionedUsage({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'anthropic', fields))
  for (let sequence = 1; sequence <= 257; sequence++) {
    const target = `acme/model-${sequence}`
    const admitted = admit(envelope, sequence, { target, label: 'fast', pricing })
    const summary: UsageExecutionSummary = { type: 'usage_summary', requestId: admitted.token.id, executionId: executionId(sequence), outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: measured }] }
    envelope = reduceUsage(admitted.envelope, { type: 'summary', token: admitted.token, summary })
    envelope = reduceUsage(envelope, { type: 'settle', token: admitted.token, at: 2000 })
  }
  const current = envelope.sessions[0]!
  expect(Object.keys(current.buckets)).toHaveLength(257)
  expect(current.overflow).toHaveLength(0)
  expect(current.unattributedAttempts).toBe(0)
  expect(current.warnings.trackingGap).toBe(false)
  expect(Math.abs(current.costUsd - 0.002827)).toBeLessThan(1e-15)
  expect(current.completedAttempts).toBe(257)
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
})

test('A to B to native to A, compaction and repeated rate edits keep stable canonical aggregates', async () => {
  let envelope = createUsageEnvelope('session', 1000)
  const dispatches = [
    { target: 'p/a', rate: 1, purpose: 'step' as const },
    { target: 'p/b', rate: 2, purpose: 'step' as const },
    { target: 'p/a', rate: 3, purpose: 'compaction' as const },
    { target: 'p/a', rate: 4, purpose: 'step' as const },
  ]
  for (const [index, dispatch] of dispatches.entries()) {
    // Native intervals make no observer call, and selecting the same session does not reset its usage.
    envelope = activateUsageSession(envelope, 'session', 2000)
    const admitted = admit(envelope, index + 1, { target: dispatch.target, label: dispatch.target, pricing: { currency: 'USD', perMillionTokens: { input: dispatch.rate, output: dispatch.rate } } }, dispatch.purpose)
    envelope = complete(admitted.envelope, admitted.token)
  }
  expect(envelope.sessions[0]!.costUsd).toBeCloseTo(0.00002, 14)
  for (let sequence = 5; sequence <= 1004; sequence++) {
    const admitted = admit(envelope, sequence, { target: 'p/a', label: 'alias', pricing: { currency: 'USD', perMillionTokens: { input: sequence, output: 0 } } })
    envelope = complete(admitted.envelope, admitted.token)
  }
  const current = envelope.sessions[0]!
  expect(Object.keys(current.buckets)).toHaveLength(3)
  expect(Object.keys(current.pending)).toHaveLength(0)
  expect(current.logicalRequests).toBe(1004)
  expect(current.costUsd).toBeCloseTo(0.50452, 12)
  expect(jsonBytes(envelope)).toBeLessThan(6000)
  const view = usageView(current)
  expect(view.models).toHaveLength(2)
  expect(view.models[0]!.target).toBe('p/a')
  expect(view.models[0]!.requests).toBe(1003)
  expect(view.models[0]!.costUsd).toBeCloseTo(0.504516, 12)
  const lines = usageText(current)
  expect(lines[1]).toBe(`Estimated cost: ${view.estimatedCost}`)
  expect(lines.findIndex(line => line.startsWith('Estimated cost:'))).toBeLessThan(lines.findIndex(line => line.startsWith('Logical requests:')))
  expect(lines.join('\n')).not.toContain('rate snapshot')
  const host = hostPort(envelope)
  const reloaded = createUsageLifetime()
  await reloaded.start(host.port)
  expect(reloaded.snapshot()!.sessions[0]!.costUsd).toBeCloseTo(0.50452, 12)
  expect(usageView(reloaded.snapshot()!.sessions[0]!).models).toHaveLength(2)

})

test('v1 conversion merges computed historical dollars without repricing or adding session totals twice', () => {
  const fixture = createUsageEnvelope('session', 1000)
  const current = fixture.sessions[0]!
  current.logicalRequests = 2
  current.completedAttempts = 2
  current.costUsd = 0.00059
  current.hasKnownCost = true
  current.totals.totalInput.count = 40
  const bucket = { target: 'p/a', purpose: 'step', owner: 'main', requests: 1, executions: { success: 1, failure: 0, refused: 0, aborted: 0 }, attempts: 1, unknownExecutions: 0, cacheEligibleAttempts: 0, cacheInputTokens: 0, cacheReadTokens: 0, outcomes: { success: 1, httpError: 0, transportError: 0, responseError: 0, cut: 0, aborted: 0, unknown: 0 }, totals: emptyUsageTotals(), costUsd: 0.00025, hasKnownCost: true, costIncompleteAttempts: 0, fullyPricedAttempts: 1, arithmeticOverflow: false }
  bucket.totals.totalInput.count = 20
  const firstPricing = { currency: 'USD', perMillionTokens: { input: 900 } }
  const secondPricing = { currency: 'USD', perMillionTokens: { input: 1800 } }
  const legacy = { ...fixture, version: 1, sessions: [{ ...current, buckets: {
    [JSON.stringify(['p/a', 'step', 'main', firstPricing, null])]: { ...bucket, pricing: firstPricing },
    [JSON.stringify(['p/a', 'step', 'main', secondPricing, null])]: { ...bucket, pricing: secondPricing, costUsd: 0.00034 },
  } }] }
  const converted = validateUsageEnvelope(legacy)!
  expect(converted.version).toBe(2)
  expect(converted.sessions[0]!.costUsd).toBe(0.00059)
  expect(converted.sessions[0]!.totals).toEqual(current.totals)
  expect(Object.keys(converted.sessions[0]!.buckets)).toHaveLength(1)
  const merged = Object.values(converted.sessions[0]!.buckets)[0]!
  expect(merged.costUsd).toBe(0.00059)
  expect(merged.requests).toBe(2)
  expect(merged.totals.totalInput.count).toBe(40)
  expect(Object.hasOwn(merged, 'pricing')).toBe(false)
  expect(validateUsageEnvelope(converted)).toEqual(converted)
  expect(legacy.version).toBe(1)
})

test('storage capacity failure keeps new live requests, while a CAS conflict fences the old owner', async () => {
  const capacity = hostPort()
  const live = createUsageLifetime()
  await live.start(capacity.port)
  observe(live, 1)
  await turns()
  capacity.failState()
  observe(live, 2)
  await turns()
  observe(live, 3)
  await turns()
  expect(live.snapshot()!.sessions[0]!.completedAttempts).toBe(3)
  expect(live.snapshot()!.sessions[0]!.costUsd).toBeCloseTo(0.000006, 14)
  expect(Object.keys(live.snapshot()!.sessions[0]!.pending)).toHaveLength(0)
  expect(live.snapshot()!.sessions[0]!.warnings.persistenceFailure).toBe(true)
  expect(live.snapshot()!.sessions[0]!.warnings.trackingGap).toBe(false)
  const ownership = hostPort()
  const old = createUsageLifetime()
  await old.start(ownership.port)
  const fresh = createUsageLifetime()
  await fresh.start(ownership.port)
  observe(old, 4)
  await turns()
  expect(old.observer.begin({ purpose: 'step', owner: 'main', target: 'p/a' })).toBeUndefined()
  expect((ownership.state as UsageEnvelope).ownerGeneration).toBe(fresh.snapshot()!.ownerGeneration)
  expect((ownership.state as UsageEnvelope).sessions[0]!.completedAttempts).toBe(0)
})

test('shared store rejection warns without suppressing subsequent known cost', async () => {
  const host = hostPort()
  const life = createUsageLifetime()
  await life.start(host.port)
  observe(life, 1)
  host.failStore()
  await life.end(host.port)
  expect(host.storeWrites).toBe(1)
  await life.resume(host.port)
  observe(life, 2)
  await turns()
  expect(life.snapshot()!.sessions[0]!.completedAttempts).toBe(2)
  expect(life.snapshot()!.sessions[0]!.costUsd).toBeCloseTo(0.000004, 14)
  expect(life.snapshot()!.sessions[0]!.warnings.persistenceFailure).toBe(true)
  expect(usageText(life.snapshot()!.sessions[0]!).join('\n')).toContain('Checkpoint: Not saved')
})


test('a checkpoint larger than the shared host limit stays live and never reaches storeSet', async () => {
  const target = `p/${'x'.repeat(2_100_000)}`
  const admitted = admit(createUsageEnvelope('session', 1000), 1, { target, label: target, pricing })
  const envelope = complete(admitted.envelope, admitted.token)
  expect(jsonBytes(envelope)).toBeGreaterThan(4 * 1024 * 1024)
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
  const host = hostPort(envelope)
  const life = createUsageLifetime()
  await life.start(host.port)
  observe(life, 2)
  await life.end(host.port)
  expect(host.storeWrites).toBe(0)
  expect(life.snapshot()!.sessions[0]!.completedAttempts).toBe(2)
  expect(life.snapshot()!.sessions[0]!.costUsd).toBeCloseTo(0.000004, 14)
  expect(life.snapshot()!.sessions[0]!.warnings.persistenceFailure).toBe(true)
})

test('counter saturation never rolls back finalization and duplicate or late owner callbacks cannot charge it', () => {
  let envelope = createUsageEnvelope('session', 1000)
  envelope.sessions[0]!.completedAttempts = Number.MAX_SAFE_INTEGER
  envelope.sessions[0]!.logicalRequests = Number.MAX_SAFE_INTEGER
  const admitted = admit(envelope, 1, { target: 'p/a', label: 'p/a', pricing })
  envelope = complete(admitted.envelope, admitted.token)
  expect(envelope.sessions[0]!.completedAttempts).toBe(Number.MAX_SAFE_INTEGER)
  expect(envelope.sessions[0]!.costUsd).toBe(0.000002)
  expect(envelope.sessions[0]!.arithmeticOverflow).toBe(true)
  expect(Object.keys(envelope.sessions[0]!.pending)).toHaveLength(0)
  expect(validateUsageEnvelope(envelope)).toEqual(envelope)
  expect(reduceUsage(envelope, { type: 'settle', token: admitted.token, at: 3000 })).toBe(envelope)
  const newOwner = interruptPending(envelope, 3000, 1)
  expect(reduceUsage(newOwner, { type: 'dispatch', token: admitted.token, executionId: executionId(1), snapshot: { target: 'p/b', label: 'p/b', pricing } })).toBe(newOwner)
})

test('conflicting evidence remains provisional and cancellation retires its pending token once', () => {
  const admitted = admit(createUsageEnvelope('session', 1000), 1, { target: 'p/a', label: 'p/a', pricing })
  const summary: UsageExecutionSummary = { type: 'usage_summary', requestId: admitted.token.id, executionId: executionId(1), outcome: 'aborted', attempts: [{ sequence: 1, outcome: 'aborted', evidence }] }
  let envelope = reduceUsage(admitted.envelope, { type: 'summary', token: admitted.token, summary })
  envelope = reduceUsage(envelope, { type: 'summary', token: admitted.token, summary: { ...summary, outcome: 'success' } })
  envelope = reduceUsage(envelope, { type: 'settle', token: admitted.token, at: 3000 })
  const current = envelope.sessions[0]!
  expect(current.completedAttempts).toBe(1)
  expect(current.executions.aborted).toBe(1)
  expect(current.totals.totalInput.count).toBe(0)
  expect(current.totals.totalInput.partial).toBe(1)
  expect(current.costUsd).toBe(0)
  expect(current.hasKnownCost).toBe(false)
  expect(current.warnings.trackingGap).toBe(true)
  expect(Object.keys(current.pending)).toHaveLength(0)
  expect(reduceUsage(envelope, { type: 'settle', token: admitted.token, at: 3001 })).toBe(envelope)
})

test('successor claims retire interrupted callback metadata rather than accumulating completed token IDs', async () => {
  const host = hostPort()
  const life = createUsageLifetime()
  await life.start(host.port)
  for (let claim = 0; claim < 5; claim++) {
    for (let request = 0; request < 64; request++) expect(life.observer.begin({ purpose: 'step', owner: 'main', target: 'p/a' })).toBeDefined()
    await life.end(host.port)
    await life.start(host.port)
    expect(Object.keys(life.snapshot()!.sessions[0]!.pending)).toHaveLength(0)
  }
  observe(life, 1)
  expect(life.snapshot()!.sessions[0]!.completedAttempts).toBe(1)
  expect(life.snapshot()!.sessions[0]!.untrackedRequests).toBe(320)
})
