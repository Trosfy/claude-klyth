// Normal routing and compaction share a header/history builder; assertions inspect real codec bytes.
import { expect, test } from 'bun:test'
import type { SessionMessage } from 'claude-code'

import { compactBoundary, type ContextPreparation } from '../hooks/compact-decision'
import { compact as routedCompact } from '../hooks/compact'
import { createStepper } from './step'
import type { UpstreamRequest } from './step'
import { createAutoCompact } from '../hooks/autocompact'
import { createCompactAdapter } from '../hooks/compact-adapter'
import type { CompactPort } from '../hooks/compact'
import { parseConfig } from '../hooks/config'
import type { Kind } from '../hooks/kinds'
import type { ApiMessage, Backend, StepEvent, StepRequest } from '../hooks/protocol'
import { turnStep } from '../hooks/routing'
import { createSession } from '../hooks/session'
import { CODECS } from './codecs'
import { normalize } from './history'

const answer: StepEvent[] = [{ type: 'text', text: 'Summary.\n<klyth-summary-complete>' }, { type: 'stop', reason: 'end_turn' }]
const origin = { plugin: 'engine', tier: 'core' } as const
const route = { target: 'fast', label: 'fast', type: 'Explore', prompt: 'task', effort: 'high' as const }
const initial: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'task' }, { type: 'text', text: 'reminder' }] }]
const report: ApiMessage = { role: 'assistant', content: 'done' }

function fixture(kind: Kind = 'openai') {
  const text = JSON.stringify({ providers: { p: { kind, baseUrl: kind === 'bedrock' ? 'https://bedrock-runtime.us-east-1.amazonaws.com' : 'https://klyth.invalid/v1', auth: kind === 'bedrock' ? { command: ['/key'] } : 'none', sessionHeader: 'session_id', models: { m: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000, ...(kind === 'openai' ? { maxTokensParam: 'max_completion_tokens' } : kind === 'openai-responses' ? { maxTokensParam: 'max_output_tokens' } : { cache: '5m' }), effort: { high: kind === 'bedrock' ? { additionalModelRequestFields: { reasoning: 'high' } } : { reasoning_effort: 'high' } } } } } }, aliases: { fast: 'p/m' } })
  const s = createSession()
  s.loaded = { config: parseConfig(text).config!, text, errors: [], missing: false, path: 'klyth.json' }
  s.main = 'fast'
  let api: readonly ApiMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` }))
  const rows: SessionMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}`, toolUses: [], handle: `h${i}` }))
  let system = 'NORMAL SYSTEM', events = answer
  const debug: string[] = []
  const requests: StepRequest[] = [], encoded: Record<string, unknown>[] = []
  const io: Omit<CompactPort, 'compacted'> & { setPin(pin: typeof s.pin): Promise<void> } = {
    main: async () => s.main, pin: async () => s.pin, setPin: async pin => { s.pin = pin }, route: async id => s.routes.get(id),
    saveDraft: async () => '/config/klyth/compactions/fixture/draft.json',
    transcript: async () => api, rows: async () => rows, engineModel: async () => 'native',
    compose: async () => [{ id: 'intro', text: system }], cwd: async () => '/w', configDir: async () => '/config', exists: async () => false, read: async () => '', listDir: async () => [],
    run: async () => ({ exitCode: 0, stdout: 'Darwin', stderr: '' }), now: async () => 0, list: async () => [{ name: 'Read', description: 'Reads', mcp: false }], loadedMcp: async () => new Set<string>(),
    trusted: async () => true, after: () => ({ cancel() {} }), debug: text => { debug.push(text) }, toast: () => {},
  }
  const backend: Backend = { configure: async () => {}, start: async () => {}, status: async () => [], step: async function* (req) {
    requests.push(req)
    const p = s.loaded.config!.providers['p']!, m = p.models['m']!
    encoded.push(JSON.parse(CODECS[kind].encode({ system: req.system, tools: req.tools, messages: normalize(req.transcript, m.vision, () => undefined), effort: req.effort, ...(req.compaction === undefined ? {} : { maintenance: true, prefixMessages: req.compaction.prefixMessages, outputTokens: req.compaction.outputTokens }) }, p, m).body))
    yield* events
  } }
  const adapter = createCompactAdapter(s)
  const compact = (agentId?: string, trigger = 'manual' as 'manual' | 'precompute') => adapter.compact(io, backend, { trigger, agentId, messages: rows, instructions: 'retain restrictions' }, new AbortController().signal, async () => { throw new Error('native must not run') })
  const normal = async (agentId?: string, model = 'native') => {
    const gen = turnStep({ ...io, translated: async () => ({}), setTranslated: async () => {}, sleep: async () => {}, agentType: async () => undefined }, s, backend, { turnId: 't', index: 0, model, messageCount: rows.length, agentId, effort: 'high' }, new AbortController().signal, () => { throw new Error('native must not run') })
    while (!(await gen.next()).done) {}
  }
  return { s, io, rows, backend, debug, requests, encoded, compact, normal, api: (value: readonly ApiMessage[]) => { api = value }, system: (value: string) => { system = value }, events: (value: StepEvent[]) => { events = value } }
}

for (const kind of ['openai', 'openai-responses', 'anthropic', 'bedrock'] as const) test(`${kind}: encoded normal prefix, schema bytes, effort and original session survive append-only compaction`, async () => {
  const f = fixture(kind)
  f.api(Array.from({ length: 11 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` })))
  await f.normal()
  const normal = f.encoded[0]!, req = f.requests[0]!
  // Normal request excludes its own response; the response is new tail, not part of the cached prefix.
  f.api([...req.transcript, { role: 'assistant', content: 'response accumulated after request' }, { role: 'user', content: 'new tail request' }, { role: 'assistant', content: 'new tail response' }])
  f.system('DIFFERENT COMPOSITION MUST NOT REPLACE STAMPED HEADER')
  expect((await f.compact()).skip).toBeUndefined()
  const compact = f.encoded[1]!, sent = f.requests[1]!
  expect(sent.system).toBe(req.system)
  expect(sent.tools).toBe(req.tools)
  expect(sent.effort).toBe(req.effort)
  expect(sent.sessionId).toBe(req.sessionId)
  const key = kind === 'openai-responses' ? 'input' : 'messages'
  const before = normal[key] as unknown[], after = compact[key] as unknown[]
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before))
  for (const field of ['system', 'instructions', 'tools', 'toolConfig', 'reasoning_effort', 'inferenceConfig', 'additionalModelRequestFields']) {
    if (field === 'inferenceConfig') continue // The bounded compaction output cap is intentionally smaller.
    expect(JSON.stringify(compact[field])).toBe(JSON.stringify(normal[field]))
  }
  expect(JSON.stringify(after[0])).not.toContain('Klyth conversation maintenance')
  expect(JSON.stringify(after.at(-1))).toContain('Klyth conversation maintenance')
  expect(sent.transcript.at(-1)?.role).toBe('user')
})

test('a last user input item remains separate from the generated maintenance item', async () => {
  const f = fixture('openai-responses')
  f.api([{ role: 'user', content: 'last input' }])
  await f.normal()
  expect((await f.compact()).skip).toBeUndefined()
  const before = f.encoded[0]!.input as unknown[], after = f.encoded[1]!.input as unknown[]
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before))
  expect(after.length).toBe(before.length + 1)
})

test('cold and config-reloaded headers use the normal builder without changing offers, tokens, pins or tool reports', async () => {
  const f = fixture()
  const before = { offers: f.s.offered, report: f.s.toolReport, pin: f.s.pin, epoch: f.s.dropEpoch }
  expect((await f.compact()).skip).toBeUndefined()
  expect(f.s.offered).toBe(before.offers)
  expect(f.s.offered.size).toBe(0)
  expect(f.s.toolReport).toBe(before.report)
  expect(f.s.pin).toBe(before.pin)
  await f.normal()
  f.s.loaded = { ...f.s.loaded }
  f.s.resetForReload()
  f.system('RELOADED NORMAL SYSTEM')
  expect((await f.compact()).skip).toBeUndefined()
  expect(f.requests.at(-1)?.system).toBe('RELOADED NORMAL SYSTEM')
})

test('a changed child route never reuses an old header or effort', async () => {
  const f = fixture()
  f.s.routes.set('child', route)
  await f.normal('child')
  const old = f.requests[0]!
  f.s.routes.set('child', { ...route, type: 'general-purpose', effort: 'low' })
  expect((await f.compact('child')).skip).toBeUndefined()
  expect(f.requests[1]?.effort).toBe('low')
  expect(f.requests[1]?.system).not.toBe(old.system)
})

test('fork compaction rebuilds normal inherited history on a cold header', async () => {
  const f = fixture()
  const parent: ApiMessage[] = [...initial, { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-call', name: 'Agent', input: {} }] }]
  f.s.routes.set('fork', { ...route, type: 'fork', forkOf: 'fork-call' })
  f.io.transcript = async id => id === undefined ? parent : [initial[0]!, report]
  await f.normal('fork')
  const old = f.requests[0]!
  f.s.sent.delete('fork')
  expect((await f.compact('fork')).skip).toBeUndefined()
  expect(f.requests[1]?.transcript.slice(0, -1)).toEqual([...old.transcript])
  expect(f.requests[1]?.system).toBe(old.system)
})

for (const failure of ['tool', 'tool stop', 'refusal', 'incomplete'] as const) test(`${failure}: failed compaction keeps child/sibling snapshots and original token state`, async () => {
  const f = fixture()
  for (const id of ['child', 'sibling']) {
    f.s.routes.set(id, route)
    await f.s.cacheHistory.read(id, route, initial, 'old', () => {})
    await f.s.cacheHistory.complete(id, [...initial, report])
  }
  f.s.promptTokens.set('child', { tokens: 100, messageCount: 12 })
  const sent = { target: 'fast', system: 'old', tools: [] }
  f.s.sent.set('child', sent)
  f.s.sentContext.set('child', { loaded: f.s.loaded, routeKey: '', model: 'native-child', messageCount: 12, turnId: 'old' })
  f.events(failure === 'tool' ? [{ type: 'tool_use', id: 'u', name: 'Read', input: {} }] : failure === 'incomplete' ? [{ type: 'text', text: 'partial' }, { type: 'stop', reason: 'end_turn' }] : [{ type: 'stop', reason: failure === 'refusal' ? 'refusal' : 'tool_use' }])
  expect((await f.compact('child')).skip).toContain('history kept')
  expect(f.s.sent.get('child')).toBe(sent)
  expect(f.s.promptTokens.get('child')?.tokens).toBe(100)
  expect(f.s.cacheHistory.begin('child', 'next', origin, route)).toBeDefined()
  expect(f.s.cacheHistory.tracked('sibling')).toBe(true)
})

test('routed success invalidates exactly its child snapshot; main compaction never invalidates siblings', async () => {
  const f = fixture()
  for (const id of ['child', 'sibling']) {
    f.s.routes.set(id, route)
    await f.s.cacheHistory.read(id, route, initial, 'old', () => {})
    await f.s.cacheHistory.complete(id, [...initial, report])
  }
  f.s.sentContext.set('child', { loaded: f.s.loaded, routeKey: '', model: 'native-child', effort: 'high', messageCount: initial.length, turnId: 'old' })
  expect((await f.compact('child')).skip).toBeUndefined()
  expect(f.s.cacheHistory.tracked('child')).toBe(false)
  expect(f.s.cacheHistory.tracked('sibling')).toBe(true)
  expect((await f.compact()).skip).toBeUndefined()
  expect(f.s.cacheHistory.tracked('sibling')).toBe(true)
})

test('native skip and precompute keep the snapshot; successful native installation invalidates only that loop', async () => {
  const f = fixture(), native = { ...route, target: null }
  await f.s.cacheHistory.read('child', route, initial, 'old', () => {})
  await f.s.cacheHistory.complete('child', [...initial, report])
  f.s.routes.set('child', native)
  const adapter = createCompactAdapter(f.s), e = { agentId: 'child', trigger: 'manual' as const, messages: f.rows }, signal = new AbortController().signal
  const unused = {} as Backend
  expect(await adapter.compact(f.io, unused, e, signal, async () => ({ skip: 'native skip' }))).toEqual({ skip: 'native skip' })
  expect(f.s.cacheHistory.tracked('child')).toBe(true)
  await adapter.compact(f.io, unused, { ...e, trigger: 'precompute' }, signal, async () => ({ messages: [] }))
  expect(f.s.cacheHistory.tracked('child')).toBe(true)
  const result = { messages: [] }
  expect(await adapter.compact(f.io, unused, e, signal, async () => result)).toBe(result)
  expect(f.s.cacheHistory.tracked('child')).toBe(false)
})

test('resumed child seam is normalized observationally; a failed compact cannot claim its delivery turn', async () => {
  const f = fixture()
  f.s.routes.set('child', route)
  await f.s.cacheHistory.read('child', route, initial, 'old', () => {})
  await f.s.cacheHistory.complete('child', [...initial, report])
  const raw = 'resume payload', wrapper = { type: 'text', text: `frame ${raw}` }
  f.s.cacheHistory.begin('child', raw, origin, route)!()
  const resumed: ApiMessage[] = [{ ...initial[0]!, content: [{ type: 'text', text: 'task\n' }, { type: 'text', text: 'reminder' }, wrapper] }, report, { role: 'user', content: raw }]
  f.api(resumed)
  f.s.sentContext.set('child', { loaded: f.s.loaded, routeKey: '', model: 'native-child', messageCount: initial.length, turnId: 'old' })
  f.events([{ type: 'stop', reason: 'refusal' }])
  expect((await f.compact('child')).skip).toContain('history kept')
  expect(f.requests[0]?.transcript[0]).toEqual(initial[0])
  expect(f.requests[0]?.transcript[2]).toEqual({ ...resumed[2]!, content: [{ ...wrapper, text: '\n' + wrapper.text }, { type: 'text', text: raw }] })
  const actual = await f.s.cacheHistory.read('child', route, resumed, 'actual-resume-turn', () => {})
  expect(actual[0]).toEqual(initial[0])
  await f.s.cacheHistory.complete('child', [...resumed, report])
  expect(f.s.cacheHistory.begin('child', 'another delivery', origin, route)).toBeDefined()
})

test('recovery above the normal 95% guard still uses the append-only request when it fits compaction headroom', async () => {
  const f = fixture()
  await f.normal()
  f.s.promptTokens.set('main', { tokens: 840_000, messageCount: 12 })
  expect((await f.compact()).skip).toBeUndefined()
  expect(f.requests[1]?.system).toBe(f.requests[0]?.system)
  expect(f.requests[1]?.sessionId).toBe(f.requests[0]?.sessionId)
})

test('an Agent call in the history leaves the compaction request holding the normal request as its prefix', async () => {
  const f = fixture()
  f.api([...initial, { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: { prompt: 'task' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'started' }] }])
  await f.normal()
  expect((await f.compact()).skip).toBeUndefined()
  expect(f.requests[1]?.transcript.slice(0, -1)).toEqual([...f.requests[0]!.transcript])
})

test('failed cold preparation leaves classifier authority and diagnostic state untouched', async () => {
  const f = fixture()
  f.s.tokens.set('main\ncall', { until: 1, step: 1, cwd: '/w', source: 'model-fresh' })
  f.s.offered.set('child', new Set(['Read']))
  const token = f.s.tokens.get('main\ncall'), report = f.s.toolReport, pin = f.s.pin, epoch = f.s.dropEpoch
  f.events([{ type: 'stop', reason: 'refusal' }])
  expect((await f.compact()).skip).toContain('history kept')
  expect(f.s.tokens.get('main\ncall')).toBe(token)
  expect(f.s.offered.get('child')).toEqual(new Set(['Read']))
  expect(f.s.toolReport).toBe(report)
  expect(f.s.pin).toBe(pin)
  expect(f.s.dropEpoch).toBe(epoch)
})

test('unsupported Bedrock last-user prefix skips rather than modifying its encoded item', async () => {
  const f = fixture('bedrock')
  f.api(initial)
  expect((await f.compact()).skip).toContain('alternating roles')
  expect(f.requests).toHaveLength(0)
})

test('config changed during cold header preparation skips before any provider request', async () => {
  const f = fixture()
  f.io.compose = async () => {
    f.s.loaded = { ...f.s.loaded }
    return [{ id: 'intro', text: 'changed' }]
  }
  expect((await f.compact()).skip).toContain('history kept')
  expect(f.requests).toHaveLength(0)
})

// Real provider decoding must prove a clean terminal finish, not merely normalize it to end_turn.
const stream = (...parts: unknown[]) => new TextEncoder().encode(parts.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join(''))
function realBackend(f: ReturnType<typeof fixture>, data: Uint8Array, posted: UpstreamRequest[]) {
  const stepper = createStepper({ version: '0.2.0', post: async req => { posted.push(req); return { status: 200, body: (async function* () { yield data; return undefined })(), cancel() {} } }, run: async () => ({ exitCode: 0, stdout: JSON.stringify({ accessKeyId: 'fake', secretAccessKey: 'fake' }), stderr: '' }), now: () => 0, sleep: async () => {}, log: () => {} })
  return { ...f.backend, step: (req: StepRequest, signal: AbortSignal) => stepper.step({ req, configText: f.s.loaded.text!, approved: [...f.s.approved], token: 'fake' }, signal) }
}
for (const kind of ['openai', 'openai-responses'] as const) for (const finish of ['missing', 'unknown', 'success'] as const) test(`${kind}: ${finish} raw finish through codec/stepper/compact is atomic; ordinary compatibility survives`, async () => {
  const f = fixture(kind), posted: UpstreamRequest[] = []
  const data = kind === 'openai'
    ? stream({ choices: [{ delta: { content: 'Summary.\n<klyth-summary-complete>' }, finish_reason: finish === 'missing' ? null : finish === 'success' ? 'stop' : 'unknown' }] }, '[DONE]')
    : stream({ type: 'response.output_text.delta', delta: 'Summary.\n<klyth-summary-complete>' }, ...(finish === 'missing' ? [] : [{ type: finish === 'success' ? 'response.completed' : 'response.incomplete', response: { incomplete_details: { reason: 'incomplete' } } }]))
  const backend = realBackend(f, data, posted)
  f.s.promptTokens.set('main', { tokens: 100, messageCount: 12 })
  const result = await routedCompact({ ...f.io, compacted() {} }, f.s, backend, { trigger: 'manual', messages: f.rows }, new AbortController().signal, async () => { throw new Error('native') })
  expect(posted.length).toBe(1)
  if (finish === 'success') expect(result.messages).toBeDefined()
  else {
    expect(result.messages).toBeUndefined()
    expect(result.skip).toContain('history kept')
    expect(f.debug.join('\n')).toContain(kind === 'openai-responses' && finish === 'missing' ? 'stream ended with no finish reason' : 'recognized successful provider finish')
    expect(f.s.promptTokens.get('main')?.tokens).toBe(100)
  }
  const ordinary: StepEvent[] = []
  for await (const ev of backend.step({ target: 'fast', system: 'system', tools: [], transcript: [{ role: 'user', content: 'ordinary' }], who: 'main' }, new AbortController().signal)) ordinary.push(ev)
  expect(ordinary.some(ev => ev.type === 'stop' && ev.reason === 'end_turn')).toBe(!(kind === 'openai-responses' && finish === 'missing'))
  expect(ordinary.some(ev => ev.type === 'error')).toBe(kind === 'openai-responses' && finish === 'missing')
})

for (const kind of ['anthropic', 'bedrock'] as const) test(`${kind}: filtered assistant prefix keeps encoded cache bytes; cross-boundary merges reject only maintenance`, () => {
  const f = fixture(kind), p = f.s.loaded.config!.providers['p']!, m = p.models['m']!
  const original: ApiMessage[] = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: '' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }]
  const tail: ApiMessage[] = [{ role: 'user', content: 'tail user' }, { role: 'assistant', content: 'tail assistant' }, { role: 'user', content: 'maintenance' }]
  const encode = (api: ApiMessage[], prefix?: ApiMessage[]) => CODECS[kind].encode({ system: 'system', tools: [], messages: normalize(api, true, () => undefined), ...(prefix === undefined ? {} : { maintenance: true, prefixMessages: normalize(prefix, true, () => undefined).length }) }, p, m)
  const before = JSON.parse(encode(original).body).messages
  const safe = encode([...original, ...tail], original)
  expect(safe.rejected).toBeUndefined()
  expect(JSON.stringify(JSON.parse(safe.body).messages.slice(0, before.length))).toBe(JSON.stringify(before))
  if (kind === 'bedrock') {
    const prefix: ApiMessage[] = [{ role: 'user', content: 'cached' }]
    const merged: ApiMessage[] = [...prefix, { role: 'assistant', content: '' }, ...tail]
    expect(encode(merged, prefix).rejected).toContain('merge across the cached prefix')
    expect(encode(merged).rejected).toBeUndefined()
    expect(JSON.parse(encode(merged).body).messages[0].content.slice(0, 2)).toEqual([{ text: 'cached' }, { text: 'tail user' }])
  }
})

test('Bedrock cross-boundary merge skips atomically before upstream send', async () => {
  const f = fixture('bedrock'), posted: UpstreamRequest[] = []
  f.api([{ role: 'user', content: 'cached' }]); await f.normal()
  const sent = f.s.sent.get('main')
  f.api([{ role: 'user', content: 'cached' }, { role: 'assistant', content: '' }, { role: 'user', content: 'tail user' }, { role: 'assistant', content: 'tail assistant' }])
  f.s.promptTokens.set('main', { tokens: 100, messageCount: 12 })
  const result = await routedCompact({ ...f.io, compacted() { throw new Error('must not install') } }, f.s, realBackend(f, stream(), posted), { trigger: 'manual', messages: f.rows }, new AbortController().signal, async () => { throw new Error('native') })
  expect(result.skip).toContain('history kept')
  expect(result.messages).toBeUndefined()
  expect(posted.length).toBe(0)
  expect(f.debug.join('\n')).toContain('merge across the cached prefix')
  expect(f.s.sent.get('main')).toBe(sent)
  expect(f.s.promptTokens.get('main')?.tokens).toBe(100)
})

for (const type of ['claude', 'Explore', 'custom', 'fork'] as const) for (const reload of [false, true]) test(`${type} child native provenance remains independent of main (${reload ? 'rebuild' : 'reuse'})`, async () => {
  const f = fixture()
  f.s.routes.set('child', { target: 'fast', label: 'fast', type })
  if (type === 'fork') {
    f.s.routes.set('child', { target: 'fast', label: 'fast', type, forkOf: 'fork-call' })
    const parent: ApiMessage[] = [...initial, { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-call', name: 'Agent', input: {} }] }]
    f.io.transcript = async id => id === undefined ? parent : [initial[0]!, report]
  }
  f.io.compose = async model => [{ id: 'intro', text: `system for ${model}` }]
  await f.normal('child', 'native-child')
  const before = f.requests.at(-1)!
  f.io.engineModel = async () => 'different-main'
  if (reload) { f.s.loaded = { ...f.s.loaded }; f.s.resetForReload() }
  expect((await f.compact('child')).skip).toBeUndefined()
  const after = f.requests.at(-1)!
  expect(after.system).toBe(before.system)
  expect(after.tools).toEqual(before.tools)
  expect(after.effort).toBe(before.effort)
  expect(after.sessionId).toBe(before.sessionId)
})

test('cold child cannot reconstruct a native prompt from the main model', async () => {
  const f = fixture()
  f.s.routes.set('child', route)
  expect((await f.compact('child')).skip).toContain('child native prompt provenance')
  expect(f.requests).toEqual([])
})

for (const change of ['disabled', 'error', 'cancel', 'reload', 'end'] as const) test(`automatic reservation coalesces overlapping schedules and releases after ${change}`, async () => {
  const f = fixture(), auto = createAutoCompact(f.s), callbacks: (() => void)[] = []
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  let release!: (value: boolean) => void, reject!: (reason: Error) => void, enqueued = 0
  const waiting = new Promise<boolean>((yes, no) => { release = yes; reject = no })
  const io = { now: () => 0, enabled: () => waiting, estimate: async (p?: ContextPreparation) => { p?.committed(compactBoundary(f.s), { count: 0, digest: 'fixture' }); return 900_000 }, after: (fn: () => void) => { callbacks.push(fn) }, enqueue: async () => { enqueued++ }, debug() {} }
  const both = Promise.all([auto.schedule(io), auto.schedule(io)])
  if (change === 'cancel' || change === 'end') auto.cancel()
  if (change === 'reload') f.s.loaded = { ...f.s.loaded }
  if (change === 'error') reject(new Error('settings failed')); else release(change !== 'disabled')
  try { await both; expect(change === 'error').toBe(false) } catch (err) { expect(String(err)).toContain('settings failed') }
  expect(callbacks.length).toBe(0)
  await Promise.all([auto.schedule({ ...io, enabled: async () => true }), auto.schedule({ ...io, enabled: async () => true })])
  expect(callbacks.length).toBe(1)
  auto.cancel(); callbacks[0]!(); expect(enqueued).toBe(0)
  await auto.schedule({ ...io, enabled: async () => true })
  callbacks[1]!(); expect(enqueued).toBe(1)
})

for (const change of ['error', 'cancel'] as const) test(`idle automatic eligibility ${change} releases only its own reservation`, async () => {
  const f = fixture(), auto = createAutoCompact(f.s), callbacks: (() => void)[] = []
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  let now = 0, compacted = 0
  const io = { now: () => now, enabled: async () => true, estimate: async (p?: ContextPreparation) => { p?.committed(compactBoundary(f.s), { count: 0, digest: 'fixture' }); return 900_000 }, after: (fn: () => void) => { callbacks.push(fn) }, enqueue: async () => {}, debug() {} }
  await auto.schedule(io)
  let release!: (value: boolean) => void, reject!: (reason: Error) => void
  const waiting = new Promise<boolean>((yes, no) => { release = yes; reject = no })
  const running = auto.run({ ...io, enabled: () => waiting }, async () => { compacted++; return { messages: [] } })
  if (change === 'error') reject(new Error('settings failed'))
  else { auto.cancel(); await auto.schedule(io); release(true) }
  try { expect((await running).skip).toContain('stale or disabled') } catch (err) { expect(String(err)).toContain('settings failed') }
  expect(compacted).toBe(0)
  if (change === 'error') { now = 60_000; await auto.schedule(io) }
  // Cancellation of old work cannot release the replacement reservation.
  await auto.schedule(io)
  expect(callbacks.length).toBe(2)
})
