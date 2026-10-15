// The engine transcript as every codec reads it: thinking dropped, other blocks named as text, orphan tool
// results dropped, every field but the content's own stripped, images downgraded without vision; and the
// provider's own tool-call ids, given back to that provider only and kept for the daemon's life.
import { expect, test } from 'bun:test'

import type { ApiMessage } from '../hooks/protocol'
import { normalize, remoteIds } from './history'
import type { Placed } from './history'
import { memoryStore, type ResponseStore } from './responses'

const none = () => undefined
// A turn's calls and blocks as the store records them: one handle, its call lines, then its block lines.
const seal = (store: ResponseStore, owner: string, calls: string[], blocks: readonly Placed[], handle = crypto.randomUUID()) =>
  store.record([...calls.map(local => ({ kind: 'call' as const, handle, loop: 't', owner, local })), ...blocks.map(p => ({ kind: 'block' as const, handle, owner, at: p.at, block: p.block }))])

test('thinking goes, other blocks are named, cache_control and unknown fields go, and orphan tool results are dropped', () => {
  const transcript: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'go', cache_control: { type: 'ephemeral' } }, { type: 'document', source: {} }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret', signature: 's' },
        { type: 'redacted_thinking', data: 'x' },
        { type: 'text', text: 'ok', citations: [] },
        { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} },
        { type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'x' }, cache_control: { type: 'ephemeral' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'mcp__a__b' }, { type: 'text', text: 'loaded' }] },
        { type: 'tool_result', tool_use_id: 'gone', content: 'orphan' },
        { type: 'web_search_tool_result', tool_use_id: 'srv', content: [] },
      ],
    },
  ]
  expect(normalize(transcript, true, none)).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'text', text: '[document omitted]' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'x' } }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[tool loaded: mcp__a__b]' }, { type: 'text', text: 'loaded' }], is_error: false },
        { type: 'text', text: '[web_search_tool_result block omitted]' },
      ],
    },
  ])
  expect(JSON.stringify(normalize(transcript, true, none))).not.toContain('secret')
})

test('images pass with vision and become a note without it, in messages and in tool results alike', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  const transcript: ApiMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [img], is_error: true }, img] },
  ]
  expect<unknown>(normalize(transcript, true, none)[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [img], is_error: true }, img] })
  const note = { type: 'text', text: '[image omitted: model has no vision]' }
  expect<unknown>(normalize(transcript, false, none)[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [note], is_error: true }, note] })
})

test("a minted id goes out as the provider's own only to the provider that made it, and later calls push none out; the map holds ids and nothing else", () => {
  const ids = remoteIds()
  expect(Object.keys(ids).sort()).toEqual(['of', 'remember'])
  ids.remember('kimi', 'toolu_klyth_a', 'functions.Read:0')
  const transcript: ApiMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_klyth_a', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_a', content: 'x' }] },
  ]
  const sentIds = (provider: string) => normalize(transcript, true, ids.of(provider)).map(m => m.content[0] as { id?: string; tool_use_id?: string }).map(b => b.id ?? b.tool_use_id)
  expect(sentIds('kimi')).toEqual(['functions.Read:0', 'functions.Read:0'])
  expect(sentIds('claude')).toEqual(['toolu_klyth_a', 'toolu_klyth_a'])
  for (let i = 0; i < 256; i++) ids.remember('kimi', `toolu_klyth_${i}`, `r${i}`)
  expect(ids.of('kimi')('toolu_klyth_a')).toBe('functions.Read:0')
  expect(ids.of('kimi')('toolu_klyth_255')).toBe('r255')
})

const think = (thinking: string, signature = 'sig'): Placed['block'] => ({ type: 'thinking', thinking, signature })
const placed = (...blocks: [number, Placed['block']][]): Placed[] => blocks.map(([at, block]) => ({ at, block }))
const turn = (...calls: string[]): ApiMessage[] => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }, ...calls.map(id => ({ type: 'tool_use', id, name: 'Read', input: {} }))] },
  { role: 'user', content: calls.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'x' })) },
]

test("the thinking blocks kept for a turn's calls come back in that turn, given only to the model that wrote them; a turn with calls and none kept is marked", () => {
  const store = memoryStore()
  const blocks = placed([0, think('hm')], [0, { type: 'redacted_thinking', data: 'red' }])
  seal(store, 'acme/m', ['toolu_klyth_a', 'toolu_klyth_b'], blocks)
  seal(store, 'acme/m', ['toolu_klyth_none'], [])
  const assistant = (calls: string[], owner: string) => normalize(turn(...calls), true, none, store.blocks(owner))[1]
  expect(assistant(['toolu_klyth_a', 'toolu_klyth_b'], 'acme/m')).toEqual({
    role: 'assistant',
    content: [...blocks.map(p => p.block), { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_klyth_a', name: 'Read', input: {} }, { type: 'tool_use', id: 'toolu_klyth_b', name: 'Read', input: {} }],
  })
  expect(assistant(['toolu_klyth_none'], 'acme/m')?.content.map(b => b.type)).toEqual(['text', 'tool_use'])
  expect(assistant(['toolu_klyth_none'], 'acme/m')?.unsealed).toBeUndefined()
  // Not kept (a restart), or kept for another model: marked, and nothing sent.
  expect(assistant(['toolu_klyth_lost'], 'acme/m')).toMatchObject({ unsealed: true, content: [{ type: 'text' }, { type: 'tool_use' }] })
  expect(assistant(['toolu_klyth_a'], 'acme/other')).toMatchObject({ unsealed: true, content: [{ type: 'text' }, { type: 'tool_use' }] })
  // A turn with no calls, and a transcript read with no thinking source, are never marked.
  expect(normalize([{ role: 'assistant', content: 'plain' }], true, none, store.blocks('acme/m'))).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'plain' }] }])
  expect(normalize(turn('toolu_klyth_lost'), true, none)[1]?.unsealed).toBeUndefined()
})

test('each thinking block goes back where it came in its turn: before the blocks it preceded, and last when it came after them all', () => {
  const store = memoryStore()
  const [t1, t2, t3] = [think('one'), think('two'), think('three')]
  seal(store, 'o', ['toolu_klyth_a', 'toolu_klyth_b'], placed([0, t1], [1, t2], [2, t3]))
  const content = normalize(turn('toolu_klyth_a', 'toolu_klyth_b'), true, none, store.blocks('o'))[1]?.content.map(b => (b.type === 'thinking' ? b.thinking : b.type === 'text' ? b.text : b.type === 'tool_use' ? b.id : b.type))
  // The turn holds a text block and two calls: [T1, ok, T2, a, T3, b].
  expect(content).toEqual(['one', 'ok', 'two', 'toolu_klyth_a', 'three', 'toolu_klyth_b'])
  // A place past the end (the turn came back with fewer blocks than it had) puts the block last.
  seal(store, 'o', ['toolu_klyth_c'], placed([0, t1], [9, t2]))
  expect(normalize(turn('toolu_klyth_c'), true, none, store.blocks('o'))[1]?.content.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use', 'thinking'])
})
