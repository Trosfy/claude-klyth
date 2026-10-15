import { expect, test } from 'claude-code/testing'
import { createUsageEnvelope, reduceUsage, type UsageEnvelope, type UsageSession } from '../hooks/usage-ledger'
import { finalEvidence, partitionedUsage } from '../hooks/usage-evidence'
import { createUsageLifetime, UsageOwnershipConflict, type UsagePort } from '../hooks/usage-lifetime'
import { renderUsagePane } from '../hooks/usage-pane'
import { usageNumber, usageCompactTokens, usageModelName, usageModelDetails, usageText, usageView } from '../hooks/usage-view'
import { klyth, SESSION_ID, start, step, world } from './world'

const pricing = { currency: 'USD' as const, perMillionTokens: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1.5 } }
function fixture(target = 'acme/model-a', prices = true, counts = true): UsageEnvelope {
  const id = `${SESSION_ID}:1:1`, executionId = '00000000-0000-4000-8000-000000000001'
  const token = { id, sessionId: SESSION_ID, generation: 1, sequence: 1 }
  let state = createUsageEnvelope(SESSION_ID, Date.UTC(2026, 9, 15, 12))
  state = reduceUsage(state, { type: 'begin', pending: { requestId: id, sessionId: SESSION_ID, generation: 1, sequence: 1, purpose: 'step', owner: 'main', target, startedAt: 1000, executions: {} } })
  state = reduceUsage(state, { type: 'dispatch', token, executionId, snapshot: { target, label: 'fast', ...(prices ? { pricing } : {}) } })
  const evidence = finalEvidence(partitionedUsage({ input_tokens: 12000, output_tokens: 1500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000 }, 'anthropic', { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }))
  state = reduceUsage(state, { type: 'summary', token, summary: { type: 'usage_summary', requestId: id, executionId, outcome: 'success', attempts: [{ sequence: 1, outcome: 'success', ...(counts ? { evidence } : {}) }] } })
  return reduceUsage(state, { type: 'settle', token, at: 2000 })
}
const props = (columns: number) => ({ title: 'Klyth usage', isFocused: true, bodyColumns: columns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 18 }, view: {} })

for (const width of [80, 110, 144]) test(`usage cost states and controls match the text report at ${width} columns`, { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const empty = createUsageEnvelope(SESSION_ID, 1000).sessions[0]!
  const pending = structuredClone(empty)
  pending.logicalRequests = 1
  pending.pending.pending = { requestId: 'pending', sessionId: SESSION_ID, generation: 1, sequence: 1, purpose: 'step', owner: 'main', target: 'acme/model-a', startedAt: 1000, executions: {} }
  const refused = structuredClone(empty); refused.logicalRequests = 1; refused.executions.refused = 1
  const cases = [
    [undefined, 'Not available'],
    [empty, 'No requests yet. Run a request through Klyth to see usage.'],
    [pending, 'Work in progress. Wait for the request to finish.'],
    [fixture('acme/model-a', false).sessions[0], 'Not available. Some usage has no cost estimate. Add model prices under pricing in klyth.json.'],
    [fixture('acme/model-a', true, false).sessions[0], 'Not available. Some token counts are missing. Run another request to check usage data.'],
    [refused, 'Not available. No provider calls have usage data. Run another request through Klyth.'],
    [fixture().sessions[0], '$0.0215'],
  ] as const
  let current: UsageSession | undefined = cases[0][0]
  on('ui.render', { component: 'Pane', requestId: 'copy-fixture' }, ($, e) => renderUsagePane({ elements: $.ui.resolve(e), change: async () => {}, close: async () => {}, text: async () => {} }, SESSION_ID, current, undefined, e.props.bodyColumns))
  const ui = await $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'copy-fixture', props: props(width), viewport: { columns: width, rows: 35 } })
  for (const [session, cost] of cases) {
    current = session
    await ui.redraw()
    const lines = (await ui.findAll({ type: 'Text' })).map(item => item.text)
    const expected = `Estimated cost: ${cost}`
    expect(lines).toContain(expected)
    expect(usageText(session)[1]).toBe(expected)
    expect(lines.indexOf('Press Escape to close.')).toBeLessThan(lines.indexOf(expected))
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons[0]?.key).toBe(session === undefined ? 'text' : 'diagnostics')
    expect(buttons.findIndex(item => item.key === 'close')).toBeLessThan(buttons.findIndex(item => item.key?.startsWith('model-')) < 0 ? buttons.length : buttons.findIndex(item => item.key?.startsWith('model-')))
    expect(await ui.drawn()).toBeDefined()
  }
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})

for (const width of [80, 144]) test(`long provider keeps a model name at ${width} columns`, { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const target = `${'very-long-provider-name-'.repeat(3)}/${'distinct-model-name-'.repeat(8)}`
  const state = fixture(target)
  on('ui.render', { component: 'Pane', requestId: 'long-fixture' }, ($, e) => renderUsagePane({ elements: $.ui.resolve(e), change: async () => {}, close: async () => {}, text: async () => {} }, SESSION_ID, state.sessions[0], undefined, e.props.bodyColumns))
  const ui = await $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'long-fixture', props: props(width), viewport: { columns: width, rows: 35 } })
  const model = (await ui.findAll({ type: 'Button' })).find(item => item.key === `model-${target}`)!
  expect(model.text).toContain('very-l')
  expect(model.text).toContain('distin')
  expect(model.text!.length).toBeLessThanOrEqual(width)
  if (width === 144) expect(model.text!.length).toBeGreaterThan(usageModelName(target, 55).length + 20)
  expect(usageModelDetails(usageView(state.sessions[0]!).models[0]!).join('\n')).toContain(target)
  expect(await ui.drawn()).toBeDefined()
  await ui.unmount()
})

test('fenced lifetime has its own pane and text warning instead of the save-failure assurance', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  let value: unknown, version = 0, conflict = false
  const port: UsagePort = {
    sessionId: async () => SESSION_ID, now: async () => 1000,
    state: async () => ({ value, version }),
    setState: async next => { if (conflict) throw new UsageOwnershipConflict('forced conflict'); value = structuredClone(next); return ++version },
    storeGet: async () => undefined, storeSet: async () => {}, after: () => ({ cancel: () => {} }), context: async () => undefined, log: () => {},
  }
  const life = createUsageLifetime()
  on('ui.render', { component: 'Pane', requestId: 'fenced-fixture' }, ($, e) => renderUsagePane({ elements: $.ui.resolve(e), change: async () => {}, close: async () => {}, text: async () => {} }, SESSION_ID, life.snapshot()?.sessions[0], undefined, e.props.bodyColumns, undefined, life.recordState()))
  await life.start(port)
  for (let i = 0; i < 24; i++) await Promise.resolve()
  conflict = true
  const request = life.observer.begin({ purpose: 'step', owner: 'main', target: 'acme/model-a' })!
  for (let i = 0; i < 48; i++) await Promise.resolve()
  life.observer.settle(request, 'complete')
  expect(life.observer.begin({ purpose: 'step', owner: 'main', target: 'acme/model-a' })).toBeUndefined()
  const ui = await $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'fenced-fixture', props: props(80) })
  const lines = (await ui.findAll({ type: 'Text' })).map(item => item.text)
  const warning = 'Klyth cannot update this usage record. Totals may be incomplete.'
  expect(lines).toContain(warning)
  const report = await life.text(port)
  expect(report).toContain(warning)
  expect(report).toContain('Estimated cost: Not available. Klyth cannot update this usage record.')
  expect(report).toContain('Requests without final records: 1')
  expect(report.join('\n')).not.toContain('Wait for')
  expect(lines.join('\n')).not.toContain('Wait for')
  expect(lines.join('\n')).toContain('1 request without final records.')
  expect(lines.join('\n')).not.toContain('live totals are still tracked')
  expect(lines.join('\n')).not.toContain('Klyth could not save usage.')
  expect(lines).toContain('Print this report to keep the current totals.')
  await ui.unmount()
})

test('text report puts cost, one warning and model groups before session diagnostics', () => {
  const session = fixture().sessions[0]!
  session.warnings.recovered = true
  session.warnings.persistenceFailure = true
  session.warnings.trackingGap = true
  const lines = usageText(session)
  expect(lines[1]).toBe('Estimated cost: At least $0.0215. Some usage data is missing. Open Session details.')
  expect(lines[2]).toBe('Klyth could not save usage. Totals may be incomplete.')
  expect(lines.filter(line => line.includes('Totals may be incomplete.'))).toHaveLength(1)
  const model = lines.indexOf('Model: acme/model-a'), details = lines.indexOf('Session details')
  expect(model).toBeGreaterThan(2)
  expect(details).toBeGreaterThan(model)
  expect(lines.indexOf('Reported input tokens: 21,000')).toBeGreaterThan(details)
  expect(lines[model + 2]).toBe('Requests: 1')
  expect(lines[model + 3]).toBe('Input tokens: 21,000')
  expect(lines[model + 4]).toBe('Output tokens: 1,500')
})

test('expanded details use purpose and result labels, full numbers and dollar amounts', () => {
  const session = fixture().sessions[0]!, bucket = Object.values(session.buckets)[0]!
  bucket.purpose = 'classifier'; bucket.owner = 'child'; bucket.outcomes.responseError = 1
  let details = usageModelDetails(usageView(session).models[0]!).join('\n')
  expect(details).toContain('Auto mode checks for subagents')
  expect(details).toContain('Response errors: 1')
  expect(details).toContain('Total input tokens: 21,000')
  expect(details).toContain('Reasoning tokens within output:')
  expect(details).not.toContain('cacheWrite5m')
  bucket.purpose = 'compaction'
  details = usageModelDetails(usageView(session).models[0]!).join('\n')
  expect(details).toContain('Conversation summaries for subagents')
  session.costUsd = 1e21
  expect(usageText(session)[1]).toBe('Estimated cost: $1,000,000,000,000,000,000,000')
  session.costUsd = 1e-13; session.costIncompleteAttempts = 1
  expect(usageText(session)[1]).toBe('Estimated cost: At least $0.0000000000001. Some usage has no cost estimate. Add model prices under pricing in klyth.json.')
})

test('token values keep full digits and explain missing and non-final counts', () => {
  expect(usageNumber(1234000)).toBe('1,234,000')
  expect(usageCompactTokens({ count: 12500, unknown: 1, partial: 0 })).toBe('12,500 tokens. Some counts are missing.')
  expect(usageCompactTokens({ count: 0, unknown: 1, partial: 200 })).toBe('No final token count. Other calls reported at least 200 tokens. Their final counts are not available. Some counts are missing.')
})

test('registered usage pane receives the fenced lifetime state', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  let conflict = false
  on('state.set', { plugin: 'klyth', key: 'usage' }, ($, e, next) => conflict ? { value: { isSet: false, version: 100 } } : next(e))
  await start($)
  conflict = true
  await $.command.run({ command: 'model', args: 'fast', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($, { turnId: 'fenced-pane', index: 0 })
  const ui = await $.ui.mount({ plugin: 'klyth', surface: 'terminal', component: 'Pane', requestId: 'klyth-usage', props: props(80) })
  const warning = 'Klyth cannot update this usage record. Totals may be incomplete.'
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text)).toContain(warning)
  await klyth($, 'usage text')
  expect(w.transcript).toContain(warning)
  await ui.unmount()
})

test('a refused model does not inherit pending work for another model', () => {
  let state = createUsageEnvelope(SESSION_ID, 1000)
  const id = `${SESSION_ID}:1:1`, executionId = '00000000-0000-4000-8000-000000000001'
  const token = { id, sessionId: SESSION_ID, generation: 1, sequence: 1 }
  state = reduceUsage(state, { type: 'begin', pending: { requestId: id, sessionId: SESSION_ID, generation: 1, sequence: 1, purpose: 'step', owner: 'main', target: 'acme/refused', startedAt: 1000, executions: {} } })
  state = reduceUsage(state, { type: 'dispatch', token, executionId, snapshot: { target: 'acme/refused', label: 'refused' } })
  state = reduceUsage(state, { type: 'summary', token, summary: { type: 'usage_summary', requestId: id, executionId, outcome: 'refused', attempts: [] } })
  state = reduceUsage(state, { type: 'settle', token, at: 2000 })
  const before = usageView(state.sessions[0]!).models[0]!.estimatedCost
  state = reduceUsage(state, { type: 'begin', pending: { requestId: `${SESSION_ID}:1:2`, sessionId: SESSION_ID, generation: 1, sequence: 2, purpose: 'step', owner: 'main', target: 'acme/other', startedAt: 3000, executions: {} } })
  expect(usageView(state.sessions[0]!).models[0]!.estimatedCost).toBe(before)
  expect(before).toBe('Not available. No provider calls have usage data. Run another request through Klyth.')
})

for (const width of [80, 144]) test(`shared model prefixes and shortening collisions stay distinct at ${width} columns`, { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const session = fixture().sessions[0]!, base = Object.values(session.buckets)[0]!
  const prefix = 'very-long-model-prefix-'.repeat(5)
  const targets = [`provider/${prefix}-a`, `provider/${prefix}-b`, `provider/${prefix}-left-${prefix}`, `provider/${prefix}-right-${prefix}`]
  expect(usageModelName(targets[0]!, width - 25)).not.toBe(usageModelName(targets[1]!, width - 25))
  expect(usageModelName(targets[0]!, width - 25)).toContain('provider/very-long')
  session.buckets = Object.fromEntries(targets.map(target => [target, { ...structuredClone(base), target }]))
  on('ui.render', { component: 'Pane', requestId: 'distinct-fixture' }, ($, e) => renderUsagePane({ elements: $.ui.resolve(e), change: async () => {}, close: async () => {}, text: async () => {} }, SESSION_ID, session, undefined, e.props.bodyColumns))
  const ui = await $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'distinct-fixture', props: props(width), viewport: { columns: width, rows: 35 } })
  const labels = (await ui.findAll({ type: 'Button' })).filter(item => item.key?.startsWith('model-')).map(item => item.text!)
  expect(labels).toHaveLength(4)
  expect(new Set(labels).size).toBe(4)
  expect(labels.every(label => label.length <= width)).toBe(true)
  await ui.unmount()
})

for (const count of [0, 1, 2]) test(`token formatters agree with counts of ${count}`, () => {
  const plural = count === 1 ? '' : 's'
  expect(usageCompactTokens({ count, unknown: 0, partial: 0 })).toBe(String(count))
  const compact = usageCompactTokens({ count, unknown: 0, partial: 1 })
  expect(compact).toBe(`${count} final token${plural}. Other calls reported at least 1 token. Their final counts are not available.`)
  if (count > 0) expect(usageCompactTokens({ count: 1, unknown: 0, partial: count })).toBe(`1 final token. Other calls reported at least ${count} token${plural}. Their final counts are not available.`)
  const session = fixture().sessions[0]!, bucket = Object.values(session.buckets)[0]!
  bucket.totals.totalInput = { count: 1, unknown: 0, partial: count }
  const line = usageModelDetails(usageView(session).models[0]!).find(item => item.startsWith('Total input tokens:'))
  expect(line).toBe(count === 0 ? 'Total input tokens: 1' : `Total input tokens: 1. Other calls reported at least ${count} token${plural}. Their final counts are not available.`)
})

function settledPartial(state: UsageEnvelope, sequence = 1): UsageEnvelope {
  const id = `${SESSION_ID}:1:${sequence}`, executionId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
  const token = { id, sessionId: SESSION_ID, generation: 1, sequence }
  state = reduceUsage(state, { type: 'begin', pending: { requestId: id, sessionId: SESSION_ID, generation: 1, sequence, purpose: 'step', owner: 'main', target: 'acme/model-a', startedAt: 1000, executions: {} } })
  state = reduceUsage(state, { type: 'dispatch', token, executionId, snapshot: { target: 'acme/model-a', label: 'fast', pricing } })
  const evidence = partitionedUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'anthropic', { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' })
  state = reduceUsage(state, { type: 'summary', token, summary: { type: 'usage_summary', requestId: id, executionId, outcome: 'failure', attempts: [{ sequence: 1, outcome: 'cut', evidence }] } })
  return reduceUsage(state, { type: 'settle', token, at: 2000 })
}

for (const mixed of [false, true]) test(`settled partial counts have no pricing action or future promise, mixed final counts ${mixed}`, { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const state = settledPartial(mixed ? fixture() : createUsageEnvelope(SESSION_ID, 1000), mixed ? 2 : 1)
  const session = state.sessions[0]!, row = usageView(session).models[0]!
  expect(session.totals.totalInput).toEqual({ count: mixed ? 21000 : 0, unknown: 0, partial: 10 })
  expect(Object.keys(session.pending)).toHaveLength(0)
  const cost = `Estimated cost: ${mixed ? 'At least $0.0215.' : 'Not available.'} Some calls have no final token counts. Open Session details.`
  const report = usageText(session)
  expect(report[1]).toBe(cost)
  expect(report).toContain(`Input tokens: ${mixed ? '21,000' : '0'}. Other calls reported at least 10 tokens. Their final counts are not available.`)
  expect(report).toContain('Requests in progress: 0')
  expect(report.join('\n')).not.toContain('await')
  expect(report.join('\n')).not.toContain('Add model prices')
  expect(usageModelDetails(row).join('\n')).not.toContain('await')
  on('ui.render', { component: 'Pane', requestId: 'partial-fixture' }, ($, e) => renderUsagePane({ elements: $.ui.resolve(e), change: async () => {}, close: async () => {}, text: async () => {} }, SESSION_ID, session, { sessionId: SESSION_ID, filter: 'All', page: 0, detailPage: 0, expanded: row.target, diagnostics: true }, e.props.bodyColumns))
  const ui = await $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'partial-fixture', props: props(80) })
  const lines = (await ui.findAll({ type: 'Text' })).map(item => item.text)
  expect(lines).toContain(cost)
  expect(lines).toContain(`${mixed ? '21,000' : '0'} final tokens. Other calls reported at least 10 tokens. Their final counts are not available.`)
  expect(lines.join('\n')).not.toContain('await')
  expect(lines.join('\n')).not.toContain('Add model prices')
  await ui.unmount()
})

for (const count of [0, 1, 2]) test(`context and cache text use token agreement for ${count}`, () => {
  const session = fixture().sessions[0]!, bucket = Object.values(session.buckets)[0]!
  session.cacheInputTokens = count; session.cacheReadTokens = count; session.cacheEligibleAttempts = 1
  bucket.cacheInputTokens = count; bucket.cacheReadTokens = count; bucket.cacheEligibleAttempts = 1
  const report = usageText(session, count)
  const unit = count === 1 ? 'token' : 'tokens'
  expect(report).toContain(`Current conversation size: About ${count} ${unit}. This is not total usage.`)
  if (count > 0) expect(report.filter(line => line.startsWith('Input tokens from cache:'))).toEqual([
    `Input tokens from cache: 100.0%. ${count} of ${count} input ${unit} came from cache across 1 provider call.`,
    `Input tokens from cache: 100.0%. ${count} of ${count} input ${unit} came from cache across 1 provider call.`,
  ])
  else expect(report).toContain('Input tokens from cache: Not available. 1 provider call reported zero input tokens.')
})
