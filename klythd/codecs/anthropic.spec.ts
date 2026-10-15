// The `anthropic` codec: request bodies from the normalized transcript, and its decoder read event by event
// and through the step assembler, beside the conformance suite's recorded and synthetic streams.
import { expect, test } from 'bun:test'

import { parseConfig } from '../../hooks/config'
import type { Config } from '../../hooks/config'
import { resolve } from '../../hooks/names'
import type { ApiMessage } from '../../hooks/protocol'
import { normalize, remoteIds } from '../history'
import type { Placed } from '../history'
import { assembler } from '../step'
import { anthropic } from './anthropic'

// The provider and model `m`, or the model as the alias `a` (given as `alias`) requests it.
const cfg = (model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}, alias?: Record<string, unknown>) => {
  const c = parseConfig(
    JSON.stringify({
      providers: {
        acme: {
          kind: 'anthropic',
          baseUrl: 'https://klyth.invalid',
          auth: { command: ['/usr/bin/security'] },
          ...provider,
          models: { m: { contextWindow: 100_000, maxOutputTokens: 8000, ...model } },
        },
      },
      ...(alias === undefined ? {} : { aliases: { a: { target: 'acme/m', ...alias } } }),
    }),
  )
  expect(c.errors).toEqual([])
  const t = resolve(c.config as Config, alias === undefined ? 'acme/m' : 'a')
  if (t?.kind !== 'remote') throw new Error('not remote')
  return { p: t.provider, m: t.model }
}

const USER: ApiMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
const encode = (o: { model?: Record<string, unknown>; provider?: Record<string, unknown>; alias?: Record<string, unknown>; messages?: ApiMessage[]; effort?: unknown; tools?: { name: string }[]; system?: string; ids?: Record<string, string>; sealed?: Record<string, Placed[]> } = {}) => {
  const { p, m } = cfg(o.model, o.provider, o.alias)
  const built = anthropic.encode(
    {
      system: o.system ?? 'SYS',
      messages: normalize(o.messages ?? [USER], m.vision, id => o.ids?.[id], o.sealed === undefined ? undefined : id => o.sealed?.[id]),
      tools: (o.tools ?? []).map(t => ({ name: t.name, description: `${t.name} tool`, schema: { type: 'object' } })),
      ...(o.effort === undefined ? {} : { effort: o.effort as never }),
    },
    p,
    m,
  )
  return { ...built, sent: JSON.parse(built.body) as Record<string, unknown> }
}

const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const START = { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }
const block = (index: number, content_block: unknown) => ({ type: 'content_block_start', index, content_block })
const delta = (index: number, d: unknown) => ({ type: 'content_block_delta', index, delta: d })
const stop = (index: number) => ({ type: 'content_block_stop', index })
const tool = (index: number, name = 'Read', id = `t${index}`) => block(index, { type: 'tool_use', id, name, input: {} })
const json = (index: number, partial_json: string) => delta(index, { type: 'input_json_delta', partial_json })
const END = (stop_reason: string, usage: unknown = { output_tokens: 5 }) => [{ type: 'message_delta', delta: { stop_reason }, usage }, { type: 'message_stop' }]

// The decoder's events for each piece fed, then at the end.
function read(...pieces: string[]) {
  const d = anthropic.decoder()
  const fed = pieces.map(p => d.feed(new TextEncoder().encode(p)))
  return { fed, end: d.end() }
}
// The step events a whole response gives through the assembler.
function run(stream: string) {
  const asm = assembler(anthropic, 'acme', remoteIds(), () => 'toolu_klyth_x')
  const { fed, end } = read(stream)
  const events = [...asm.feed(fed.flat()), ...asm.feed(end)]
  const closed = asm.end(cfg().p)
  return { events: [...events, ...closed.events], note: closed.note }
}
const failed = (detail: string) => ({ type: 'error', kind: 'response', text: `klyth: acme response failed: ${detail}; retry, or see the debug log` })

test('the request goes to /v1/messages with the version header, the model, max_tokens, the system text and tools as input_schema', () => {
  const b = encode({ tools: [{ name: 'Read' }] })
  expect(b.path).toBe('/v1/messages')
  expect(b.headers).toEqual({ 'anthropic-version': '2023-06-01' })
  expect(b.sent).toEqual({
    model: 'm',
    max_tokens: 8000,
    stream: true,
    system: 'SYS',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'Read', description: 'Read tool', input_schema: { type: 'object' } }],
  })
  expect('system' in encode({ system: '' }).sent).toBe(false)
  expect('tools' in encode({ model: { tools: false }, tools: [{ name: 'Read' }] }).sent).toBe(false)
  expect('tools' in encode().sent).toBe(false)
})

test('effort comes from config alone: the declared level, else the nearest below, else above; none when undeclared', () => {
  const topK = (n: number) => ({ top_k: n })
  const model = { effort: { low: topK(10), high: topK(60) } }
  expect(encode({ model, effort: 'high' })).toMatchObject({ effort: 'high', sent: { top_k: 60, max_tokens: 8000 } })
  expect(encode({ model, effort: 'medium' })).toMatchObject({ effort: 'low', sent: { top_k: 10 } })
  expect(encode({ model: { effort: { high: topK(60) } }, effort: 'low' })).toMatchObject({ effort: 'high', sent: { top_k: 60 } })
  const plain = encode({ effort: 'high' })
  expect(plain.effort).toBe('none')
  expect('top_k' in plain.sent).toBe(false)
})

test('body precedence: max_tokens, provider params, model params, then the effort level; objects merge and null deletes', () => {
  const b = encode({
    model: { params: { temperature: null, metadata: { user_id: 'u', tag: 'a' }, top_k: 5 }, effort: { high: { metadata: { tag: 'b' } } } },
    provider: { params: { temperature: 0.2, top_p: 0.9 } },
    effort: 'high',
  })
  expect(b.sent).toMatchObject({ top_p: 0.9, top_k: 5, metadata: { user_id: 'u', tag: 'b' }, max_tokens: 8000, model: 'm', stream: true })
  expect('temperature' in b.sent).toBe(false)
})

test('parallelToolCalls: false sends tool_choice with disable_parallel_tool_use, and only when tools are sent', () => {
  expect(encode({ model: { parallelToolCalls: false }, tools: [{ name: 'Read' }] }).sent['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  expect('tool_choice' in encode({ model: { parallelToolCalls: false } }).sent).toBe(false)
  expect('tool_choice' in encode({ tools: [{ name: 'Read' }] }).sent).toBe(false)
})

test('history: tool_use and tool_result blocks keep their shapes, results lead their turn, and is_error is sent only when true', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  const messages: ApiMessage[] = [
    USER,
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: '' }, { type: 'tool_use', id: 'minted1', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 'minted2', name: 'Bash', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'after' },
        { type: 'tool_result', tool_use_id: 'minted1', content: [{ type: 'text', text: 'a' }, img] },
        { type: 'tool_result', tool_use_id: 'minted2', content: 'boom', is_error: true },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: '' }] },
  ]
  const sent = encode({ messages, ids: { minted1: 'toolu_remote' } }).sent['messages']
  expect(sent).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_remote', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 'minted2', name: 'Bash', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_remote', content: [{ type: 'text', text: 'a' }, img] },
        { type: 'tool_result', tool_use_id: 'minted2', content: [{ type: 'text', text: 'boom' }], is_error: true },
        { type: 'text', text: 'after' },
      ],
    },
  ])
  expect(JSON.stringify(sent)).not.toContain('secret')
})

test('a tool call is emitted when its block stops, never before, with its fragments joined', () => {
  const { fed } = read(
    sse(START, { type: 'ping' }, tool(1, 'Write', 'toolu_a'), json(1, '{"file_path":')),
    sse(json(1, '"/a"}')),
    sse(stop(1)),
    sse(...END('tool_use')),
  )
  expect(fed.map(f => f.map(d => d.t))).toEqual([[], [], ['tool'], ['usage', 'finish']])
  expect(fed[2]).toEqual([{ t: 'tool', id: 'toolu_a', name: 'Write', args: '{"file_path":"/a"}' }])
})

test('text and thinking deltas pass as they arrive; empty deltas, pings and unknown events are ignored, and a signed thinking block passes whole', () => {
  const { fed } = read(
    sse(
      START,
      { type: 'ping' },
      block(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'hm' }),
      delta(0, { type: 'signature_delta', signature: 'sig' }),
      stop(0),
      block(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: '' }),
      delta(1, { type: 'text_delta', text: 'Hi' }),
      { type: 'something_new', index: 7 },
      stop(1),
    ),
  )
  expect(fed[0]).toEqual([{ t: 'thinking', text: 'hm' }, { t: 'sealed', block: { type: 'thinking', thinking: 'hm', signature: 'sig' } }, { t: 'text', text: 'Hi' }])
})

test('usage is the largest count seen across message_start and message_delta, zeros from message_start included', () => {
  const usage = (start: unknown, end: unknown) => read(sse({ type: 'message_start', message: { usage: start } }, ...END('end_turn', end))).fed[0]?.find(d => d.t === 'usage')
  expect(usage({ input_tokens: 0, output_tokens: 0 }, { input_tokens: 495, output_tokens: 54 })).toEqual({ t: 'usage', in: 495, out: 54, cacheRead: 0, cacheWrite: 0 })
  expect(usage({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, { output_tokens: 20 })).toEqual({ t: 'usage', in: 10, out: 20, cacheRead: 7, cacheWrite: 3 })
  expect(usage({}, {})).toEqual({ t: 'usage', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
})

test('empty or absent fragments give {}; a whole input on the block start is used when no fragments follow; interleaved blocks stop in order', () => {
  const { events } = run(sse(START, tool(0, 'A'), stop(0), block(1, { type: 'tool_use', id: 'w', name: 'B', input: { q: 1 } }), stop(1), tool(2, 'C'), tool(3, 'D'), json(3, '{"d":'), json(2, '{"c":1}'), json(3, '1}'), stop(3), stop(2), ...END('tool_use')))
  expect(events.filter(e => e.type === 'tool_use').map(e => [(e as { name: string }).name, (e as { input: unknown }).input])).toEqual([['A', {}], ['B', { q: 1 }], ['D', { d: 1 }], ['C', { c: 1 }]])
})

test('stop reasons map to stops, a tool call or not; an unknown reason reads as end_turn with a note', () => {
  const stopOf = (reason: string) => run(sse(START, ...END(reason))).events.at(-1)
  expect<unknown>(['end_turn', 'max_tokens', 'tool_use', 'stop_sequence', 'refusal'].map(stopOf)).toEqual(['end_turn', 'max_tokens', 'tool_use', 'end_turn', 'refusal'].map(reason => ({ type: 'stop', reason })))
  expect(run(sse(START, ...END('constructor')))).toMatchObject({ events: [{ type: 'usage' }, { type: 'stop', reason: 'end_turn' }], note: 'finish_reason "constructor" read as end_turn' })
})

test('an error event ends the reading with one line; nothing after it is read, and a held call is never emitted', () => {
  const { events } = run(sse(START, tool(0), json(0, '{}'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, stop(0), ...END('tool_use')))
  expect<unknown>(events).toEqual([failed('Overloaded')])
  expect<unknown>(run(sse({ type: 'error', error: { message: 'line one\nline two' } })).events).toEqual([failed('line one line two')])
})

test('a stream that ends inside a tool call, before a stop reason, or on broken data is an error and holds no tool_use', () => {
  expect<unknown>(run(sse(START, tool(0), json(0, '{"a":'))).events).toEqual([failed('the stream ended inside a tool call')])
  expect<unknown>(run(sse(START, tool(0), json(0, '{"a":'), ...END('tool_use'))).events).toEqual([failed('the stream ended inside a tool call')])
  expect<unknown>(run(sse(START, tool(0, 'Read'), json(0, '{}'), stop(0))).events).toEqual([{ type: 'tool_use', id: 'toolu_klyth_x', name: 'Read', input: {} }, failed('the stream ended with no stop reason')])
  expect(run(`${sse(START, tool(0))}data: {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_del`).events.map(e => e.type)).toEqual(['error'])
  expect<unknown>(run('data: [1]\n\n').events).toEqual([failed('unparseable stream data: [1]')])
  expect(run(sse(START, block(0, 'x'), delta(0, 5), ...END('end_turn'))).events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' })
})

test('a malformed call is an error, not a tool_use: an unnamed block, or fragments that are not an object', () => {
  expect<unknown>(run(sse(START, block(0, { type: 'tool_use', id: 'a' }), stop(0), ...END('tool_use'))).events).toEqual([failed('a tool call arrived with no name')])
  expect<unknown>(run(sse(START, tool(0, 'Read'), json(0, '[1]'), stop(0), ...END('tool_use'))).events).toEqual([failed("the Read call's arguments are not a JSON object")])
})

// The cache marks in a body: where they are, in the order the body lists them (system, messages, tools).
const marks = (sent: Record<string, unknown>) => {
  const found: string[] = []
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) k === 'cache_control' ? found.push(`${path}=${JSON.stringify(x)}`) : walk(x, `${path}.${k}`)
  }
  walk(sent, '')
  return found
}
const TOOL_TURN: ApiMessage[] = [
  USER,
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
]

test('cache: "5m" or "1h" marks the last system block, the last tool and the last block of the last two user turns: the four allowed', () => {
  const tools = [{ name: 'Read' }, { name: 'Bash' }]
  for (const ttl of ['5m', '1h']) {
    const mark = { type: 'ephemeral', ttl }
    const sent = encode({ model: { cache: ttl }, tools, messages: TOOL_TURN }).sent
    expect(sent['system']).toEqual([{ type: 'text', text: 'SYS', cache_control: mark }])
    expect(marks(sent)).toEqual([`.system[0]=${JSON.stringify(mark)}`, `.messages[0].content[0]=${JSON.stringify(mark)}`, `.messages[2].content[0]=${JSON.stringify(mark)}`, `.tools[1]=${JSON.stringify(mark)}`])
    expect((sent['tools'] as { cache_control?: unknown }[])[0]?.cache_control).toBeUndefined()
  }
  // The mark sits on the last block even when text follows the tool results.
  const last = encode({ model: { cache: '5m' }, messages: [...TOOL_TURN.slice(0, 2), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }, { type: 'text', text: 'and then' }] }] }).sent['messages'] as { content: { type: string; cache_control?: unknown }[] }[]
  expect(last[2]?.content.map(b => [b.type, b.cache_control !== undefined])).toEqual([['tool_result', false], ['text', true]])
})

test("a step after many parallel calls still reads the previous step's cache: that step's mark was on the user turn before the last, and this one marks it again", () => {
  const calls = Array.from({ length: 30 }, (_, i) => `t${i}`)
  const messages: ApiMessage[] = [
    USER,
    { role: 'assistant', content: calls.slice(0, 1).map(id => ({ type: 'tool_use', id, name: 'Read', input: {} })) },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'x' }] },
    { role: 'assistant', content: calls.slice(1).map(id => ({ type: 'tool_use', id, name: 'Read', input: {} })) },
    { role: 'user', content: calls.slice(1).map(id => ({ type: 'tool_result', tool_use_id: id, content: 'x' })) },
  ]
  const sent = encode({ model: { cache: '5m' }, messages }).sent
  // The last block of the user turn that closed the previous step (messages[2]) and of the newest one (messages[4]).
  expect(marks(sent)).toEqual(['.system[0]={"type":"ephemeral","ttl":"5m"}', '.messages[2].content[0]={"type":"ephemeral","ttl":"5m"}', '.messages[4].content[28]={"type":"ephemeral","ttl":"5m"}'])
})

test('without cache nothing is marked and the system prompt stays a string; with no system prompt or tools only the rest is marked', () => {
  const plain = encode({ tools: [{ name: 'Read' }], messages: TOOL_TURN }).sent
  expect(marks(plain)).toEqual([])
  expect(plain['system']).toBe('SYS')
  expect(marks(encode({ model: { cache: '1h' }, system: '' }).sent)).toEqual(['.messages[0].content[0]={"type":"ephemeral","ttl":"1h"}'])
})

test('thinking and effort params for Claude reach the body whole: thinking, output_config.effort, merged with the model and provider params', () => {
  const model = { effort: { low: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }, max: { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } } } }
  expect(encode({ model, effort: 'low' }).sent).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, max_tokens: 8000 })
  expect(encode({ model, effort: 'max' })).toMatchObject({ effort: 'max', sent: { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } } })
  expect(encode({ model: { params: { thinking: { type: 'enabled', budget_tokens: 2048 } } } }).sent['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 })
})

test("the signed thinking of a tool turn goes first in that turn; a turn whose thinking is lost sends no thinking param and says so", () => {
  const blocks: Placed[] = [{ at: 0, block: { type: 'thinking', thinking: 'hm', signature: 'sig' } }, { at: 0, block: { type: 'redacted_thinking', data: 'red' } }]
  const model = { params: { thinking: { type: 'enabled', budget_tokens: 2048 } } }
  const kept = encode({ model, messages: TOOL_TURN, sealed: { t1: blocks } })
  expect((kept.sent['messages'] as { content: unknown[] }[])[1]?.content).toEqual([...blocks.map(p => p.block), { type: 'tool_use', id: 't1', name: 'Read', input: {} }])
  expect(kept.sent['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(kept.lost).toBeUndefined()
  const lost = encode({ model, messages: TOOL_TURN, sealed: {} })
  expect('thinking' in lost.sent).toBe(false)
  expect(lost.lost).toBe(true)
  expect(JSON.stringify(lost.sent['messages'])).not.toContain('"thinking"')
  // No thinking param asked for, so nothing to leave out; a model that thinks by default is sent as it is.
  expect(encode({ messages: TOOL_TURN, sealed: {} }).lost).toBeUndefined()
  // The turn in progress alone counts: a lost turn behind a newer user message does not.
  const behind: ApiMessage[] = [...TOOL_TURN, { role: 'assistant', content: 'done' }, { role: 'user', content: 'again' }]
  expect(encode({ model, messages: behind, sealed: {} }).sent['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 })
})

test('only a thinking param that asks for thinking is left out when the signed blocks are lost: enabled and adaptive go, disabled stays as sent, in params and in an effort level alike', () => {
  const gone = (model: Record<string, unknown>, effort?: string) => {
    const r = encode({ model, messages: TOOL_TURN, sealed: {}, ...(effort === undefined ? {} : { effort }) })
    return [r.sent['thinking'], r.lost]
  }
  expect(gone({ params: { thinking: { type: 'adaptive' } } })).toEqual([undefined, true])
  expect(gone({ params: { thinking: { type: 'enabled', budget_tokens: 2048 } } })).toEqual([undefined, true])
  expect(gone({ params: { thinking: { type: 'disabled' } } })).toEqual([{ type: 'disabled' }, undefined])
  expect(gone({ effort: { low: { thinking: { type: 'disabled' } }, high: { thinking: { type: 'adaptive' } } } }, 'low')).toEqual([{ type: 'disabled' }, undefined])
  expect(gone({ effort: { low: { thinking: { type: 'disabled' } }, high: { thinking: { type: 'adaptive' } } } }, 'high')).toEqual([undefined, true])
})

test('thinking blocks interleaved with text and a call, [T1, A, T2, B], come back in that order, whatever their kind', () => {
  const stream = sse(
    START,
    block(0, { type: 'thinking', thinking: '', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'one' }),
    delta(0, { type: 'signature_delta', signature: 'S1' }),
    stop(0),
    block(1, { type: 'text', text: '' }),
    delta(1, { type: 'text_delta', text: 'A' }),
    stop(1),
    block(2, { type: 'redacted_thinking', data: 'R2' }),
    stop(2),
    tool(3, 'Read', 'r1'),
    json(3, '{}'),
    stop(3),
    ...END('tool_use'),
  )
  const asm = assembler(anthropic, 'acme', remoteIds(), () => 'toolu_klyth_x')
  const { fed, end } = read(stream)
  asm.feed([...fed.flat(), ...end])
  const messages: ApiMessage[] = [
    USER,
    { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'tool_use', id: 'toolu_klyth_x', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_x', content: 'x' }] },
  ]
  const sent = encode({ model: { params: { thinking: { type: 'enabled', budget_tokens: 2048 } } }, messages, sealed: { toolu_klyth_x: asm.turn().blocks } }).sent
  expect((sent['messages'] as { content: unknown[] }[])[1]?.content).toEqual([
    { type: 'thinking', thinking: 'one', signature: 'S1' },
    { type: 'text', text: 'A' },
    { type: 'redacted_thinking', data: 'R2' },
    { type: 'tool_use', id: 'toolu_klyth_x', name: 'Read', input: {} },
  ])
})

test('a signed thinking block, a redacted one and a tool call decode in order; an unsigned block is not kept', () => {
  const signed = read(sse(START, block(0, { type: 'thinking', thinking: '', signature: '' }), delta(0, { type: 'thinking_delta', thinking: 'a' }), delta(0, { type: 'thinking_delta', thinking: 'b' }), delta(0, { type: 'signature_delta', signature: 'S1' }), delta(0, { type: 'signature_delta', signature: 'S2' }), stop(0), block(1, { type: 'redacted_thinking', data: 'RED' }), stop(1), tool(2), json(2, '{}'), stop(2), ...END('tool_use')))
  expect(signed.fed[0]?.filter(d => d.t !== 'usage' && d.t !== 'finish')).toEqual([
    { t: 'thinking', text: 'a' },
    { t: 'thinking', text: 'b' },
    { t: 'sealed', block: { type: 'thinking', thinking: 'ab', signature: 'S1S2' } },
    { t: 'sealed', block: { type: 'redacted_thinking', data: 'RED' } },
    { t: 'tool', id: 't2', name: 'Read', args: '{}' },
  ])
  const unsigned = read(sse(START, block(0, { type: 'thinking', thinking: '', signature: '' }), delta(0, { type: 'thinking_delta', thinking: 'a' }), stop(0), ...END('end_turn')))
  expect(unsigned.fed[0]?.map(d => d.t)).toEqual(['thinking', 'usage', 'finish'])
  // A signed block shown with its text omitted (display: omitted) still passes whole.
  const omitted = read(sse(START, block(0, { type: 'thinking', thinking: '', signature: '' }), delta(0, { type: 'thinking_delta', thinking: '' }), delta(0, { type: 'signature_delta', signature: 'S' }), stop(0), ...END('end_turn')))
  expect(omitted.fed[0]?.filter(d => d.t === 'sealed')).toEqual([{ t: 'sealed', block: { type: 'thinking', thinking: '', signature: 'S' } }])
})

test('usage reads the cache counts the response reports: reads, writes and the input left over', () => {
  const evs = run(sse({ type: 'message_start', message: { usage: { input_tokens: 4, cache_read_input_tokens: 2378, cache_creation_input_tokens: 146, output_tokens: 1 } } }, ...END('end_turn', { output_tokens: 26 }))).events
  expect(evs[0]).toEqual({ type: 'usage', in: 4, out: 26, cacheRead: 2378, cacheWrite: 146 })
})

test('an alias lays its params after the model\'s and before the effort level\'s, null deletes at any layer, its effort map replaces the model\'s, and its cache replaces the model\'s', () => {
  const model = { params: { top_k: 5, metadata: { a: 1, b: 2 }, temperature: 0.5 }, effort: { high: { top_p: 0.1 } }, cache: '5m' }
  const provider = { params: { stop_sequences: ['x'], top_p: 0.9 } }
  const alias = { params: { top_k: 9, metadata: { b: null, c: 3 }, stop_sequences: null }, effort: { low: { top_p: 0.2 }, high: { metadata: { c: 4 } } }, cache: '1h' }
  const direct = encode({ model, provider, effort: 'high' })
  expect(direct.sent).toMatchObject({ top_k: 5, top_p: 0.1, stop_sequences: ['x'], metadata: { a: 1, b: 2 } })
  const via = encode({ model, provider, alias, effort: 'high' })
  // Alias params over the model's (top_k 9, b deleted, c added, stop_sequences deleted from the provider's); its effort map instead of the model's (top_p stays the provider's 0.9).
  expect(via.sent).toMatchObject({ top_k: 9, top_p: 0.9, temperature: 0.5, metadata: { a: 1, c: 4 } })
  expect('stop_sequences' in via.sent).toBe(false)
  expect((via.sent['metadata'] as Record<string, unknown>)['b']).toBeUndefined()
  expect(encode({ model, provider, alias, effort: 'low' }).sent).toMatchObject({ top_p: 0.2 })
  expect(marks(via.sent)[0]).toContain('"ttl":"1h"')
  // An effort level the alias's map does not declare resolves inside the alias's map alone.
  expect(encode({ model, alias, effort: 'max' })).toMatchObject({ effort: 'high' })
  // A null set by the alias deletes what the provider and model set; a plain alias changes nothing.
  expect(encode({ model, provider, alias: { params: { temperature: null } } }).sent['temperature']).toBeUndefined()
  expect(encode({ model, provider, alias: {} }).sent).toEqual(encode({ model, provider }).sent)
})

test('an in-stream error is recorded at most 4 KiB long, and a line past 16 MiB is one error', () => {
  const big = read(sse({ type: 'error', error: { type: 'overloaded_error', message: ' '.repeat(1 << 20) } }))
  expect(big.fed[0]).toEqual([{ t: 'error', message: expect.any(String) }])
  expect(((big.fed[0] ?? [])[0] as { message: string }).message).toHaveLength(4096)
  const long = read('data: ', ...Array.from({ length: 17 }, () => 'a'.repeat(1 << 20)))
  expect(long.fed.flat()).toEqual([{ t: 'error', message: 'the stream sent a line over 16 MiB' }])
})
