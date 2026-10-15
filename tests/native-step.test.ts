// A native main step's klyth agent calls leave it as Agent calls (one spawn path with a routed main): the engine runs,
// draws and reports them as its own Agent calls, and the agent.spawn hook claims them on the note's target. A call
// the rewrite cannot make (a deny rule, an unapproved provider, a native model id Agent does not take, input that
// does not parse, no Agent tool) reaches the klyth agent tool as the model made it.
import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'
import { nativeMain } from '../hooks/native-step'
import type { NativeIo } from '../hooks/native-step'
import { WRAPPER } from '../hooks/routing'
import { createSession } from '../hooks/session'
import { CONFIG, CONFIG_OBJECT, start, step, world } from './world'

const TWO = JSON.stringify({ ...CONFIG_OBJECT, aliases: { ...CONFIG_OBJECT.aliases, quick: 'native/claude-haiku-4-5' } })
const loaded = (text = CONFIG) => {
  const s = createSession()
  s.loaded = { config: parseConfig(text).config, text, errors: [], missing: false, path: '~/.claude/klyth.json' }
  return s
}
// Claude Code 2.1.299's own verdict on the tool where no rule grants it, as a real-engine query returned it.
const UNGRANTED = { decision: 'ask' as const, reason: "Claude requested permissions to use mcp__klyth__agent, but you haven't granted it yet." }
type Io = NativeIo & { saved: Record<string, Record<string, string>>; checked: string[]; logs: string[] }
const ports = (o: { trusted?: boolean; decision?: string; reason?: string; rule?: string; tools?: string[] } = {}): Io => {
  const io: Io = {
    saved: {},
    checked: [],
    logs: [],
    trusted: async () => o.trusted ?? true,
    translated: async who => io.saved[who],
    setTranslated: async (who, map) => void (io.saved[who] = { ...map }),
    debug: text => void io.logs.push(text),
    list: async () => (o.tools ?? ['Read', 'Agent', WRAPPER]).map(name => ({ name })),
    check: async e => (io.checked.push(e.tool), { ...UNGRANTED, ...(o.decision === undefined ? {} : { decision: o.decision }), ...(o.reason === undefined ? {} : { reason: o.reason }), ...(o.rule === undefined ? {} : { rule: o.rule }) }),
  }
  return io
}
const ask = (input: Record<string, unknown> = {}) => ({ model: 'fast', prompt: 'list the files', description: 'List files', subagent_type: 'Explore', ...input })
// A native response: text, then each call as a tool chunk and its input in two pieces, then the stop.
const response = (...calls: { name: string; input: unknown; id?: string; raw?: string }[]): TurnStepChunk[] => [
  { kind: 'text', index: 0, text: 'On it.' },
  ...calls.flatMap((c, i) => {
    const json = c.raw ?? JSON.stringify(c.input)
    return [
      { kind: 'tool', index: i + 1, id: c.id ?? `toolu_${i}`, name: c.name },
      { kind: 'input', index: i + 1, json: json.slice(0, 7) },
      { kind: 'input', index: i + 1, json: json.slice(7) },
    ] as TurnStepChunk[]
  }),
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]
const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown
  } catch {
    return json
  }
}
const RESULT = (chunks: readonly TurnStepChunk[]): TurnStepResult => ({
  turnId: 't',
  index: 0,
  answer: 'On it.',
  toolUses: chunks.flatMap(c => (c.kind === 'tool' ? [{ name: c.name, input: parsed(chunks.filter(x => x.kind === 'input' && x.index === c.index).map(x => (x as { json: string }).json).join('')) }] : [])),
  stopReason: 'tool_use',
  usage: null,
})
async function run(io: NativeIo, s: ReturnType<typeof createSession>, chunks: TurnStepChunk[]) {
  async function* native() {
    yield* chunks
    return RESULT(chunks)
  }
  const out: TurnStepChunk[] = []
  const it = nativeMain(io, s, native)
  let n = await it.next()
  for (; !n.done; n = await it.next()) out.push(n.value)
  return { out, result: n.value }
}
const callOf = (out: readonly TurnStepChunk[], index: number) => ({
  name: (out.find(c => c.kind === 'tool' && c.index === index) as { name: string }).name,
  input: JSON.parse(out.filter(c => c.kind === 'input' && c.index === index).map(c => (c as { json: string }).json).join('')) as unknown,
})

test('a native main klyth agent call leaves the step as an Agent call with the same id, in the background, noted and remembered', async () => {
  const s = loaded()
  const io = ports()
  const { out, result } = await run(io, s, response({ name: 'Read', input: { file_path: '/w/a' } }, { name: WRAPPER, input: ask(), id: 'toolu_k' }))
  const agent = { description: 'List files', prompt: 'list the files', subagent_type: 'Explore', run_in_background: true }
  expect(out[0]).toEqual({ kind: 'text', index: 0, text: 'On it.' })
  expect(callOf(out, 1)).toEqual({ name: 'Read', input: { file_path: '/w/a' } })
  expect(callOf(out, 2)).toEqual({ name: 'Agent', input: agent })
  expect((out.find(c => c.kind === 'tool' && c.index === 2) as { id: string }).id).toBe('toolu_k')
  expect(out.filter(c => c.kind === 'input' && c.index === 2).map(c => (c as { json: string }).json)[1]).toBe('')
  expect(out.at(-1)).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: null })
  expect(result.toolUses).toEqual([{ name: 'Read', input: { file_path: '/w/a' } }, { name: 'Agent', input: agent }])
  // The spawn reads the note: the target, and the task Claude Code's check passed as an Agent call.
  expect(s.calls.get('toolu_k')).toEqual({ target: 'fast', vetted: 'list the files' })
  expect(io.saved['main']).toEqual({ toolu_k: 'fast' })
  expect(io.checked).toEqual([WRAPPER])
})

test('a native model, an explicit foreground, effort and isolation carry over as the routed path makes them', async () => {
  const s = loaded()
  const { out } = await run(ports(), s, response({ name: WRAPPER, input: ask({ model: 'sonnet', subagent_type: undefined }), id: 'toolu_n' }, { name: WRAPPER, input: ask({ run_in_background: false, effort: 'high', isolation: 'worktree' }), id: 'toolu_f' }))
  expect(callOf(out, 1)).toEqual({ name: 'Agent', input: { description: 'List files', prompt: 'list the files', run_in_background: true, model: 'sonnet' } })
  expect(callOf(out, 2)).toEqual({ name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'Explore', isolation: 'worktree', run_in_background: false, effort: 'high' } })
  expect(s.calls.get('toolu_n')).toEqual({ target: null, vetted: 'list the files' })
  expect(s.calls.get('toolu_f')).toEqual({ target: 'fast', effort: 'high', isolated: true, vetted: 'list the files' })
})

test('a call the rewrite cannot make reaches the klyth agent tool as the model made it, with nothing noted', async () => {
  const cases: [string, Io, ReturnType<typeof createSession>, Record<string, unknown> | string][] = [
    ['a deny rule on the tool', ports({ decision: 'deny' }), loaded(), ask()],
    ['an ask rule on the tool (an Agent allow rule must not stand in for it)', ports({ decision: 'ask', rule: 'mcp__klyth__agent' }), loaded(), ask()],
    ["a plugin hook's ask, which names no rule", ports({ decision: 'ask', reason: 'Policy: confirm external delegation' }), loaded(), ask()],
    ['an unapproved provider (the tool asks)', ports({ trusted: false }), loaded(), ask()],
    ['a native model id Agent does not take', ports(), loaded(TWO), ask({ model: 'quick' })],
    ['no Agent tool offered', ports({ tools: [WRAPPER] }), loaded(), ask()],
    ['input that does not parse', ports(), loaded(), '{"model": "fast", "prompt"'],
    ['a fork from a native main', ports(), loaded(), ask({ subagent_type: 'fork', model: undefined })],
  ]
  for (const [why, io, s, input] of cases) {
    const chunks = response(typeof input === 'string' ? { name: WRAPPER, input: null, raw: input, id: 'toolu_x' } : { name: WRAPPER, input, id: 'toolu_x' })
    const { out, result } = await run(io, s, chunks)
    expect(out, why).toEqual(chunks)
    expect(result, why).toEqual(RESULT(chunks))
    expect(s.calls.get('toolu_x'), why).toBeUndefined()
    expect(io.saved['main'], why).toBeUndefined()
  }
})

test('a step with no klyth agent call streams through as it came, and an allow or ask verdict both rewrite', async () => {
  const s = loaded()
  const plain = response({ name: 'Read', input: { file_path: '/w/a' } })
  const { out, result } = await run(ports(), s, plain)
  expect(out).toEqual(plain)
  expect(result).toEqual(RESULT(plain))
  for (const decision of ['allow', 'ask']) expect(callOf((await run(ports({ decision }), loaded(), response({ name: WRAPPER, input: ask() }))).out, 1).name).toBe('Agent')
})

test('turnStep sends a native main step through the rewrite', async ($, on) => {
  const chunks = response({ name: WRAPPER, input: ask(), id: 'toolu_w' })
  const w = world(on, { nativeStep: () => ({ chunks, result: RESULT(chunks) }) })
  on('tool.check', () => UNGRANTED)
  await start($)
  const main = await step($, { turnId: 't', index: 0 })
  expect(callOf(main.chunks, 1).name).toBe('Agent')
  expect(main.result.toolUses).toEqual([{ name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'Explore', run_in_background: true } }])
  expect(w.nativeSteps).toHaveLength(1)
})

test('a port that fails for one call leaves that call alone and keeps the calls before it rewritten and noted', async () => {
  const s = loaded()
  const io = ports()
  let checks = 0
  io.check = async () => (++checks === 2 ? Promise.reject(new Error('query unavailable')) : UNGRANTED)
  const { out } = await run(io, s, response({ name: WRAPPER, input: ask({ run_in_background: false }), id: 'toolu_a' }, { name: WRAPPER, input: ask({ prompt: 'second' }), id: 'toolu_b' }))
  expect([callOf(out, 1).name, callOf(out, 2)]).toEqual(['Agent', { name: WRAPPER, input: ask({ prompt: 'second' }) }])
  expect([s.calls.get('toolu_a')?.vetted, s.calls.get('toolu_b')]).toEqual(['list the files', undefined])
  expect(io.saved['main']).toEqual({ toolu_a: 'fast' })
  expect(io.logs).toEqual(["klyth: main's klyth agent call toolu_b was left as it was (Error: query unavailable); the tool answers it"])
})

test('a consumer that stops reading closes the native step beneath, which makes no second request', async () => {
  let closed = false
  let requests = 0
  async function* native(): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    requests++
    try {
      yield { kind: 'text', index: 0, text: 'On it.' }
      yield { kind: 'text', index: 0, text: ' More.' }
      return RESULT([])
    } finally {
      closed = true
    }
  }
  const it = nativeMain(ports(), loaded(), native)
  expect((await it.next()).value).toEqual({ kind: 'text', index: 0, text: 'On it.' })
  await it.return(undefined as never)
  expect([closed, requests]).toEqual([true, 1])
})
