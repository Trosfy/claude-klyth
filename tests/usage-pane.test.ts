import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { createUsageEnvelope, reduceUsage, type UsageEnvelope } from '../hooks/usage-ledger'
import { finalEvidence, partitionedUsage } from '../hooks/usage-evidence'
import { usageNumber, usageCompactTokens, usageText, usageView } from '../hooks/usage-view'
import { changeUsagePane, openUsagePane, renderUsagePane, usagePanePreferences } from '../hooks/usage-pane'
import { klyth, SESSION_ID, start, step, world } from './world'

const paneProps = (bodyColumns: number) => ({ title: 'Klyth usage', isFocused: true, bodyColumns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} })
const mount = ($: Engine, columns = 40) => $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'fixture-pane', props: paneProps(columns), viewport: { columns: 200, rows: 40 } })
function measured(): UsageEnvelope {
  const id = `${SESSION_ID}:1:1`
  const token = { id, sessionId: SESSION_ID, generation: 1, sequence: 1 }
  const executionId = '00000000-0000-4000-8000-000000000001'
  let state = createUsageEnvelope(SESSION_ID, 1000)
  state = reduceUsage(state, { type: 'begin', pending: { requestId: id, sessionId: SESSION_ID, generation: 1, sequence: 1, purpose: 'step', owner: 'main', target: 'acme/model', startedAt: 1000, executions: {} } })
  state = reduceUsage(state, { type: 'dispatch', token, executionId, snapshot: { target: 'acme/model', label: 'model', pricing: { currency: 'USD', perMillionTokens: { output: 4 } } } })
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'anthropic', { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }))
  state = reduceUsage(state, { type: 'summary', token, summary: { type: 'usage_summary', requestId: id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', evidence }] } })
  return reduceUsage(state, { type: 'settle', token, at: 2000 })
}

test('empty pane is compact, explains observation start, and reveals diagnostics only on demand', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const state = createUsageEnvelope(SESSION_ID, 1000)
  let preferences = usagePanePreferences(SESSION_ID)
  on('ui.render', { component: 'Pane', requestId: 'fixture-pane' }, ($, e) => renderUsagePane({
    elements: $.ui.resolve(e), change: async action => { preferences = changeUsagePane(SESSION_ID, preferences, action) }, close: async () => {}, text: async () => {},
  }, SESSION_ID, state.sessions[0], preferences, e.props.bodyColumns, 617564))
  const ui = await mount($, 40)
  const initial = (await ui.findAll({ type: 'Text' })).map(item => item.text)
  expect(initial.length).toBeLessThanOrEqual(18)
  expect(initial.find(line => line?.startsWith('Estimated cost:'))).toBe('Estimated cost: No requests yet. Run a request through Klyth to see usage.')
  expect(initial).toContain('Klyth has not sent a request in this session.')
  expect(initial).toContain('Run a request through Klyth to see usage.')
  expect(initial).toContain('Press Escape to close.')
  expect(initial.join('\n')).not.toContain('Runs:')
  expect(initial.join('\n')).not.toContain('Provider calls with input and output counts:')
  expect(initial.join('\n')).not.toContain('617,564')
  expect(await ui.find({ key: 'filter-All' })).toBeUndefined()
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  await ui.press({ key: 'diagnostics' })
  await ui.redraw()
  const details = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(details).toContain('Runs:')
  expect(details).toContain('Current conversation size: About 617,564 tokens')
  expect(details).toContain('Usage count start:')
  await ui.press({ key: 'diagnostics' })
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text)).toEqual(initial)
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})

test('compact token labels keep missing and provisional usage visible', () => {
  expect(usageNumber(1234000)).toBe('1,234,000')
  expect(usageCompactTokens({ count: 0, unknown: 1, partial: 0 })).toBe('No token count')
  expect(usageCompactTokens({ count: 12500, unknown: 1, partial: 0 })).toBe('12,500 tokens. Some counts are missing.')
  expect(usageCompactTokens({ count: 0, unknown: 0, partial: 20 })).toBe('0 final tokens. Other calls reported at least 20 tokens. Their final counts are not available.')
  expect(usageCompactTokens({ count: 0, unknown: 1, partial: 20 })).toBe('No final token count. Other calls reported at least 20 tokens. Their final counts are not available. Some counts are missing.')
})

for (const width of [24, 40, 75, 76, 110]) test(`native pane mounts at ${width} body columns with total-first partial cost and local controls`, { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const state = measured()
  let preferences = usagePanePreferences(SESSION_ID)
  on('ui.render', { component: 'Pane', requestId: 'fixture-pane' }, async ($, e) => renderUsagePane({
    elements: $.ui.resolve(e),
    change: async action => { preferences = changeUsagePane(SESSION_ID, preferences, action) },
    text: async () => { w.transcript.push(...usageText(state.sessions[0]!)) },
    close: async () => { return },
  }, SESSION_ID, state.sessions[0], preferences, e.props.bodyColumns))
  await start($)
  const sets = w.stateSets.length
  const runs = w.runs.length
  const requests = w.requests.length
  const ui = await mount($, width)
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Estimated cost: At least $0.00004. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
  expect((await ui.findAll({ type: 'Text' })).find(item => item.text?.startsWith('Estimated cost:'))?.text).toBe('Estimated cost: At least $0.00004. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
  expect(w.stateSets).toHaveLength(sets)
  expect(await ui.find({ key: 'filter-All' })).toBeDefined()
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(item => item.props?.['flexDirection'] === 'row' && item.props?.['flexWrap'] === 'wrap')).toBe(true)
  await ui.press({ key: 'filter-Children' })
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('This group has no models. Select All to see all models.')
  expect((await ui.findAll({ type: 'Text' })).find(item => item.text?.startsWith('Estimated cost:'))?.text).toBe('Estimated cost: At least $0.00004. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
  await ui.press({ key: 'filter-All' })
  await ui.redraw()
  await ui.press({ key: 'model-acme/model' })
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Reasoning tokens within output:')
  await ui.press({ key: 'text' })
  expect(w.transcript).toEqual(usageText(state.sessions[0]!))
  expect(w.requests).toHaveLength(requests)
  expect(w.runs).toHaveLength(runs)
  await ui.unmount()
})

test('pane command opens only on request, requests focus, falls back on unplaced or rejected open, and text never opens', async ($, on) => {
  const w = world(on)
  on('command.register', { name: 'klyth' }, ($, e, next) => {
    expect(e.immediate).not.toBe(true)
    return next(e)
  })
  let opens = 0
  let fail = false
  let placed = true
  on('ui.open', ($, e) => {
    opens++
    expect(e).toMatchObject({ id: 'klyth-usage', title: 'Klyth usage', focus: true, closeOnEscape: true, rows: 18, columns: 72 })
    if (fail) throw new Error('surface unavailable')
    return { value: { isPlaced: placed, ...(placed ? {} : { reason: 'headless' }) } } as never
  })
  await start($)
  expect(opens).toBe(0)
  expect(await klyth($, 'usage')).toEqual({})
  expect(opens).toBe(1)
  expect(w.transcript).toEqual([])
  placed = false
  expect(await klyth($, 'usage')).toEqual({})
  expect(w.transcript.join('\n')).toContain('Estimated cost: No requests yet. Run a request through Klyth to see usage.')
  fail = true
  expect(await klyth($, 'usage')).toEqual({})
  const before = opens
  expect(await klyth($, 'usage text')).toEqual({})
  expect(opens).toBe(before)
  expect(w.requests).toEqual([])
})

test('opening exceptions produce the exact local fallback report', async () => {
  const lines = ['Estimated cost: At least $0. Some usage has no cost estimate. Add model prices under pricing in klyth.json.']
  expect(await openUsagePane(async () => { throw new Error('not placed') }, async () => lines)).toEqual(lines)
  expect(await openUsagePane(async () => ({ isPlaced: false }), async () => lines)).toEqual(lines)
  expect(await openUsagePane(async () => ({ isPlaced: true }), async () => { throw new Error('fallback should not run') })).toEqual([])
})

test('large Unicode model identities remain reachable in bounded 20-row pages and chunked details', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const state = measured()
  const session = state.sessions[0]!
  const base = Object.values(session.buckets)[0]!
  session.buckets = {}
  for (let i = 0; i < 61; i++) {
    const target = `acme/${String(i).padStart(3, '0')}-${'界🙂'.repeat(900)}\u001b`
    session.buckets[JSON.stringify([target, base.purpose, base.owner])] = { ...structuredClone(base), target, label: `alias-${i}` }
  }
  expect(usageText(session).join('\n').length).toBeGreaterThan(100000)
  let preferences = usagePanePreferences(SESSION_ID)
  on('ui.render', { component: 'Pane', requestId: 'fixture-pane' }, async ($, e) => renderUsagePane({
    elements: $.ui.resolve(e),
    change: async action => { preferences = changeUsagePane(SESSION_ID, preferences, action) },
    text: async () => { w.transcript.push(...usageText(state.sessions[0]!)) },
    close: async () => { return },
  }, SESSION_ID, state.sessions[0], preferences, e.props.bodyColumns))
  await start($)
  const ui = await mount($, 24)
  const seen = new Set<string>()
  for (let page = 0; page < 4; page++) {
    const buttons = await ui.findAll({ type: 'Button' })
    const models = buttons.filter(item => item.key?.startsWith('model-'))
    expect(models.length).toBeLessThanOrEqual(20)
    for (const item of models) seen.add(item.key!)
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.map(item => item.text).join('').length).toBeLessThanOrEqual(32000)
    expect(texts.map(item => item.text).join('')).not.toContain('\u001b')
    if (page < 3) { await ui.press({ key: 'next' }); await ui.redraw() }
  }
  expect(seen.size).toBe(61)
  const model = (await ui.findAll({ type: 'Button' })).find(item => item.key?.startsWith('model-'))!
  await ui.press({ key: model.key! })
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('')).toContain('Full model name, part 1 of ')
  expect(await ui.find({ key: 'detail-next' })).toBeDefined()
  await ui.press({ key: 'detail-next' })
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('').length).toBeLessThanOrEqual(32000)
  session.buckets = { [JSON.stringify([base.target, base.purpose, base.owner])]: base }
  await ui.redraw()
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).filter(item => item.key?.startsWith('model-'))).toHaveLength(1)
  expect(w.requests).toEqual([])
  await ui.unmount()
})

test('filters scope only model breakdown and preferences reset on engine-session change', () => {
  const state = measured()
  const session = state.sessions[0]!
  const base = Object.values(session.buckets)[0]!
  session.buckets.child = { ...structuredClone(base), target: 'acme/child', owner: 'child' }
  session.buckets.compact = { ...structuredClone(base), target: 'acme/compact', purpose: 'compaction' }
  session.buckets.classifier = { ...structuredClone(base), target: 'acme/classifier', purpose: 'classifier' }
  expect(usageView(session, 'Main').models.map(row => row.target)).toEqual(['acme/model'])
  expect(usageView(session, 'Children').models.map(row => row.target)).toEqual(['acme/child'])
  expect(usageView(session, 'Maintenance').models.map(row => row.target)).toEqual(['acme/classifier', 'acme/compact'])
  for (const filter of ['All', 'Main', 'Children', 'Maintenance'] as const) expect(usageView(session, filter).estimatedCost).toBe('At least $0.00004. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
  const saved = changeUsagePane(SESSION_ID, undefined, { type: 'expand', target: 'acme/model' })
  expect(saved.expanded).toBe('acme/model')
  expect(changeUsagePane(SESSION_ID, saved, { type: 'expand', target: 'acme/model' }).expanded).toBeUndefined()
  expect(usagePanePreferences('new-session', saved)).toEqual({ sessionId: 'new-session', filter: 'All', page: 0, detailPage: 0 })
})

// Unlike fixture mounts, this exercises the shipped matcher, state reads and action adapters.
test('real registration mounts cumulative state, redraws after a step and keeps every view interaction local', { timeoutMs: 30000 }, async ($, on) => {
  let fullBreakdowns = 0
  on('session.usage', { breakdown: 'full' }, ($, e, next) => { fullBreakdowns++; return next(e) })
  const w = world(on)
  on('ui.close', () => ({ value: undefined }))
  await start($)
  const ui = await $.ui.mount({ plugin: 'klyth', surface: 'terminal', component: 'Pane', requestId: 'klyth-usage', props: paneProps(40) })
  expect((await ui.findAll({ type: 'Text' })).find(item => item.text?.startsWith('Estimated cost:'))?.text).toBe('Estimated cost: No requests yet. Run a request through Klyth to see usage.')
  await $.command.run({ command: 'model', args: 'fast', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($, { turnId: 'pane-turn', index: 0 })
  await ui.press({ key: 'diagnostics' })
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Requests with records: 1')
  const runs = w.runs.length
  const requests = w.requests.length
  const writes = w.stateSets.length
  await ui.redraw({ ...paneProps(110), view: { agentId: 'unrelated-child' } })
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Requests with records: 1')
  expect(w.stateSets).toHaveLength(writes)
  await ui.press({ key: 'filter-Children' })
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('This group has no models. Select All to see all models.')
  await ui.press({ key: 'filter-All' })
  await ui.press({ key: 'model-acme/model-a' })
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Reasoning tokens within output')
  await ui.press({ key: 'text' })
  const paneCost = (await ui.findAll({ type: 'Text' })).find(item => item.text?.startsWith('Estimated cost:'))?.text
  expect(w.transcript).toContain(paneCost)
  expect(w.transcript.every(line => Array.from(line).length < 2000)).toBe(true)
  await ui.press({ key: 'close' })
  expect(w.runs).toHaveLength(runs)
  expect(w.requests).toHaveLength(requests)
  expect(fullBreakdowns).toBe(0)
  await ui.unmount()
})

test('overlapping filter actions retry a conflicting preference write and retain the later selection', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { clock: 'mocked' })
  mock.clock(on)
  let reads = 0, enabled = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const commits: unknown[] = []
  on('state.set', { plugin: 'klyth', key: 'usagePane' }, async ($, e, next) => {
    const result = await next(e)
    commits.push(result)
    return result
  })
  on('state.get', { plugin: 'klyth', key: 'usagePane' }, async ($, e, next) => {
    const result = await next(e)
    if (enabled && ++reads <= 2) { if (reads === 2) release(); await gate }
    return result
  })
  await start($)
  await $.command.run({ command: 'model', args: 'fast', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($, { turnId: 'filter-race', index: 0 })
  const ui = await $.ui.mount({ plugin: 'klyth', surface: 'terminal', component: 'Pane', requestId: 'klyth-usage', props: paneProps(40) })
  const runs = w.runs.length, requests = w.requests.length
  enabled = true
  await Promise.all([ui.press({ key: 'filter-Main' }), ui.press({ key: 'filter-Children' })])
  enabled = false
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Models: Subagents')
  expect(commits).toEqual([
    expect.objectContaining({ value: expect.objectContaining({ isSet: true }) }),
    expect.objectContaining({ value: expect.objectContaining({ isSet: false }) }),
    expect.objectContaining({ value: expect.objectContaining({ isSet: true }) }),
  ])
  expect(w.runs).toHaveLength(runs)
  expect(w.requests).toHaveLength(requests)
  await ui.unmount()
})

test('an action whose session changes while reading preferences cannot write into the successor', { timeoutMs: 30000 }, async ($, on) => {
  let sessionId = SESSION_ID, switchOnRead = false
  world(on, { sessionId: () => sessionId, clock: 'mocked' })
  mock.clock(on)
  let writes = 0
  on('state.set', { plugin: 'klyth', key: 'usagePane' }, async ($, e, next) => { writes++; return next(e) })
  on('state.get', { plugin: 'klyth', key: 'usagePane' }, async ($, e, next) => {
    const result = await next(e)
    if (switchOnRead) sessionId = 'successor-session'
    return result
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'klyth', surface: 'terminal', component: 'Pane', requestId: 'klyth-usage', props: paneProps(40) })
  switchOnRead = true
  await ui.press({ key: 'diagnostics' })
  expect(writes).toBe(0)
  await ui.unmount()
})

test('warning, empty, zero and tiny-cost states use the same literal qualifications in pane and text', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const state = measured()
  const session = state.sessions[0]!
  let current: typeof session | undefined = session
  on('ui.render', { component: 'Pane', requestId: 'fixture-pane' }, ($, e) => renderUsagePane({
    elements: $.ui.resolve(e), change: async () => {}, text: async () => {}, close: async () => {},
  }, SESSION_ID, current, undefined, e.props.bodyColumns))
  const ui = await mount($)
  session.warnings.recovered = true
  session.warnings.persistenceFailure = true
  session.warnings.earlierUnavailable = true
  await ui.redraw()
  const warnings = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(warnings).toContain('Klyth could not save usage. Totals may be incomplete.')
  expect(warnings).toContain('Klyth could not save usage. Totals may be incomplete.')
  for (const [cost, incomplete, known, label] of [
    [0, 1, true, 'At least $0. Some usage has no cost estimate. Add model prices under pricing in klyth.json.'],
    [0, 0, true, '$0'],
    [1e-13, 0, true, 'Less than $0.000000000001'],
    [0, 1, false, 'Not available. Some usage has no cost estimate. Add model prices under pricing in klyth.json.'],
  ] as const) {
    session.costUsd = cost
    session.costIncompleteAttempts = incomplete
    session.hasKnownCost = known
    await ui.redraw()
    expect((await ui.findAll({ type: 'Text' })).find(item => item.text?.startsWith('Estimated cost:'))?.text).toBe(`Estimated cost: ${label}`)
    expect(usageText(session)[1]).toBe(`Estimated cost: ${label}`)
  }
  current = undefined
  await ui.redraw()
  expect(await ui.find({ key: 'text' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).find(item => item.text?.startsWith('Estimated cost:'))?.text).toBe('Estimated cost: Not available')
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})
