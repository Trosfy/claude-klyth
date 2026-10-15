// The history a routed fork is sent (hooks/fork.ts). Claude Code saves a fork of main as its own messages alone, so
// klyth rebuilds main's history up to the turn whose Agent call started the fork and joins the fork's own turns on:
// the cut, the joining turn's tool results, alternation, a read with or without the copied turn, a missing or extra
// turn, a reload (routes read from state), and every case it cannot rebuild, which fails closed.
import { expect, test } from 'claude-code/testing'

import type { Route } from '../types'
import { alternate, forkHistory, seam, wellFormed } from '../hooks/fork'
import type { ApiMessage } from '../hooks/protocol'
import { createSession } from '../hooks/session'

const EXTRA = ['REPORT']
const u = (...content: Record<string, unknown>[]): ApiMessage => ({ role: 'user', content: content as unknown as ApiMessage['content'] })
const a = (...content: Record<string, unknown>[]): ApiMessage => ({ role: 'assistant', content: content as unknown as ApiMessage['content'] })
const text = (t: string) => ({ type: 'text', text: t })
const use = (id: string, name = 'Agent') => ({ type: 'tool_use', id, name, input: {} })
const result = (id: string, content = 'ok') => ({ type: 'tool_result', tool_use_id: id, content })
const STARTED = 'The fork started and runs in the background.'

// Main's read: two turns, then the turn whose Agent call (fork-call) started the fork beside a Read, then main going on.
const MAIN: ApiMessage[] = [
  u(text('read the config')),
  a(text('reading'), use('r0', 'Read')),
  u(result('r0', 'config text')),
  a(text('forking'), use('fork-call'), use('r1', 'Read')),
  u(result('fork-call', 'agent started'), result('r1', 'file text')),
  a(text('main goes on')),
  u(text('next prompt')),
]
const CUT = MAIN.slice(0, 4)
// Main's read while the turn that started the fork is still open: the calls beside the fork's have no results yet.
const MAIN_OPEN = MAIN.slice(0, 4)
const UNANSWERED = 'This call was made by the conversation that started the fork; its result is not available to the fork.'
const FORK: Route = { target: 'fast', label: 'fast', type: 'fork', prompt: 'Find the code word.', forkOf: 'fork-call' }

type Reads = Record<string, readonly ApiMessage[] | Error>
function port(reads: Reads, o: { routes?: Record<string, Route> } = {}) {
  const s = createSession()
  const io = {
    transcript: async (agentId: string | undefined) => {
      const read = reads[agentId ?? 'main']
      if (read instanceof Error) throw read
      return read ?? { deny: 'no such agent' }
    },
    route: async (id: string) => o.routes?.[id],
  }
  return { s, io, history: (who: string, route: Route) => forkHistory(io, s, who, route, reads[who] as readonly ApiMessage[], EXTRA) }
}

test("a fork of main whose read holds only its task gets main's history up to the turn that started it, then one user turn that answers each call of that turn", async () => {
  const { history } = port({ main: MAIN, f1: [u(text('Find the code word.'))] })
  const sent = await history('f1', FORK)
  expect(sent).toEqual([...CUT, u(result('fork-call', STARTED), result('r1', 'file text'), text('Find the code word.'), text('REPORT'))])
  expect(wellFormed(sent ?? [])).toBe(true)
})

test("a fork of main whose read holds a copy of the turn that started it and its own results keeps the results and drops what came before the copy", async () => {
  const own = [u(text('context reminder')), a(text('forking'), use('fork-call'), use('r1', 'Read')), u(result('fork-call', 'Fork started'), text('Find the code word.'))]
  const { history } = port({ main: MAIN, f1: own })
  expect(await history('f1', FORK)).toEqual([...CUT, u(result('fork-call', 'Fork started'), result('r1', 'file text'), text('Find the code word.'), text('REPORT'))])
})

test("a fork of main further on: its own calls and results follow the joining turn, and the request alternates and pairs every call", async () => {
  const own = [u(text('Find the code word.')), a(use('g1', 'Grep')), u(result('g1', 'hits')), a(text('looking')), u(text('a reminder'))]
  const { history } = port({ main: MAIN, f1: own })
  const sent = (await history('f1', FORK)) ?? []
  expect(sent.slice(0, 4)).toEqual(CUT)
  expect(sent.slice(5)).toEqual(own.slice(1))
  expect(wellFormed(sent)).toBe(true)
})

test('a missing joining turn is made, an extra one is merged, and a result for a call the cut turn does not hold is dropped', async () => {
  const opensOnAssistant = port({ main: MAIN, f1: [a(text('thinking'))] })
  expect(await opensOnAssistant.history('f1', FORK)).toEqual([...CUT, u(result('fork-call', STARTED), result('r1', 'file text'), text('Find the code word.'), text('REPORT')), a(text('thinking'))])
  const empty = port({ main: MAIN, f1: [] })
  expect((await empty.history('f1', FORK))?.at(-1)).toEqual(u(result('fork-call', STARTED), result('r1', 'file text'), text('Find the code word.'), text('REPORT')))
  const doubled = port({ main: MAIN, f1: [u(result('stray'), text('Find the code word.')), u(text('and more'))] })
  const sent = (await doubled.history('f1', FORK)) ?? []
  expect(sent.slice(4)).toEqual([u(result('fork-call', STARTED), result('r1', 'file text'), text('Find the code word.'), text('REPORT'), text('and more'))])
  expect(wellFormed(sent)).toBe(true)
})

test("main's klyth agent calls and the fork's own stay as the engine read them, whatever the translated calls hold", async () => {
  const own = [u(text('Find the code word.')), a(use('g1')), u(result('g1'))]
  const { history, s } = port({ main: MAIN, f1: own })
  s.translated.set('main', { 'fork-call': 'fast' })
  s.translated.set('f1', { g1: 'strong' })
  const sent = (await history('f1', FORK)) ?? []
  expect(sent.slice(0, 4)).toEqual(CUT)
  expect(sent[5]).toEqual(a(use('g1')))
  expect(wellFormed(sent)).toBe(true)
})

test('a fork of a subagent that is no fork is sent its read as it is, when that holds the turn that started it; else it is joined to the subagent\'s read', async () => {
  const sub = { par: { target: 'fast', label: 'fast', type: 'Explore' } as Route }
  const own = [...MAIN.slice(0, 4), u(result('fork-call'), result('r1'), text('Find the code word.'))]
  const whole = port({ par: MAIN, f1: own }, { routes: sub })
  expect(await whole.history('f1', { ...FORK, parent: 'par' })).toEqual([...own.slice(0, 4), u(result('fork-call'), result('r1'), text('Find the code word.'), text('REPORT'))])
  const bare = port({ par: MAIN, f1: [u(text('Find the code word.'))] }, { routes: sub })
  expect((await bare.history('f1', { ...FORK, parent: 'par' }))?.slice(0, 4)).toEqual(CUT)
})

test("a fork of a subagent that is no fork keeps the subagent's klyth agent calls as read, and a parent read opening on an assistant turn gets the parent's task", async () => {
  const sub = { par: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'Audit' } as Route }
  const parentRead = MAIN.slice(1, 5)
  const own = [u(text('Find the code word.'))]
  const { history, s } = port({ par: parentRead, f1: own }, { routes: sub })
  s.translated.set('par', { 'fork-call': 'fast' })
  const sent = (await history('f1', { ...FORK, parent: 'par' })) ?? []
  expect(sent[0]).toEqual(u(text('Audit')))
  expect(sent[3]).toEqual(MAIN[3])
  expect(wellFormed(sent)).toBe(true)
  const whole = port({ par: MAIN, f1: [...MAIN.slice(0, 4), u(result('fork-call'), result('r1'))] }, { routes: sub })
  whole.s.translated.set('par', { 'fork-call': 'fast' })
  expect(((await whole.history('f1', { ...FORK, parent: 'par' })) ?? [])[3]).toEqual(MAIN[3])
})

test("a fork's joining turn answers a call beside the fork's from the parent's next turn, else says it is not available; the answer is frozen at the first step", async () => {
  const open = port({ main: MAIN_OPEN, f1: [u(text('Find the code word.'))] })
  expect(await open.history('f1', FORK)).toEqual([...CUT, u(result('fork-call', STARTED), result('r1', UNANSWERED), text('Find the code word.'), text('REPORT'))])
  const reads: Reads = { main: MAIN_OPEN, f1: [u(text('Find the code word.'))] }
  const { history, s } = port(reads)
  const first = await history('f1', FORK)
  reads['main'] = MAIN
  expect(await history('f1', FORK)).toEqual(first)
  expect(s.forkPrefixes.get('f1')?.messages).toEqual(MAIN_OPEN)
})

test("a fork's inherited prefix is kept from its first step: a later compaction of main does not stop it; an unrebuilt or forgotten fork keeps none", async () => {
  const own = [u(text('Find the code word.'))]
  const reads: Reads = { main: MAIN, f1: own }
  const { history, s } = port(reads)
  const first = (await history('f1', FORK)) ?? []
  expect(s.forkPrefixes.get('f1')?.cut).toBe(3)
  reads['main'] = MAIN.slice(5)
  reads['f1'] = [...own, a(use('g1', 'Grep')), u(result('g1', 'hits'))]
  const second = (await history('f1', FORK)) ?? []
  expect(second.slice(0, 4)).toEqual(CUT)
  expect(second.slice(0, first.length)).toEqual(first)
  expect(second.slice(first.length)).toEqual([a(use('g1', 'Grep')), u(result('g1', 'hits'))])
  expect(wellFormed(second)).toBe(true)
  const failed = port({ main: MAIN.slice(5), f1: own })
  expect(await failed.history('f1', FORK)).toBeUndefined()
  expect(failed.s.forkPrefixes.has('f1')).toBe(false)
  s.forget('f1')
  expect(await history('f1', FORK)).toBeUndefined()
})

test("a fork of a fork keeps its prefix too: with main compacted after both are rebuilt, the child's next step has the same first four messages", async () => {
  const parentOwn = [u(text('Find the code word.')), a(text('found it'), use('fork-2'))]
  const reads: Reads = { main: MAIN, f1: parentOwn, f2: [u(text('Check it.'))] }
  const { history, s } = port(reads, { routes: { f1: FORK } })
  const child = { ...FORK, prompt: 'Check it.', parent: 'f1', forkOf: 'fork-2' }
  expect(await history('f1', FORK)).toBeDefined()
  expect(await history('f2', child)).toBeDefined()
  reads['main'] = MAIN.slice(5)
  reads['f2'] = [u(text('Check it.')), a(text('checking'))]
  const next = (await history('f2', child)) ?? []
  expect(next.slice(0, 4)).toEqual(CUT)
  expect(wellFormed(next)).toBe(true)
  expect(s.forkPrefixes.has('f2')).toBe(true)
})

test("a fork of a fork stores only its own prefix: rebuilding it after the parent fork was forgotten leaves the parent with none", async () => {
  const reads: Reads = { main: MAIN, f1: [u(text('Find the code word.')), a(text('found it'), use('fork-2'))], f2: [u(text('Check it.'))] }
  const { history, s } = port(reads, { routes: { f1: FORK } })
  expect(await history('f1', FORK)).toBeDefined()
  s.forget('f1')
  expect(await history('f2', { ...FORK, prompt: 'Check it.', parent: 'f1', forkOf: 'fork-2' })).toBeDefined()
  expect(s.forkPrefixes.has('f2')).toBe(true)
  expect(s.forkPrefixes.has('f1')).toBe(false)
})

test("a fork of a fork of main gets main's history, the parent fork's turns, then its own", async () => {
  const parentOwn = [u(text('Find the code word.')), a(text('found it'), use('fork-2'))]
  const childOwn = [u(text('Check it.'))]
  const routes = { f1: FORK }
  const { history } = port({ main: MAIN, f1: parentOwn, f2: childOwn }, { routes })
  const sent = (await history('f2', { ...FORK, prompt: 'Check it.', parent: 'f1', forkOf: 'fork-2' })) ?? []
  expect(sent.slice(0, 4)).toEqual(CUT)
  expect(sent.slice(4)).toEqual([
    u(result('fork-call', STARTED), result('r1', 'file text'), text('Find the code word.'), text('REPORT')),
    a(text('found it'), use('fork-2')),
    u(result('fork-2', STARTED), text('Check it.'), text('REPORT')),
  ])
  expect(wellFormed(sent)).toBe(true)
})

for (const [why, reads, route, routes] of [
  ['no call recorded for the fork (a route from before forks were joined)', { main: MAIN, f1: [u(text('t'))] }, { ...FORK, forkOf: undefined }, {}],
  ["main's read no longer holds the call (it was compacted)", { main: MAIN.slice(5), f1: [u(text('t'))] }, FORK, {}],
  ["main's read fails", { main: new Error('down'), f1: [u(text('t'))] }, FORK, {}],
  ["the parent subagent's route is gone", { par: MAIN, f1: [u(text('t'))] }, { ...FORK, parent: 'par' }, {}],
  ["the parent subagent's read is refused", { f1: [u(text('t'))] }, { ...FORK, parent: 'par' }, { par: { target: 'fast', label: 'fast', type: 'Explore' } }],
  ["main's history before the cut does not pair its calls", { main: [u(text('a')), a(use('x', 'Read')), u(text('no result')), ...MAIN.slice(3)], f1: [u(text('t'))] }, FORK, {}],
] as const) {
  test(`a fork whose history cannot be rebuilt whole is not sent: ${why}`, async () => {
    const { history } = port(reads as unknown as Reads, { routes: routes as Record<string, Route> })
    expect(await history('f1', route as Route)).toBeUndefined()
  })
}

test('alternate joins runs of one role, tool results first; wellFormed holds a request to the pairing the Messages API takes', () => {
  expect(alternate([u(text('a')), u(result('x'), text('b'))])).toEqual([u(result('x'), text('a'), text('b'))])
  expect(alternate(MAIN)).toBe(MAIN)
  expect(wellFormed(MAIN)).toBe(true)
  expect(wellFormed(MAIN.slice(1))).toBe(false)
  expect(wellFormed([u(result('x'))])).toBe(false)
  expect(wellFormed([u(text('a')), a(use('x')), u(text('b'))])).toBe(false)
  expect(wellFormed([u(text('a')), a(use('x')), u(result('x'), result('y'))])).toBe(false)
  expect(seam(a(use('x')), undefined, [], undefined, [], 'x')).toEqual([u(result('x', STARTED))])
})
