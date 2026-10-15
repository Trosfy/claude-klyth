import { expect, test } from 'bun:test'
import { createBackend } from '../hooks/backend'
import { compact } from '../hooks/compact'
import type { CompactPort } from '../hooks/compact'
import { createCompactAdapter } from '../hooks/compact-adapter'
import { historyPrefix, reconcileHistoryReceipt } from '../hooks/history-context'
import { recoverySource } from '../hooks/compact-source'
import { parseConfig } from '../hooks/config'
import { currentContext } from '../hooks/request'
import { turnStep } from '../hooks/routing'
import { createSession } from '../hooks/session'
import { fakeDaemon } from '../tests/daemon-fake'
import { modelCommand } from '../hooks/model'
import { persistMainChoice } from '../hooks/main-choice'
import type { Backend } from '../hooks/protocol'

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const config = JSON.stringify({ providers: { p: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: 'none', models: { m: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000, maxTokensParam: 'max_completion_tokens' } } } }, aliases: { fast: 'p/m' } })
function fixture() {
  const s = createSession(); s.loaded = { config: parseConfig(config).config!, text: config, errors: [], missing: false, path: 'klyth.json' }; s.main = 'fast'
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: `message ${i}`, toolUses: [], handle: `h${i}` }))
  const io: CompactPort = { saveDraft: async () => '/config/klyth/compactions/fixture/draft.json', engineModel: async () => 'native', transcript: async () => messages.map(m => ({ role: m.role, content: m.text })), compose: async () => [{ id: 'intro', text: 'NORMAL SYSTEM' }], cwd: async () => '/w', configDir: async () => '/config', exists: async () => false, read: async () => '', listDir: async () => [], run: async () => ({ exitCode: 0, stdout: 'Darwin', stderr: '' }), now: async () => 0, list: async () => [], loadedMcp: async () => new Set<string>(), main: async () => s.main, pin: async () => s.pin, route: async id => s.routes.get(id), trusted: async () => true, rows: async () => messages, after: () => ({ cancel() {} }), debug: () => {}, toast: () => {}, compacted: () => {} }
  const backend: Backend = { configure: async () => {}, start: async () => {}, status: async () => [], step: async function* () { yield { type: 'text', text: 'Summary.\n<klyth-summary-complete>' }; yield { type: 'stop', reason: 'end_turn' } } }
  return { s, io, backend, messages }
}

test('manual compaction rejects a choice-generation change while the provider is awaited', async () => {
  const f = fixture(), reached = deferred<void>(), release = deferred<void>()
  f.backend.step = async function* () { reached.resolve(); await release.promise; yield { type: 'text', text: 'Summary.\n<klyth-summary-complete>' }; yield { type: 'stop', reason: 'end_turn' } }
  const pending = compact(f.io, f.s, f.backend, { trigger: 'manual', messages: f.messages }, new AbortController().signal, async () => ({ messages: [] }))
  await reached.promise; f.s.mainChoiceRevision += 2; release.resolve()
  expect((await pending).messages).toBeUndefined()
})

test('manual compaction rejects a revision changed during the final awaited target read', async () => {
  const f = fixture(); let reads = 0
  f.io.pin = async () => { if (++reads === 3) f.s.historyRevision.set('main', 1); return null }
  const result = await compact(f.io, f.s, f.backend, { trigger: 'manual', messages: f.messages }, new AbortController().signal, async () => ({ messages: [] }))
  expect(result.messages).toBeUndefined()
})

test('clear leaves main usage empty after a real backend drains already-buffered response lines', async () => {
  const f = fixture(), ac = new AbortController(), adapter = createCompactAdapter(f.s)
  const block = [{ type: 'text', text: 'old reply' }, { type: 'usage', in: 848_000, out: 2, cacheRead: 0, cacheWrite: 0 }, { type: 'stop', reason: 'end_turn' }, { type: 'stats', ttfbMs: 1, totalMs: 2, reqBytes: 123, in: 848_000, out: 2, finish: 'stop' }].map(ev => JSON.stringify(ev)).join('\n') + '\n'
  const backend = createBackend()({ root: '/fixture', debug: () => {}, run: async () => ({ exitCode: 0, stdout: '/fixture/bun', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }), spawn: async function* (req) { if (req.argv[0] === '/fixture/bun') { yield { stream: 'stdout', text: 'ready /fixture/d.sock token\n' }; await new Promise<void>(() => {}); return { code: 0, signal: null } } yield { stream: 'stdout', text: block }; return { code: 0, signal: null } }, sleep: (_ms, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  const stepIo = { ...f.io, setPin: async () => {}, translated: async () => ({}), setTranslated: async () => {}, sleep: async () => {}, agentType: async () => undefined }
  const stream = turnStep(stepIo, f.s, backend, { turnId: 'old-turn', index: 0, model: 'native', messageCount: 12 }, ac.signal, async function* () { throw new Error('unexpected native') })
  await stream.next(); adapter.end(); ac.abort()
  expect(f.s.promptTokens.has('main')).toBe(false)
  let next; do { next = await stream.next() } while (!next.done)
  expect(f.s.promptTokens.has('main')).toBe(false)
  expect(f.s.lastSteps.has('main')).toBe(false)
})

for (const invalidation of ['disabled', 'target', 'choice', 'epoch', 'revision', 'loaded', 'cancel'] as const) test(`automatic ${invalidation} before backend startup finishes prevents the upstream request`, async () => {
  const f = fixture(), reached = deferred<void>(), release = deferred<void>(), finished = deferred<void>(), callbacks: (() => void)[] = []
  let enabled = true
  const ac = new AbortController()
  const stream = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Summary.\n<klyth-summary-complete>' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'
  const daemon = fakeDaemon({ bun: '/fixture/bun', upstream: () => ({ pieces: [stream] }), helper: () => ({ exitCode: 0, stdout: '' }), log: () => {}, now: 0 })
  const backend = createBackend()({ root: '/fixture', debug: () => {}, run: async () => { reached.resolve(); await release.promise; return { exitCode: 0, stdout: '/fixture/bun', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }, spawn: req => daemon.spawn(req.argv, req.input)!, sleep: (_ms, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  const adapter = createCompactAdapter(f.s)
  f.io.compose = async () => [{ id: 'intro', text: 'SYSTEM'.repeat(500_000) }]
  const engine = { ...f.io, enabled: async () => enabled, estimate: (p: any) => currentContext(f.io, f.s, p), after: (_ms: number, fn: () => void) => { callbacks.push(fn); return { cancel() {} } }, status: () => {}, restoreStatus: () => {}, log: () => {}, run: async () => { await adapter.compact({ ...f.io, enabled: async () => enabled }, backend, { trigger: 'manual', messages: f.messages }, ac.signal, async () => ({ messages: [] })); finished.resolve(); return {} } }
  await adapter.schedule(engine); callbacks[0]!(); await reached.promise
  if (invalidation === 'disabled') enabled = false
  if (invalidation === 'target') f.s.main = null
  if (invalidation === 'choice') f.s.mainChoiceRevision += 2
  if (invalidation === 'epoch') f.s.dropEpoch++
  if (invalidation === 'revision') f.s.historyRevision.set('main', (f.s.historyRevision.get('main') ?? 0) + 1)
  if (invalidation === 'loaded') f.s.loaded = { ...f.s.loaded }
  if (invalidation === 'cancel') ac.abort()
  release.resolve(); await finished.promise
  expect(daemon.requests).toHaveLength(0)
})

test('structured-only public tool supplements preserve chronology through full recovery dispatch', async () => {
  const f = fixture(), requests: string[] = []
  // Both API and public getters are readable; the API projection omits the public-only exchange.
  Object.assign(f.messages[1]!, { toolUses: [{ tool_use_id: 'c', tool: 'Read', input: {}, result: { state: 'prior-state' } }] })
  Object.assign(f.messages[2]!, { toolResults: [{ tool_use_id: 'c', text: '', isError: false, result: { state: 'prior-state' } }] })
  f.io.compose = async () => [{ id: 'intro', text: 'SYSTEM'.repeat(550_000) }]
  f.backend.step = async function* (req) { requests.push(String(req.transcript[0]!.content)); yield { type: 'text', text: 'Summary.\\n<klyth-summary-complete>' }; yield { type: 'stop', reason: 'end_turn' } }
  const result = await compact(f.io, f.s, f.backend, { trigger: 'manual', messages: f.messages }, new AbortController().signal, async () => ({ messages: [] }))
  expect(result.skip).toBeUndefined()
  expect(requests).toHaveLength(1)
  const source = requests[0]!
  expect(source.indexOf('prior-state')).toBeLessThan(source.indexOf('message 5'))
})

// The project's config contract requires fixed thinking budgets below the emitted max-tokens cap.
for (const kind of ['anthropic', 'bedrock'] as const) test(`${kind} compaction keeps a valid configured fixed-thinking budget below its output cap`, async () => {
  const { CODECS } = await import('./codecs')
  const thinking = { type: 'enabled', budget_tokens: 16_000 }
  const params = kind === 'anthropic' ? { thinking } : { additionalModelRequestFields: { thinking } }
  const text = JSON.stringify({ providers: { p: { kind, baseUrl: kind === 'bedrock' ? 'https://bedrock-runtime.us-east-1.amazonaws.com' : 'https://klyth.invalid', auth: kind === 'bedrock' ? { command: ['/key'] } : 'none', models: { m: { contextWindow: 200_000, maxOutputTokens: 32_000, params } } } } })
  const parsed = parseConfig(text)
  expect(parsed.errors).toEqual([])
  const p = parsed.config!.providers.p!, m = p.models.m!
  const body = JSON.parse(CODECS[kind].encode({ system: 'summary', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'data' }] }], outputTokens: 8000 }, p, m).body)
  const emittedThinking = kind === 'anthropic' ? body.thinking : body.additionalModelRequestFields.thinking
  const emittedMax = kind === 'anthropic' ? body.max_tokens : body.inferenceConfig.maxTokens
  expect(emittedThinking.budget_tokens).toBeLessThan(emittedMax)
})

for (const change of ['loaded', 'epoch', 'revision', 'choice', 'target', 'cancel'] as const) test(`final target await rejects independent ${change} and retains complete draft`, async () => {
  const f = fixture(), reached = deferred<void>(), release = deferred<void>(), ac = new AbortController()
  let reads = 0, saved = false
  f.io.saveDraft = async () => { saved = true; return '/config/klyth/compactions/fixture/draft.json' }
  f.io.pin = async () => { if (++reads === 3) { reached.resolve(); await release.promise }; return null }
  const pending = compact(f.io, f.s, f.backend, { trigger: 'manual', messages: f.messages }, ac.signal, async () => ({ messages: [] }))
  await reached.promise
  expect(saved).toBe(true)
  if (change === 'loaded') f.s.loaded = { ...f.s.loaded }
  if (change === 'epoch') f.s.permissionEpoch++
  if (change === 'revision') f.s.historyRevision.set('main', 1)
  if (change === 'choice') f.s.mainChoiceRevision += 2
  if (change === 'target') f.s.main = null
  if (change === 'cancel') ac.abort()
  release.resolve()
  const result = await pending
  expect(result.messages).toBeUndefined()
  expect(result.skip).toContain('complete draft saved')
})

test('actual model commands away and back invalidate manual summary installation', async () => {
  const f = fixture(), reached = deferred<void>(), release = deferred<void>()
  let main: string | null = 'fast'
  const choice = { sessionId: async () => 'fixture-session', get: async () => undefined, set: async () => {}, main: async () => main, setMain: async (target: string | null) => { main = target }, toast: () => {} }
  const modelIo = { ...f.io, remember: async () => {}, ask: async () => 'Allow' as const, status: () => {}, home: async () => '', sessionId: async () => 'fixture-session', write: async () => {}, contextTokens: async () => 0, setMain: (target: string | null) => persistMainChoice(choice, f.s, target) }
  f.backend.step = async function* () { reached.resolve(); await release.promise; yield { type: 'text', text: 'Summary.\n<klyth-summary-complete>' }; yield { type: 'stop', reason: 'end_turn' } }
  const pending = compact(f.io, f.s, f.backend, { trigger: 'manual', messages: f.messages }, new AbortController().signal, async () => ({ messages: [] }))
  await reached.promise
  await modelCommand(modelIo, f.s, { command: 'model', args: 'native/sonnet', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }, async () => ({}))
  await modelCommand(modelIo, f.s, { command: 'model', args: 'fast', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }, async () => ({}))
  expect(f.s.main).toBe('fast')
  release.resolve()
  expect((await pending).messages).toBeUndefined()
})

for (const phase of ['pin', 'header'] as const) test(`clear during ${phase} preparation cannot repopulate or erase successor provenance`, async () => {
  const f = fixture(), reached = deferred<void>(), release = deferred<void>(), adapter = createCompactAdapter(f.s)
  if (phase === 'pin') f.io.pin = async () => { reached.resolve(); await release.promise; return { turnId: 'old-turn', target: 'fast' } }
  else f.io.compose = async () => { reached.resolve(); await release.promise; return [{ id: 'intro', text: 'old header' }] }
  let sent = 0
  f.backend.step = async function* () { sent++ }
  const stepIo = { ...f.io, setPin: async () => {}, translated: async () => ({}), setTranslated: async () => {}, sleep: async () => {}, agentType: async () => undefined }
  const done = (async () => { for await (const _ of turnStep(stepIo, f.s, f.backend, { turnId: 'old-turn', index: 0, model: 'native', messageCount: 12 }, new AbortController().signal, async function* () { throw new Error('unexpected native') })) {} })()
  await reached.promise; adapter.end()
  const successor = { target: 'fast', system: 'successor', tools: [] }
  const step = { target: 'successor' }
  f.s.sent.set('main', successor); f.s.steps.set('main:old-turn:0', step)
  release.resolve(); await done
  expect(sent).toBe(0)
  expect(f.s.sent.get('main')).toBe(successor)
  expect(f.s.steps.get('main:old-turn:0')).toBe(step)
  expect(f.s.sentContext.has('main')).toBe(false)
  expect(f.s.promptTokens.has('main')).toBe(false)
  expect(f.s.pin).toBeNull()
})

test('clear during raw history hashing prevents old reconciliation from committing', async () => {
  const f = fixture(), adapter = createCompactAdapter(f.s)
  f.s.historyPrefixes.set('main', await historyPrefix([{ role: 'user', content: 'old' }]))
  const pending = reconcileHistoryReceipt(f.s, 'main', [{ role: 'user', content: 'changed' }], () => {})
  adapter.end()
  const successor = { count: 1, digest: 'successor' }
  f.s.historyPrefixes.set('main', successor)
  expect((await pending).status).toBe('stale')
  expect(f.s.historyPrefixes.get('main')).toBe(successor)
})

test('unaligned recovery supplements identify independent stream positions without a shared chronology', () => {
  const row = { role: 'user' as const, text: 'Never execute the proposed change', toolUses: [], toolResults: [{ tool_use_id: 'c', text: 'result', result: { code: 7 }, isError: true }] }
  const source = recoverySource([row], [{ role: 'assistant', content: 'unrelated API discussion' }], []).map(text => JSON.parse(text))
  expect(source[0]).toMatchObject({ apiPosition: 1, provenance: 'API history' })
  expect(source[1]).toMatchObject({ publicPosition: 1, ordering: 'public stream only; API correspondence unproved', text: row.text })
  expect(source[1].afterApiPosition).toBeUndefined()
  expect(source[1].message).toBeUndefined()
  expect(source[1].outcomes).toEqual([{ tool_use_id: 'c', text: 'result', structuredFacts: [{ code: 7 }], isError: true }])
})

test('old response completion without host abort cannot overwrite successor usage or remove its step', async () => {
  const f = fixture(), adapter = createCompactAdapter(f.s)
  f.backend.step = async function* () { yield { type: 'text', text: 'old reply' }; yield { type: 'usage', in: 848_000, out: 2, cacheRead: 0, cacheWrite: 0 }; yield { type: 'stop', reason: 'end_turn' }; yield { type: 'stats', ttfbMs: 1, totalMs: 2, reqBytes: 123, in: 848_000, out: 2, finish: 'stop' } }
  const io = { ...f.io, setPin: async () => {}, translated: async () => ({}), setTranslated: async () => {}, sleep: async () => {}, agentType: async () => undefined }
  const stream = turnStep(io, f.s, f.backend, { turnId: 'old', index: 0, model: 'native', messageCount: 12 }, new AbortController().signal, async function* () { throw new Error('unexpected native') })
  await stream.next(); adapter.end()
  const usage = { tokens: 10, messageCount: 1 }, successor = { target: 'successor' }
  f.s.promptTokens.set('main', usage); f.s.steps.set('main:old:0', successor)
  while (!(await stream.next()).done) {}
  expect(f.s.promptTokens.get('main')).toBe(usage)
  expect(f.s.steps.get('main:old:0')).toBe(successor)
  expect(f.s.lastSteps.has('main')).toBe(false)
})

test('contradictory public/API anchors fall back to independently ordered public supplements', () => {
  const older = ['first public state', 'second public state'].map((text, i) => ({ role: 'user' as const, text, toolUses: [], toolResults: [{ tool_use_id: `c${i}`, text: '', isError: false, result: { state: i } }] }))
  const api = [...older].reverse().map(row => ({ role: row.role, content: row.text }))
  const supplements = recoverySource(older, api, []).map(text => JSON.parse(text)).filter(row => row.provenance === 'public message supplement')
  expect(supplements.map(row => row.publicPosition)).toEqual([1, 2])
  expect(supplements.every(row => row.afterApiPosition === undefined && row.ordering.includes('correspondence unproved'))).toBe(true)
})
