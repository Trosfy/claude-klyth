// Registered main and child routes exercise the same daemon retry owner without changing their pins.
import { expect, test } from 'claude-code/testing'
import { CONFIG_OBJECT, HELPER, ORIGIN, model, sse, start, step, world } from './world'

const CONFIG = JSON.stringify({ ...CONFIG_OBJECT, providers: { acme: { ...CONFIG_OBJECT.providers.acme, kind: 'openai-responses', sessionHeader: 'session_id', models: Object.fromEntries(Object.entries(CONFIG_OBJECT.providers.acme.models).map(([id, m]) => [id, { ...m, maxTokensParam: 'max_output_tokens' }])) } } })
const TRUSTED = { [`trust:openai-responses|${ORIGIN}|cmd:${JSON.stringify(HELPER)}`]: true }
const FAILURE = sse({ type: 'response.failed', response: { error: { code: 'server_error', message: 'Our servers are currently overloaded. Please try again later.' } } })
const SUCCESS = sse({ type: 'response.output_text.delta', delta: 'recovered' }, { type: 'response.completed', response: {} })

for (const child of [false, true]) test(`${child ? 'child' : 'main'} route recovers from pre-output overload with the same request and no native fallback`, async ($, on) => {
  let sends = 0
  const w = world(on, { config: CONFIG, store: TRUSTED, routes: { retryChild: { target: 'acme/model-a', label: 'fast', effort: 'high' } }, upstream: () => ({ pieces: [++sends === 1 ? FAILURE : SUCCESS] }) })
  await start($)
  if (!child) await model($, 'fast')
  const result = await step($, { turnId: 'retry-turn', index: 0, ...(child ? { agentId: 'retryChild' } : {}) })
  expect(result.result.answer).toBe('recovered')
  expect(result.result.toolUses).toEqual([])
  expect(w.requests).toHaveLength(2)
  expect(w.requests[1]).toEqual(w.requests[0]!)
  expect(w.nativeSteps).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth retry'))).toHaveLength(1)
})

for (const child of [false, true]) test(`${child ? 'child' : 'main'} route never replays partial output after overload`, async ($, on) => {
  const w = world(on, { config: CONFIG, store: TRUSTED, routes: { retryChild: { target: 'acme/model-a', label: 'fast', effort: 'high' } }, upstream: () => ({ pieces: [sse({ type: 'response.output_text.delta', delta: 'partial' }) + FAILURE] }) })
  await start($)
  if (!child) await model($, 'fast')
  const result = await step($, { turnId: 'partial-turn', index: 0, ...(child ? { agentId: 'retryChild' } : {}) })
  expect(result.result.answer).toContain('partial')
  expect(result.result.answer).toContain('response failed')
  expect(w.requests).toHaveLength(1)
  expect(w.nativeSteps).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth retry'))).toEqual([])
})
