// Compaction replaces history only after a complete routed summary; native quota failures stay out of it.
import type { SessionCompactInput, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { createUsageLifetime } from '../hooks/usage-lifetime'
import type { UsagePort } from '../hooks/usage-lifetime'
import { finalEvidence, partitionedUsage } from '../hooks/usage-evidence'

import { compactBoundary, type ContextPreparation } from '../hooks/compact-decision'
import { dropTokens, noteMode } from '../hooks/classifier'
import { currentContext } from '../hooks/request'
import { historyPrefix, reconcileHistory } from '../hooks/history-context'
import { recoveryPieces, recoverySource } from '../hooks/compact-source'
import { compact, recentTail, summaryChunks } from '../hooks/compact'
import type { CompactPort } from '../hooks/compact'
import { autoEnabled, createCompactAdapter } from '../hooks/compact-adapter'
import { createCompactProgress, progressText, type CompactProgress } from '../hooks/compact-progress'
import { parseConfig } from '../hooks/config'
import { createAutoCompact, autoThreshold } from '../hooks/autocompact'
import type { Backend, StepEvent, StepRequest } from '../hooks/protocol'
import { createSession } from '../hooks/session'
import { CONFIG, model, sse, start, world } from './world'

const rows = (n = 12): SessionMessage[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}`, toolUses: [], handle: `h${i}` }))
const constantEstimate = (s: ReturnType<typeof createSession>, p?: ContextPreparation) => { p?.committed(compactBoundary(s), { count: 0, digest: 'fixture' }); return 900_000 }
const events: StepEvent[] = [{ type: 'text', text: 'Preserved work and restrictions.\n<klyth-summary-complete>' }, { type: 'usage', in: 90, out: 15, cacheRead: 10, cacheWrite: 0 }, { type: 'stop', reason: 'end_turn' }]
function fixture(messages = rows(), answer: readonly StepEvent[] = events) {
  const s = createSession()
  s.loaded = { config: parseConfig(CONFIG).config!, text: CONFIG, errors: [], missing: false, path: 'klyth.json' }
  s.main = 'fast'
  const requests: StepRequest[] = []
  const installed: string[] = []
  let current = messages
  let before = () => {}
  const io: CompactPort = { saveDraft: async () => '/config/klyth/compactions/fixture/draft.json', engineModel: async () => 'native', transcript: async () => current.map(m => ({ role: m.role, content: m.text })), compose: async () => [{ id: 'intro', text: 'NORMAL SYSTEM' }], cwd: async () => '/w', configDir: async () => '/config', exists: async () => false, read: async () => '', listDir: async () => [], run: async () => ({ exitCode: 0, stdout: 'Darwin', stderr: '' }), now: async () => 0, list: async () => [], loadedMcp: async () => new Set<string>(), main: async () => s.main, pin: async () => s.pin, route: async id => s.routes.get(id), trusted: async () => true, rows: async () => current, after: () => ({ cancel() {} }), debug: () => {}, toast: () => {}, compacted: who => void installed.push(who) }
  const backend: Backend = { configure: async () => {}, start: async () => {}, status: async () => [], step: async function* (req) { requests.push(req); before(); yield* answer } }
  const e: SessionCompactInput = { trigger: 'manual', messages }
  const native = async () => { throw new Error('native quota exhausted') }
  return { s, io, backend, e, requests, installed, native, current: (v: SessionMessage[]) => { current = v }, before: (fn: () => void) => { before = fn } }
}

test('a compaction response just before its deadline reaches installation while usage state publication is blocked', async () => {
  const f = fixture()
  const usage = createUsageLifetime()
  let stateValue: unknown
  let stateVersion = 0
  let blocked = false
  let release: (() => void) | undefined
  const usagePort: UsagePort = {
    sessionId: async () => 'compact-session',
    now: async () => 1000,
    state: async () => ({ value: stateValue, version: stateVersion }),
    setState: async (value, ifVersion) => {
      if (blocked) await new Promise<void>(resolve => { release = resolve })
      if (ifVersion !== stateVersion) throw new Error('state CAS conflict')
      stateValue = structuredClone(value)
      return ++stateVersion
    },
    storeGet: async () => undefined,
    storeSet: async () => {},
    after: () => ({ cancel() {} }),
    context: async () => undefined,
    log: () => {},
  }
  await usage.start(usagePort)
  blocked = true
  let clock = 10_000
  f.io.wallNow = () => clock
  try {
    const backend: Backend = {
      ...f.backend,
      step: (req, _signal, opts) => (async function* () {
        const requestId = usage.observer.begin({ ...req.accounting!, target: req.target })
        if (requestId === undefined) throw new Error('usage request was not admitted')
        const executionId = '00000000-0000-4000-8000-000000000099'
        usage.observer.dispatch(requestId, executionId, { target: 'acme/model-a', label: 'fast' })
        usage.observer.summary(requestId, { type: 'usage_summary', requestId, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence: finalEvidence(partitionedUsage({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'anthropic', { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' })) }] })
        usage.observer.settle(requestId, 'complete')
        clock += 1_199_990
        expect(await opts?.dispatchGuard?.()).toBe(true)
        yield { type: 'text', text: 'Useful summary.\n<klyth-summary-complete>' }
        yield { type: 'stop', reason: 'end_turn' }
      })(),
    }
    const result = await compact(f.io, f.s, backend, f.e, new AbortController().signal, f.native)
    expect(result.messages?.[0]?.text).toContain('Useful summary.')
    expect(usage.snapshot()?.sessions[0]?.costIncompleteAttempts).toBe(1)
  } finally {
    blocked = false
    release?.()
    await usage.end(usagePort)
  }
})

for (const trigger of ['manual', 'auto', 'plugin'] as const) test(`routed ${trigger} compaction has no native dependency, retains normal header and preserves recent handles`, async () => {
  const f = fixture()
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  f.s.sent.set('main', { target: 'fast', system: 'old', tools: [] })
  const original = f.e.messages
  const done = await compact(f.io, f.s, f.backend, { ...f.e, trigger, instructions: 'retain the pending migration' }, new AbortController().signal, f.native)
  expect(done.messages?.slice(1)).toEqual(original.slice(6))
  expect(done.messages?.[1]).toBe(original[6])
  expect(done.messages?.[0]).toMatchObject({ role: 'user', toolUses: [] })
  expect(done.messages?.[0]?.handle).toBe(undefined)
  expect(done.messages?.[0]?.text).toContain('not a new user request or approval')
  expect(f.requests[0]).toMatchObject({ tools: [], who: 'compact:main', compaction: { outputTokens: 8000 } })
  expect(f.requests[0]?.accounting).toEqual({ purpose: 'compaction', owner: 'main' })
  expect(JSON.stringify(f.requests[0]?.transcript)).toContain('retain the pending migration')
  expect(f.requests[0]?.sessionId).toBe(f.s.sessionId('main'))
  expect(f.requests[0]?.system).toBe('NORMAL SYSTEM')
  expect(f.requests[0]?.transcript.slice(0, -1)).toEqual(original.map(m => ({ role: m.role, content: m.text })))
  expect(f.installed).toEqual(['main'])
  expect(f.s.promptTokens.size).toBe(0)
  expect(f.s.sent.size).toBe(0)
  expect('usage' in done ? done.usage : undefined).toBe(undefined)
  expect(original).toBe(f.e.messages)
})

test('compaction gives the whole operation twenty minutes and reports timeout without installing', async () => {
  const f = fixture()
  let deadline = 0
  let expire = () => {}
  let cancelled = false
  f.io.after = (ms, fn) => { deadline = ms; expire = fn; return { cancel() { cancelled = true } } }
  f.before(() => expire())
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(deadline).toBe(1_200_000)
  expect(f.requests[0]?.timeoutMs).toBeGreaterThan(120_000)
  expect(f.requests[0]?.timeoutMs).toBeLessThanOrEqual(1_200_000)
  expect(done.skip).toContain('timed out after 1200 seconds')
  expect(done.messages).toBe(undefined)
  expect(f.installed).toEqual([])
  expect(cancelled).toBe(true)
})

test('compaction distinguishes cancellation from timeout', async () => {
  const f = fixture()
  const ac = new AbortController()
  f.before(() => ac.abort())
  const done = await compact(f.io, f.s, f.backend, f.e, ac.signal, f.native)
  expect(done.skip).toContain('skipped: cancelled;')
  expect(done.skip).not.toContain('timed out')
  expect(done.messages).toBe(undefined)
})

test('summarizer failure reports a bounded redacted cause without exposing credentials', async () => {
  const secret = 'sk-test-provider-credential-value'
  const f = fixture(rows(), [{ type: 'error', kind: 'request', text: `upstream rejected Bearer ${secret}\nprivate second line` }])
  const debug: string[] = []
  f.io.debug = text => { debug.push(text) }
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('upstream rejected Bearer [REDACTED]')
  expect(done.skip).not.toContain(secret)
  expect(done.skip).not.toContain('private second line')
  expect(debug.join('\n')).not.toContain(secret)
  expect(done.messages).toBe(undefined)
})

test('main and child compaction resolve their own routes; native child passes through unchanged', async () => {
  const f = fixture()
  f.s.routes.set('child', { target: 'strong', label: 'strong' })
  f.s.sentContext.set('child', { loaded: f.s.loaded, routeKey: '', model: 'native-child', messageCount: 12, turnId: 'child-turn' })
  expect((await compact(f.io, f.s, f.backend, { ...f.e, agentId: 'child' }, new AbortController().signal, f.native)).skip).toBe(undefined)
  expect(f.requests[0]).toMatchObject({ target: 'strong', who: 'compact:child' })
  expect(f.requests[0]?.accounting).toEqual({ purpose: 'compaction', owner: 'child' })
  f.s.routes.set('native', { target: null, label: 'opus' })
  const native = { messages: rows(2) }
  expect(await compact(f.io, f.s, f.backend, { ...f.e, agentId: 'native' }, new AbortController().signal, async () => native)).toBe(native)
})

test('the active main turn keeps its pin even if the selected next-turn route changes', async () => {
  const f = fixture()
  f.s.mainTurn = 't'
  f.s.pin = { turnId: 't', target: 'strong' }
  await compact(f.io, f.s, f.backend, { ...f.e, trigger: 'auto' }, new AbortController().signal, f.native)
  expect(f.requests[0]?.target).toBe('strong')
})

test('tail expansion retains complete pairs, rejects orphans and shrinks oversized completed suffixes', () => {
  const m = rows()
  m[5] = { ...m[5]!, toolUses: [{ tool_use_id: 'u', tool: 'Read', input: {} }] }
  m[6] = { ...m[6]!, toolResults: [{ tool_use_id: 'u', text: 'result', isError: false }] }
  expect(recentTail(m)).toBe(5)
  m[5] = { ...m[5]!, toolUses: [] }
  expect(recentTail(m)).toBe(undefined)
  expect(recentTail(rows().map(m => ({ ...m, text: 'x'.repeat(5000) })))).toBe(8)
})

test('an oversized recent exchange is summarized while the smaller paired suffix is retained', async () => {
  const m = rows()
  m[5] = { ...m[5]!, toolUses: [{ tool_use_id: 'large', tool: 'Read', input: {} }] }
  m[6] = { ...m[6]!, text: '', toolResults: [{ tool_use_id: 'large', text: 'x'.repeat(30_000), isError: false }] }
  expect(recentTail(m)).toBe(7)
  const f = fixture(m)
  const done = await compact(f.io, f.s, f.backend, { ...f.e, trigger: 'auto' }, new AbortController().signal, f.native)
  expect(done.messages?.slice(1)).toEqual(m.slice(7))
  expect(f.requests.length).toBe(1)
})

test('an oversized latest complete tool batch can be summarized without retaining partial pairs', () => {
  const m = rows()
  m[10] = { ...m[10]!, role: 'assistant', toolUses: [{ tool_use_id: 'large', tool: 'Read', input: {} }] }
  m[11] = { ...m[11]!, role: 'user', text: '', toolResults: [{ tool_use_id: 'large', text: 'x'.repeat(30_000), isError: false }] }
  expect(recentTail(m)).toBe(m.length)
  m[11] = { ...m[11]!, toolResults: [] }
  expect(recentTail(m)).toBe(undefined)
})

test('repeated child permission-mode observations revoke classifier tokens without invalidating main summary', async () => {
  const f = fixture()
  noteMode(f.io, f.s, { permission_mode: 'bypassPermissions', agent_id: 'child' })
  const epoch = f.s.dropEpoch
  f.before(() => noteMode(f.io, f.s, { permission_mode: 'bypassPermissions', agent_id: 'child' }))
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(f.s.dropEpoch).toBeGreaterThan(epoch)
  expect(done.skip).toBe(undefined)
  expect(f.installed).toEqual(['main'])
})

test('an unrelated child mode change leaves the queued automatic main decision valid', async () => {
  const f = fixture(), auto = createAutoCompact(f.s)
  const port = { enabled: async () => true, estimate: async (p?: ContextPreparation) => constantEstimate(f.s, p), after: () => {}, enqueue: async () => {}, now: () => 0, debug: () => {} }
  await auto.schedule(port)
  noteMode(f.io, f.s, { permission_mode: 'auto', agent_id: 'child' })
  noteMode(f.io, f.s, { permission_mode: 'bypassPermissions', agent_id: 'child' })
  let dispatched = 0
  const result = await auto.run(port, async () => { dispatched++; return { messages: rows(2) } })
  expect(dispatched).toBe(1)
  expect(result.skip).toBe(undefined)
})

test('a child history rewrite revokes classifier state without invalidating the unchanged main summary', async () => {
  const f = fixture()
  await reconcileHistory(f.s, 'child', [{ role: 'user', content: 'old child history' }], f.io.debug)
  const backend: Backend = { ...f.backend, step: async function* (req) {
    f.requests.push(req)
    await reconcileHistory(f.s, 'child', [{ role: 'user', content: 'rewritten child history' }], f.io.debug)
    yield* events
  } }
  const done = await compact(f.io, f.s, backend, f.e, new AbortController().signal, f.native)
  expect(f.s.dropEpoch).toBeGreaterThan(0)
  expect(done.skip).toBe(undefined)
  expect(f.installed).toEqual(['main'])
})

test('a real permission change in the compacting loop still rejects the saved replacement', async () => {
  const f = fixture()
  noteMode(f.io, f.s, { permission_mode: 'auto' })
  f.before(() => noteMode(f.io, f.s, { permission_mode: 'bypassPermissions' }))
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('permission epoch changed')
  expect(f.installed).toEqual([])
})

test('a global permission invalidation still rejects main even when no classifier tokens exist', async () => {
  const f = fixture()
  f.before(() => dropTokens(f.io, f.s, 'PermissionRequest'))
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('permission epoch changed')
  expect(f.installed).toEqual([])
})

for (const [name, answer] of [
  ['truncated', [{ type: 'text', text: 'partial <klyth-summary-complete>' }, { type: 'stop', reason: 'max_tokens' }]],
  ['missing completion marker', [{ type: 'text', text: 'partial' }, { type: 'stop', reason: 'end_turn' }]],
  ['request failure', [{ type: 'error', kind: 'request', text: 'quota' }]],
  ['too much output', [{ type: 'text', text: 'x'.repeat(32_001) }]],
  ['too many output tokens', [...events, { type: 'usage', in: 0, out: 8001, cacheRead: 0, cacheWrite: 0 }]],
  ['unexpected tools', [{ type: 'tool_use', id: 'u', name: 'Read', input: {} }]],
] as [string, StepEvent[]][]) test(`${name} preserves original history and token estimate`, async () => {
  const f = fixture(rows(), answer)
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.messages).toBe(undefined)
  expect(done.skip).toContain('history kept')
  expect(f.installed).toEqual([])
  expect(f.s.promptTokens.get('main')?.tokens).toBe(900_000)
})

for (const change of ['route', 'config', 'history', 'revision', 'permissions', 'cancel'] as const) test(`${change} while summarizing rejects stale publication`, async () => {
  const f = fixture()
  const ac = new AbortController()
  f.before(() => {
    if (change === 'route') f.s.main = 'strong'
    if (change === 'config') f.s.loaded = { ...f.s.loaded }
    if (change === 'history') f.current([...rows(), ...rows(1)])
    if (change === 'revision') f.s.historyRevision.set('main', 1)
    if (change === 'permissions') f.s.permissionEpoch++
    if (change === 'cancel') ac.abort()
  })
  expect((await compact(f.io, f.s, f.backend, f.e, ac.signal, f.native)).messages).toBe(undefined)
  expect(f.installed).toEqual([])
})

test('precompute, untrusted provider and excessive source skip without any request', async () => {
  const f = fixture()
  expect((await compact(f.io, f.s, f.backend, { ...f.e, trigger: 'precompute' }, new AbortController().signal, f.native)).skip).toContain('installation time')
  f.io.trusted = async () => false
  expect((await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)).skip).toContain('not approved')
  f.io.trusted = async () => true
  const many = rows(18); many[0]!.text = 'x'.repeat(14_000_000)
  f.current(many)
  expect((await compact(f.io, f.s, f.backend, { ...f.e, messages: many }, new AbortController().signal, f.native)).skip).toContain('four bounded')
  expect(f.requests).toEqual([])
})

test('summary chunks respect actual quoted size when escaping density changes', () => {
  const source = 'x'.repeat(100) + '\\'.repeat(200)
  const pieces = summaryChunks(source, 250)!
  expect(pieces.join('')).toBe(source)
  expect(pieces.length).toBeLessThanOrEqual(4)
  for (const piece of pieces) expect(JSON.stringify(piece).length).toBeLessThanOrEqual(250)
})

test('summary chunk preflight rejects excessive input and keeps surrogate pairs together', () => {
  expect(summaryChunks('x'.repeat(1000), 250)).toBe(undefined)
  expect(summaryChunks('x', 2)).toBe(undefined)
  const source = 'a'.repeat(240) + '🌿'.repeat(100)
  const pieces = summaryChunks(source, 250)!
  expect(pieces.join('')).toBe(source)
  for (const piece of pieces) {
    expect(JSON.stringify(piece).length).toBeLessThanOrEqual(250)
    expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false)
    expect(/^[\uDC00-\uDFFF]/.test(piece)).toBe(false)
  }
})

test('oversized history chunks once and reduces only summaries with a bounded call count', async () => {
  const m = rows(); m[0]!.text = 'x'.repeat(3_600_000)
  const f = fixture(m)
  expect((await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)).skip).toBe(undefined)
  expect(f.requests.length).toBe(3)
  expect(JSON.stringify(f.requests.at(-1)?.transcript)).toContain('partialSummaries')
  expect(JSON.stringify(f.requests.at(-1)?.transcript).length < 2000).toBe(true)
})

test('routed threshold follows 780k at 1M and scales down for small models', () => {
  const m = parseConfig(CONFIG).config!.providers['acme']!.models['model-a']!
  expect(autoThreshold({ ...m, contextWindow: 1_000_000, maxInputTokens: 872_000 }, 'openai')).toBe(780_000)
  expect(autoThreshold({ ...m, contextWindow: 128_000, maxInputTokens: 120_000, maxOutputTokens: 8000 }, 'openai')).toBe(99_840)
})

test('automatic queue is detached, coalesces, respects off, rejects stale work and cools down failures', async () => {
  const f = fixture()
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  const auto = createAutoCompact(f.s)
  const callbacks: (() => void)[] = []
  let enabled = true, now = 0, queued = 0, compacted = 0
  const io = { enabled: async () => enabled, estimate: async (p?: ContextPreparation) => constantEstimate(f.s, p), after: (fn: () => void) => void callbacks.push(fn), enqueue: async () => { queued++ }, now: () => now, debug: () => {} }
  await auto.schedule(io); await auto.schedule(io)
  expect(queued).toBe(0); expect(callbacks.length).toBe(1)
  callbacks[0]!(); expect(queued).toBe(1)
  expect((await auto.run(io, async () => { compacted++; return { skip: 'failed' } })).skip).toBe('failed')
  await auto.schedule(io); expect(callbacks.length).toBe(1)
  now = 60_000; enabled = false; await auto.schedule(io); expect(callbacks.length).toBe(1)
  enabled = true; await auto.schedule(io); expect(callbacks.length).toBe(2)
  f.s.historyRevision.set('main', 1)
  expect((await auto.run(io, async () => { compacted++; return { messages: [] } })).skip).toContain('stale')
  expect(compacted).toBe(1)
})

const summaryStream = sse({ choices: [{ delta: { content: 'Summary.\n<klyth-summary-complete>' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 20 } }, '[DONE]')

test('manual routed dispatch bypasses a quota-throwing native bottom through the real backend and codec', async ($, on) => {
  let native = 0
  on('session.compact', () => { native++; throw new Error('native weekly quota exhausted') })
  const m = rows().map(m => ({ ...m, content: m.text }))
  const w = world(on, { messages: m, upstream: () => ({ pieces: [summaryStream] }), run: argv => argv.some(a => a.endsWith('/scripts/compact-draft.ts')) ? { exitCode: 0, stdout: '/config/klyth/compactions/fixture/draft.json' } : undefined })
  await start($); await model($, 'fast')
  const done = await $.session.compact({ trigger: 'manual', messages: m, instructions: 'keep restrictions' })
  expect(done.skip).toBe(undefined)
  expect(native).toBe(0)
  expect(w.requests[0]?.body['max_completion_tokens']).toBe(8000)
  expect((w.requests[0]?.body['tools'] as unknown[]).length > 0).toBe(true)
  expect(w.wires[0]).toMatchObject({ req: { who: 'compact:main', compaction: { outputTokens: 8000 } } })
})



test('an uncappable Responses model keeps its declared reservations and sends no invented output limit', async () => {
  const f = fixture()
  const config = JSON.stringify({ providers: { p: { kind: 'openai-responses', baseUrl: 'https://klyth.invalid', auth: 'none', models: { m: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 } } } }, aliases: { fast: 'p/m' } })
  f.s.loaded = { ...f.s.loaded, config: parseConfig(config).config!, text: config }
  expect((await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)).skip).toBe(undefined)
  expect(f.requests[0]?.compaction).toEqual({ prefixMessages: 12 })
})

test('native main passes through the exact result and concurrent routed work skips without another request', async () => {
  const f = fixture()
  f.s.main = null
  const done = { messages: rows(2) }
  expect(await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, async () => done)).toBe(done)
  f.s.main = 'fast'; f.s.compacting.add('main')
  expect((await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)).skip).toContain('in progress')
  expect(f.requests).toEqual([])
})

test('primary progress reports preparation, provider wait, receive, completed call and validation honestly', async () => {
  const f = fixture()
  const progress: CompactProgress[] = []
  f.io.progress = p => { progress.push(p) }
  await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(progress.map(p => p.stage)).toEqual(['preparing', 'preparing', 'awaiting provider', 'receiving summary', 'completed', 'saving draft', 'validating', 'ready to install'])
  expect(progress.find(p => p.stage === 'awaiting provider')).toMatchObject({ path: 'cache-friendly', completed: 0, total: 1 })
  expect(progress.find(p => p.stage === 'receiving summary')).toMatchObject({ chars: events[0]!.type === 'text' ? events[0]!.text.length : 0, completed: 0 })
  expect(progress.at(-1)).toMatchObject({ completed: 1, total: 1, stage: 'ready to install' })
  expect(progressText(progress.at(-1)!, 492_000)).not.toContain('1/1')
  expect(progressText(progress.at(-1)!, 492_000)).toContain('replacement ready for host installation')
  expect(progressText(progress.at(-1)!, 492_000)).toContain('8m12s')
})

test('uncached progress counts chunks and reduction as completed calls, not elapsed percentage', async () => {
  const m = rows(); m[0]!.text = 'x'.repeat(3_600_000)
  const f = fixture(m)
  const progress: CompactProgress[] = []
  f.io.progress = p => { progress.push(p) }
  await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  const waiting = progress.filter(p => p.stage === 'awaiting provider')
  expect(waiting.map(p => [p.completed, p.total, p.chunk, p.reduction])).toEqual([[0, 3, 1, undefined], [1, 3, 2, undefined], [2, 3, undefined, true]])
  expect(progress.filter(p => p.stage === 'completed').map(p => p.completed)).toEqual([1, 2, 3])
  expect(progressText(waiting[1]!, 599_000)).toContain('[■■□□□□□□] 1/3')
  expect(progressText(waiting[1]!, 0)).toContain('large-history summary · part 2 of 2')
  expect(progressText(waiting[2]!, 0)).toContain('combining summaries')
})

test('heartbeat pins live status, debug-logs milestones once and ignores stale callbacks after finish', () => {
  const timers: { fn: () => void; cancelled: boolean }[] = []
  const status: string[] = [], logs: string[] = []
  let restored = 0
  const p = createCompactProgress({ after: (ms, fn) => { expect(ms).toBe(1000); const t = { fn, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true } } }, status: text => { status.push(text) }, debug: text => { logs.push(text) }, restoreStatus: () => { restored++ } })
  const event: CompactProgress = { stage: 'awaiting provider', path: 'cache-friendly', completed: 0, total: 1 }
  p.update(event)
  timers[0]!.fn()
  expect(status.length).toBe(2)
  expect(logs.length).toBe(1)
  p.update({ ...event, stage: 'receiving summary', chars: 20 })
  p.update({ ...event, stage: 'receiving summary', chars: 40 })
  expect(logs.length).toBe(2)
  p.finish(); p.finish()
  expect(restored).toBe(1)
  expect(timers.at(-1)?.cancelled).toBe(true)
  const count = status.length
  timers.at(-1)!.fn(); p.update(event)
  expect(status.length).toBe(count)
  expect(timers.length).toBe(2)
})

for (const outcome of ['success', 'error', 'abort', 'timeout', 'reload'] as const) test(`adapter releases progress and restores status on ${outcome}`, async () => {
  const f = fixture(rows(), outcome === 'error' ? [{ type: 'error', kind: 'request', text: 'failed' }] : events)
  const adapter = createCompactAdapter(f.s)
  const ac = new AbortController()
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const status: string[] = [], logs: string[] = [], transcript: string[] = []
  let restored = 0
  const io = { ...f.io, after: (ms: number, fn: () => void) => { const t = { ms, fn, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true } } }, status: (text: string) => { status.push(text) }, debug: (text: string) => { logs.push(text) }, log: (text: string) => { transcript.push(text) }, restoreStatus: () => { restored++ } }
  f.before(() => { if (outcome === 'abort') ac.abort(); if (outcome === 'timeout') timers.find(t => t.ms === 1_200_000)!.fn(); if (outcome === 'reload') adapter.end() })
  const done = await adapter.compact(io, f.backend, f.e, ac.signal, f.native)
  expect(done.skip === undefined).toBe(outcome === 'success')
  expect(restored).toBe(1)
  expect(timers.every(t => t.cancelled)).toBe(true)
  expect(status[0]).toContain('preparing')
  const count = status.length
  timers.filter(t => t.ms === 1000).forEach(t => t.fn())
  expect(status.length).toBe(count)
  expect(logs.some(text => text.includes('conversation summary'))).toBe(true)
  expect(transcript).toEqual([])
})

test('child progress never touches main status and native passthrough never starts a heartbeat', async () => {
  const f = fixture()
  const adapter = createCompactAdapter(f.s)
  let writes = 0, timers = 0
  const io = { ...f.io, after: () => { timers++; return { cancel() {} } }, status: () => { writes++ }, restoreStatus: () => { writes++ }, log: () => { writes++ } }
  f.s.routes.set('child', { target: 'strong', label: 'strong' })
  f.s.sentContext.set('child', { loaded: f.s.loaded, routeKey: '', model: 'native-child', messageCount: 12, turnId: 'child-turn' })
  expect((await adapter.compact(io, f.backend, { ...f.e, agentId: 'child' }, new AbortController().signal, f.native)).skip).toBe(undefined)
  expect(writes).toBe(0)
  expect(timers).toBe(1)
  f.s.main = null
  const native = { messages: rows(2) }
  expect(await adapter.compact(io, f.backend, f.e, new AbortController().signal, async () => native)).toBe(native)
  expect(writes).toBe(0)
  expect(timers).toBe(1)
})


test('public getter outcome enrichment and key order do not reject unchanged handled history', async () => {
  const messages = rows()
  messages[1]!.toolUses = [{ tool_use_id: 'read', tool: 'Read', input: { path: '/fixture', offset: 1 } }]
  const f = fixture(messages)
  const getter = messages.map(({ handle: _handle, ...row }) => ({ ...row, toolResults: [], toolUses: row.toolUses.map(use => ({ ...use, input: { offset: 1, path: '/fixture' }, text: 'result', result: { bytes: 5 } })) }))
  f.io.rows = async () => getter
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toBe(undefined)
  expect(done.messages?.[1]).toBe(messages[6])
})

test('preflight rejects genuinely different source rows before paid requests without logging text', async () => {
  const f = fixture()
  const debug: string[] = []
  f.io.debug = text => { debug.push(text) }
  f.current(rows().map((row, i) => i === 0 ? { ...row, text: 'PRIVATE EDIT' } : row))
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('source history mismatch before dispatch')
  expect(done.skip).toContain('fields text')
  expect(debug.join(' ')).not.toContain('PRIVATE EDIT')
  expect(f.requests).toEqual([])
})

test('complete final draft is stored before stale installation checks and its path survives rejection', async () => {
  const f = fixture()
  const drafts: string[] = []
  f.io.saveDraft = async draft => { drafts.push(draft.summary); f.s.permissionEpoch++; return '/config/klyth/compactions/fixture/saved.json' }
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(drafts).toEqual(['Preserved work and restrictions.'])
  expect(done.skip).toContain('permission epoch changed')
  expect(done.skip).toContain('/config/klyth/compactions/fixture/saved.json (not installed)')
  expect(done.messages).toBe(undefined)
  expect(f.installed).toEqual([])
})

test('draft storage failure preserves history and reports actionable failure', async () => {
  const f = fixture()
  f.io.saveDraft = async () => { throw new Error('private draft storage failed; check available disk space') }
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('check available disk space')
  expect(done.messages).toBe(undefined)
  expect(f.installed).toEqual([])
})

for (const change of ['edit', 'rewind', 'outcome'] as const) test(`same-getter ${change} rejects installation after preserving final draft`, async () => {
  const original = rows()
  if (change === 'outcome') original[1]!.toolUses = [{ tool_use_id: 'same', tool: 'Read', input: {}, text: 'before' }]
  const f = fixture(original)
  let saves = 0
  f.io.saveDraft = async () => { saves++; return '/config/klyth/compactions/fixture/saved.json' }
  f.before(() => {
    const changed = original.map(row => ({ ...row, toolUses: row.toolUses.map(use => ({ ...use })) }))
    if (change === 'edit') changed[0]!.text = 'EDIT'
    if (change === 'rewind') changed.pop()
    if (change === 'outcome') changed[1]!.toolUses[0]!.text = 'after'
    f.current(changed)
  })
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('message history changed')
  expect(done.skip).toContain('saved.json')
  expect(saves).toBe(1)
  expect(f.installed).toEqual([])
})


test('API history key ordering is benign but an API-only content edit rejects and saves', async () => {
  for (const edited of [false, true]) {
    const f = fixture()
    let reads = 0
    f.io.transcript = async () => {
      reads++
      return rows().map((row, i) => reads === 1 ? { role: row.role, content: row.text } : { content: edited && i === 0 ? 'PRIVATE API EDIT' : row.text, role: row.role })
    }
    const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
    if (edited) {
      expect(done.skip).toContain('API history changed')
      expect(done.skip).toContain('/compactions/fixture/draft.json')
      expect(done.skip).not.toContain('PRIVATE API EDIT')
      expect(f.installed).toEqual([])
    } else expect(done.skip).toBe(undefined)
  }
})

for (const instructions of [undefined, 'preserve fixture']) test(`manual compact command projection with ${instructions ?? 'no emphasis'} retains handled source and actual API prefix`, async () => {
  const f = fixture(rows(8))
  const source = f.e.messages
  const suffix: SessionMessage = { role: 'user', text: `/compact${instructions ? ` ${instructions}` : ''}`, toolUses: [] }
  f.current([...source, suffix])
  const done = await compact(f.io, f.s, f.backend, { ...f.e, instructions }, new AbortController().signal, f.native)
  expect(done.skip).toBe(undefined)
  expect(done.messages?.slice(1)).toEqual(source.slice(2))
  expect(done.messages?.[1]).toBe(source[2])
  expect(f.requests[0]?.transcript.slice(0, -1)).toEqual([...source, suffix].map(m => ({ role: m.role, content: m.text })))
})

for (const shape of ['arbitrary append', 'wrong emphasis', 'edited prefix', 'two commands', 'tool-bearing command', 'plugin trigger', 'child loop'] as const) test(`manual projection refuses ${shape} before dispatch`, async () => {
  const f = fixture(rows(8))
  const current = [...f.e.messages, { role: 'user' as const, text: '/compact preserve fixture', toolUses: [] }]
  if (shape === 'arbitrary append') current[8] = { ...current[8]!, text: 'a genuine new user request' }
  if (shape === 'wrong emphasis') current[8] = { ...current[8]!, text: '/compact something else' }
  if (shape === 'edited prefix') current[0] = { ...current[0]!, text: 'modified original' }
  if (shape === 'two commands') current.push(current[8]!)
  if (shape === 'tool-bearing command') current[8] = { ...current[8]!, toolUses: [{ tool_use_id: 'extra', tool: 'Read', input: {} }] }
  f.current(current)
  if (shape === 'child loop') f.s.routes.set('child', { target: 'fast', label: 'fast' })
  const done = await compact(f.io, f.s, f.backend, { ...f.e, instructions: 'preserve fixture', ...(shape === 'plugin trigger' ? { trigger: 'plugin' } : {}), ...(shape === 'child loop' ? { agentId: 'child' } : {}) }, new AbortController().signal, f.native)
  expect(done.skip).toContain('source history mismatch before dispatch')
  expect(f.requests).toEqual([])
  expect(f.installed).toEqual([])
})

for (const change of ['append', 'same-count edit', 'command edit', 'rewind'] as const) test(`manual projection still rejects concurrent ${change} after saving the final draft`, async () => {
  const f = fixture(rows(8))
  const source = f.e.messages
  const initial = [...source, { role: 'user' as const, text: '/compact preserve fixture', toolUses: [] }]
  f.current(initial)
  let saved = false
  f.io.saveDraft = async () => { saved = true; return '/config/klyth/compactions/fixture/draft.json' }
  f.before(() => {
    const modified = initial.map(m => ({ ...m }))
    if (change === 'append') modified.push({ role: 'user', text: 'real concurrent append', toolUses: [] })
    if (change === 'same-count edit') modified[0]!.text = 'rewound and replaced at the same row count'
    if (change === 'command edit') modified[8]!.text = '/compact different instructions'
    if (change === 'rewind') modified.splice(3, 1)
    f.current(modified)
  })
  const done = await compact(f.io, f.s, f.backend, { ...f.e, instructions: 'preserve fixture' }, new AbortController().signal, f.native)
  expect(done.skip).toContain('message history changed')
  expect(done.skip).toContain('/compactions/fixture/draft.json')
  expect(saved).toBe(true)
  expect(f.installed).toEqual([])
})


test('cold automatic eligibility estimates current system, tools and history without fabricating usage', async () => {
  const f = fixture()
  f.io.compose = async () => [{ id: 'intro', text: 'system'.repeat(450_000) }]
  f.io.list = async () => [{ name: 'Read', description: 'tool'.repeat(200_000), mcp: false }]
  const estimate = await currentContext(f.io, f.s)
  expect(estimate!).toBeGreaterThan(900_000)
  expect(f.s.promptTokens.size).toBe(0)
  expect(f.requests.length).toBe(0)
  const callbacks: (() => void)[] = []
  let dispatches = 0
  const auto = createAutoCompact(f.s)
  const io = { enabled: async () => true, estimate: (p?: ContextPreparation) => currentContext(f.io, f.s, p), after: (fn: () => void) => void callbacks.push(fn), enqueue: async () => { dispatches++ }, now: () => 0, debug: () => {} }
  await auto.schedule(io)
  expect(dispatches).toBe(0); expect(callbacks.length).toBe(1)
  auto.cancel(); callbacks[0]!()
  expect(dispatches).toBe(0)
})

for (const change of ['append', 'shrink', 'same-count'] as const) test(`compaction validates cached prefix before reuse on ${change}`, async () => {
  const f = fixture(), api = f.e.messages.map(m => ({ role: m.role, content: m.text }))
  f.s.sent.set('main', { target: 'fast', system: 'CACHED SYSTEM', tools: [] })
  f.s.sentContext.set('main', { loaded: f.s.loaded, routeKey: '{}', model: 'native', messageCount: api.length, prefix: await historyPrefix(api), turnId: 'old' })
  await reconcileHistory(f.s, 'main', api, () => {})
  let current = rows(change === 'append' ? 14 : change === 'shrink' ? 10 : 12)
  if (change === 'same-count') current = current.map((m, i) => i === 0 ? { ...m, text: 'edited request' } : m)
  f.current(current)
  const done = await compact(f.io, f.s, f.backend, { ...f.e, messages: current }, new AbortController().signal, f.native)
  expect(done.skip).toBe(undefined)
  expect(f.requests[0]?.compaction?.prefixMessages).toBe(change === 'append' ? 12 : current.length)
  expect(f.requests[0]?.system).toBe(change === 'append' ? 'CACHED SYSTEM' : 'NORMAL SYSTEM')
})

test('child rewind rebuilds the header with its own native model provenance', async () => {
  const f = fixture(), api = f.e.messages.map(m => ({ role: m.role, content: m.text }))
  f.s.routes.set('child', { target: 'strong', label: 'strong', type: 'claude' })
  f.s.sent.set('child', { target: 'strong', system: 'STALE CHILD', tools: [] })
  f.s.sentContext.set('child', { loaded: f.s.loaded, routeKey: '', model: 'native-child', effort: 'high', messageCount: 12, prefix: await historyPrefix(api), turnId: 'old' })
  await reconcileHistory(f.s, 'child', api, () => {})
  const current = rows(10)
  f.current(current)
  let composedModel = ''
  f.io.compose = async model => { composedModel = model; return [{ id: 'intro', text: 'REBUILT CHILD' }] }
  const done = await compact(f.io, f.s, f.backend, { ...f.e, agentId: 'child', messages: current }, new AbortController().signal, f.native)
  expect(done.skip).toBe(undefined)
  expect(composedModel).toBe('native-child')
  expect(f.requests[0]?.system).toContain('REBUILT CHILD')
  expect(f.requests[0]?.compaction?.prefixMessages).toBe(10)
})


test('a cold stamped header with an edited prefix is rebuilt even without previous raw history metadata', async () => {
  const f = fixture(), api = f.e.messages.map(m => ({ role: m.role, content: m.text }))
  f.s.sent.set('main', { target: 'fast', system: 'STALE PREFIX', tools: [] })
  f.s.sentContext.set('main', { loaded: f.s.loaded, routeKey: '{}', model: 'native', messageCount: api.length, prefix: await historyPrefix(api), turnId: 'old' })
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: api.length })
  const current = rows().map((m, i) => i === 0 ? { ...m, text: 'changed source' } : m)
  f.current(current)
  expect((await compact(f.io, f.s, f.backend, { ...f.e, messages: current }, new AbortController().signal, f.native)).skip).toBe(undefined)
  expect(f.requests[0]?.system).toBe('NORMAL SYSTEM')
  expect(f.requests[0]?.compaction?.prefixMessages).toBe(current.length)
})


for (const change of ['epoch', 'revision'] as const) test(`initial reconciliation cannot swallow an independent ${change} change during API preflight`, async () => {
  const f = fixture()
  await reconcileHistory(f.s, 'main', [{ role: 'user', content: 'removed source' }], () => {})
  const read = f.io.transcript
  f.io.transcript = async id => {
    const rows = await read(id)
    if (change === 'epoch') f.s.permissionEpoch++
    else f.s.historyRevision.set('main', 1)
    return rows
  }
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toContain('changed before dispatch')
  expect(f.requests).toEqual([])
})


test('session end cancels the bounded automatic callback and drops ended-session person permissions', async () => {
  const f = fixture(), adapter = createCompactAdapter(f.s)
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  f.s.prompts = ['old permission']; f.s.currentPrompt = 'old request'
  f.s.tokens.set('main\nRead\n{}', { until: 100, step: 0, cwd: '/w', source: 'model-fresh' })
  const timers: { fn: () => void; cancelled: boolean }[] = []
  let commands = 0
  const io = { ...f.io, enabled: async () => true, estimate: async (p?: ContextPreparation) => constantEstimate(f.s, p), run: async () => { commands++; return {} }, log: () => {}, status: () => {}, restoreStatus: () => {}, after: (_ms: number, fn: () => void) => { const t = { fn, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true } } } }
  await adapter.schedule(io)
  expect(timers.length).toBe(1)
  adapter.end(); timers[0]!.fn()
  expect(timers[0]?.cancelled).toBe(true)
  expect(commands).toBe(0); expect(f.s.prompts).toEqual([]); expect(f.s.tokens.size).toBe(0)
  expect(f.s.promptTokens.has('main')).toBe(false)
})


test('unvalidated measured usage alone cannot make automatic compaction eligible', async () => {
  const f = fixture(), auto = createAutoCompact(f.s)
  f.s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  const callbacks: (() => void)[] = []
  await auto.schedule({ enabled: async () => true, estimate: async () => undefined, after: fn => void callbacks.push(fn), enqueue: async () => {}, now: () => 0, debug: () => {} })
  expect(callbacks).toEqual([])
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

for (const projection of ['LF', 'coalesced', 'shrink'] as const) test(`one automatic boundary survives its own ${projection} reconciliation`, async () => {
  const f = fixture(), auto = createAutoCompact(f.s), callbacks: (() => void)[] = []
  const old = [{ role: 'user' as const, content: 'x'.repeat(3_000_000) }, { role: 'assistant' as const, content: 'old' }]
  await reconcileHistory(f.s, 'main', old, f.io.debug)
  const read = projection === 'shrink' ? old.slice(0, 1) : [{ ...old[0]!, content: old[0]!.content + (projection === 'LF' ? '\n' : '\nnew person request') }, old[1]!]
  f.io.transcript = async () => read
  const port = { enabled: async () => true, estimate: (preparation?: ContextPreparation) => currentContext(f.io, f.s, preparation), after: (fn: () => void) => void callbacks.push(fn), enqueue: async () => {}, now: () => 0, debug: f.io.debug }
  await auto.schedule(port)
  expect(callbacks.length).toBe(1)
  expect(f.s.dropEpoch).toBe(1); expect(f.s.historyRevision.get('main')).toBe(1)
  expect(f.s.promptTokens.size).toBe(0)
  let dispatched = 0
  await auto.run(port, async decision => { dispatched++; expect(decision.raw?.count).toBe(read.length); expect(decision.boundary.epoch).toBe(0); expect(decision.boundary.revision).toBe(1); return { messages: [] } })
  expect(dispatched).toBe(1)
})

const boundaryChanges = {
  route: (s: ReturnType<typeof createSession>) => { s.main = 'strong' },
  config: (s: ReturnType<typeof createSession>) => { s.loaded = { ...s.loaded } },
  epoch: (s: ReturnType<typeof createSession>) => { s.permissionEpoch++ },
  revision: (s: ReturnType<typeof createSession>) => { s.historyRevision.set('main', 1) },
  'away-and-back': (s: ReturnType<typeof createSession>) => { s.mainChoiceRevision += 2 },
}
for (const [change, mutate] of Object.entries(boundaryChanges)) for (const operation of ['enabled', 'estimate'] as const) test(`automatic execution rejects ${change} during awaited ${operation}`, async () => {
  const f = fixture(), auto = createAutoCompact(f.s), entered = deferred<void>(), release = deferred<void>()
  let holding = false, dispatches = 0
  const wait = async () => { if (holding) { entered.resolve(); await release.promise } }
  const port = { enabled: async () => { if (operation === 'enabled') await wait(); return true }, estimate: async (p?: ContextPreparation) => { if (operation === 'estimate') await wait(); return constantEstimate(f.s, p) }, after: () => {}, enqueue: async () => {}, now: () => 0, debug: () => {} }
  await auto.schedule(port); holding = true
  const running = auto.run(port, async () => { dispatches++; return { messages: [] } })
  await entered.promise; mutate(f.s); release.resolve()
  expect((await running).skip).toContain('stale'); expect(dispatches).toBe(0)
})

for (const method of ['transcript', 'engineModel', 'list', 'loadedMcp', 'compose'] as const) test(`automatic preparation validates the boundary after ${method}`, async () => {
  const f = fixture(), auto = createAutoCompact(f.s), entered = deferred<void>(), release = deferred<void>(), callbacks: (() => void)[] = []
  const original = f.io[method]
  // All chosen methods have no required arguments in the main observational lane.
  Object.assign(f.io, { [method]: async (...args: unknown[]) => { entered.resolve(); await release.promise; return (original as (...args: unknown[]) => unknown)(...args) } })
  const preparation = auto.schedule({ enabled: async () => true, estimate: p => currentContext(f.io, f.s, p), after: fn => void callbacks.push(fn), enqueue: async () => {}, now: () => 0, debug: () => {} })
  await entered.promise; f.s.mainChoiceRevision += 2; release.resolve(); await preparation
  expect(callbacks.length).toBe(0)
  expect(f.s.historyPrefixes.size).toBe(method === 'transcript' ? 0 : 1)
})

test('a stale preparation cannot commit history or clear its replacement owner', async () => {
  const f = fixture(), auto = createAutoCompact(f.s), entered = deferred<void>(), release = deferred<void>(), callbacks: (() => void)[] = []
  let first = true
  const port = { enabled: async () => { if (first) { first = false; entered.resolve(); await release.promise } return true }, estimate: async (p?: ContextPreparation) => constantEstimate(f.s, p), after: (fn: () => void) => void callbacks.push(fn), enqueue: async () => {}, now: () => 0, debug: () => {} }
  const obsolete = auto.schedule(port)
  await entered.promise; f.s.permissionEpoch++; await auto.schedule(port); release.resolve(); await obsolete
  await auto.schedule(port)
  expect(callbacks.length).toBe(1)
  let dispatches = 0
  await auto.run(port, async () => { dispatches++; return { messages: [] } })
  expect(dispatches).toBe(1)
})

test('automatic execution refuses a same-count raw edit even when the estimated size stays eligible', async () => {
  const f = fixture(), auto = createAutoCompact(f.s)
  let text = 'x'.repeat(3_000_000), dispatched = 0
  f.io.transcript = async () => [{ role: 'user', content: text }]
  const port = { enabled: async () => true, estimate: (p?: ContextPreparation) => currentContext(f.io, f.s, p), after: () => {}, enqueue: async () => {}, now: () => 0, debug: () => {} }
  await auto.schedule(port); text = 'y'.repeat(3_000_000)
  expect((await auto.run(port, async () => { dispatched++; return { messages: [] } })).skip).toContain('stale')
  expect(dispatched).toBe(0)
})

test('semantic recovery preserves rendered restrictions, tool input, and attributed structured-only facts once', () => {
  const stdout = 'complete stdout'.repeat(100)
  const older: SessionMessage[] = [
    { role: 'user', text: 'Do not publish. Keep the full request.', toolUses: [] },
    { role: 'assistant', text: 'Proposal, not approval.', toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'inspect' }, text: stdout, result: { stdout, exitCode: 7, privateFact: 'only structured' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: stdout, isError: false, result: { stdout, exitCode: 7, privateFact: 'only structured' } }] },
  ]
  const api = [
    { role: 'user' as const, content: `${older[0]!.text}\n<system-reminder>Never delete files.</system-reminder>` },
    { role: 'assistant' as const, content: [{ type: 'text', text: older[1]!.text }, { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'inspect' } }] },
    { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'c1', content: stdout }] },
  ]
  const source = recoverySource(older, api, []).join('\n')
  expect(source.split(stdout).length - 1).toBe(1)
  expect(source).toContain('Never delete files.'); expect(source).toContain('Do not publish.')
  expect(source).toContain('Proposal, not approval.'); expect(source).toContain('only structured'); expect(source).toContain('exitCode'); expect(source).toContain('inspect')
  expect(source.indexOf('tool_use')).toBeLessThan(source.indexOf('tool_result'))
})

test('message-aware recovery packs whole rows and attributes individually oversized continuations', () => {
  const small = [JSON.stringify({ message: 1, text: 'one' }), JSON.stringify({ message: 2, text: 'two' })]
  expect(recoveryPieces(small, 200, summaryChunks)).toEqual([small.join('\n')])
  const row = JSON.stringify({ message: 3, text: '"\\😀'.repeat(150) })
  const pieces = recoveryPieces([row], 1200, summaryChunks)!
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces.every(piece => JSON.stringify(piece).length <= 1200)).toBe(true)
  expect(pieces.every(piece => piece.startsWith('Message 1, part '))).toBe(true)
  expect(pieces.map(piece => piece.slice(piece.indexOf('\n') + 1)).join('')).toBe(row)
})

test('rich getter recovery that formerly exceeded four pieces dispatches bounded semantic input without losing stdout', async () => {
  const stdout = 'z'.repeat(3_000_000)
  const messages: SessionMessage[] = [
    { role: 'user', text: 'Preserve this full restriction: no publication.', toolUses: [] },
    { role: 'assistant', text: 'Inspecting.', toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'inspect' }, text: stdout, result: { stdout, exitCode: 3 } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: stdout, isError: false, result: { stdout, exitCode: 3 } }] },
    ...rows(9),
  ]
  const f = fixture(messages)
  const api = [
    { role: 'user' as const, content: messages[0]!.text + '\n<system-reminder>Original rendered context.</system-reminder>' },
    { role: 'assistant' as const, content: [{ type: 'text', text: 'Inspecting.' }, { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'inspect' } }] },
    { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'c1', content: stdout }] },
    ...messages.slice(3).map(row => ({ role: row.role, content: row.text })),
  ]
  f.io.transcript = async () => api
  // Force recovery without allowing the normal prompt to consume its piece budget.
  f.io.compose = async () => [{ id: 'intro', text: 'NORMAL SYSTEM'.repeat(100_000) }]
  expect(summaryChunks(JSON.stringify(messages.slice(0, 6)), 2_700_000)).toBe(undefined)
  const done = await compact(f.io, f.s, f.backend, f.e, new AbortController().signal, f.native)
  expect(done.skip).toBe(undefined)
  expect(f.requests.length).toBeGreaterThan(1); expect(f.requests.length).toBeLessThanOrEqual(5)
  const source = f.requests.slice(0, -1).map(req => String(req.transcript[0]!.content)).join('')
  expect(source).toContain('no publication.'); expect(source).toContain('Original rendered context.'); expect(source).toContain('exitCode'); expect(source).toContain('inspect')
  expect(source.split('z').length - 1).toBe(3_000_000)
  expect(f.requests.every(req => req.tools.length === 0)).toBe(true)
})

for (const change of ['stable', 'disabled', 'away-and-back', 'raw-edit'] as const) test(`original automatic decision survives idle dispatch only for ${change}`, async () => {
  const f = fixture(), adapter = createCompactAdapter(f.s), entered = deferred<void>(), release = deferred<void>(), finished = deferred<void>()
  const callbacks: (() => void)[] = []
  let enabled = true, result: Awaited<ReturnType<typeof adapter.compact>> | undefined, nativeCalls = 0
  f.io.compose = async () => [{ id: 'intro', text: 'SYSTEM'.repeat(550_000) }]
  const engine = { ...f.io, status: () => {}, restoreStatus: () => {}, enabled: async () => enabled, estimate: (p?: ContextPreparation) => currentContext(f.io, f.s, p), after: (_ms: number, fn: () => void) => { callbacks.push(fn); return { cancel() {} } }, log: () => {}, run: async () => {
    entered.resolve(); await release.promise
    result = await adapter.compact({ ...f.io, enabled: async () => enabled }, f.backend, f.e, new AbortController().signal, async () => { nativeCalls++; return { messages: [] } })
    finished.resolve(); return { text: 'done' }
  } }
  await adapter.schedule(engine); expect(callbacks.length).toBe(1); callbacks[0]!(); await entered.promise
  if (change === 'disabled') enabled = false
  if (change === 'away-and-back') f.s.mainChoiceRevision += 2
  if (change === 'raw-edit') f.current(rows().map((row, i) => i === 0 ? { ...row, text: 'edited request' } : row))
  release.resolve(); await finished.promise
  expect(nativeCalls).toBe(0)
  expect(result?.skip === undefined).toBe(change === 'stable')
  expect(f.requests.length > 0).toBe(change === 'stable')
})

for (const stage of ['provider', 'draft'] as const) test(`automatic ${stage} invalidation preserves the complete draft before rejecting installation`, async () => {
  const f = fixture(), adapter = createCompactAdapter(f.s), finished = deferred<void>(), callbacks: (() => void)[] = []
  let result: Awaited<ReturnType<typeof adapter.compact>> | undefined
  f.io.compose = async () => [{ id: 'intro', text: 'SYSTEM'.repeat(550_000) }]
  if (stage === 'provider') f.before(() => { f.s.mainChoiceRevision += 2 })
  else f.io.saveDraft = async () => { f.s.mainChoiceRevision += 2; return '/config/klyth/compactions/fixture/final.json' }
  const engine = { ...f.io, status: () => {}, restoreStatus: () => {}, enabled: async () => true, estimate: (p?: ContextPreparation) => currentContext(f.io, f.s, p), after: (_ms: number, fn: () => void) => { callbacks.push(fn); return { cancel() {} } }, log: () => {}, run: async () => {
    result = await adapter.compact({ ...f.io, enabled: async () => true }, f.backend, f.e, new AbortController().signal, f.native)
    finished.resolve(); return { text: 'done' }
  } }
  await adapter.schedule(engine); callbacks[0]!(); await finished.promise
  expect(result?.skip).toContain('complete draft saved at')
  expect(result?.skip).toContain(stage === 'draft' ? 'final.json' : 'draft.json')
  expect(f.requests.length).toBe(1)
})

test('overlapping preparations reserve their owner before the first awaited setting read', async () => {
  const f = fixture(), auto = createAutoCompact(f.s), entered = deferred<void>(), release = deferred<void>(), callbacks: (() => void)[] = []
  let reads = 0
  const port = { enabled: async () => { reads++; entered.resolve(); await release.promise; return true }, estimate: async (p?: ContextPreparation) => constantEstimate(f.s, p), after: (fn: () => void) => void callbacks.push(fn), enqueue: async () => {}, now: () => 0, debug: () => {} }
  const pending = auto.schedule(port); await entered.promise; await auto.schedule(port)
  expect(reads).toBe(1); release.resolve(); await pending
  expect(callbacks.length).toBe(1)
})

test('failed callback registration releases its owner for the next lifecycle boundary', async () => {
  const f = fixture(), auto = createAutoCompact(f.s), callbacks: (() => void)[] = []
  let failing = true
  const port = { enabled: async () => true, estimate: async (p?: ContextPreparation) => constantEstimate(f.s, p), after: (fn: () => void) => { if (failing) throw new Error('clock unavailable'); callbacks.push(fn) }, enqueue: async () => {}, now: () => 0, debug: () => {} }
  let failure: unknown
  try { await auto.schedule(port) } catch (err) { failure = err }
  expect(String(failure)).toContain('clock unavailable')
  failing = false; await auto.schedule(port); expect(callbacks.length).toBe(1)
})

for (const flag of ['setting', 'effective'] as const) test(`automatic switch ${flag} validates ownership after its asynchronous read`, async () => {
  const entered = deferred<void>(), release = deferred<void>()
  let valid = true, effectiveReads = 0
  const enabled = autoEnabled(async () => { if (flag === 'setting') { entered.resolve(); await release.promise } return true }, async () => { effectiveReads++; if (flag === 'effective') { entered.resolve(); await release.promise } return true }, () => valid)
  await entered.promise; valid = false; release.resolve()
  expect(await enabled).toBe(false)
  expect(effectiveReads).toBe(flag === 'setting' ? 0 : 1)
})
