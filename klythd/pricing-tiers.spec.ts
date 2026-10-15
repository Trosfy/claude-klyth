import { expect, test } from 'bun:test'
import { createBackend } from '../hooks/backend'
import { parseConfig } from '../hooks/config'
import { resolve } from '../hooks/names'
import { parsePricing, valueUsage } from '../hooks/pricing'
import type { Pricing } from '../hooks/pricing'
import { finalEvidence, partitionedUsage, reported, unknownMeasure } from '../hooks/usage-evidence'
import type { UsageEvidence, UsageExecutionSummary } from '../hooks/usage-evidence'
import { createUsageEnvelope, reduceUsage } from '../hooks/usage-ledger'
import type { UsageSnapshot, UsageToken } from '../hooks/usage-ledger'
import { validateUsageEnvelope } from '../hooks/usage-ledger-codec'
import type { StepWire } from '../hooks/protocol'
import { CODECS } from './codecs'

const rates = { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 2 }
const schedule: Pricing = { currency: 'USD', perMillionTokens: rates, tiers: [{ aboveInputTokens: 272000, perMillionTokens: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 6 } }] }
const fields = { input: 'input', output: 'output', cacheRead: 'read', cacheWrite: 'write', cacheWrite5m: 'short', cacheWrite1h: 'long', reasoning: 'reasoning' }
const evidence = (input: number, output = 0, read = 0, write = 0) => finalEvidence(partitionedUsage({ input, output, read, write }, 'anthropic', fields))
const configText = (pricing: unknown = schedule) => JSON.stringify({ providers: { p: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: 'none', models: { m: { contextWindow: 1000000, maxInputTokens: 872000, maxOutputTokens: 128000, maxTokensParam: 'max_completion_tokens', pricing } } } }, aliases: { fast: 'p/m', slow: 'p/m' } })
const executionId = '00000000-0000-4000-8000-000000000001'
const token: UsageToken = { id: 'session:1:1', sessionId: 'session', generation: 1, sequence: 1 }
function pendingEnvelope(pricing: unknown) {
  let state = createUsageEnvelope('session', 1000)
  state = reduceUsage(state, { type: 'begin', pending: { requestId: token.id, sessionId: token.sessionId, generation: 1, sequence: 1, purpose: 'step', owner: 'main', target: 'p/m', startedAt: 1000, executions: {} } })
  return reduceUsage(state, { type: 'dispatch', token, executionId, snapshot: { target: 'p/m', label: 'fast', pricing: pricing as Pricing } })
}

for (const [input, cost] of [[271999, 0.271999], [272000, 0.272], [272001, 0.544002]] as const) test(`strict whole-request boundary at ${input} input tokens`, () => {
  expect(valueUsage(evidence(input), schedule)).toEqual({ value: cost, hasKnown: true, complete: true, overflow: false })
})

test('cached reads and writes select the tier and each category uses its own whole-request rate', () => {
  // 200k uncached + 60k read + 12,001 write crosses 272k; output is charged once.
  const value = valueUsage(evidence(200000, 100, 60000, 12001), schedule)
  expect(value.value).toBeCloseTo(0.503206, 12)
  expect(value.complete).toBe(true)
})

test('output and reasoning do not select tiers or double-charge reasoning', () => {
  const usage = { ...evidence(10, 300000), reasoning: reported(290000) }
  expect(valueUsage(usage, schedule).value).toBeCloseTo(1.20001, 12)
})

test('highest strictly exceeded threshold replaces all rates, including partial and empty tables', () => {
  const pricing: Pricing = { ...schedule, tiers: [...schedule.tiers!, { aboveInputTokens: 300000, perMillionTokens: { output: 0.5 } }, { aboveInputTokens: 400000, perMillionTokens: {} }] }
  expect(valueUsage(evidence(300000, 100), pricing).value).toBeCloseTo(0.6012, 12)
  expect(valueUsage(evidence(300001, 100), pricing)).toEqual({ value: 0.00005, hasKnown: true, complete: false, overflow: false })
  expect(valueUsage(evidence(400001, 100), pricing)).toEqual({ value: 0, hasKnown: true, complete: false, overflow: false })
})

test('zero threshold, zero and fractional rates preserve observed TTL write pricing', () => {
  const usage = finalEvidence(partitionedUsage({ input: 1, output: 10, read: 20, write: 30, short: 10, long: 20, reasoning: 9 }, 'anthropic', fields))
  const pricing: Pricing = { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: { input: 0, output: 0.5, cacheRead: 0.25, cacheWrite: { '5m': 1.5, '1h': 3 } } }] }
  expect(valueUsage(usage, pricing)).toEqual({ value: 0.000085, hasKnown: true, complete: true, overflow: false })
  const unknownTtl = valueUsage(evidence(1, 10, 20, 30), pricing)
  expect(unknownTtl.value).toBe(0.00001)
  expect(unknownTtl.complete).toBe(false)
  expect(valueUsage(usage, { ...pricing, tiers: [{ aboveInputTokens: 0, perMillionTokens: { input: 0, output: 0.5, cacheRead: 0.25, cacheWrite: 2 } }] }).value).toBeCloseTo(0.00007, 12)
})

test('unknown total input never guesses a tier from input, output or requested cache policy', () => {
  const usage: UsageEvidence = { ...evidence(300000, 10, 20, 30), totalInput: unknownMeasure() }
  expect(valueUsage(usage, schedule)).toEqual({ value: 0, hasKnown: false, complete: false, overflow: false })
  expect(valueUsage({ ...usage, output: reported(0) }, schedule)).toEqual({ value: 0, hasKnown: true, complete: false, overflow: false })
  expect(valueUsage({ ...usage, input: unknownMeasure() }, schedule).hasKnown).toBe(false)
  expect(valueUsage(usage, { currency: 'USD', perMillionTokens: rates }).value).toBeCloseTo(0.300105, 12)
  expect(valueUsage(usage, { currency: 'USD', perMillionTokens: rates, tiers: [] }).value).toBeCloseTo(0.300105, 12)
  expect(valueUsage({ ...evidence(0), totalInput: unknownMeasure() }, schedule).complete).toBe(false)
})

test('provisional evidence has no priced contribution in valuation or completed aggregates', () => {
  const usage = { ...evidence(300000, 100), finality: 'provisional' as const }
  expect(valueUsage(usage, schedule)).toEqual({ value: 0, hasKnown: false, complete: false, overflow: false })
  let state = pendingEnvelope(schedule)
  state = reduceUsage(state, { type: 'summary', token, summary: { type: 'usage_summary', requestId: token.id, executionId, outcome: 'aborted', attempts: [{ sequence: 1, outcome: 'cut', evidence: usage }] } })
  state = reduceUsage(state, { type: 'settle', token, at: 2000 })
  expect(state.sessions[0]!.costUsd).toBe(0)
  expect(state.sessions[0]!.hasKnownCost).toBe(false)
  expect(state.sessions[0]!.costFullyPricedAttempts).toBe(0)
  expect(state.sessions[0]!.totals.totalInput.partial).toBe(300000)
  expect(state.sessions[0]!.pending).toEqual({})
})

const invalidSchedules: [string, unknown][] = [
  ['null tiers', { ...schedule, tiers: null }],
  ['object tiers', { ...schedule, tiers: {} }],
  ['null tier', { ...schedule, tiers: [null] }],
  ['array tier', { ...schedule, tiers: [[]] }],
  ['missing rate table', { ...schedule, tiers: [{ aboveInputTokens: 0 }] }],
  ['null rate table', { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: null }] }],
  ['array rate table', { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: [] }] }],
  ['unknown tier key', { ...schedule, tiers: [{ ...schedule.tiers![0], currency: 'USD' }] }],
  ['unknown rate key', { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: { reasoning: 1 } }] }],
  ['unknown TTL key', { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: { cacheWrite: { '2h': 1 } } }] }],
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '272000', null, undefined, Infinity, NaN].map(threshold => [`threshold ${String(threshold)}`, { ...schedule, tiers: [{ aboveInputTokens: threshold, perMillionTokens: {} }] }] as [string, unknown]),
  ...[-1, Infinity, NaN, '1', null, true].flatMap(value => ['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [`invalid ${key} ${String(value)}`, { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: { [key]: value } }] }] as [string, unknown])),
  ['invalid TTL rate', { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: { cacheWrite: { '5m': -1 } } }] }],
  ['duplicate thresholds', { ...schedule, tiers: [schedule.tiers![0], schedule.tiers![0]] }],
  ['descending thresholds', { ...schedule, tiers: [schedule.tiers![0], { aboveInputTokens: 0, perMillionTokens: {} }] }],
]
for (const [label, pricing] of invalidSchedules) test(`config and checkpoint reject ${label}`, () => {
  const errors: string[] = []
  expect(parsePricing(pricing, 'pricing', errors)).toBeUndefined()
  expect(errors.length).toBeGreaterThan(0)
  expect(parseConfig(configText(pricing)).config).toBeUndefined()
  expect(validateUsageEnvelope(pendingEnvelope(pricing))).toBeUndefined()
})

test('parser copies schedules and nested TTL maps without retaining caller references', () => {
  const raw = { ...schedule, tiers: [{ aboveInputTokens: 0, perMillionTokens: { cacheWrite: { '5m': 1 } } }] }
  const errors: string[] = [], parsed = parsePricing(raw, 'pricing', errors)
  raw.tiers[0]!.perMillionTokens.cacheWrite['5m'] = 99
  expect(errors).toEqual([])
  expect(parsed?.tiers?.[0]?.perMillionTokens.cacheWrite).toEqual({ '5m': 1 })
})

test('legacy v1 and v2 flat pending schedules remain readable', () => {
  const flat = { currency: 'USD', perMillionTokens: rates }
  for (const version of [1, 2]) {
    const state = { ...pendingEnvelope(flat), version }
    expect(validateUsageEnvelope(JSON.parse(JSON.stringify(state)))?.version).toBe(2)
  }
})

for (const kind of Object.keys(CODECS) as (keyof typeof CODECS)[]) test(`${kind} outbound request body ignores all pricing metadata`, () => {
  const config = parseConfig(configText()).config!, provider = { ...config.providers['p']!, kind }, model = provider.models['m']!
  const { pricing: _pricing, ...flatModel } = model
  const neutral = { system: 'system', messages: [], tools: [] }
  const without = CODECS[kind].encode(neutral, provider, flatModel)
  expect(CODECS[kind].encode(neutral, provider, model).body).toBe(without.body)
  expect(without.body).not.toContain('perMillionTokens')
  expect(without.body).not.toContain('aboveInputTokens')
})

test('real dispatch snapshot survives pending JSON validation and config reload before final settlement', async () => {
  const original = configText(), parsed = parseConfig(original)
  expect(parsed.errors).toEqual([])
  expect(resolve(parsed.config!, 'fast')).toMatchObject({ kind: 'remote', target: 'p/m', model: { pricing: schedule } })
  let state = createUsageEnvelope('session', 1000), captured: UsageSnapshot | undefined
  const observer = {
    begin() {
      state = reduceUsage(state, { type: 'begin', pending: { requestId: token.id, sessionId: token.sessionId, generation: 1, sequence: 1, purpose: 'step', owner: 'main', target: 'fast', startedAt: 1000, executions: {} } })
      return token.id
    },
    dispatch(_requestId: string, id: string, snapshot: UsageSnapshot) {
      captured = snapshot
      state = reduceUsage(state, { type: 'dispatch', token, executionId: id, snapshot })
    },
    summary(_requestId: string, summary: UsageExecutionSummary) { state = reduceUsage(state, { type: 'summary', token, summary }) },
    missing() { throw new Error('unexpected missing summary') },
    settle() { state = reduceUsage(state, { type: 'settle', token, at: 2000 }) },
    gap() { throw new Error('unexpected tracking gap') },
  }
  const backend = createBackend(observer)({
    root: '/fixture', debug: () => {},
    run: async () => ({ exitCode: 0, stdout: '/fixture/bun', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    spawn: async function* (req) {
      if (req.argv[0] === '/fixture/bun') {
        yield { stream: 'stdout', text: 'ready /fixture/d.sock token\n' }
        await new Promise<void>(() => {})
        return { code: 0, signal: null }
      }
      const wire = JSON.parse(req.input!) as StepWire
      expect(wire.configText).toBe(original)
      yield { stream: 'stdout', text: JSON.stringify({ type: 'text', text: 'synthetic pause' }) + '\n' }
      const summary: UsageExecutionSummary = { type: 'usage_summary', ...wire.accounting!, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: evidence(200000, 100, 60000, 12001) }] }
      yield { stream: 'stdout', text: [summary, { type: 'stop', reason: 'end_turn' }, { type: 'stats', ttfbMs: 1, totalMs: 2, reqBytes: 1, in: 272001, out: 100, finish: 'stop' }].map(value => JSON.stringify(value)).join('\n') + '\n' }
      return { code: 0, signal: null }
    },
    sleep: (_ms, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  })
  await backend.configure({ configText: original, approved: [] })
  const stream = backend.step({ target: 'fast', system: 'system', tools: [], transcript: [], who: 'main', accounting: { purpose: 'step', owner: 'main' } }, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ type: 'text', text: 'synthetic pause' })
  expect(captured?.pricing).toEqual(schedule)
  expect(state.sessions[0]!.completedAttempts).toBe(0)
  const restored = validateUsageEnvelope(JSON.parse(JSON.stringify(state)))
  expect(restored).toBeDefined()
  state = restored!
  await backend.configure({ configText: configText({ ...schedule, perMillionTokens: { input: 100 }, tiers: [{ aboveInputTokens: 0, perMillionTokens: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 } }] }), approved: [] })
  while (!(await stream.next()).done) { /* consume final evidence */ }
  const session = state.sessions[0]!
  expect(session.costUsd).toBeCloseTo(0.503206, 12)
  expect(session.pending).toEqual({})
  expect(Object.keys(session.buckets)).toEqual([JSON.stringify(['p/m', 'step', 'main'])])
  expect(Object.values(session.buckets)[0]!.costUsd).toBeCloseTo(0.503206, 12)
  expect(session.costFullyPricedAttempts).toBe(1)
  expect(validateUsageEnvelope(JSON.parse(JSON.stringify(state)))).toBeDefined()
})

test('many small alias requests stay at base rates after cumulative session input exceeds the threshold', () => {
  const config = parseConfig(configText()).config!
  let state = createUsageEnvelope('session', 1000)
  for (let sequence = 1; sequence <= 4; sequence++) {
    const target = resolve(config, sequence % 2 ? 'fast' : 'slow')
    if (target?.kind !== 'remote') throw new Error('expected remote alias')
    const requestToken = { ...token, id: `session:1:${sequence}`, sequence }
    const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    state = reduceUsage(state, { type: 'begin', pending: { requestId: requestToken.id, sessionId: 'session', generation: 1, sequence, purpose: 'step', owner: 'main', target: target.target, startedAt: 1000, executions: {} } })
    state = reduceUsage(state, { type: 'dispatch', token: requestToken, executionId: id, snapshot: { target: target.target, label: target.label, pricing: target.model.pricing } })
    state = reduceUsage(state, { type: 'summary', token: requestToken, summary: { type: 'usage_summary', requestId: requestToken.id, executionId: id, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: evidence(100000) }] } })
    state = reduceUsage(state, { type: 'settle', token: requestToken, at: 2000 })
  }
  expect(state.sessions[0]!.totals.totalInput.count).toBe(400000)
  expect(state.sessions[0]!.costUsd).toBe(0.4)
  expect(Object.keys(state.sessions[0]!.buckets)).toHaveLength(1)
  expect(state.sessions[0]!.pending).toEqual({})
})
