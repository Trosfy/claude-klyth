// The `bedrock` codec: the event-stream framing (CRC32, header types, frames split anywhere), the decoder's
// events for each synthetic response in fixtures/bedrock (built here, checked in as bytes for the
// conformance suite, and compared with what is built), how a response's end is read, and the ConverseStream
// request bodies.
//
//   bun test klythd/codecs/bedrock.spec.ts      KLYTH_WRITE_FIXTURES=1 bun test klythd/codecs/bedrock.spec.ts   (rewrites the .eventstream files)
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseConfig } from '../../hooks/config'
import type { Config, ModelConfig, ProviderConfig } from '../../hooks/config'
import type { Decoded } from '../codec'
import type { Message } from '../history'
import { normalize, remoteIds } from '../history'
import { assembler } from '../step'
import { bedrock, toMessages } from './bedrock'
import { crc32, frameReader } from './eventstream'

const enc = new TextEncoder()
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]))
const u16 = (n: number) => [n >> 8, n & 255]

// A frame around raw header bytes and a payload, its prelude and message CRCs computed.
function framed(headers: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + headers.length + payload.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, out.length)
  v.setUint32(4, headers.length)
  v.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(headers, 12)
  out.set(payload, 12 + headers.length)
  v.setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)))
  return out
}

// A string header (type 7).
const header = (name: string, value: string) => [enc.encode(name).length, ...enc.encode(name), 7, ...u16(enc.encode(value).length), ...enc.encode(value)]
const frame = (headers: Record<string, string>, payload: string) => framed(Uint8Array.from(Object.entries(headers).flatMap(([k, v]) => header(k, v))), enc.encode(payload))
// The padding field Bedrock adds to every event's payload.
const PAD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'
const event = (type: string, body: object) => frame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify({ ...body, p: PAD }))
const exception = (type: string, message: string) => frame({ ':exception-type': type, ':content-type': 'application/json', ':message-type': 'exception' }, JSON.stringify({ message }))

const start = event('messageStart', { role: 'assistant' })
const delta = (i: number, d: object) => event('contentBlockDelta', { contentBlockIndex: i, delta: d })
const stop = (i: number) => event('contentBlockStop', { contentBlockIndex: i })
const tool = (i: number, id: string, name: string) => event('contentBlockStart', { contentBlockIndex: i, start: { toolUse: { toolUseId: id, name } } })
const input = (i: number, json: string) => delta(i, { toolUse: { input: json } })
const done = (stopReason: string) => event('messageStop', { stopReason })
const metadata = (usage: object) => event('metadata', { usage, metrics: { latencyMs: 420 } })

// The frame of `delta(0, { text: 'part' })` with a payload byte changed, so its message CRC no longer holds.
const corrupt = () => {
  const bad = delta(0, { text: 'part' })
  bad[bad.length - 30] = (bad[bad.length - 30] as number) ^ 1
  return bad
}

const SCENARIOS: Record<string, Uint8Array> = {
  text: concat(start, delta(0, { text: 'Hello' }), delta(0, { text: ', world.' }), stop(0), done('end_turn'), metadata({ inputTokens: 12, outputTokens: 5, totalTokens: 17 })),
  reasoning: concat(
    start,
    delta(0, { reasoningContent: { text: 'The user asks' } }),
    delta(0, { reasoningContent: { text: ' for a greeting.' } }),
    delta(0, { reasoningContent: { signature: 'EqQBCkYIBRgC' } }),
    stop(0),
    delta(1, { text: 'Hi there.' }),
    stop(1),
    done('end_turn'),
    metadata({ inputTokens: 20, outputTokens: 31, totalTokens: 51 }),
  ),
  'tool-fragments': concat(
    start,
    delta(0, { text: 'Reading it.' }),
    stop(0),
    tool(1, 'tooluse_abc123', 'Read'),
    input(1, '{"file_'),
    input(1, 'path": "/tmp/'),
    input(1, 'a.txt"}'),
    stop(1),
    done('tool_use'),
    metadata({ inputTokens: 40, outputTokens: 18, totalTokens: 158, cacheReadInputTokens: 100, cacheWriteInputTokens: 20 }),
  ),
  'parallel-tools': concat(
    start,
    delta(0, { text: 'Checking both.' }),
    stop(0),
    tool(1, 'tooluse_one', 'get_time'),
    input(1, '{"tz":"Europe/London"}'),
    stop(1),
    tool(2, 'tooluse_two', 'get_time'),
    input(2, '{"tz":'),
    input(2, '"UTC"}'),
    stop(2),
    done('tool_use'),
    metadata({ inputTokens: 55, outputTokens: 40, totalTokens: 95 }),
  ),
  'empty-arguments': concat(start, tool(0, 'tooluse_e', 'list'), stop(0), done('tool_use'), metadata({ inputTokens: 9, outputTokens: 3, totalTokens: 12 })),
  'max-tokens': concat(start, delta(0, { text: 'cut off mid' }), stop(0), done('max_tokens'), metadata({ inputTokens: 9, outputTokens: 64, totalTokens: 73 })),
  'crc-failure': concat(start, delta(0, { text: 'Fine so far, ' }), corrupt(), delta(0, { text: 'never read' }), done('end_turn')),
  exception: concat(start, delta(0, { text: 'part' }), exception('throttlingException', 'Too many requests, please wait before trying again.')),
  'cut-mid-tool': concat(start, tool(0, 'tooluse_cut', 'Write'), input(0, '{"file_path": "/tmp/')),
}
const DIR = join(import.meta.dir, 'fixtures', 'bedrock')

test('the checked-in fixture bytes are the ones built here', () => {
  for (const [name, bytes] of Object.entries(SCENARIOS)) {
    const path = join(DIR, `${name}.eventstream`)
    if (process.env['KLYTH_WRITE_FIXTURES'] === '1') writeFileSync(path, bytes)
    expect(Buffer.from(bytes).equals(readFileSync(path)), name).toBe(true)
  }
})

test('crc32 is the standard CRC-32: the check value, and the empty input', () => {
  expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
  expect(crc32(new Uint8Array(0))).toBe(0)
})

// The decoder's events for `bytes` fed in pieces cut at `cuts`, then ended.
function decode(bytes: Uint8Array, cuts: readonly number[] = []): Decoded[] {
  const d = bedrock.decoder()
  const out: Decoded[] = []
  let at = 0
  for (const cut of [...cuts, bytes.length]) {
    out.push(...d.feed(bytes.subarray(at, cut)))
    at = cut
  }
  return [...out, ...d.end()]
}
const errorOf = (ds: readonly Decoded[]) => (ds.find(d => d.t === 'error') as { message: string } | undefined)?.message

test('each response gives its events whole, cut at every byte offset, and fed a byte at a time', () => {
  for (const [name, bytes] of Object.entries(SCENARIOS)) {
    const whole = decode(bytes)
    for (let cut = 0; cut <= bytes.length; cut++) expect(decode(bytes, [cut]), `${name} cut at ${cut}`).toEqual(whole)
    expect(decode(bytes, Array.from({ length: bytes.length }, (_, i) => i)), `${name} byte by byte`).toEqual(whole)
  }
})

test('Bedrock usage before messageStop becomes final only when the event stream completes', () => {
  const decoder = bedrock.decoder()
  decoder.feed(concat(start, metadata({ inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 1, cacheWriteInputTokens: 0 }), done('end_turn')))
  expect(decoder.evidence?.()?.finality).toBe('provisional')
  decoder.end()
  expect(decoder.evidence?.()).toMatchObject({ finality: 'final', totalInput: { status: 'reported', count: 4 }, output: { status: 'reported', count: 2 } })
  const cut = bedrock.decoder()
  cut.feed(concat(start, metadata({ inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 1, cacheWriteInputTokens: 0 })))
  cut.end()
  expect(cut.evidence?.()?.finality).toBe('provisional')
})

test('text, reasoning, tool input fragments and parallel tools decode to their events, usage and finish reason', () => {
  const usage = (u: Record<string, number>) => ({ t: 'usage' as const, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, ...u })
  expect(decode(SCENARIOS['text'] as Uint8Array)).toEqual([{ t: 'text', text: 'Hello' }, { t: 'text', text: ', world.' }, { t: 'finish', reason: 'end_turn' }, usage({ in: 12, out: 5 })])
  expect(decode(SCENARIOS['reasoning'] as Uint8Array)).toEqual([
    { t: 'thinking', text: 'The user asks' },
    { t: 'thinking', text: ' for a greeting.' },
    { t: 'sealed', block: { type: 'thinking', thinking: 'The user asks for a greeting.', signature: 'EqQBCkYIBRgC' } },
    { t: 'text', text: 'Hi there.' },
    { t: 'finish', reason: 'end_turn' },
    usage({ in: 20, out: 31 }),
  ])
  expect(decode(SCENARIOS['tool-fragments'] as Uint8Array)).toEqual([
    { t: 'text', text: 'Reading it.' },
    { t: 'tool', id: 'tooluse_abc123', name: 'Read', args: '{"file_path": "/tmp/a.txt"}' },
    { t: 'finish', reason: 'tool_use' },
    usage({ in: 40, out: 18, cacheRead: 100, cacheWrite: 20 }),
  ])
  expect(decode(SCENARIOS['parallel-tools'] as Uint8Array).filter(d => d.t === 'tool')).toEqual([
    { t: 'tool', id: 'tooluse_one', name: 'get_time', args: '{"tz":"Europe/London"}' },
    { t: 'tool', id: 'tooluse_two', name: 'get_time', args: '{"tz":"UTC"}' },
  ])
  expect(decode(SCENARIOS['empty-arguments'] as Uint8Array)[0]).toEqual({ t: 'tool', id: 'tooluse_e', name: 'list', args: '' })
})

test('two tool blocks open at once are told apart by their block index', () => {
  const ds = decode(concat(start, tool(0, 'a', 'one'), tool(1, 'b', 'two'), input(1, '{"y":'), input(0, '{"x":1}'), input(1, '2}'), stop(0), stop(1), done('tool_use')))
  expect(ds.filter(d => d.t === 'tool')).toEqual([
    { t: 'tool', id: 'a', name: 'one', args: '{"x":1}' },
    { t: 'tool', id: 'b', name: 'two', args: '{"y":2}' },
  ])
})

test('a frame reader skips header values that are not strings, whatever their type, and reads the string ones', () => {
  const named = (name: string, type: number, ...value: number[]) => [enc.encode(name).length, ...enc.encode(name), type, ...value]
  const headers = Uint8Array.from([
    ...named('t', 0),
    ...named('f', 1),
    ...named('byte', 2, 7),
    ...named('short', 3, 1, 2),
    ...named('int', 4, 1, 2, 3, 4),
    ...named('long', 5, 1, 2, 3, 4, 5, 6, 7, 8),
    ...named('bytes', 6, ...u16(3), 9, 9, 9),
    ...named('time', 8, 1, 2, 3, 4, 5, 6, 7, 8),
    ...named('uuid', 9, ...new Array<number>(16).fill(1)),
    ...header(':event-type', 'x'),
    ...header('é', 'ü'),
  ])
  const [f] = [...frameReader().feed(framed(headers, enc.encode('body')))]
  expect(f?.headers).toEqual({ ':event-type': 'x', 'é': 'ü' })
  expect(f?.payload).toBe('body')
})

// The error of decoding `bytes`, after the good frame `ok`.
const broken = (bytes: Uint8Array) => errorOf(decode(concat(delta(0, { text: 'ok' }), bytes)))

test('a corrupt frame is an error with the reason: prelude CRC, length, message CRC, a header that overruns, an unknown header type', () => {
  const good = delta(0, { text: 'x' })
  const flip = (at: number) => Uint8Array.from(good, (b, i) => (i === at ? b ^ 1 : b))
  expect(broken(flip(2))).toBe('event-stream prelude CRC mismatch')
  expect(broken(flip(good.length - 1))).toBe('event-stream message CRC mismatch')
  expect(broken(flip(20))).toBe('event-stream message CRC mismatch')
  const prelude = (total: number, headers: number) => {
    const p = new Uint8Array(12)
    new DataView(p.buffer).setUint32(0, total)
    new DataView(p.buffer).setUint32(4, headers)
    new DataView(p.buffer).setUint32(8, crc32(p.subarray(0, 8)))
    return p
  }
  expect(broken(prelude(20, 9))).toBe('event-stream frame length is out of range')
  expect(broken(prelude(0xffffffff, 0))).toBe('event-stream frame length is out of range')
  expect(broken(framed(Uint8Array.from([5, 97, 98]), new Uint8Array(0)))).toBe('event-stream header runs past the headers')
  expect(broken(framed(Uint8Array.from([1, 97, 42]), new Uint8Array(0)))).toBe('event-stream header type 42 is not defined')
  expect(broken(framed(Uint8Array.from([1, 97, 7, 0, 9, 98]), new Uint8Array(0)))).toBe('event-stream header runs past the headers')
})

test('after a corrupt frame, the events before it stand and nothing after it is read', () => {
  expect(decode(SCENARIOS['crc-failure'] as Uint8Array)).toEqual([{ t: 'text', text: 'Fine so far, ' }, { t: 'error', message: 'event-stream message CRC mismatch' }])
})

// A response's step events, as the assembler gives them: the decoder fed `bytes` and ended, then the end.
function steps(bytes: Uint8Array) {
  let n = 0
  const asm = assembler(bedrock, 'p', remoteIds(), () => `toolu_klyth_${String(++n).padStart(24, '0')}`)
  const d = bedrock.decoder()
  const events = [...asm.feed(d.feed(bytes)), ...asm.feed(d.end())]
  const end = asm.end({ id: 'p' } as ProviderConfig)
  return { events: [...events, ...end.events], note: end.note }
}

test('an exception event is one error line naming its type and message, the events before it kept', () => {
  const { events } = steps(SCENARIOS['exception'] as Uint8Array)
  expect(events).toEqual([
    { type: 'text', text: 'part' },
    { type: 'error', kind: 'response', text: 'klyth: p response failed: throttlingException: Too many requests, please wait before trying again.; retry, or see the debug log' },
  ])
  const many = steps(concat(exception('validationException', 'first line\nsecond line'))).events
  expect(many).toEqual([{ type: 'error', kind: 'response', text: 'klyth: p response failed: validationException: first line; retry, or see the debug log' }])
})

test('an error message frame, or an exception with a payload that is not JSON, still gives one error line', () => {
  const err = frame({ ':message-type': 'error', ':error-code': 'InternalError', ':error-message': 'it broke' }, '')
  expect(steps(err).events).toEqual([{ type: 'error', kind: 'response', text: 'klyth: p response failed: InternalError: it broke; retry, or see the debug log' }])
  const raw = frame({ ':message-type': 'exception', ':exception-type': 'internalServerException' }, 'plain text failure')
  expect(errorOf(decode(raw))).toBe('internalServerException: plain text failure')
})

test('an event whose payload is not JSON, or tool input for a block that never started, is an error', () => {
  const junk = frame({ ':event-type': 'contentBlockDelta', ':message-type': 'event' }, '{not json')
  expect(errorOf(decode(junk))).toBe('unparseable contentBlockDelta event')
  expect(errorOf(decode(concat(start, input(3, '{}'))))).toBe('tool input arrived for a block that never started')
})

test('the end of a response says how it was cut: inside a frame, inside a tool call, or before any stop reason', () => {
  const text = SCENARIOS['text'] as Uint8Array
  expect(errorOf(decode(text.subarray(0, text.length - 5)))).toBe('the stream ended inside an event frame')
  expect(errorOf(decode(SCENARIOS['cut-mid-tool'] as Uint8Array))).toBe('the stream ended inside a tool call')
  expect(errorOf(decode(concat(start, delta(0, { text: 'x' }))))).toBe('the stream ended with no stop reason')
  expect(errorOf(decode(new Uint8Array(0)))).toBe('the stream ended with no stop reason')
  expect(decode(SCENARIOS['cut-mid-tool'] as Uint8Array).some(d => d.t === 'tool')).toBe(false)
})

test('each stop reason reads as the engine\'s; a malformed one is an error, an unknown one reads as end_turn with a note', () => {
  const reason = (stopReason: string) => steps(concat(start, delta(0, { text: 'x' }), stop(0), done(stopReason)))
  const table: [string, string][] = [
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['stop_sequence', 'end_turn'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['guardrail_intervened', 'refusal'],
    ['content_filtered', 'refusal'],
  ]
  for (const [aws, engine] of table) expect(reason(aws).events.at(-1), aws).toEqual({ type: 'stop', reason: engine as never })
  for (const aws of ['malformed_model_output', 'malformed_tool_use']) {
    const events = reason(aws).events
    expect(events.at(-1), aws).toEqual({ type: 'error', kind: 'response', text: `klyth: p response failed: the model ended with stopReason "${aws}"; retry, or see the debug log` })
  }
  const unknown = reason('a_future_reason')
  expect([unknown.events.at(-1), unknown.note]).toEqual([{ type: 'stop', reason: 'end_turn' }, 'finish_reason "a_future_reason" read as end_turn'])
})

test('usage maps input, output and cache tokens; a response with no metadata still ends cleanly, without usage', () => {
  const { events } = steps(SCENARIOS['tool-fragments'] as Uint8Array)
  expect(events.filter(e => e.type === 'usage')).toEqual([{ type: 'usage', in: 40, out: 18, cacheRead: 100, cacheWrite: 20 }])
  const bare = steps(concat(start, delta(0, { text: 'x' }), stop(0), done('end_turn'))).events
  expect(bare.map(e => e.type)).toEqual(['text', 'stop'])
})

test('a tool call becomes a tool_use with a minted id, its own id remembered; empty arguments are an empty object', () => {
  const { events } = steps(SCENARIOS['parallel-tools'] as Uint8Array)
  expect(events.filter(e => e.type === 'tool_use')).toEqual([
    { type: 'tool_use', id: 'toolu_klyth_000000000000000000000001', name: 'get_time', input: { tz: 'Europe/London' } },
    { type: 'tool_use', id: 'toolu_klyth_000000000000000000000002', name: 'get_time', input: { tz: 'UTC' } },
  ])
  expect(steps(SCENARIOS['empty-arguments'] as Uint8Array).events[0]).toMatchObject({ type: 'tool_use', name: 'list', input: {} })
})

const cfg = (model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) => {
  const c = parseConfig(
    JSON.stringify({
      providers: {
        aws: {
          kind: 'bedrock',
          baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
          auth: { command: ['/usr/bin/security'] },
          ...provider,
          models: { 'us.anthropic.claude-sonnet-4-5-v1:0': { contextWindow: 200_000, maxOutputTokens: 8000, ...model } },
        },
      },
    }),
  )
  expect(c.errors).toEqual([])
  const p = (c.config as Config).providers['aws'] as ProviderConfig
  return { p, m: Object.values(p.models)[0] as ModelConfig }
}
const turn = (messages: Message[], extra: { tools?: { name: string; description?: string }[]; effort?: unknown } = {}, model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) => {
  const { p, m } = cfg(model, provider)
  const built = bedrock.encode(
    {
      system: 'SYS',
      messages,
      tools: (extra.tools ?? []).map(t => ({ name: t.name, description: t.description ?? `${t.name} tool`, schema: { type: 'object', properties: { a: { type: 'string' } } } })),
      ...(extra.effort === undefined ? {} : { effort: extra.effort as never }),
    },
    p,
    m,
  )
  return { ...built, json: JSON.parse(built.body) as Record<string, unknown> }
}
const say = (role: 'user' | 'assistant', t: string): Message => ({ role, content: [{ type: 'text', text: t }] })

test('the request goes to the ConverseStream path of the model id, escaped, with max tokens, the system prompt and the messages', () => {
  const r = turn([say('user', 'hi')])
  expect(r.path).toBe('/model/us.anthropic.claude-sonnet-4-5-v1%3A0/converse-stream')
  expect(r.json).toEqual({ inferenceConfig: { maxTokens: 8000 }, messages: [{ role: 'user', content: [{ text: 'hi' }] }], system: [{ text: 'SYS' }] })
  expect(r.effort).toBe('none')
  const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0'
  const { p, m } = cfg()
  expect(bedrock.encode({ system: '', messages: [], tools: [] }, p, { ...m, id: arn }).path).toBe(`/model/${encodeURIComponent(arn)}/converse-stream`)
  expect(bedrock.encode({ system: '', messages: [], tools: [] }, p, m).body).not.toContain('system')
})

test('tools go out as toolSpecs with their JSON schema, none when the model takes no tools', () => {
  const r = turn([say('user', 'hi')], { tools: [{ name: 'Read' }, { name: 'Bare', description: '' }] })
  expect(r.json['toolConfig']).toEqual({
    tools: [
      { toolSpec: { name: 'Read', description: 'Read tool', inputSchema: { json: { type: 'object', properties: { a: { type: 'string' } } } } } },
      { toolSpec: { name: 'Bare', inputSchema: { json: { type: 'object', properties: { a: { type: 'string' } } } } } },
    ],
  })
  expect(turn([say('user', 'hi')], { tools: [{ name: 'Read' }] }, { tools: false }).json).not.toHaveProperty('toolConfig')
})

test('effort params and provider params merge into the body, inferenceConfig deep-merged over max tokens', () => {
  const topK = (n: number) => ({ additionalModelRequestFields: { top_k: n } })
  const model = { effort: { low: topK(10), high: { ...topK(40), inferenceConfig: { temperature: 1 } } } }
  const high = turn([say('user', 'hi')], { effort: 'high' }, model, { params: { inferenceConfig: { topP: 0.9 } } })
  expect(high.json['additionalModelRequestFields']).toEqual({ top_k: 40 })
  expect(high.json['inferenceConfig']).toEqual({ maxTokens: 8000, topP: 0.9, temperature: 1 })
  expect(high.effort).toBe('high')
  const max = turn([say('user', 'hi')], { effort: 'max' }, model)
  expect([max.effort, max.json['additionalModelRequestFields']]).toEqual(['high', topK(40).additionalModelRequestFields])
})

test('tool calls and results become toolUse and toolResult blocks; an error result carries its status, an empty one a note', () => {
  const messages: Message[] = [
    say('user', 'go'),
    { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_klyth_1', name: 'Read', input: { a: 'x' } }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_klyth_1', content: [{ type: 'text', text: 'file body' }], is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_klyth_2', content: [{ type: 'text', text: 'denied' }], is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_klyth_3', content: [{ type: 'text', text: '' }], is_error: false },
      ],
    },
  ]
  expect(toMessages(messages)).toEqual([
    { role: 'user', content: [{ text: 'go' }] },
    { role: 'assistant', content: [{ text: 'Reading.' }, { toolUse: { toolUseId: 'toolu_klyth_1', name: 'Read', input: { a: 'x' } } }] },
    {
      role: 'user',
      content: [
        { toolResult: { toolUseId: 'toolu_klyth_1', content: [{ text: 'file body' }] } },
        { toolResult: { toolUseId: 'toolu_klyth_2', content: [{ text: 'denied' }], status: 'error' } },
        { toolResult: { toolUseId: 'toolu_klyth_3', content: [{ text: '(no output)' }] } },
      ],
    },
  ])
})

test('images go as inline bytes (a tool result\'s too), a URL image as a note; blank text is dropped', () => {
  const png = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } }
  const link = { type: 'image' as const, source: { type: 'url' as const, url: 'https://x.invalid/a.png' } }
  const out = toMessages([
    { role: 'user', content: [{ type: 'text', text: '  ' }, png, link] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Shot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'shot' }, png], is_error: false }] },
  ])
  const inline = { image: { format: 'png', source: { bytes: 'AAAA' } } }
  const note = { text: '[image omitted: Bedrock takes inline images only]' }
  expect(out[0]).toEqual({ role: 'user', content: [inline, note] })
  expect(out[2]).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 't', content: [{ text: 'shot' }, inline] } }] })
})

test('messages left empty are dropped and neighbours of one role merge, so the turns alternate', () => {
  const out = toMessages([say('user', 'a'), say('user', 'b'), { role: 'assistant', content: [{ type: 'text', text: '' }] }, say('user', 'c'), say('assistant', 'd'), say('user', 'e')])
  expect(out).toEqual([
    { role: 'user', content: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
    { role: 'assistant', content: [{ text: 'd' }] },
    { role: 'user', content: [{ text: 'e' }] },
  ])
})

const TOOL_TURN: Message[] = [
  say('user', 'go'),
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }], is_error: false }] },
]
const POINT = { cachePoint: { type: 'default' } }

test('cache: "5m" puts a cache point after the system prompt, after the tools and at the end of the last two user turns (the four allowed); "1h" adds its ttl', () => {
  const r = turn(TOOL_TURN, { tools: [{ name: 'Read' }, { name: 'Bash' }] }, { cache: '5m' })
  expect(r.json['system']).toEqual([{ text: 'SYS' }, POINT])
  const tools = (r.json['toolConfig'] as { tools: object[] }).tools
  expect([tools.length, tools.at(-1)]).toEqual([3, POINT])
  const messages = r.json['messages'] as { content: object[] }[]
  expect([messages[0]?.content.at(-1), messages[1]?.content.at(-1), messages[2]?.content.at(-1)]).toEqual([POINT, { toolUse: { toolUseId: 't1', name: 'Read', input: {} } }, POINT])
  expect(JSON.stringify(r.json).match(/cachePoint/g)).toHaveLength(4)
  const hour = turn(TOOL_TURN, { tools: [{ name: 'Read' }] }, { cache: '1h' })
  expect(JSON.stringify(hour.json).match(/"cachePoint":\{"type":"default","ttl":"1h"\}/g)).toHaveLength(4)
  // Nothing to mark: no system prompt, no tools.
  const bare = bedrock.encode({ system: '', messages: [say('user', 'hi')], tools: [] }, cfg().p, { ...cfg().m, cache: '5m' })
  expect(JSON.parse(bare.body)).toEqual({ inferenceConfig: { maxTokens: 8000 }, messages: [{ role: 'user', content: [{ text: 'hi' }, POINT] }] })
})

test('without cache no cache point is sent', () => {
  expect(turn(TOOL_TURN, { tools: [{ name: 'Read' }] }).body).not.toContain('cachePoint')
})

test('Claude thinking and effort go in additionalModelRequestFields whole, beside the cache points', () => {
  const fields = (effort: string) => ({ additionalModelRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort } } })
  const r = turn([say('user', 'hi')], { effort: 'high' }, { cache: '5m', effort: { low: fields('low'), high: fields('high') } })
  expect(r.json['additionalModelRequestFields']).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
  const manual = turn([say('user', 'hi')], {}, { params: { additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 } } } })
  expect(manual.json['additionalModelRequestFields']).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } })
})

test("the signed thinking of a tool turn goes first as reasoningContent; a turn whose thinking is lost sends no thinking param but keeps the other fields", () => {
  const blocks: Message['content'] = [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'redacted_thinking', data: 'cmVk' }]
  const withBlocks: Message[] = [TOOL_TURN[0] as Message, { role: 'assistant', content: [...blocks, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] }, TOOL_TURN[2] as Message]
  const model = { params: { additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 }, top_k: 5 } } }
  const kept = turn(withBlocks, {}, model)
  expect((kept.json['messages'] as { content: object[] }[])[1]?.content).toEqual([
    { reasoningContent: { reasoningText: { text: 'hm', signature: 'sig' } } },
    { reasoningContent: { redactedContent: 'cmVk' } },
    { toolUse: { toolUseId: 't1', name: 'Read', input: {} } },
  ])
  expect(kept.json['additionalModelRequestFields']).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 }, top_k: 5 })
  expect(kept.lost).toBeUndefined()
  const lost = turn([TOOL_TURN[0] as Message, { ...(withBlocks[1] as Message), content: [(withBlocks[1] as Message).content[2] as Message['content'][number]], unsealed: true }, TOOL_TURN[2] as Message], {}, model)
  expect(lost.json['additionalModelRequestFields']).toEqual({ top_k: 5 })
  expect(lost.lost).toBe(true)
  // Nothing set to leave out, or a lost turn that is not the one in progress: sent as it is.
  expect(turn([TOOL_TURN[0] as Message, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], unsealed: true }, TOOL_TURN[2] as Message]).lost).toBeUndefined()
})

test('only a thinking param that asks for thinking is left out when the signed blocks are lost: enabled and adaptive go, disabled stays as sent', () => {
  const unsealed: Message[] = [TOOL_TURN[0] as Message, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], unsealed: true }, TOOL_TURN[2] as Message]
  const fields = (thinking: object) => turn(unsealed, {}, { params: { additionalModelRequestFields: { thinking, top_k: 5 } } })
  expect(fields({ type: 'adaptive' })).toMatchObject({ lost: true, json: { additionalModelRequestFields: { top_k: 5 } } })
  expect(fields({ type: 'enabled', budget_tokens: 2048 }).lost).toBe(true)
  const disabled = fields({ type: 'disabled' })
  expect(disabled.lost).toBeUndefined()
  expect(disabled.json['additionalModelRequestFields']).toEqual({ thinking: { type: 'disabled' }, top_k: 5 })
})

test('reasoning interleaved with text and a call, [T1, A, T2, B], comes back in that order, whatever its kind', () => {
  const bytes = concat(
    start,
    delta(0, { reasoningContent: { text: 'one' } }),
    delta(0, { reasoningContent: { signature: 'S1' } }),
    stop(0),
    delta(1, { text: 'A' }),
    stop(1),
    delta(2, { reasoningContent: { redactedContent: 'cmVk' } }),
    stop(2),
    tool(3, 'tooluse_1', 'Read'),
    input(3, '{}'),
    stop(3),
    done('tool_use'),
  )
  const asm = assembler(bedrock, 'p', remoteIds(), () => 'toolu_klyth_x')
  const d = bedrock.decoder()
  asm.feed([...d.feed(bytes), ...d.end()])
  const transcript = [
    { role: 'user' as const, content: 'go' },
    { role: 'assistant' as const, content: [{ type: 'text', text: 'A' }, { type: 'tool_use', id: 'toolu_klyth_x', name: 'Read', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_x', content: 'x' }] },
  ]
  const sealed = (id: string) => (id === 'toolu_klyth_x' ? asm.turn().blocks : undefined)
  const sent = turn(normalize(transcript, true, () => undefined, sealed)).json['messages'] as { content: object[] }[]
  expect(sent[1]?.content).toEqual([
    { reasoningContent: { reasoningText: { text: 'one', signature: 'S1' } } },
    { text: 'A' },
    { reasoningContent: { redactedContent: 'cmVk' } },
    { toolUse: { toolUseId: 'toolu_klyth_x', name: 'Read', input: {} } },
  ])
})

test("a redacted block's pieces are each base64 on their own, so they are joined as bytes, not as text", () => {
  // 'red' and 'act' are 3 bytes each: 'cmVk' and 'YWN0'. 'ed' is 2 bytes: 'ZWQ=', padded on its own, so
  // joined as text the data would hold a '=' in its middle.
  const pieces = ['cmVk', 'ZWQ=', 'YWN0']
  const ds = decode(concat(start, ...pieces.map(redactedContent => delta(0, { reasoningContent: { redactedContent } })), stop(0), done('end_turn')))
  const sealed = ds.find(d => d.t === 'sealed')
  expect(sealed).toEqual({ t: 'sealed', block: { type: 'redacted_thinking', data: Buffer.from('rededact').toString('base64') } })
  expect(Buffer.from((sealed as { block: { data: string } }).block.data, 'base64').toString()).toBe('rededact')
})

test('a signed reasoning block and a redacted one decode whole beside their text; a block with no signature is not kept', () => {
  const ds = decode(concat(start, delta(0, { reasoningContent: { text: 'a' } }), delta(0, { reasoningContent: { text: 'b' } }), delta(0, { reasoningContent: { signature: 'S' } }), stop(0), delta(1, { reasoningContent: { redactedContent: 'cmVk' } }), stop(1), delta(2, { reasoningContent: { text: 'unsigned' } }), stop(2), done('end_turn')))
  expect(ds.filter(d => d.t === 'sealed')).toEqual([
    { t: 'sealed', block: { type: 'thinking', thinking: 'ab', signature: 'S' } },
    { t: 'sealed', block: { type: 'redacted_thinking', data: 'cmVk' } },
  ])
})

test('an exception event with a huge message is recorded at most 4 KiB long', () => {
  const message = errorOf(decode(exception('validationException', ' '.repeat(1 << 20)))) as string
  expect(message).toHaveLength(4096)
  expect(message.startsWith('validationException: ')).toBe(true)
})
