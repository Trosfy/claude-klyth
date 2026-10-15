// The `openai` codec: request bodies from the normalized transcript, and its decoder read the way klythd
// reads it (whole tool calls, ids minted, one stop or error) and the way the engine gets it (through the
// step assembler), against the captured LV1 fixtures and hand-built streams for the cases LV1 cannot produce.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TurnStepChunk } from 'claude-code'

import { parseConfig } from '../../hooks/config'
import type { Config, ModelConfig, ProviderConfig } from '../../hooks/config'
import { mintToolId } from '../../hooks/protocol'
import type { ApiMessage, StepEvent } from '../../hooks/protocol'
import { coalesce, createAssembler } from '../../hooks/step'
import { effortLevel } from '../codec'
import { normalize, remoteIds } from '../history'
import { assembler } from '../step'
import { openai, toMessages } from './openai'

const SSE = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'openai', name), 'utf8')

const cfg = (model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) => {
  const c = parseConfig(
    JSON.stringify({
      providers: {
        acme: {
          kind: 'openai',
          baseUrl: 'https://klyth.invalid/v1',
          auth: { command: ['/usr/bin/security'] },
          ...provider,
          models: { m: { contextWindow: 100_000, maxOutputTokens: 8000, ...model } },
        },
      },
    }),
  )
  expect(c.errors).toEqual([])
  const p = (c.config as Config).providers['acme'] as ProviderConfig
  return { p, m: p.models['m'] as ModelConfig }
}

// The Chat Completions messages for an engine transcript.
const oa = (messages: readonly ApiMessage[], m: ModelConfig, system = 'SYS') => toMessages({ system, messages: normalize(messages, m.vision, () => undefined), tools: [] }, m)

const body = (o: { model?: Record<string, unknown>; provider?: Record<string, unknown>; messages?: ApiMessage[]; effort?: unknown; tools?: { name: string }[]; ids?: Record<string, string> }) => {
  const { p, m } = cfg(o.model, o.provider)
  const built = openai.encode(
    {
      system: 'SYS',
      messages: normalize(o.messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], m.vision, id => o.ids?.[id]),
      tools: (o.tools ?? []).map(t => ({ name: t.name, description: `${t.name} tool`, schema: { type: 'object' } })),
      ...(o.effort === undefined ? {} : { effort: o.effort as never }),
    },
    p,
    m,
  )
  expect(built.path).toBe('/chat/completions')
  const sent: Record<string, unknown> = { ...(JSON.parse(built.body) as Record<string, unknown>), applied: built.effort }
  return sent
}

// Feeds `pieces` to a decoder and klythd's assembler, then ends them (`failure` is a transport cut), their
// events going through the step assembler as the mod sends them (each piece's coalesced); returns each
// feed's events and chunks, all chunks, the step's end with the note, and the remote ids.
function parse(pieces: readonly string[], failure?: string) {
  let n = 0
  const remote: Record<string, string> = {}
  const ids = remoteIds()
  const { p } = cfg()
  const asm = assembler(openai, 'acme', { ...ids, remember: (prov, minted, id) => ((remote[minted] = id), ids.remember(prov, minted, id)) }, () => `toolu_klyth_${String(++n).padStart(24, '0')}`)
  const decoder = openai.decoder()
  const chunker = createAssembler('acme/m')
  const bytes = new TextEncoder()
  const events = pieces.map(piece => asm.feed(decoder.feed(bytes.encode(piece))))
  const fed = events.map(evs => coalesce(evs).flatMap(ev => chunker.feed(ev)))
  const tail = failure === undefined ? asm.feed(decoder.end()) : []
  const ended = asm.end(p, failure)
  const closed = { ...ended, events: [...tail, ...ended.events] }
  const tailChunks = closed.events.flatMap(ev => chunker.feed(ev))
  const end = { ...chunker.end(), ...(closed.note === undefined ? {} : { note: closed.note }) }
  return { events, closed, fed, chunks: [...fed.flat(), ...tailChunks, ...end.chunks], end, remote }
}
const failed = (detail: string) => `klyth: acme response failed: ${detail}; retry, or see the debug log`
const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const delta = (d: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ choices: [{ index: 0, delta: d, ...extra }] })
const call = (index: number | undefined, fn: Record<string, unknown>, id?: string) => ({ ...(index === undefined ? {} : { index }), ...(id ? { id } : {}), type: 'function', function: fn })
const FINISH = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
const USAGE = { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } }
const kinds = (chunks: readonly TurnStepChunk[]) => chunks.map(c => `${c.kind}${'index' in c ? c.index : ''}`)

for (const model of ['model-a', 'model-b']) {
  test(`the ${model} LV1 step-1 fixture parses to one get_weather call and a tool_use stop`, () => {
    const { chunks, end, remote } = parse([SSE(`${model}-step1.sse`)])
    expect(kinds(chunks)).toEqual(['tool0', 'input0', 'stop'])
    expect(chunks[0]).toEqual({ kind: 'tool', index: 0, id: 'toolu_klyth_000000000000000000000001', name: 'get_weather' })
    expect(chunks[1]).toEqual({ kind: 'input', index: 0, json: '{"city":"London"}' })
    expect(end.stopReason).toBe('tool_use')
    expect(end.usage).toEqual({ input_tokens: 55, output_tokens: 19, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'acme/m' })
    expect(end.toolUses).toEqual([{ name: 'get_weather', input: { city: 'London' } }])
    expect(Object.values(remote)[0]).toMatch(/^call_/)
    expect(chunks.some(c => c.kind === 'thinking')).toBe(false)
  })

  test(`the ${model} LV1 step-2 fixture parses to the answer text and an end_turn stop`, () => {
    const { chunks, end } = parse([SSE(`${model}-step2.sse`)])
    const text = chunks.filter(c => c.kind === 'text')
    expect(text.every(c => c.index === 0)).toBe(true)
    expect(text.map(c => (c as { text: string }).text).join('')).toBe('London is 31°C with light rain.')
    expect(end.answer).toBe('London is 31°C with light rain.')
    expect(end.stopReason).toBe('end_turn')
    expect(end.usage).toMatchObject({ input_tokens: 95, output_tokens: 14, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(end.toolUses).toEqual([])
    expect(chunks.some(c => c.kind === 'thinking')).toBe(false)
  })
}

test('the next body after LV1 step 1 has exactly the step-2 shape the gateway accepted, with the remote id', () => {
  const { chunks, remote } = parse([SSE('model-a-step1.sse')])
  const minted = (chunks[0] as { id: string }).id
  const messages: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Weather in London?' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: minted, name: 'get_weather', input: { city: 'London' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: minted, content: '31°C, light rain' }] },
  ]
  const b = body({ messages, ids: remote })
  expect((b['messages'] as unknown[]).slice(2)).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_uSfVqgMohVm7xNnZOFY7ZHXv', type: 'function', function: { name: 'get_weather', arguments: '{"city":"London"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_uSfVqgMohVm7xNnZOFY7ZHXv', content: '31°C, light rain' },
  ])
})

test('without a stored remote id the minted id is sent back', () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_klyth_x', name: 'Read', input: { file_path: '/a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_x', content: 'text' }] },
  ]
  const sent = body({ messages })['messages'] as Record<string, unknown>[]
  expect(sent[2]).toMatchObject({ content: 'checking', tool_calls: [{ id: 'toolu_klyth_x' }] })
  expect(sent[3]).toMatchObject({ tool_call_id: 'toolu_klyth_x' })
})

test('body precedence: base, provider params, model params, effort level, then klyth-owned keys; null deletes; objects deep-merge', () => {
  const b = body({
    model: {
      maxTokensParam: 'max_tokens',
      params: { temperature: null, chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'low', max_tokens: 100 },
      effort: { high: { reasoning_effort: 'high' } },
    },
    provider: { params: { temperature: 0.2, top_p: 0.9, chat_template_kwargs: { keep: 1 }, stream: undefined } },
    effort: 'high',
  })
  expect(b).toMatchObject({ max_tokens: 100, top_p: 0.9, chat_template_kwargs: { keep: 1, enable_thinking: true }, reasoning_effort: 'high', model: 'm', stream: true })
  expect('temperature' in b).toBe(false)
  expect(b['stream_options']).toEqual({ include_usage: true })
  expect(body({ provider: { streamUsage: false } })['stream_options']).toBeUndefined()
})

test('maxTokensParam sends exactly the declared key, or none', () => {
  expect(body({ model: { maxTokensParam: 'max_completion_tokens' } })).toMatchObject({ max_completion_tokens: 8000 })
  const none = body({})
  expect(['max_tokens', 'max_completion_tokens'].filter(k => k in none)).toEqual([])
})

test('effort applies the declared level, else the nearest below, else above; nothing when undeclared or numeric', () => {
  const levels = { effort: { low: { reasoning_effort: 'low' }, high: { reasoning_effort: 'high' } } }
  expect(body({ model: levels, effort: 'medium' })).toMatchObject({ reasoning_effort: 'low', applied: 'low' })
  expect(body({ model: levels, effort: 'max' })).toMatchObject({ reasoning_effort: 'high', applied: 'high' })
  expect(body({ model: { effort: { high: { reasoning_effort: 'high' } } }, effort: 'low' })).toMatchObject({ reasoning_effort: 'high' })
  expect(body({ effort: 'high' })).toMatchObject({ applied: 'none' })
  expect('reasoning_effort' in body({ effort: 'high' })).toBe(false)
  expect(effortLevel(cfg(levels).m, 3)).toBeUndefined()
})

test('systemRole places the system text as system, developer, or a leading user message', () => {
  expect((body({})['messages'] as unknown[])[0]).toEqual({ role: 'system', content: 'SYS' })
  expect((body({ model: { systemRole: 'developer' } })['messages'] as unknown[])[0]).toEqual({ role: 'developer', content: 'SYS' })
  expect((body({ model: { systemRole: 'user' } })['messages'] as unknown[])[0]).toEqual({ role: 'user', content: 'System instructions:\n\nSYS' })
})

test('tools: false omits tools; parallelToolCalls: false sends parallel_tool_calls false with tools', () => {
  expect('tools' in body({ model: { tools: false }, tools: [{ name: 'Read' }] })).toBe(false)
  const b = body({ model: { parallelToolCalls: false }, tools: [{ name: 'Read' }] })
  expect(b).toMatchObject({ parallel_tool_calls: false, tools: [{ type: 'function', function: { name: 'Read', description: 'Read tool', parameters: { type: 'object' } } }] })
  expect('parallel_tool_calls' in body({ model: { parallelToolCalls: false } })).toBe(false)
})

test('tool results come first as tool messages, flattened, with Error: on errors and images moved to a user message', () => {
  const { m } = cfg()
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  const out = oa(
    [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'after' },
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, img, { type: 'text', text: 'b' }] },
          { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
        ],
      },
    ],
    m,
  )
  expect(out.slice(2)).toEqual([
    { role: 'assistant', content: null, tool_calls: [expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 't2' })] },
    { role: 'tool', tool_call_id: 't1', content: 'a\nb' },
    { role: 'tool', tool_call_id: 't2', content: 'Error: boom' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'after' }] },
  ])
  expect(JSON.stringify(out)).not.toContain('secret')
})

test('images respect vision, URL images pass through, documents are named, and orphan tool results are dropped', () => {
  const img = { type: 'image', source: { type: 'url', url: 'https://img.invalid/a.png' } }
  const msgs: ApiMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'orphan' }, img, { type: 'document', source: {} }] },
  ]
  expect(oa(msgs, cfg().m).slice(1)).toEqual([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.invalid/a.png' } }, { type: 'text', text: '[document omitted]' }] },
  ])
  expect(oa(msgs, cfg({ vision: false }).m).slice(1)).toEqual([
    { role: 'user', content: '[image omitted: model has no vision]\n\n[document omitted]' },
  ])
})

test('chunked SSE: split mid-line, CRLF, comments, no trailing newline; text, two calls and usage', () => {
  const stream = sse(delta({ content: 'Hel' }), delta({ content: 'lo' }), delta({ tool_calls: [call(0, { name: 'Read', arguments: '{"file_path"' }, 'call_a')] }), delta({ tool_calls: [call(0, { arguments: ':"/a"}' })] }), delta({ tool_calls: [call(1, { name: 'Bash', arguments: '{"command":"ls"}' }, 'call_b')] }), FINISH('tool_calls'), USAGE).replaceAll('\n\n', '\r\n: keep-alive\r\n\r\n') + 'data: [DONE]'
  const { chunks, end } = parse([stream.slice(0, 37), stream.slice(37, 300), stream.slice(300)])
  expect(kinds(chunks)).toEqual(['text0', 'tool1', 'input1', 'tool2', 'input2', 'stop'])
  expect(end).toMatchObject({ answer: 'Hello', stopReason: 'tool_use', toolUses: [{ name: 'Read', input: { file_path: '/a' } }, { name: 'Bash', input: { command: 'ls' } }] })
  expect(end.usage).toEqual({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, model: 'acme/m' })
})

test('block indexes: reasoning → text → tool is 0,1,2; text after a tool opens a new index', () => {
  const { chunks } = parse([sse(delta({ reasoning_content: 'hmm' }), delta({ content: 'x' }), delta({ tool_calls: [call(0, { name: 'Read', arguments: '{}' }, 'c')] }), delta({ content: 'y' }), FINISH('stop'), '[DONE]')])
  expect(kinds(chunks)).toEqual(['thinking0', 'text1', 'tool2', 'input2', 'text3', 'stop'])
  expect(parse([sse(delta({ reasoning: 'also' }), FINISH('stop'))]).chunks[0]).toEqual({ kind: 'thinking', index: 0, text: 'also' })
})

test('a second parallel call arriving as tool_calls[0] with index 1 is its own call', () => {
  const { end } = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{}' }, 'c0')] }), delta({ tool_calls: [call(1, { name: 'B', arguments: '{"x":1}' }, 'c1')] }), FINISH('tool_calls'))])
  expect(end.toolUses).toEqual([{ name: 'A', input: {} }, { name: 'B', input: { x: 1 } }])
})

test('empty arguments become {}; whole and object arguments are accepted', () => {
  const { chunks, end } = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '  ' }, 'c0')] }), delta({ tool_calls: [call(1, { name: 'B', arguments: { q: 1 } }, 'c1')] }), FINISH('tool_calls'))])
  expect(chunks.filter(c => c.kind === 'input').map(c => (c as { json: string }).json)).toEqual(['{}', '{"q":1}'])
  expect(end.toolUses).toEqual([{ name: 'A', input: {} }, { name: 'B', input: { q: 1 } }])
})

test('usage is read from a chunk with choices [] or [{delta: {}}], after the finish, which stays latched', () => {
  for (const choices of [[], [{ index: 0, delta: {} }]]) {
    const { end } = parse([sse(delta({ content: 'x' }), FINISH('length'), { ...USAGE, choices })])
    expect(end.stopReason).toBe('max_tokens')
    expect(end.usage?.cache_read_input_tokens).toBe(20)
  }
})

test('null fields are absent, unknown keys pass, data: without a space and event:/id: lines are accepted', () => {
  const stream = `event: message\nid: 7\ndata:${JSON.stringify({ ...delta({ content: null, tool_calls: [call(0, { name: 'A', arguments: '{}' }, 'c0')] }), provider_specific_fields: {}, cost: 1 })}\n\n` + sse(FINISH('tool_calls'))
  const { end } = parse([stream])
  expect(end.toolUses).toEqual([{ name: 'A', input: {} }])
  expect(parse([sse(delta({ content: 5 }), FINISH('stop'))]).end.answer).toBe(failed('malformed stream chunk: delta.content is not text'))
})

test('structured fields are validated by their own shapes', () => {
  expect(parse([sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 'zero', function: { name: 'A' } }] } }] }, FINISH('stop'))]).end.answer).toContain('a tool call index is not an index')
  expect(parse([sse({ ...USAGE, usage: { prompt_tokens: '1', completion_tokens: 2 } }, FINISH('stop'))]).end.answer).toContain('usage prompt_tokens or completion_tokens is not a count')
  expect(parse([sse({ ...USAGE, usage: { prompt_tokens: 1, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } } }, FINISH('stop'))]).end.answer).toContain('cached tokens')
  expect(parse([sse({ choices: { 0: {} } }, FINISH('stop'))]).end.answer).toContain('choices is not an array')
})

test('empty and role-only deltas between fragments do not end a held call', () => {
  const { end } = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{"a"' }, 'c0')] }), delta({}), delta({ role: 'assistant' }), delta({ content: '' }), delta({ tool_calls: [call(0, { arguments: ':1}' })] }), FINISH('tool_calls'))])
  expect(end).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'A', input: { a: 1 } }] })
})

test('an in-stream error, a missing finish and [DONE], and finish_reason "error" take the error path', () => {
  expect(parse([sse({ error: { message: 'boom' } })]).end).toMatchObject({ answer: failed('boom'), stopReason: 'end_turn', usage: null })
  expect(parse([sse(delta({ content: 'part' }))]).end.answer).toBe(`part${failed('the stream ended with no finish reason')}`)
  expect(parse([sse(delta({ content: 'x' }), FINISH('ERROR'))]).end.answer).toContain('finish_reason "error"')
})

test('finish reasons map case-insensitively; tool calls force tool_use; unknown reasons read as end_turn', () => {
  expect(parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{}' }, 'c')] }), FINISH('stop'))]).end.stopReason).toBe('tool_use')
  expect(parse([sse(delta({ content: 'x' }), FINISH('Content_Filter'))]).end.stopReason).toBe('refusal')
  const eos = parse([sse(delta({ content: 'x' }), FINISH('eos'))]).end
  expect(eos).toMatchObject({ stopReason: 'end_turn', note: 'finish_reason "eos" read as end_turn' })
  expect(parse([sse(delta({ content: 'x' }), '[DONE]')]).end.stopReason).toBe('end_turn')
})

test('[synthetic] whole calls one per chunk at position 0, no index, different ids, are separate calls', () => {
  const { end } = parse([sse({ choices: [{ delta: { tool_calls: [call(undefined, { name: 'A', arguments: '{"n":1}' }, 'x1')] } }] }, { choices: [{ delta: { tool_calls: [call(undefined, { name: 'B', arguments: '{"n":2}' }, 'x2')] } }] }, FINISH('tool_calls'))])
  expect(end.toolUses).toEqual([{ name: 'A', input: { n: 1 } }, { name: 'B', input: { n: 2 } }])
})

test('[synthetic] calls that all arrive as index 0 with their own ids are separate calls', () => {
  const { end } = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{"n":' }, 'x1')] }), delta({ tool_calls: [call(0, { arguments: '1}' })] }), delta({ tool_calls: [call(0, { name: 'B', arguments: '{"n":2}' }, 'x2')] }), FINISH('tool_calls'))])
  expect(end.toolUses).toEqual([{ name: 'A', input: { n: 1 } }, { name: 'B', input: { n: 2 } }])
})

test('[synthetic] two calls with neither id nor index in one array are told apart by position', () => {
  const { end } = parse([sse(delta({ tool_calls: [call(undefined, { name: 'A', arguments: '{"n":1}' }), call(undefined, { name: 'B', arguments: '{"n":2}' })] }), FINISH('tool_calls'))])
  expect(end).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'A', input: { n: 1 } }, { name: 'B', input: { n: 2 } }] })
})

test('live emission: a call is yielded when the next starts, the next when text arrives; a late fragment errors', () => {
  const { fed, end } = parse([
    sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{"a"' }, 'c0')] })),
    sse(delta({ tool_calls: [call(0, { arguments: ':1}' })] })),
    sse(delta({ tool_calls: [call(1, { name: 'B', arguments: '{}' }, 'c1')] })),
    sse(delta({ content: 'done' })),
    sse(FINISH('stop')),
  ])
  expect(fed.map(kinds)).toEqual([[], [], ['tool0', 'input0'], ['tool1', 'input1', 'text2'], []])
  expect(end.stopReason).toBe('tool_use')
  const late = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{}' }, 'c0')] }), delta({ tool_calls: [call(1, { name: 'B', arguments: '{}' }, 'c1')] }), delta({ tool_calls: [call(0, { arguments: 'x' })] }), FINISH('tool_calls'))])
  expect(late.end.answer).toContain('interleaved calls are not supported')
  expect(late.end.toolUses).toEqual([{ name: 'A', input: {} }])
  expect(late.end.stopReason).toBe('tool_use')
})

test('a transport failure after a complete call keeps it and stops tool_use; before any call it stops end_turn', () => {
  const cut = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{}' }, 'c0')] }), delta({ tool_calls: [call(1, { name: 'B', arguments: '{"par' }, 'c1')] }))], 'klyth: acme stalled (no data for 600 s)')
  expect(kinds(cut.chunks)).toEqual(['tool0', 'input0', 'text1', 'stop'])
  expect(cut.end).toMatchObject({ stopReason: 'tool_use', usage: null, toolUses: [{ name: 'A', input: {} }], answer: 'klyth: acme stalled (no data for 600 s)' })
  const early = parse([sse(delta({ content: 'par' }))], 'klyth: acme stalled (no data for 600 s)')
  expect(early.end).toMatchObject({ stopReason: 'end_turn', answer: 'parklyth: acme stalled (no data for 600 s)' })
})

test('a truncated held call is never yielded: empty or partial arguments with a failed transport', () => {
  for (const args of ['', '{"cit']) {
    const { chunks } = parse([sse(delta({ tool_calls: [call(0, { name: 'get_weather', arguments: args }, 'c0')] }))], 'klyth: acme stalled (no data for 600 s)')
    expect(kinds(chunks)).toEqual(['text0', 'stop'])
  }
})

test('malformed completed arguments fail before any chunk for that call', () => {
  const { chunks, end } = parse([sse(delta({ tool_calls: [call(0, { name: 'A', arguments: '{"a":' }, 'c0')] }), FINISH('tool_calls'))])
  expect(kinds(chunks)).toEqual(['text0', 'stop'])
  expect(end.answer).toBe(failed("the A call's arguments are not a JSON object"))
})

test('[DONE] then a failed exit gives the error text before exactly one stop; a clean fixture stops only at end', () => {
  const failed = parse([sse(delta({ content: 'ok' }), FINISH('stop'), '[DONE]')], 'klyth: acme curl exit 56: curl: (56) Recv failure')
  expect(kinds(failed.chunks)).toEqual(['text0', 'text1', 'stop'])
  expect(failed.chunks.filter(c => c.kind === 'stop')).toHaveLength(1)
  const clean = parse([SSE('model-b-step2.sse')])
  expect(clean.fed.flat().some(c => c.kind === 'stop')).toBe(false)
  expect(clean.end.chunks.at(-1)).toMatchObject({ kind: 'stop', stopReason: 'end_turn' })
})

test('minted ids are 36 characters of [A-Za-z0-9_-], unique across 10,000 mints', () => {
  const ids = new Set(Array.from({ length: 10_000 }, mintToolId))
  expect(ids.size).toBe(10_000)
  for (const id of [...ids].slice(0, 50)) expect(/^toolu_klyth_[0-9a-f]{24}$/.test(id) && id.length === 36).toBe(true)
})

test('deltas of one block in one stdout piece are yielded as one chunk; pieces, blocks and kinds stay apart', () => {
  const words = ['Klyth ', 'currently ', 'routes ', 'to ', 'acme/model-b', ' — ', 'naïve ✓ 日本', '.']
  const one = parse([sse(...words.map(w => delta({ content: w })), FINISH('stop'))])
  expect(one.fed[0]).toEqual([{ kind: 'text', index: 0, text: words.join('') }])
  const split = parse([sse(...words.slice(0, 3).map(w => delta({ content: w }))), sse(...words.slice(3).map(w => delta({ content: w })), FINISH('stop'))])
  expect(split.fed.map(f => f.map(c => (c as { text: string }).text))).toEqual([[words.slice(0, 3).join('')], [words.slice(3).join('')]])
  expect(split.end.answer).toBe(words.join(''))
  const mixed = parse([sse(delta({ reasoning_content: 'a' }), delta({ reasoning_content: 'b' }), delta({ content: 'c' }), delta({ content: 'd' }), FINISH('stop'))])
  expect(mixed.fed[0]).toEqual([
    { kind: 'thinking', index: 0, text: 'ab' },
    { kind: 'text', index: 1, text: 'cd' },
  ])
})

test('a message whose content is text, not blocks, is carried as its text', () => {
  const sent = body({ messages: [{ role: 'user', content: 'list the files' }, { role: 'assistant', content: 'done' }] })
  expect(sent['messages']).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'list the files' },
    { role: 'assistant', content: 'done' },
  ])
})

// The parser's own events: what the codec hands the backend, before any block index exists.
const types = (events: readonly StepEvent[]) => events.map(e => e.type)

test('the parser emits raw deltas as they come, and a tool call only whole, with its input parsed and an id minted', () => {
  const { events, closed } = parse([
    sse(delta({ reasoning_content: 'hm' }), delta({ reasoning_content: 'm' }), delta({ content: 'Rea' }), delta({ content: 'ding' })),
    sse(delta({ tool_calls: [call(0, { name: 'Read', arguments: '{"file_' }, 'call_r')] })),
    sse(delta({ tool_calls: [call(0, { arguments: 'path":"/a"}' })] })),
    sse(FINISH('tool_calls'), USAGE),
  ])
  expect(events.map(types)).toEqual([['thinking', 'thinking', 'text', 'text'], [], [], ['tool_use']])
  expect(events[3]?.[0]).toEqual({ type: 'tool_use', id: 'toolu_klyth_000000000000000000000001', name: 'Read', input: { file_path: '/a' } })
  expect(closed.events).toEqual([
    { type: 'usage', in: 100, out: 30, cacheRead: 20, cacheWrite: 0 },
    { type: 'stop', reason: 'tool_use' },
  ])
  expect(closed.finish).toBe('tool_calls')
})

test('a stream cut mid tool call emits no tool_use: one request error, and no usage or stop', () => {
  const cut = parse([sse(delta({ content: 'x' }), delta({ tool_calls: [call(0, { name: 'Write', arguments: '{"content":"par' }, 'c0')] }))], 'klyth: acme stalled (no data for 600 s); retry')
  expect([...cut.events.flat(), ...cut.closed.events]).toEqual([
    { type: 'text', text: 'x' },
    { type: 'error', kind: 'request', text: 'klyth: acme stalled (no data for 600 s); retry' },
  ])
  const whole = parse([sse(delta({ tool_calls: [call(0, { name: 'Read', arguments: '{"file_path":"/a"}' }, 'c0')] }))], 'klyth: acme stalled (no data for 600 s); retry')
  expect(whole.closed.events).toEqual([{ type: 'error', kind: 'request', text: 'klyth: acme stalled (no data for 600 s); retry' }])
  const truncated = parse([sse(delta({ tool_calls: [call(0, { name: 'Write', arguments: '{"content":"par' }, 'c0')] }))])
  expect(truncated.closed.events).toEqual([{ type: 'error', kind: 'response', text: failed('the stream ended with no finish reason') }])
})

test('the end maps finish reasons to stops, reads reasoning tokens when reported, and notes an unknown reason', () => {
  const stopOf = (reason: string) => parse([sse(delta({ content: 'x' }), FINISH(reason))]).closed.events.at(-1)
  expect<unknown>(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'constructor'].map(r => stopOf(r))).toEqual(
    ['end_turn', 'max_tokens', 'refusal', 'tool_use', 'tool_use', 'end_turn'].map(reason => ({ type: 'stop', reason })),
  )
  expect(parse([sse(delta({ content: 'x' }), FINISH('constructor'))]).closed.note).toBe('finish_reason "constructor" read as end_turn')
  const reasoned = { choices: [], usage: { prompt_tokens: 50, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 32 } } }
  expect(parse([sse(delta({ content: 'x' }), FINISH('stop'), reasoned)]).closed.events[0]).toEqual({ type: 'usage', in: 50, out: 40, cacheRead: 0, cacheWrite: 0, reasoning: 32 })
  expect(parse([sse(delta({ content: 'x' }), '[DONE]')]).closed).toEqual({ events: [{ type: 'stop', reason: 'end_turn' }], finish: 'none' })
})

test('an in-stream error is recorded at most 4 KiB long, and a line past 16 MiB is one error', () => {
  const big = openai.decoder().feed(new TextEncoder().encode(sse({ error: { message: ' '.repeat(1 << 20) } })))
  expect(big).toEqual([{ t: 'error', message: expect.any(String) }])
  expect((big[0] as { message: string }).message).toHaveLength(4096)
  const d = openai.decoder()
  const fed = ['data: ', ...Array.from({ length: 17 }, () => 'a'.repeat(1 << 20))].flatMap(piece => d.feed(new TextEncoder().encode(piece)))
  expect(fed).toEqual([{ t: 'error', message: 'the stream sent a line over 16 MiB' }])
})
