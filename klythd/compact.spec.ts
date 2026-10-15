// Per-request compaction limits override params only on protocols/models declaring output-cap support.
import { expect, test } from 'bun:test'

import { parseConfig } from '../hooks/config'
import { CODECS } from './codecs'

for (const kind of ['openai', 'openai-responses', 'anthropic', 'bedrock'] as const) test(`${kind} compaction caps output after every configured params layer without mutating config`, () => {
  const key = kind === 'openai' ? 'max_completion_tokens' : kind === 'openai-responses' ? 'max_output_tokens' : kind === 'anthropic' ? 'max_tokens' : 'inferenceConfig'
  const limits = kind === 'anthropic' ? {} : kind === 'bedrock' ? { inferenceConfig: { maxTokens: 100_000, temperature: 0.5 } } : { [key]: 100_000 }
  const config = parseConfig(JSON.stringify({ providers: { p: { kind, baseUrl: kind === 'bedrock' ? 'https://bedrock-runtime.us-east-1.amazonaws.com' : 'https://klyth.invalid', auth: kind === 'bedrock' ? { command: ['/key'] } : 'none', params: limits, models: { m: { contextWindow: 1_000_000, maxOutputTokens: 128_000, ...(kind.startsWith('openai') ? { maxTokensParam: key } : {}), params: limits } } } } })).config!
  const p = config.providers['p']!, m = p.models['m']!
  const before = JSON.stringify(config)
  const neutral = { system: 'summary', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'data' }] }], tools: [] }
  const body = JSON.parse(CODECS[kind].encode({ ...neutral, outputTokens: 8000 }, p, m).body)
  expect(kind === 'bedrock' ? body.inferenceConfig.maxTokens : body[key]).toBe(8000)
  expect(JSON.stringify(config)).toBe(before)
  const normal = JSON.parse(CODECS[kind].encode(neutral, p, m).body)
  expect(kind === 'bedrock' ? normal.inferenceConfig.maxTokens : normal[key]).toBe(kind === 'anthropic' ? 128_000 : 100_000)
})

test('Responses without maxTokensParam never invents max_output_tokens', () => {
  const config = parseConfig(JSON.stringify({ providers: { p: { kind: 'openai-responses', baseUrl: 'https://klyth.invalid', auth: 'none', models: { m: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 } } } } })).config!
  const p = config.providers['p']!, m = p.models['m']!
  const body = JSON.parse(CODECS['openai-responses'].encode({ system: 'summary', messages: [{ role: 'user', content: [{ type: 'text', text: 'data' }] }], tools: [], outputTokens: 8000 }, p, m).body)
  expect(body.max_output_tokens).toBeUndefined()
})

for (const kind of ['anthropic', 'bedrock'] as const) for (const layer of ['provider', 'model', 'effort'] as const) test(`${kind} ${layer} fixed thinking overlay is bounded only for maintenance`, () => {
  const thinking = { type: 'enabled', budget_tokens: 16_000 }
  const params = kind === 'anthropic' ? { thinking } : { additionalModelRequestFields: { thinking } }
  const parsed = parseConfig(JSON.stringify({ providers: { p: { kind, baseUrl: kind === 'bedrock' ? 'https://bedrock-runtime.us-east-1.amazonaws.com' : 'https://klyth.invalid', auth: kind === 'bedrock' ? { command: ['/key'] } : 'none', ...(layer === 'provider' ? { params } : {}), models: { m: { contextWindow: 200_000, maxOutputTokens: 32_000, ...(layer === 'model' ? { params } : {}), ...(layer === 'effort' ? { effort: { high: params } } : {}) } } } } }))
  expect(parsed.errors).toEqual([])
  const p = parsed.config!.providers['p']!, m = p.models['m']!, before = JSON.stringify(parsed.config)
  const n = { system: 'summary', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'data' }] }], tools: [], effort: 'high' as const }
  const read = (body: string) => { const v = JSON.parse(body); return kind === 'anthropic' ? v.thinking : v.additionalModelRequestFields.thinking }
  expect(read(CODECS[kind].encode({ ...n, maintenance: true, outputTokens: 8000 }, p, m).body).budget_tokens).toBe(7999)
  expect(read(CODECS[kind].encode(n, p, m).body).budget_tokens).toBe(16_000)
  expect(JSON.stringify(parsed.config)).toBe(before)
})

for (const kind of ['anthropic', 'bedrock'] as const) test(`${kind} alias effort overrides remain supported and maintenance-only`, async () => {
  const { resolve } = await import('../hooks/names')
  const thinking = { type: 'enabled', budget_tokens: 16_000 }
  const params = kind === 'anthropic' ? { thinking } : { additionalModelRequestFields: { thinking } }
  const parsed = parseConfig(JSON.stringify({ providers: { p: { kind, baseUrl: kind === 'bedrock' ? 'https://bedrock-runtime.us-east-1.amazonaws.com' : 'https://klyth.invalid', auth: kind === 'bedrock' ? { command: ['/key'] } : 'none', models: { m: { contextWindow: 200_000, maxOutputTokens: 32_000 } } } }, aliases: { summary: { target: 'p/m', effort: { high: params } } } }))
  expect(parsed.errors).toEqual([])
  const target = resolve(parsed.config!, 'summary')!
  if (target.kind !== 'remote') throw new Error('expected remote fixture')
  const before = JSON.stringify(parsed.config)
  const n = { system: 'summary', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'data' }] }], tools: [], effort: 'high' as const }
  const body = JSON.parse(CODECS[kind].encode({ ...n, outputTokens: 8000 }, target.provider, target.model).body)
  expect((kind === 'anthropic' ? body.thinking : body.additionalModelRequestFields.thinking).budget_tokens).toBe(7999)
  const tiny = JSON.parse(CODECS[kind].encode({ ...n, outputTokens: 1024 }, target.provider, target.model).body)
  expect((kind === 'anthropic' ? tiny.thinking : tiny.additionalModelRequestFields.thinking).type).toBe('disabled')
  expect(JSON.stringify(parsed.config)).toBe(before)
})
