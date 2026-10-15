import { expect, test } from 'bun:test'

import { openai } from './codecs/openai'
import { openaiResponses } from './codecs/openai-responses'
import { anthropic } from './codecs/anthropic'
import { parseConfig } from '../hooks/config'
import { CODECS } from './codecs'

const bytes = (text: string) => new TextEncoder().encode(text)
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const reported = (count: number) => ({ status: 'reported' as const, count })
const unknown = { status: 'unknown' as const }
const notApplicable = { status: 'notApplicable' as const }

test('OpenAI evidence keeps total input while missing cache details leave both input partitions unknown', () => {
  const decoder = openai.decoder()
  const decoded = decoder.feed(bytes(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })))
  expect(decoded).toEqual([{ t: 'usage', in: 10, out: 3, cacheRead: 0, cacheWrite: 0 }])
  expect(decoder.evidence?.()).toEqual({
    protocol: 'openai', finality: 'final', totalInput: reported(10), input: unknown, output: reported(3), cacheRead: unknown,
    cacheWrite: notApplicable, cacheWrite5m: notApplicable, cacheWrite1h: notApplicable, reasoning: unknown,
  })
})

test('OpenAI final usage in a finish chunk becomes final only after the stream ends cleanly', () => {
  const decoder = openai.decoder()
  decoder.feed(bytes(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })))
  expect(decoder.evidence?.()?.finality).toBe('provisional')
  decoder.end()
  expect(decoder.evidence?.()).toMatchObject({ finality: 'final', totalInput: reported(10), input: reported(10), output: reported(2) })
})

test('OpenAI evidence preserves an explicit zero cache count and rejects an inconsistent partition without a negative total', () => {
  const decoder = openai.decoder()
  decoder.feed(bytes(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } })))
  expect(decoder.evidence?.()).toMatchObject({ totalInput: reported(10), input: reported(10), cacheRead: reported(0) })
  const inconsistent = openai.decoder()
  inconsistent.feed(bytes(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 12 } } })))
  expect(inconsistent.evidence?.()).toMatchObject({ totalInput: reported(10), input: unknown, cacheRead: unknown })
})

test('Responses terminal failure retains final reported usage without adding legacy usage events', () => {
  const decoder = openaiResponses.decoder()
  const events = decoder.feed(bytes(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } }, error: { message: 'failed' } } })}\n\n`))
  expect(events).toEqual([{ t: 'error', message: '{"message":"failed"}', provider: true }])
  expect(decoder.evidence?.()).toMatchObject({ finality: 'final', totalInput: reported(7), input: reported(6), output: reported(2), cacheRead: reported(1) })
})

test('Anthropic cumulative snapshots retain field presence and accept TTL writes only when they match the aggregate', () => {
  const decoder = anthropic.decoder()
  decoder.feed(bytes(sse({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 } } })))
  decoder.feed(bytes(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } } })))
  expect(decoder.evidence?.()).toEqual({
    protocol: 'anthropic', finality: 'final', totalInput: reported(30), input: reported(20), output: reported(3),
    cacheRead: reported(0), cacheWrite: reported(10), cacheWrite5m: reported(10), cacheWrite1h: reported(0), reasoning: unknown,
  })
})

test('Anthropic absent cache partitions remain unknown while present zero input and output counts stay reported', () => {
  const decoder = anthropic.decoder()
  decoder.feed(bytes(sse({ type: 'message_start', message: { usage: { input_tokens: 0 } } })))
  decoder.feed(bytes(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })))
  expect(decoder.evidence?.()).toMatchObject({ totalInput: unknown, input: reported(0), output: reported(0), cacheRead: unknown, cacheWrite: unknown, finality: 'final' })
})

test('pricing metadata never appears in any provider request body', () => {
  const make = (kind: string, pricing: boolean) => {
    const config = parseConfig(JSON.stringify({ providers: { acme: {
      kind, baseUrl: 'https://klyth.invalid/v1', auth: { command: ['/bin/true'] },
      models: { m: { contextWindow: 100_000, maxOutputTokens: 1000, ...(pricing ? { pricing: { currency: 'USD', perMillionTokens: { input: 1, output: 4 } } } : {}) } },
    } } }))
    if (config.config === undefined) throw new Error(config.errors.join('; '))
    const provider = config.config.providers['acme']!
    const model = provider.models['m']!
    return CODECS[provider.kind].encode({ system: 'system', messages: [], tools: [] }, provider, model).body
  }
  for (const kind of ['openai', 'openai-responses', 'anthropic', 'bedrock']) {
    expect(make(kind, true), kind).toBe(make(kind, false))
    expect(make(kind, true), kind).not.toContain('perMillionTokens')
  }
})
