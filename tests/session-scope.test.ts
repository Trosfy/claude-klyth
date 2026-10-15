// The seams between the hooks and klythd's per-session records: the session scope every step carries (and that klythd's own
// check accepts), the loop a compaction shares main's cache with, and the resumed child's repaired opening that survives a reload in host state.
import { expect, test } from 'claude-code/testing'

import { createBackend } from '../hooks/backend'
import type { Host } from '../hooks/backend'
import { createCacheHistory } from '../hooks/cache-history'
import { compact } from '../hooks/compact'
import type { CompactPort } from '../hooks/compact'
import { parseConfig } from '../hooks/config'
import type { Backend, SessionScope, StepEvent, StepRequest, StepWire } from '../hooks/protocol'
import { createSession } from '../hooks/session'
import { createUsageEnvelope } from '../hooks/usage-ledger'
import { bindUsageTranscript } from '../hooks/usage-retention'
import { invalidSessionScope } from '../klythd/responses'
import { denied } from './fixtures/denied'
import { CONFIG, CONFIG_OBJECT, HOME, SESSION_ID, klyth, model, start, step, world } from './world'

const TRANSCRIPT = `${HOME}/.claude/projects/-w/${SESSION_ID}.jsonl`
const scopes = (w: { wires: readonly unknown[] }) => w.wires.flatMap(x => ((x as StepWire).req === undefined ? [] : [(x as StepWire).session]))
const begin = ($: Parameters<typeof start>[0]) => $.classic.SessionStart({ source: 'startup', session_id: SESSION_ID, transcript_path: TRANSCRIPT } as never)

test('every routed step carries the session scope SessionStart gave, and the daemon\'s own check accepts it', async ($, on) => {
  const w = world(on)
  await begin($)
  await start($)
  await model($, 'strong')
  await step($, { turnId: 't1', index: 0 })
  await step($, { turnId: 't1', index: 1 })
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION_ID, transcript_path: 'projects/-w/session.jsonl' } as never)
  await step($, { turnId: 't2', index: 0 })
  const scope = { configDir: `${HOME}/.claude`, id: SESSION_ID, transcript: TRANSCRIPT }
  expect(scopes(w)).toEqual([scope, scope, { configDir: `${HOME}/.claude`, id: SESSION_ID }])
  expect(invalidSessionScope(scopes(w)[0])).toBeUndefined()
})

test('a registration reloaded after SessionStart reads the transcript from the usage record in state', async ($, on) => {
  const w = world(on)
  const record = bindUsageTranscript(createUsageEnvelope(SESSION_ID, 0), SESSION_ID, TRANSCRIPT)
  on('state.get', { plugin: 'klyth', key: 'usage' }, () => ({ value: { value: record, version: 1 } }))
  await start($)
  await model($, 'strong')
  await step($, { turnId: 't1', index: 0 })
  expect(scopes(w)).toEqual([{ configDir: `${HOME}/.claude`, id: SESSION_ID, transcript: TRANSCRIPT }])
})

test('a config dir that is not absolute says so once, and no routed step reaches klythd (the launch refuses it first)', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '~/cfg' } })
  await begin($)
  await start($)
  expect(w.debug.filter(l => l.includes('CLAUDE_CONFIG_DIR is not an absolute path'))).toHaveLength(1)
  expect(w.wires).toHaveLength(0)
})

test('the backend puts the host\'s session scope on the step wire, and none when the host has none', async () => {
  const wires: StepWire[] = []
  const host = (session?: SessionScope): Host => ({
    root: '/mod', debug: () => {}, sleep: async () => {}, ...(session === undefined ? {} : { session }),
    run: async () => ({ exitCode: 0, stdout: '/bun\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    spawn: request => (async function* () {
      if (request.argv[0] === '/bun') { yield { stream: 'stdout', text: 'ready /sock token\n' }; await new Promise<void>(() => {}) }
      wires.push(JSON.parse(request.input ?? '{}') as StepWire)
      yield { stream: 'stdout', text: `${JSON.stringify({ type: 'stop', reason: 'end_turn' })}\n` }
      return { code: 0, signal: null }
    })(),
  })
  const scope = { configDir: '/cfg', id: SESSION_ID }
  for (const session of [scope, undefined]) {
    const backend = createBackend()(host(session))
    await backend.configure({ configText: '{}', approved: [] })
    for await (const _event of backend.step({ target: 'p/m', system: '', transcript: [], tools: [], who: 'main' }, new AbortController().signal)) { /* the wire is what matters */ }
  }
  expect(wires.map(wire => wire.session)).toEqual([scope, undefined])
})

test('each routed request names its cache loop: a main step main, a child\'s step its agent id, and the fork classifier the loop it classifies', async ($, on) => {
  const HISTORY = [{ role: 'user', content: [{ type: 'text', text: 'fix the typo' }] }], EDIT = { file_path: '/w/README.md', old_string: 'teh', new_string: 'the' }
  let main: readonly unknown[] = HISTORY
  const w = world(on, { config: JSON.stringify({ ...CONFIG_OBJECT, classifier: { context: 'fork' } }), routes: { kid: KID }, messages: (agentId: string | undefined) => (agentId === undefined ? main : FIRST) })
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await model($, 'strong')
  await step($, { turnId: 't', index: 0 })
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  main = [...HISTORY, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_klyth_1', name: 'Edit', input: EDIT }] }]
  await $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'toolu_klyth_1' } as never)
  await $.classic.PermissionDenied(denied('Edit', EDIT, 'toolu_klyth_1') as never)
  expect(w.wires.flatMap(x => ((x as StepWire).req === undefined ? [] : [[(x as StepWire).req.who, (x as StepWire).req.cacheLoop]]))).toEqual([['main', 'main'], ['kid', 'kid'], ['classifier:main', 'main']])
})

test('the primary compaction request carries main\'s loop as its cache loop, beside main\'s session id', async () => {
  const s = createSession()
  s.loaded = { config: parseConfig(CONFIG).config!, text: CONFIG, errors: [], missing: false, path: 'klyth.json' }
  s.main = 'fast'
  s.promptTokens.set('main', { tokens: 900_000, messageCount: 12 })
  s.sent.set('main', { target: 'fast', system: 'old', tools: [] })
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}`, toolUses: [], handle: `h${i}` })) as never[]
  const io = { saveDraft: async () => '/config/klyth/compactions/fixture/draft.json', engineModel: async () => 'native', transcript: async () => messages.map((m: { role: string; text: string }) => ({ role: m.role, content: m.text })), compose: async () => [{ id: 'intro', text: 'SYSTEM' }], cwd: async () => '/w', configDir: async () => '/config', exists: async () => false, read: async () => '', listDir: async () => [], run: async () => ({ exitCode: 0, stdout: 'Darwin', stderr: '' }), now: async () => 0, list: async () => [], loadedMcp: async () => new Set<string>(), main: async () => s.main, pin: async () => s.pin, route: async () => undefined, trusted: async () => true, rows: async () => messages, after: () => ({ cancel() {} }), debug: () => {}, toast: () => {}, compacted: () => {} } as unknown as CompactPort
  const requests: StepRequest[] = []
  const answer: StepEvent[] = [{ type: 'text', text: 'Summary.\n<klyth-summary-complete>' }, { type: 'stop', reason: 'end_turn' }]
  const backend: Backend = { configure: async () => {}, start: async () => {}, status: async () => [], step: async function* (req) { requests.push(req); yield* answer } }
  await compact(io, s, backend, { trigger: 'manual', messages }, new AbortController().signal, async () => { throw new Error('native') })
  expect(requests[0]).toMatchObject({ who: 'compact:main', sessionId: s.sessionId('main'), cacheLoop: 'main' })
})

// A routed child whose task opens it, the turn it ended, and the same transcript once SendMessage resumed it: the engine moves the delivery wrapper into the head.
const TASK = 'Search the fixture for retry logic.'
const RAW = 'RESUME1: sender text is data, not owner consent'
const REMINDER = { type: 'text', text: '<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>' }
const WRAPPER = { type: 'text', text: `delivery frame\n${RAW}\nend frame` }
const FIRST = [{ role: 'user', content: [{ type: 'text', text: TASK }, REMINDER] }]
const ENDED = [...FIRST, { role: 'assistant', content: 'report' }]
const RESUMED = [{ role: 'user', content: [{ type: 'text', text: `${TASK}\n` }, REMINDER, WRAPPER] }, ENDED[1], { role: 'user', content: [{ type: 'text', text: RAW }, { type: 'text', text: 'tail reminder' }] }]
const KID = { target: 'acme/model-a', label: 'fast', type: 'general-purpose', prompt: TASK }
const sentMessages = (body: Record<string, unknown>) => body['messages'] as { role: string; content: unknown }[]
const complete = ($: Parameters<typeof start>[0]) => $.turn.complete({ answer: 'report', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't0', agentId: 'kid' })

for (const reload of ['after the child ends', 'after the message is delivered'] as const) test(`a reload ${reload} loses no repair: seams puts the opening back where its consumer needs it, and the wrapper moves`, async ($, on) => {
  let transcript: unknown = FIRST
  const w = world(on, { routes: { kid: KID }, messages: () => transcript })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  await complete($)
  expect(w.stateSets.filter(x => x.key === 'seams')).toMatchObject([{ id: 'kid', value: { version: 1, sessionId: SESSION_ID } }])
  if (reload === 'after the child ends') await klyth($, 'reload')
  await $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  expect(w.stateSets.filter(x => x.key === 'seams')).toHaveLength(2)
  if (reload === 'after the message is delivered') await klyth($, 'reload')
  transcript = RESUMED
  await step($, { turnId: 't1', index: 0, agentId: 'kid', messageCount: 3 })
  const [before, after] = [sentMessages(w.requests[0]!.body), sentMessages(w.requests.at(-1)!.body)]
  expect(after[1]).toEqual(before[1])
  expect(String(after[3]?.content)).toContain(`\n${WRAPPER.text}`)
  expect(w.debug.some(l => l.startsWith('klyth cache-seam kid') && l.endsWith('apply=moved'))).toBe(true)
})

const OPENING = { version: 1, opening: { head: FIRST[0], task: 0, prompt: TASK, completed: true, revision: 0, boundary: 1, size: 100, ledger: [] } }
for (const [name, saved] of [
  ['another session', { version: 1, sessionId: 'another-session', opening: OPENING }],
  ['a value that is not an opening', { version: 1, sessionId: SESSION_ID, opening: { version: 1, opening: { head: 7 } } }],
] as const) test(`a seams value from ${name} is ignored with one debug line, and the child's step proceeds without an opening`, async ($, on) => {
  const w = world(on, { routes: { kid: KID } })
  on('state.get', { plugin: 'klyth', key: 'seams' }, () => ({ value: { value: saved, version: 1 } }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  await step($, { turnId: 't0', index: 1, agentId: 'kid', messageCount: 1 })
  expect(w.requests).toHaveLength(2)
  expect(w.debug.filter(l => l.startsWith('klyth seams: kid proceeds without its saved opening'))).toHaveLength(1)
})

const seams = (w: { stateSets: { key: string; value: unknown }[] }) => w.stateSets.filter(x => x.key === 'seams').map(x => (x.value as { opening: unknown }).opening === null ? 'null' : 'opening')
const moved = (w: { debug: string[] }) => w.debug.some(l => l.startsWith('klyth cache-seam kid') && l.endsWith('apply=moved'))
const SUMMARY = [{ role: 'user', content: [{ type: 'text', text: 'summary of the earlier turns' }] }]

test('an opening a changed history drops is saved as null once by that step, even one abandoned mid-stream, and after a reload nothing restores the stale copy', async ($, on) => {
  let transcript: unknown = FIRST
  const w = world(on, { routes: { kid: KID }, messages: () => transcript })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  await complete($)
  await $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  transcript = SUMMARY
  await step($, { turnId: 't1', index: 0, agentId: 'kid', messageCount: 1 })
  const changed = [{ role: 'user', content: [{ type: 'text', text: 'another summary' }] }]
  transcript = changed // not an extension of what the last step sent: memory drops the opening, and the step is abandoned mid-stream
  const stream = $.turn.step({ model: 'claude-opus-5-5', turnId: 't1', index: 1, agentId: 'kid', messageCount: 1 })
  await stream.next()
  await stream.return(undefined as never)
  expect(seams(w)).toEqual(['opening', 'opening', 'null'])
  await klyth($, 'reload')
  const notes = w.debug.filter(l => l.startsWith('klyth cache-seam kid') || l.startsWith('klyth seams:')).length
  transcript = [...changed, { role: 'assistant', content: 'more' }, { role: 'user', content: 'go on' }] // extends it: nothing drops a restored copy
  await step($, { turnId: 't1', index: 2, agentId: 'kid', messageCount: 3 })
  expect(seams(w)).toEqual(['opening', 'opening', 'null'])
  expect(w.debug.filter(l => l.startsWith('klyth cache-seam kid') || l.startsWith('klyth seams:')).length).toBe(notes)
})

test('a save that began before the opening dropped does not end the drop: the step that dropped it still saves the null', async ($, on) => {
  let release!: () => void, entered!: () => void, holding = false
  const gate = new Promise<void>(r => (release = r)), held = new Promise<void>(r => (entered = r))
  on('state.set', { plugin: 'klyth', key: 'seams' }, async ($, e, next) => { if (holding && (e.value as { opening: unknown }).opening !== null) { holding = false; entered(); await gate } return next(e) })
  let transcript: unknown = FIRST
  const w = world(on, { routes: { kid: KID }, messages: () => transcript })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  await complete($)
  holding = true
  const delivered = $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  await held // the delivery's save holds the opening as it was
  transcript = SUMMARY
  await step($, { turnId: 't1', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = [{ role: 'user', content: [{ type: 'text', text: 'another summary' }] }]
  const stream = $.turn.step({ model: 'claude-opus-5-5', turnId: 't1', index: 1, agentId: 'kid', messageCount: 1 })
  await stream.next() // the opening is dropped
  release()
  await delivered
  for (;;) if ((await stream.next()).done) break
  expect(seams(w)).toEqual(['opening', 'opening', 'null'])
})

test('an opening whose null could not be saved is still never restored from its stale copy in this registration', async ($, on) => {
  on('state.set', { plugin: 'klyth', key: 'seams' }, ($, e, next) => (e.value as { opening: unknown }).opening === null ? { deny: 'state unavailable' } : next(e))
  let transcript: unknown = FIRST
  const w = world(on, { routes: { kid: KID }, messages: () => transcript })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  await complete($)
  await $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  transcript = SUMMARY
  await step($, { turnId: 't1', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = [{ role: 'user', content: [{ type: 'text', text: 'another summary' }] }]
  await step($, { turnId: 't1', index: 1, agentId: 'kid', messageCount: 1 })
  expect(w.debug.filter(l => l.startsWith('klyth seams: could not save the opening of kid'))).toHaveLength(1)
  transcript = RESUMED
  await step($, { turnId: 't1', index: 2, agentId: 'kid', messageCount: 3 })
  await klyth($, 'reload')
  await step($, { turnId: 't1', index: 3, agentId: 'kid', messageCount: 3 })
  expect(moved(w)).toBe(false)
})

for (const reload of [false, true]) test(`a child compaction${reload ? ' after a reload, its opening not yet restored,' : ''} saves the opening it dropped as null at once`, async ($, on) => {
  const routes: Record<string, unknown> = { kid: KID }
  let transcript: unknown = FIRST
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [], handle: 'h1' }] }))
  const w = world(on, { routes: routes as never, messages: () => transcript })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  await complete($)
  await $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  if (reload) await klyth($, 'reload')
  routes['kid'] = { ...KID, target: 'native/claude-opus-5-5' } // a native compaction, which replaces the history
  await $.session.compact({ trigger: 'manual', agentId: 'kid', messages: [{ role: 'user', text: 'older', toolUses: [], handle: 'h0' }] } as never)
  expect(seams(w)).toEqual(['opening', 'opening', 'null'])
})

test('a restore that read the saved opening before the opening dropped puts nothing back', async ($, on) => {
  let release!: () => void, entered!: () => void, holding = false
  const gate = new Promise<void>(r => (release = r)), held = new Promise<void>(r => (entered = r))
  on('state.get', { plugin: 'klyth', key: 'seams' }, async ($, e, next) => { const r = await next(e); if (holding) { holding = false; entered(); await gate } return r })
  let transcript: unknown = FIRST
  const w = world(on, { routes: { kid: KID }, messages: () => transcript })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  await complete($)
  await klyth($, 'reload')
  holding = true
  const delivered = $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  await held // the delivery's restore has read the saved opening and waits
  transcript = SUMMARY
  await step($, { turnId: 't1', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = [{ role: 'user', content: [{ type: 'text', text: 'another summary' }] }]
  await step($, { turnId: 't1', index: 1, agentId: 'kid', messageCount: 1 })
  release()
  await delivered
  expect(seams(w).at(-1)).toBe('null')
})

test('a session id that cannot be read leaves the child\'s end as it was, with one debug line', async ($, on) => {
  let broken = false, transcript: unknown = FIRST
  const w = world(on, { routes: { kid: KID }, messages: () => transcript, sessionId: () => { if (broken) throw new Error('no session'); return SESSION_ID } })
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  transcript = ENDED
  broken = true
  await complete($)
  expect(w.debug.filter(l => l.startsWith('klyth seams: could not save the opening of kid'))).toHaveLength(1)
})

test('a message to a loop with no opening and none dropped saves nothing', async ($, on) => {
  const w = world(on, { routes: { kid: KID } })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await start($)
  await $.tool.call({ tool: 'SendMessage', to: 'kid', message: RAW } as never)
  expect(w.stateSets.filter(x => x.key === 'seams')).toEqual([])
})

test('a drop is ended only by a save that began after it: a later drop of the loop, and another loop\'s drop, keep their marks', () => {
  const history = createCacheHistory()
  history.invalidate('a')
  const first = history.invalidated('a')
  history.invalidate('b')
  history.invalidate('a')
  history.saved('a', first)
  expect(history.invalidated('a')).toBeDefined()
  history.saved('a', history.invalidated('a'))
  expect(history.invalidated('a')).toBeUndefined()
  history.saved('b', undefined)
  expect(history.invalidated('b')).toBeDefined()
  history.saved('b', history.invalidated('b'))
  expect(history.invalidated('b')).toBeUndefined()
})

test('a seams value saved as null is no opening: the child\'s step proceeds without one, and without a debug line', async ($, on) => {
  const w = world(on, { routes: { kid: KID } })
  on('state.get', { plugin: 'klyth', key: 'seams' }, () => ({ value: { value: { version: 1, sessionId: SESSION_ID, opening: null }, version: 1 } }))
  await start($)
  await step($, { turnId: 't0', index: 0, agentId: 'kid', messageCount: 1 })
  expect(w.requests).toHaveLength(1)
  expect(w.debug.filter(l => l.startsWith('klyth seams:'))).toEqual([])
})

test('a saved opening is put back only whole: past the loop bound, or with any field of the wrong shape, restore() throws', () => {
  const history = createCacheHistory(), whole = OPENING.opening
  for (let i = 0; i < 64; i++) history.restore(`kid${i}`, OPENING)
  expect(() => history.restore('kid64', OPENING)).toThrow('not a whole one')
  for (const [field, value] of [['head', 7], ['head', { ...whole.head, role: 'assistant' }], ['head', { role: 'user', content: TASK }], ['prompt', 1], ['task', 0.5], ['boundary', '1'], ['revision', null], ['completed', 'yes'], ['size', '100'], ['ledger', [{ raw: RAW, confirmed: 'no', size: 1 }]], ['delivery', { raw: 1, confirmed: true, size: 1 }]] as const)
    expect(() => createCacheHistory().restore(field, { version: 1, opening: { ...whole, [field]: value } })).toThrow('not a whole one')
})
