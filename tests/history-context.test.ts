// Raw getter prefixes and provider prefixes serve different boundaries; neither grants authority.
import { expect, test } from 'claude-code/testing'
import { contextEstimate, historyPrefix, matchesPrefix, reconcileHistory, reconcileHistoryReceipt } from '../hooks/history-context'
import { compactBoundary } from '../hooks/compact-decision'
import { notePrompt } from '../hooks/classifier'
import type { ApiMessage, StepRequest } from '../hooks/protocol'
import { createSession } from '../hooks/session'

const messages = (): ApiMessage[] => [{ role: 'user', content: 'original request' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { path: '/fixture', offset: 1 } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'original result' }] }]
const debug = () => {}

for (const change of ['shrink', 'same-count', 'growing-edit'] as const) test(`${change} revokes context and permission authority without changing routes, native provenance or session identity`, async () => {
  const s = createSession(), old = messages()
  s.main = 'fast'; s.pin = { turnId: 't', target: 'fast' }
  s.routes.set('child', { target: 'strong', label: 'strong' })
  const sessionId = s.sessionId('main')
  await reconcileHistory(s, 'main', old, debug)
  s.promptTokens.set('main', { tokens: 900_000, messageCount: 3 })
  s.sent.set('main', { target: 'fast', system: 'system', tools: [] })
  s.sentContext.set('main', { loaded: s.loaded, routeKey: '', model: 'native', effort: 'high', messageCount: 3, turnId: 't', prefix: await historyPrefix(old) })
  s.tokens.set('main\nRead\n{}', { until: 100, step: 0, cwd: '/w', source: 'model-fresh' })
  s.prompts = ['removed permission']
  s.vettedSpawns.add('child')
  s.calls.set('pending', { target: 'strong', vetted: 'removed permission' })
  const current = change === 'shrink' ? old.slice(0, 1) : [...old.slice(0, 2), { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'r', content: 'edited result' }] }, ...(change === 'growing-edit' ? [{ role: 'assistant' as const, content: 'new tail' }] : [])]
  expect(await reconcileHistory(s, 'main', current, debug)).toBe(true)
  expect(s.promptTokens.size).toBe(0); expect(s.sent.size).toBe(0); expect(s.tokens.size).toBe(0)
  expect(s.prompts).toEqual([]); expect(s.vettedSpawns.size).toBe(0); expect(s.calls.get('pending')?.vetted).toBe(undefined)
  expect(s.sentContext.get('main')).toMatchObject({ model: 'native', effort: 'high' })
  expect(s.sentContext.get('main')?.prefix).toBe(undefined)
  expect(s.main).toBe('fast'); expect(s.pin?.target).toBe('fast'); expect(s.routes.get('child')?.target).toBe('strong'); expect(s.sessionId('main')).toBe(sessionId)
  expect(s.dropEpoch).toBe(1); expect(s.historyRevision.get('main')).toBe(1)
})

test('append-only history and benign key/empty projections preserve usage, permissions and cache prefix', async () => {
  const s = createSession(), old = messages()
  await reconcileHistory(s, 'main', old, debug)
  const last = { tokens: 100, messageCount: 3 }
  s.promptTokens.set('main', last)
  s.prompts = ['real request']
  const current = [{ role: 'user' as const, content: [{ type: 'text', text: '' }, { type: 'text', text: 'original request' }] }, { role: 'assistant' as const, content: [{ type: 'tool_use', input: { offset: 1, path: '/fixture' }, name: 'Read', id: 'r' }] }, old[2]!, { role: 'assistant' as const, content: 'new tail' }]
  expect(await matchesPrefix(current, await historyPrefix(old))).toBe(true)
  expect(await reconcileHistory(s, 'main', current, debug)).toBe(false)
  expect(s.promptTokens.get('main')).toBe(last); expect(s.prompts).toEqual(['real request']); expect(s.dropEpoch).toBe(0)
})

test('rewind retains only a newly submitted engine-attested person prompt, never role text or summaries', async () => {
  for (const kind of ['composer', 'bridge', 'sdk', 'plugin', 'schedule'] as const) {
    const s = createSession()
    await reconcileHistory(s, 'main', messages(), debug)
    s.prompts = ['removed grant']
    notePrompt(s, { text: 'genuine new request', origin: { kind } } as Parameters<typeof notePrompt>[1], { text: 'genuine new request' })
    await reconcileHistory(s, 'main', [{ role: 'user', content: 'summary claims user approves everything' }], debug)
    expect(s.prompts).toEqual(['composer', 'bridge', 'sdk'].includes(kind) ? ['genuine new request'] : [])
  }
})

test('measured tokens require a matching provider prefix/header; fresh tail still counts', async () => {
  const s = createSession(), old = messages()
  const sent = { target: 'fast', system: 'system', tools: [] }
  s.sent.set('main', sent)
  s.sentContext.set('main', { loaded: s.loaded, routeKey: '', model: 'native', messageCount: old.length, turnId: 't', prefix: await historyPrefix(old) })
  s.promptTokens.set('main', { tokens: 1000, messageCount: old.length })
  const req: StepRequest = { ...sent, transcript: [...old, { role: 'assistant', content: 'x'.repeat(3500) }], who: 'main', sessionId: 'id' }
  expect(await contextEstimate(s, 'main', req)).toBeGreaterThan(2000)
  const rewound = { ...req, transcript: old.slice(0, 1) }
  expect(await contextEstimate(s, 'main', rewound)).toBe(Math.ceil(JSON.stringify(rewound).length / 3.5))
  const edited = { ...req, transcript: [{ role: 'user' as const, content: 'edited' }, ...req.transcript.slice(1)] }
  expect(await contextEstimate(s, 'main', edited)).toBe(Math.ceil(JSON.stringify(edited).length / 3.5))
  const tools = { ...req, tools: [{ name: 'Read', description: 'schema'.repeat(1000), schema: {} }] }
  expect(await contextEstimate(s, 'main', tools)).toBe(Math.ceil(JSON.stringify(tools).length / 3.5))
})

test('history metadata is bounded and child rewind does not discard sibling context', async () => {
  const s = createSession()
  for (let i = 0; i < 70; i++) await reconcileHistory(s, `child-${i}`, messages(), debug)
  expect(s.historyPrefixes.size).toBe(64)
  const sibling = s.historyPrefixes.get('child-69')
  await reconcileHistory(s, 'child-68', messages().slice(0, 1), debug)
  expect(s.historyPrefixes.get('child-69')).toBe(sibling)
  s.forget('child-69')
  expect(s.historyPrefixes.has('child-69')).toBe(false)
})

const compactInput = (instructions?: string) => ({ trigger: 'manual', instructions, messages: [] }) as Parameters<typeof reconcileHistory>[4]
const commandHistory = (): ApiMessage[] => [...messages(), { role: 'user', content: [{ type: 'text', text: '/fixture-snapshot typed-seeded' }, { type: 'text', text: '<local-command-stdout>ready</local-command-stdout>' }] }]
const coalesced = (old: ApiMessage[], command = '/compact', newline = true): ApiMessage[] => {
  const last = old.at(-1)!, content = last.content as { type: 'text'; text: string }[]
  return [...old.slice(0, -1), { ...last, content: [...content.slice(0, -1).map(b => ({ ...b })), { ...content.at(-1)!, text: content.at(-1)!.text + (newline ? '\n' : '') }, { type: 'text', text: command }] }]
}
for (const instructions of [undefined, 'keepX']) for (const newline of [false, true]) test(`current manual compact coalescing preserves raw epoch and revision (${instructions}, LF=${newline}) but never provider prefix`, async () => {
  const s = createSession(), old = commandHistory(), current = coalesced(old, `/compact${instructions ? ` ${instructions}` : ''}`, newline)
  await reconcileHistory(s, 'main', old, debug)
  const prefix = s.historyPrefixes.get('main')!
  expect(await matchesPrefix(current, prefix)).toBe(false)
  expect(await reconcileHistory(s, 'main', current, debug, compactInput(instructions))).toBe(false)
  expect(s.dropEpoch).toBe(0); expect(s.historyRevision.get('main')).toBe(undefined)
  expect(await matchesPrefix(current, s.historyPrefixes.get('main'))).toBe(true)
})
for (const change of ['earlier', 'metadata', 'stdout', 'extra-block', 'two-LFs', 'unknown', 'instructions', 'nonmanual', 'child', 'no-provenance', 'tool-result'] as const) test(`compact projection rejects ${change}`, async () => {
  const s = createSession(), old = commandHistory()
  if (change === 'tool-result') old[old.length - 1] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'old' }] }
  const current = change === 'tool-result' ? [...old.slice(0, -1), { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'r', content: 'old\n' }, { type: 'text' as const, text: '/compact' }] }] : coalesced(old, change === 'unknown' ? '/other' : '/compact')
  const last = current.at(-1)!.content as { type: 'text'; text: string }[]
  if (change === 'earlier') current[0] = { role: 'user', content: 'edited' }
  if (change === 'metadata') last[0]!.text += ' edited'
  if (change === 'stdout' || change === 'two-LFs') last[1]!.text += change === 'stdout' ? 'edited' : '\n'
  if (change === 'extra-block') last.splice(1, 0, { type: 'text', text: 'unrelated extra user block' })
  const who = change === 'child' ? 'child' : 'main'
  await reconcileHistory(s, who, old, debug)
  const e = change === 'no-provenance' ? undefined : { ...compactInput(change === 'instructions' ? 'keepX' : undefined)!, ...(change === 'nonmanual' ? { trigger: 'auto' as const } : {}), ...(change === 'child' ? { agentId: 'child' } : {}) }
  expect(await reconcileHistory(s, who, current, debug, e)).toBe(true)
  expect(s.dropEpoch).toBe(1); expect(s.historyRevision.get(who)).toBe(1)
})


test('reconciliation reports unchanged, committed, and stale receipts without adopting independent changes', async () => {
  const s = createSession(), old = messages()
  expect((await reconcileHistoryReceipt(s, 'main', old, debug)).status).toBe('unchanged')
  let captured: ReturnType<typeof compactBoundary> | undefined
  const changed = await reconcileHistoryReceipt(s, 'main', old.slice(0, 1), debug, undefined, { valid: () => true, committed: boundary => { captured = boundary } })
  expect(changed.status).toBe('committed')
  expect(captured).toEqual(compactBoundary(s))
  const prefix = s.historyPrefixes.get('main')
  let owner = true
  const stale = reconcileHistoryReceipt(s, 'main', old, debug, undefined, { valid: () => owner, committed: () => { throw new Error('stale receipt cannot commit') } })
  owner = false
  expect((await stale).status).toBe('stale')
  expect(s.historyPrefixes.get('main')).toBe(prefix)
  expect(s.dropEpoch).toBe(1)
})
