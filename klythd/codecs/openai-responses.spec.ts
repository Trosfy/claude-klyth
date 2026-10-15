// The `openai-responses` codec: request bodies from the normalized transcript, and its decoder read the way
// klythd reads it (whole tool calls, ids minted, one stop or error) through the step assembler, against the
// hand-built responses under fixtures/openai-responses (which the conformance suite also splits anywhere).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseConfig } from '../../hooks/config'
import type { Config, ModelConfig, ProviderConfig } from '../../hooks/config'
import type { ApiMessage } from '../../hooks/protocol'
import { normalize, remoteIds } from '../history'
import { memoryStore } from '../responses'
import type { Placed } from '../history'
import { assembler } from '../step'
import { openaiResponses, toInput } from './openai-responses'

const SSE = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'openai-responses', `${name}.sse`), 'utf8')

const cfg = (model: Record<string, unknown> = {}) => {
  const c = parseConfig(
    JSON.stringify({
      providers: {
        acme: {
          kind: 'openai-responses',
          baseUrl: 'https://klyth.invalid/v1',
          auth: { command: ['/usr/bin/security'] },
          models: { m: { contextWindow: 100_000, maxOutputTokens: 8000, params: { reasoning: { summary: 'auto' } }, ...model } },
        },
      },
    }),
  )
  expect(c.errors).toEqual([])
  const p = (c.config as Config).providers['acme'] as ProviderConfig
  return { p, m: p.models['m'] as ModelConfig }
}

const USER: ApiMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
type Options = { affinity?: string; model?: Record<string, unknown>; messages?: ApiMessage[]; effort?: unknown; tools?: { name: string }[]; ids?: Record<string, string>; sealed?: (id: string) => readonly Placed[] | undefined }
const encode = (o: Options) => {
  const { p, m } = cfg(o.model)
  const built = openaiResponses.encode(
    {
      system: 'SYS',
      messages: normalize(o.messages ?? [USER], m.vision, id => o.ids?.[id], o.sealed),
      tools: (o.tools ?? []).map(t => ({ name: t.name, description: `${t.name} tool`, schema: { type: 'object' } })),
      ...(o.effort === undefined ? {} : { effort: o.effort as never }),
      ...(o.affinity === undefined ? {} : { affinity: o.affinity }),
    },
    p,
    m,
  )
  expect(built.path).toBe('/responses')
  const sent: Record<string, unknown> = { ...(JSON.parse(built.body) as Record<string, unknown>), applied: built.effort }
  return sent
}
const input = (o: Options) => encode(o)['input'] as Record<string, unknown>[]

// Feeds `pieces` to a decoder and klythd's assembler, then ends them (`failure` is a transport cut); returns
// the events read, the step's end, the remote id behind each minted id, and the turn's calls and held blocks.
function parse(pieces: readonly string[], failure?: string) {
  let n = 0
  const remote: Record<string, string> = {}
  const ids = remoteIds()
  const asm = assembler(openaiResponses, 'acme', { ...ids, remember: (prov, minted, id) => ((remote[minted] = id), ids.remember(prov, minted, id)) }, () => `toolu_klyth_${String(++n).padStart(24, '0')}`)
  const decoder = openaiResponses.decoder()
  const fed = pieces.map(piece => asm.feed(decoder.feed(new TextEncoder().encode(piece))))
  const tail = failure === undefined ? asm.feed(decoder.end()) : []
  const closed = asm.end(cfg().p, failure)
  return { fed, events: [...fed.flat(), ...tail, ...closed.events], closed, remote, turn: asm.turn() }
}
const sse = (...events: (Record<string, unknown> | string)[]) => events.map(e => (typeof e === 'string' ? `data: ${e}\n\n` : `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)).join('')
const failed = (detail: string) => `klyth: acme response failed: ${detail}; retry, or see the debug log`
const types = (events: readonly { type: string }[]) => events.map(e => e.type)
const done = { type: 'response.completed', response: { status: 'completed' } }

test('the request sets exactly model, instructions, input, stream and store; the system prompt is instructions, never a message', () => {
  const b = encode({})
  expect(b).toEqual({ model: 'm', instructions: 'SYS', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], reasoning: { summary: 'auto' }, stream: true, store: false, applied: 'none' })
  expect(JSON.stringify(b['input'])).not.toMatch(/"role":"(system|developer)"/)
  // A loop's cache id goes in the body as prompt_cache_key, beside the session header; none when the step has no id.
  expect(encode({ affinity: 'loop-1' })['prompt_cache_key']).toBe('loop-1')
})

test('max_output_tokens is sent only with maxTokensParam; parallel_tool_calls false only when off and tools exist', () => {
  expect(encode({ model: { maxTokensParam: 'max_output_tokens' } })).toMatchObject({ max_output_tokens: 8000 })
  expect('max_output_tokens' in encode({})).toBe(false)
  const tools = [{ name: 'Read' }]
  expect(encode({ model: { parallelToolCalls: false }, tools })).toMatchObject({ parallel_tool_calls: false })
  expect('parallel_tool_calls' in encode({ model: { parallelToolCalls: false } })).toBe(false)
  expect('parallel_tool_calls' in encode({ tools })).toBe(false)
})

test('the applied effort level merges into the model params, deep: reasoning.effort beside reasoning.summary', () => {
  const effort = { low: { reasoning: { effort: 'low' } }, high: { reasoning: { effort: 'high' } } }
  expect(encode({ model: { effort }, effort: 'high' })).toMatchObject({ reasoning: { summary: 'auto', effort: 'high' }, applied: 'high' })
  expect(encode({ model: { effort }, effort: 'medium' })).toMatchObject({ reasoning: { summary: 'auto', effort: 'low' }, applied: 'low' })
  expect(encode({ effort: 'high' })).toMatchObject({ reasoning: { summary: 'auto' }, applied: 'none' })
})

test('tools are function tools with strict false; tools: false sends none', () => {
  expect(encode({ tools: [{ name: 'Read' }] })['tools']).toEqual([{ type: 'function', name: 'Read', description: 'Read tool', parameters: { type: 'object' }, strict: false }])
  expect('tools' in encode({ model: { tools: false }, tools: [{ name: 'Read' }] })).toBe(false)
})

test('user text and images are input parts; a URL image passes, a base64 one is a data URL, and no vision names the image', () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'url', url: 'https://img.invalid/a.png' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  ]
  expect(input({ messages })).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'https://img.invalid/a.png' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
  ])
  expect(input({ messages, model: { vision: false } })).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_text', text: '[image omitted: model has no vision]' }, { type: 'input_text', text: '[image omitted: model has no vision]' }] },
  ])
})

test('an assistant turn is its text and calls in order, with the remote call_id; tool results are outputs ahead of one user message holding their images first', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  const messages: ApiMessage[] = [
    USER,
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }, { type: 'text', text: '' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'after' },
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, img, { type: 'text', text: 'b' }] },
        { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
        { type: 'tool_result', tool_use_id: 'gone', content: 'orphan' },
      ],
    },
  ]
  const items = input({ messages, ids: { t1: 'call-1' } })
  expect(items.slice(1)).toEqual([
    { role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 'call-1', name: 'Read', arguments: '{"file_path":"/a"}' },
    { type: 'function_call', call_id: 't2', name: 'Bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'a\nb' },
    { type: 'function_call_output', call_id: 't2', output: 'Error: boom' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: 'after' }] },
  ])
  expect(JSON.stringify(items)).not.toContain('secret')
})

test('a held reasoning block goes back in its place, ahead of the text and calls it came before; one for another call is not sent', () => {
  const block = { type: 'reasoning' as const, id: 'reasoning-1', encrypted_content: 'opaque-reasoning-1' }
  const messages: ApiMessage[] = [USER, { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] }]
  const sealed = (held: readonly Placed[]) => (id: string) => (id === 't1' ? held : undefined)
  expect(input({ messages, sealed: sealed([{ at: 0, block }]) }).slice(1, 3)).toEqual([{ type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-reasoning-1', summary: [] }, { role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] }])
  expect(input({ messages, sealed: sealed([{ at: 1, block }]) }).map(i => i['type'] ?? i['role'])).toEqual(['user', 'assistant', 'reasoning', 'function_call'])
  expect(input({ messages, sealed: () => undefined }).map(i => i['type'] ?? i['role'])).toEqual(['user', 'assistant', 'function_call'])
  expect(toInput({ system: '', messages: [], tools: [] })).toEqual([])
})

test('a reasoning item read with a tool call comes back before that call in the next request, with the call_id the provider gave', () => {
  const { remote, turn } = parse([SSE('reasoning-carry')])
  const [minted] = turn.calls as [string]
  const store = memoryStore()
  store.record([...turn.calls.map(local => ({ kind: 'call' as const, handle: 'h', loop: 't', owner: 'acme/m', local })), ...turn.blocks.map(p => ({ kind: 'block' as const, handle: 'h', owner: 'acme/m', at: p.at, block: p.block }))])
  const messages: ApiMessage[] = [
    USER,
    { role: 'assistant', content: [{ type: 'text', text: 'Let me read it.' }, { type: 'tool_use', id: minted, name: 'Read', input: { file_path: '/a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: minted, content: 'file text' }] },
  ]
  expect(input({ messages, ids: remote, sealed: store.blocks('acme/m') }).slice(1)).toEqual([
    { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-reasoning-1', summary: [] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Let me read it.' }] },
    { type: 'function_call', call_id: 'call-1', name: 'Read', arguments: '{"file_path":"/a"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'file text' },
  ])
  expect(input({ messages, ids: remote, sealed: store.blocks('acme/other') }).map(i => i['type'] ?? i['role'])).toEqual(['user', 'assistant', 'function_call', 'function_call_output'])
})

test('a text response gives its deltas, the usage with cached tokens apart, and an end_turn stop', () => {
  const { events, closed } = parse([SSE('text')])
  expect(events).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo, ' },
    { type: 'text', text: 'world.' },
    { type: 'usage', in: 100, out: 30, cacheRead: 20, cacheWrite: 0, reasoning: 0 },
    { type: 'stop', reason: 'end_turn' },
  ])
  expect(closed.finish).toBe('completed')
})

test('a function call is read whole when its item is done, from the item and not the argument deltas; call_id is the remote id', () => {
  const pieces = SSE('one-tool').split(/(?<=\n\n)/)
  const { fed, events, remote } = parse(pieces)
  const at = pieces.findIndex(piece => piece.startsWith('event: response.output_item.done') && piece.includes('"function_call"'))
  expect(fed.flatMap((evs, i) => (evs.some(e => e.type === 'tool_use') ? [i] : []))).toEqual([at])
  expect(events.find(e => e.type === 'tool_use')).toEqual({ type: 'tool_use', id: 'toolu_klyth_000000000000000000000001', name: 'Read', input: { file_path: '/a' } })
  expect(remote).toEqual({ toolu_klyth_000000000000000000000001: 'call-1' })
  expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' })
})

test('parallel calls are two tool_use events in order, each with its own remote id; empty arguments are {}', () => {
  const parallel = parse([SSE('parallel-tools')])
  expect(parallel.events.filter(e => e.type === 'tool_use').map(e => (e.type === 'tool_use' ? [e.name, e.input] : []))).toEqual([['Read', { file_path: '/a' }], ['Bash', { command: 'ls' }]])
  expect(Object.values(parallel.remote)).toEqual(['call-1', 'call-2'])
  expect(parse([SSE('empty-arguments')]).events[0]).toMatchObject({ type: 'tool_use', name: 'TodoList', input: {} })
})

test('summary parts after the first are set apart by a blank line; the encrypted reasoning item is held, one without content is not', () => {
  const r = parse([SSE('reasoning-summary')])
  expect(r.events.filter(e => e.type === 'thinking').map(e => (e.type === 'thinking' ? e.text : ''))).toEqual(['Checking the', ' sum.', '\n\n', 'Adding', ' it up.'])
  expect(r.turn.blocks).toEqual([{ at: 0, block: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-reasoning-1' } }])
  expect(parse([SSE('reasoning-summary').replace('"encrypted_content":"opaque-reasoning-1"', '"encrypted_content":null')]).turn.blocks).toEqual([])
})

test('a refusal is text and finishes as a refusal; the finish reasons read as stops, and an unknown one as end_turn with a note', () => {
  const refusal = parse([SSE('refusal')])
  expect(refusal.events.filter(e => e.type === 'text')).toEqual([{ type: 'text', text: "I can't help" }, { type: 'text', text: ' with that.' }])
  expect(refusal.closed.events.at(-1)).toEqual({ type: 'stop', reason: 'refusal' })
  const incomplete = (reason: string) => parse([SSE('incomplete-max-tokens').replace('max_output_tokens', reason)]).closed
  expect(incomplete('max_output_tokens').events.at(-1)).toEqual({ type: 'stop', reason: 'max_tokens' })
  expect(incomplete('content_filter').events.at(-1)).toEqual({ type: 'stop', reason: 'refusal' })
  expect(incomplete('constructor')).toMatchObject({ events: [expect.anything(), { type: 'stop', reason: 'end_turn' }], note: 'finish_reason "constructor" read as end_turn' })
  expect(incomplete('max_output_tokens').events[0]).toEqual({ type: 'usage', in: 80, out: 30, cacheRead: 20, cacheWrite: 0, reasoning: 0 })
})

test('a response without usage gives a stop alone', () => {
  expect(parse([sse(done)]).closed).toEqual({ events: [{ type: 'stop', reason: 'end_turn' }], finish: 'completed' })
})

test('response.failed and error events end the response in one line, ChatGPT plan codes with their fix', () => {
  const cap = parse([SSE('failed-usage-limit')])
  expect(cap.closed.events).toEqual([{ type: 'error', kind: 'response', text: "klyth: acme response failed: The usage limit for this app is reached.; your ChatGPT plan's usage limit for klyth is reached; wait for it to reset, or raise it in ChatGPT settings" }])
  expect(parse([SSE('error-event')]).closed.events).toEqual([{ type: 'error', kind: 'response', text: failed('upstream overloaded') }])
  expect(parse([sse({ type: 'response.failed', response: {} })]).closed.events).toEqual([{ type: 'error', kind: 'response', text: failed('{"type":"response.failed","response":{}}') }])
})

test('a stream cut mid call or ending with no terminal event is an error, with the call never emitted', () => {
  const cut = parse([SSE('cut-mid-tool')])
  expect(types(cut.events)).toEqual(['text', 'error'])
  expect(cut.closed.events).toEqual([{ type: 'error', kind: 'response', text: failed('the stream ended with no finish reason') }])
  expect(parse([SSE('cut-mid-tool')], 'klyth: acme stalled (no data for 600 s)').closed.events).toEqual([{ type: 'error', kind: 'request', text: 'klyth: acme stalled (no data for 600 s)' }])
})

test('events that are not objects, not JSON, or have the wrong field types fail the response; nothing is read after the failure', () => {
  const answer = (...events: (Record<string, unknown> | string)[]) => parse([sse(...events)]).closed.events
  const err = (detail: string) => [{ type: 'error' as const, kind: 'response' as const, text: failed(detail) }]
  expect(answer('5')).toEqual(err('malformed stream event: an event is not an object'))
  expect(answer('{not json')).toEqual(err('unparseable stream data: {not json'))
  expect(answer({ type: 'response.output_text.delta', delta: 5 })).toEqual(err('malformed stream event: a delta is not text'))
  expect(answer({ type: 'response.output_item.done', item: 'x' })).toEqual(err('malformed stream event: an output item is not an object'))
  expect(answer({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1', name: 'Read' } })).toEqual(err('malformed stream event: a function_call item has no call_id, name or arguments as text'))
  expect(answer({ type: 'response.completed', response: { usage: { input_tokens: '1', output_tokens: 2 } } })).toEqual(err('malformed stream event: usage input_tokens or output_tokens is not a count'))
  expect(answer({ type: 'error', message: 'boom' }, { type: 'response.output_text.delta', delta: 'late' }, done)).toEqual(err('boom'))
})

test('a trailing data: [DONE] marker is skipped, and does not stand for a terminal event', () => {
  expect(parse([SSE('text-done')]).events).toEqual(parse([SSE('text')]).events)
  expect(parse([sse('[DONE]  ', done)]).closed).toEqual({ events: [{ type: 'stop', reason: 'end_turn' }], finish: 'completed' })
  expect(parse([sse({ type: 'response.output_text.delta', delta: 'cut' }, '[DONE]')]).closed.events).toEqual([{ type: 'error', kind: 'response', text: failed('the stream ended with no finish reason') }])
})

test('events klyth does not read, unknown fields and event: lines pass; an empty delta gives nothing', () => {
  const { events } = parse([sse({ type: 'response.web_search_call.in_progress', extra: 1 }, { type: 'response.output_text.delta', delta: '', future: true }, { type: 'response.output_text.delta', delta: 'ok' }, done)])
  expect(events).toEqual([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end_turn' }])
})

test('the codec distinguishes structured provider failures from malformed and missing-finish faults', () => {
  for (const event of [
    { type: 'response.failed', response: { error: { code: 'server_error', message: 'overload' } } },
    { type: 'error', code: 'server_error', message: 'overload' },
  ]) {
    const ds = openaiResponses.decoder().feed(new TextEncoder().encode(sse(event)))
    expect(ds).toEqual([{ t: 'error', message: JSON.stringify(event.type === 'response.failed' ? event.response!.error : event), provider: true }])
  }
  const malformed = openaiResponses.decoder().feed(new TextEncoder().encode('data: {bad}\n\n'))
  expect(malformed[0]).toMatchObject({ t: 'error' })
  expect(malformed[0]).not.toHaveProperty('provider')
  expect(openaiResponses.decoder().end()[0]).not.toHaveProperty('provider')
})

test('buffered activity crosses the assembly replay boundary in event order, but startup metadata does not', () => {
  const error = { type: 'response.failed', response: { error: { code: 'server_error', message: 'overload' } } }
  const start = { type: 'response.output_item.added', item: { type: 'function_call', arguments: '' } }
  const make = () => assembler(openaiResponses, 'acme', remoteIds())
  const metadata = make()
  expect(metadata.feed(openaiResponses.decoder().feed(new TextEncoder().encode(sse({ type: 'response.created', response: {} }, error))))).toEqual([])
  expect(metadata.retryFailure()).toBe(JSON.stringify(error.response.error))
  const activity = make()
  expect(activity.feed(openaiResponses.decoder().feed(new TextEncoder().encode(sse(start, error))))).toEqual([])
  expect(activity.retryFailure()).toBeUndefined()
  const failedFirst = make()
  failedFirst.feed(openaiResponses.decoder().feed(new TextEncoder().encode(sse(error, start))))
  expect(failedFirst.retryFailure()).toBe(JSON.stringify(error.response.error))
})
