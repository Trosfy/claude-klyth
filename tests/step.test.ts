// Step assembly: a routed step's events as turn.step chunks, its block indexes, coalescing, the stop and
// usage, and a failure answered as text or as one SubagentHandback call.
import type { TurnStepChunk } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { StepEvent } from '../hooks/protocol'
import { coalesce, createAssembler } from '../hooks/step'

const HANDBACK = 'SubagentHandback'
const kinds = (chunks: readonly TurnStepChunk[]) => chunks.map(c => `${c.kind}${'index' in c ? c.index : ''}`)
const read = { type: 'tool_use', id: 'toolu_klyth_000000000000000000000001', name: 'Read', input: { file_path: '/a' } } as const
const usage = { type: 'usage', in: 80, out: 30, cacheRead: 20, cacheWrite: 5 } as const
const stats = { type: 'stats', ttfbMs: 12, totalMs: 40, reqBytes: 900, in: 100, out: 30, finish: 'stop' } as const

// Feeds `events` to a fresh assembler for acme/m, then ends it; returns every chunk and the end.
function run(events: readonly StepEvent[], end: { handback?: string; failure?: string; deliver?: boolean } = {}) {
  const assembler = createAssembler('acme/m')
  const fed = events.flatMap(ev => assembler.feed(ev))
  const done = assembler.end(end)
  return { chunks: [...fed, ...done.chunks], end: done }
}

test('block indexes: thinking, text, a tool call, then text are 0, 1, 2, 3; deltas of one block share its index', () => {
  const { chunks, end } = run([
    { type: 'thinking', text: 'hm' },
    { type: 'thinking', text: 'm' },
    { type: 'text', text: 'Rea' },
    { type: 'text', text: 'ding' },
    read,
    { type: 'text', text: 'done' },
    { type: 'stop', reason: 'tool_use' },
  ])
  expect(kinds(chunks)).toEqual(['thinking0', 'thinking0', 'text1', 'text1', 'tool2', 'input2', 'text3', 'stop'])
  expect(chunks.slice(4, 6)).toEqual([
    { kind: 'tool', index: 2, id: read.id, name: 'Read' },
    { kind: 'input', index: 2, json: '{"file_path":"/a"}' },
  ])
  expect(end).toMatchObject({ answer: 'Readingdone', toolUses: [{ name: 'Read', input: { file_path: '/a' } }], stopReason: 'tool_use' })
})

test('coalescing merges adjacent deltas of one kind, and keeps kinds and the blocks a tool call splits apart', () => {
  expect(
    coalesce([
      { type: 'thinking', text: 'a' },
      { type: 'thinking', text: 'b' },
      { type: 'text', text: 'c' },
      { type: 'text', text: 'd' },
      read,
      { type: 'text', text: 'e' },
      usage,
      { type: 'text', text: 'f' },
    ]),
  ).toEqual([{ type: 'thinking', text: 'ab' }, { type: 'text', text: 'cd' }, read, { type: 'text', text: 'e' }, usage, { type: 'text', text: 'f' }])
  const words = ['Klyth ', 'routes ', 'to ', 'naïve ✓ 日本', '.']
  const one = run([...coalesce(words.map((text): StepEvent => ({ type: 'text', text }))), { type: 'stop', reason: 'end_turn' }])
  expect(one.chunks.slice(0, -1)).toEqual([{ kind: 'text', index: 0, text: words.join('') }])
})

test('stop mapping: the reason passes through, tool calls force tool_use, and a tool_use reason without calls reads as end_turn', () => {
  const stopOf = (events: readonly StepEvent[]) => run(events).end.stopReason
  expect(stopOf([{ type: 'text', text: 'x' }, { type: 'stop', reason: 'end_turn' }])).toBe('end_turn')
  expect(stopOf([{ type: 'text', text: 'x' }, { type: 'stop', reason: 'max_tokens' }])).toBe('max_tokens')
  expect(stopOf([{ type: 'stop', reason: 'refusal' }])).toBe('refusal')
  expect(stopOf([read, { type: 'stop', reason: 'end_turn' }])).toBe('tool_use')
  expect(stopOf([read, { type: 'stop', reason: 'max_tokens' }])).toBe('tool_use')
  expect(stopOf([{ type: 'text', text: 'x' }, { type: 'stop', reason: 'tool_use' }])).toBe('end_turn')
})

test('usage maps to the engine form under the step target, rides the stop, and stats yield nothing', () => {
  const { chunks, end } = run([{ type: 'text', text: 'ok' }, usage, { type: 'stop', reason: 'end_turn' }, stats])
  const turnUsage = { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, model: 'acme/m' }
  expect(chunks).toEqual([
    { kind: 'text', index: 0, text: 'ok' },
    { kind: 'stop', stopReason: 'end_turn', usage: turnUsage },
  ])
  expect(end).toEqual({ chunks: [{ kind: 'stop', stopReason: 'end_turn', usage: turnUsage }], answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: turnUsage })
})

const FAILED = 'klyth: acme HTTP 403: Access denied for this route'

test('a request failure is handed back as one SubagentHandback call when offered, with no usage, and as text when not', () => {
  const offered = run([usage, { type: 'error', kind: 'request', text: FAILED }, stats], { handback: HANDBACK })
  expect(kinds(offered.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(offered.chunks.at(-1)).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: null })
  expect(offered.chunks[0]).toMatchObject({ kind: 'tool', index: 0, id: expect.stringMatching(/^toolu_klyth_[0-9a-f]{24}$/), name: HANDBACK })
  expect(JSON.parse((offered.chunks[1] as { json: string }).json)).toEqual({ message: FAILED })
  expect(offered.end).toMatchObject({ answer: '', toolUses: [{ name: HANDBACK, input: { message: FAILED } }], stopReason: 'tool_use', usage: null, failure: FAILED })
  const plain = run([{ type: 'error', kind: 'request', text: FAILED }])
  expect(plain.chunks).toEqual([
    { kind: 'text', index: 0, text: FAILED },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ])
  expect(plain.end).toMatchObject({ answer: FAILED, toolUses: [], failure: FAILED })
})

test('a response failure, and any failure after a tool call, is answered as text at the next index, the call kept', () => {
  const said = 'klyth: acme response failed: upstream overloaded; retry, or see the debug log'
  const response = run([{ type: 'error', kind: 'response', text: said }], { handback: HANDBACK })
  expect(kinds(response.chunks)).toEqual(['text0', 'stop'])
  expect(response.end).toMatchObject({ answer: said, toolUses: [], stopReason: 'end_turn' })
  const after = run([read, { type: 'text', text: 'reading' }, { type: 'error', kind: 'request', text: FAILED }], { handback: HANDBACK })
  expect(kinds(after.chunks)).toEqual(['tool0', 'input0', 'text1', 'text2', 'stop'])
  expect(after.end).toMatchObject({ answer: `reading${FAILED}`, toolUses: [{ name: 'Read' }], stopReason: 'tool_use', usage: null })
})

test('a stream cut mid tool call reaches the assembler as an error after the text: no tool chunk, the failure as text', () => {
  const { chunks } = run([{ type: 'text', text: 'writing' }, { type: 'error', kind: 'request', text: 'klyth: acme stalled (no data for 600 s); retry' }])
  expect(kinds(chunks)).toEqual(['text0', 'text1', 'stop'])
  expect(chunks.some(c => c.kind === 'tool' || c.kind === 'input')).toBe(false)
})

test('a failure given at the end replaces what the events said, after what was yielded; events with no stop are a failure', () => {
  const internal = 'klyth: internal error on acme/m; the step was not sent to another model (see the debug log)'
  const assembler = createAssembler('acme/m')
  const fed = [{ type: 'text', text: 'part' } as const, usage].flatMap(ev => assembler.feed(ev))
  const end = assembler.end({ failure: internal, handback: HANDBACK })
  expect(kinds([...fed, ...end.chunks])).toEqual(['text0', 'tool1', 'input1', 'stop'])
  expect(end).toMatchObject({ answer: 'part', toolUses: [{ name: HANDBACK, input: { message: internal } }], stopReason: 'tool_use', usage: null })
  expect(run([{ type: 'text', text: 'x' }]).end).toMatchObject({ answer: 'xklyth: acme/m ended the step with no stop; retry', stopReason: 'end_turn', usage: null })
  expect(run([{ type: 'error', kind: 'response', text: 'first' }, { type: 'error', kind: 'request', text: 'second' }]).end.answer).toBe('first')
})

test('deliver turns a text-only end_turn into one handback call carrying the text, and only then', () => {
  const ok = [{ type: 'text', text: 'ok' }, usage, { type: 'stop', reason: 'end_turn' }] as const
  const sent = run(ok, { handback: HANDBACK, deliver: true })
  expect(kinds(sent.chunks)).toEqual(['text0', 'tool1', 'input1', 'stop'])
  expect(sent.chunks[1]).toMatchObject({ kind: 'tool', index: 1, id: expect.stringMatching(/^toolu_klyth_[0-9a-f]{24}$/), name: HANDBACK })
  expect(sent.chunks[2]).toEqual({ kind: 'input', index: 1, json: '{"message":"ok"}' })
  expect(sent.chunks[3]).toMatchObject({ kind: 'stop', stopReason: 'tool_use', usage: { input_tokens: 80, output_tokens: 30 } })
  expect(sent.end).toMatchObject({ answer: 'ok', toolUses: [{ name: HANDBACK, input: { message: 'ok' } }], stopReason: 'tool_use', delivered: true })
  const plain = run(ok, { handback: HANDBACK })
  expect(kinds(plain.chunks)).toEqual(['text0', 'stop'])
  expect(plain.end.delivered).toBeUndefined()
  const called = run([{ type: 'text', text: 'ok' }, read, usage, { type: 'stop', reason: 'tool_use' }], { handback: HANDBACK, deliver: true })
  expect(called.end).toMatchObject({ toolUses: [{ name: 'Read' }], stopReason: 'tool_use' })
  expect(called.end.delivered).toBeUndefined()
  const blank = run([{ type: 'text', text: '  ' }, usage, { type: 'stop', reason: 'end_turn' }], { handback: HANDBACK, deliver: true })
  expect(blank.end).toMatchObject({ toolUses: [], stopReason: 'end_turn' })
  expect(blank.end.delivered).toBeUndefined()
  const cut = run([{ type: 'text', text: 'ok' }, usage, { type: 'stop', reason: 'max_tokens' }], { handback: HANDBACK, deliver: true })
  expect(cut.end).toMatchObject({ toolUses: [], stopReason: 'max_tokens' })
  expect(cut.end.delivered).toBeUndefined()
  const failed = run([{ type: 'error', kind: 'request', text: FAILED }], { handback: HANDBACK, deliver: true })
  expect(failed.end).toMatchObject({ toolUses: [{ name: HANDBACK, input: { message: FAILED } }], stopReason: 'tool_use', failure: FAILED })
  expect(failed.end.delivered).toBeUndefined()
})
