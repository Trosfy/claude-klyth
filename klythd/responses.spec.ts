// The response records behind restored provider ids and thinking: the file store's write and read protocol (own
// lines read once, a peer's appends, torn and wrong-shaped lines, open and write failures, retention), the anchor and
// projection over the host's own rows, what each request purpose records, and the memory store a step without a scope uses.
import { afterAll, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fingerprint, parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import type { ApiMessage, SessionScope, StepEvent, StepRequest } from '../hooks/protocol'
import { CODECS } from './codecs'
import { toInput } from './codecs/openai-responses'
import { normalize, remoteIds } from './history'
import { invalidSessionScope, lookup, memoryStore, projection, providerKey, replied, type Rec, type ResponseStore } from './responses'
import { responseStores } from './responses-file'
import { assembler, createStepper } from './step'
import type { Env, UpstreamRequest } from './step'

const MODEL = { contextWindow: 100_000, maxOutputTokens: 8000 }
const THINKS = { ...MODEL, params: { thinking: { type: 'enabled', budget_tokens: 2048 } } }
const PROVIDERS = {
  p: { kind: 'openai-responses', baseUrl: 'https://p.invalid/v1', auth: 'none', sessionHeader: 'session_id', models: { m: MODEL, n: MODEL } },
  cl: { kind: 'anthropic', baseUrl: 'https://cl.invalid', auth: 'none', models: { m: THINKS, n: THINKS } },
  oa: { kind: 'openai', baseUrl: 'https://oa.invalid/v1', auth: 'none', models: { m: MODEL } },
}
const P = { id: 'p', kind: 'openai-responses', baseUrl: 'https://p.invalid/v1' } as const
const configOf = (providers: Record<string, unknown> = PROVIDERS) => {
  const text = JSON.stringify({ providers })
  return { text, approved: Object.values((parseConfig(text).config as Config).providers).map(fingerprint) }
}
const USER: ApiMessage = { role: 'user', content: 'task' }
const STEP = { purpose: 'step', owner: 'main' } as const
const said = (text: string) => ({ type: 'response.output_text.delta', delta: text })
const reasoning = (id: string) => ({ type: 'response.output_item.done', item: { type: 'reasoning', id, encrypted_content: `sealed-${id}` } })
const call = (id: string, args = '{}') => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name: 'Read', arguments: args } })
const DONE = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } }
const sse = (...events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
// A Chat Completions call the `openai` decoder holds until the stream's end, which has no finish reason: it comes from decoder.end().
const HELD = `${sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] } }] })}data: [DONE]\n\n`
const anthropic = (stop: string, ...blocks: unknown[][]) => sse({ type: 'message_start', message: { usage: { input_tokens: 10 } } }, ...blocks.flat(), { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 2 } })
const thinkingAt = (index: number, signature: string) => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index },
]
const textAt = (index: number, text: string) => [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index }]
const toolAt = (index: number, id: string) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'Read', input: {} } }, { type: 'content_block_stop', index }]
const afterCall = (ids: readonly string[], before: readonly ApiMessage[] = [USER]): ApiMessage[] => [
  ...before,
  { role: 'assistant', content: ids.map(id => ({ type: 'tool_use', id, name: 'Read', input: {} })) },
  { role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'x' })) },
]
const minted = (evs: readonly StepEvent[]) => evs.flatMap(e => (e.type === 'tool_use' ? [e.id] : []))
const errorOf = (evs: readonly StepEvent[]) => evs.flatMap(e => (e.type === 'error' ? [e.text] : []))
const kinds = (items: readonly Record<string, unknown>[]) => items.map(i => i['type'] ?? i['role'])
const callRec = (handle: string, owner: string, local: string, remote?: string): Rec => ({ kind: 'call', handle, loop: 'main', owner, local, ...(remote === undefined ? {} : { remote }) })
const blockRec = (handle: string, owner: string, id: string, encrypted = 'opaque'): Rec => ({ kind: 'block', handle, owner, at: 0, block: { type: 'reasoning', id, encrypted_content: encrypted } })
const request = (transcript: readonly ApiMessage[]): StepRequest => ({ target: 'p/m', system: 'S', tools: [], transcript, who: 'main' })

const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))
const scope = (id = 'session-1'): SessionScope => {
  dirs.push(realpathSync(mkdtempSync(join(tmpdir(), 'klyth-responses-'))))
  return { configDir: dirs.at(-1)!, id }
}
const dirOf = (s: SessionScope) => join(s.configDir, 'klyth', 'responses')
const fileOf = (s: SessionScope) => join(dirOf(s), `${s.id}.jsonl`)
const records = (s: SessionScope) => readFileSync(fileOf(s), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
const seed = (s: SessionScope, lines: readonly (Rec | Record<string, unknown> | string)[], tail = '\n') => {
  mkdirSync(dirOf(s), { recursive: true, mode: 0o700 })
  writeFileSync(fileOf(s), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + tail, { mode: 0o600 })
}

// A daemon whose provider answers `replies` in turn (the last one again after), each one body or its pieces, with
// `between` run before each later piece and `each` as each event is taken; its requests, debug lines and cancels are recorded.
function daemon(replies: (string | string[])[], opts: { stores?: Env['responses']; trace?: true; config?: ReturnType<typeof configOf>; between?: () => void; each?: (e: StepEvent) => void } = {}) {
  const h = { posts: [] as UpstreamRequest[], logs: [] as string[], cancelled: 0 }
  const config = opts.config ?? configOf()
  const s = createStepper({ version: '0.2.0',
    post: async r => {
      const reply = replies[Math.min(h.posts.length, replies.length - 1)]!
      h.posts.push(r)
      return { status: 200, cancel: () => void h.cancelled++, body: (async function* () { for (const [i, piece] of [reply].flat().entries()) { if (i > 0) opts.between?.(); yield new TextEncoder().encode(piece) } return undefined })() }
    },
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), now: () => 0, sleep: async () => {}, log: line => void h.logs.push(line),
    ...(opts.stores === undefined ? {} : { responses: opts.stores }), ...(opts.trace === undefined ? {} : { trace: opts.trace }),
  })
  const step = async (req: Partial<StepRequest> = {}, session?: unknown) => {
    const out: StepEvent[] = []
    for await (const e of s.step({ token: 't', configText: config.text, approved: config.approved, ...(session === undefined ? {} : { session: session as SessionScope }), req: { ...request([USER]), accounting: STEP, ...req } }, new AbortController().signal)) (opts.each?.(e), out.push(e))
    return out
  }
  const body = () => JSON.parse(h.posts.at(-1)!.body) as Record<string, unknown> & { input: Record<string, unknown>[]; messages: { content: Record<string, unknown>[] }[] }
  return { h, step, body }
}
const files = () => responseStores(() => {})
const encoded = async (store: ResponseStore, transcript: readonly ApiMessage[]) => {
  const l = await lookup(store, request(transcript), P, 'm', () => {}, new Set())
  return JSON.stringify(toInput({ system: '', tools: [], messages: normalize(transcript, true, l.remote, l.sealed, l.message) }))
}

test("a turn's provider id and reasoning go out the same after 1,024 sibling calls holding 16 MiB of blocks, from memory and from a file closed and reopened", async () => {
  const owner = `${await providerKey(P)}/m`, other = `${await providerKey(P)}/n`, transcript = afterCall(['toolu_klyth_original']), at = scope(), big = 'o'.repeat(256 * 1024)
  const siblings = Array.from({ length: 1024 }, (_, i) => [callRec(`s${i}`, other, `toolu_klyth_s${i}`, `r${i}`), blockRec(`s${i}`, other, `rs${i}`, 'x'.repeat(16 * 1024))]).flat()
  for (const open of [memoryStore, () => files()(at)]) {
    const store = open()
    store.record([callRec('h', owner, 'toolu_klyth_original', 'call_original'), blockRec('h', owner, 'rs_original', big)])
    const before = await encoded(store, transcript)
    expect(before).toContain('"call_id":"call_original"')
    expect(before).toContain(`"id":"rs_original","encrypted_content":"${big}"`)
    store.record(siblings)
    expect(await encoded(store, transcript)).toBe(before)
    if (store.kind === 'file') {
      store.close()
      expect(await encoded(files()(at), transcript)).toBe(before)
    }
  }
})

test("a stepper's own records come back exactly once on its next step, and a new daemon on the file restores them and the loop's affinity", async () => {
  const at = scope(), loop = { sessionId: 'seed-1', cacheLoop: 'main' }
  const first = daemon([sse(reasoning('r1'), call('call_1'), DONE), sse(said('ok'), DONE)], { stores: files() })
  const ids = minted(await first.step(loop, at))
  await first.step({ ...loop, transcript: afterCall(ids) }, at)
  expect(first.body().input.filter(i => i['type'] === 'reasoning')).toEqual([{ type: 'reasoning', id: 'r1', encrypted_content: 'sealed-r1', summary: [] }])
  expect(first.body().input.flatMap(i => (i['type'] === 'function_call' ? [i['call_id']] : []))).toEqual(['call_1'])
  expect(first.h.logs.at(-1)).toContain(' store=file restored=1/1 ')
  const second = daemon([sse(said('ok'), DONE)], { stores: files() })
  await second.step({ sessionId: 'seed-2', cacheLoop: 'main', transcript: afterCall(ids) }, at)
  expect(second.h.posts[0]!.body).toBe(first.h.posts[1]!.body)
  expect(second.h.posts[0]!.headers['session_id']).toBe('seed-1')
  expect(readFileSync(fileOf(at), 'utf8').split('\n').filter(l => l.includes('"kind":"block"')).every(l => l.startsWith('{"kind":"block","handle":"'))).toBe(true)
})

test('a klyth agent call the host shows as an Agent call goes out as the provider made it, for a classifier and a compaction request too, after a new daemon opens the file, to another provider, and the same when the host left it as made', async () => {
  const at = scope(), input = { description: 'look around', prompt: 'find retry logic', model: 'p/n' }
  const wrapper = { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_a', name: 'mcp__klyth__agent', arguments: JSON.stringify(input) } }
  const first = daemon([sse(call('call_r'), wrapper, DONE), sse(said('ok'), DONE)], { stores: files() })
  const [read, agent] = minted(await first.step({}, at)) as [string, string]
  expect(records(at).filter(r => r['kind'] === 'call').map(r => r['agent'])).toEqual([undefined, input])
  const turn = (name: string, use: Record<string, unknown>): ApiMessage[] => [USER, { role: 'assistant', content: [{ type: 'tool_use', id: read, name: 'Read', input: {} }, { type: 'tool_use', id: agent, name, input: use }] }, { role: 'user', content: [read, agent].map(id => ({ type: 'tool_result', tool_use_id: id, content: 'x' })) }]
  await first.step({ transcript: turn('Agent', { description: 'look around', prompt: 'find retry logic', run_in_background: false }) }, at)
  const sent = first.h.posts[1]!.body
  expect(first.body().input.filter(i => i['type'] === 'function_call').map(i => [i['call_id'], i['name'], i['arguments']])).toEqual([['call_r', 'Read', '{}'], ['call_a', 'mcp__klyth__agent', JSON.stringify(input)]])
  await first.step({ transcript: turn('mcp__klyth__agent', input) }, at)
  expect(first.h.posts[2]!.body).toBe(sent)
  for (const purpose of ['classifier', 'compaction'] as const) {
    await first.step({ accounting: { purpose, owner: 'main' }, transcript: turn('Agent', { description: 'look around', prompt: 'find retry logic', run_in_background: false }) }, at)
    expect(first.h.posts.at(-1)!.body).toBe(sent)
  }
  const second = daemon([sse(said('ok'), DONE)], { stores: files() })
  await second.step({ transcript: turn('Agent', { description: 'look around', prompt: 'find retry logic', run_in_background: false }) }, at)
  expect(second.h.posts[0]!.body).toBe(sent)
  await second.step({ target: 'oa/m', transcript: turn('Agent', {}) }, at)
  expect(second.h.posts[1]!.body).toContain(`"id":"${agent}","type":"function","function":{"name":"mcp__klyth__agent","arguments":${JSON.stringify(JSON.stringify(input))}}`)
})

test("a peer daemon's lines appended between two batches of one turn leave that turn whole when it is referenced, even after a reference mid-turn", async () => {
  const at = scope(), peer = files()(at), reader = files()(at), owner = `${await providerKey(P)}/m`
  let midTurn: readonly unknown[] | undefined
  const between = () => {
    peer.record([{ kind: 'affinity', loop: 'peer', provider: 'p~0', id: 'peer-seed' }, callRec('peer', 'p~0/m', 'toolu_klyth_peer', 'peer_remote')])
    reader.refresh()
    midTurn = reader.blocks(owner)(String(records(at).find(r => r['kind'] === 'call')!['local']))
  }
  const a = daemon([[sse(reasoning('r1'), call('call_1')), sse(reasoning('r2'), call('call_2'), DONE)]], { stores: files(), between })
  const ids = minted(await a.step({}, at))
  reader.refresh()
  expect([midTurn?.length, reader.blocks(owner)(ids[0]!)?.length]).toEqual([1, 2])
  expect(records(at).map(r => r['kind'])).toEqual(['call', 'block', 'affinity', 'call', 'call', 'block'])
  const b = daemon([sse(said('ok'), DONE)], { stores: files() })
  await b.step({ transcript: afterCall(ids) }, at)
  expect(kinds(b.body().input)).toEqual(['user', 'reasoning', 'function_call', 'reasoning', 'function_call', 'function_call_output', 'function_call_output'])
  expect(b.body().input.flatMap(i => (i['type'] === 'function_call' ? [i['call_id']] : []))).toEqual(['call_1', 'call_2'])
  expect([reader.remote('p~0')('toolu_klyth_peer'), reader.affinity('peer', 'p~0', 'other')]).toEqual(['peer_remote', 'peer-seed'])
})

test("text-only reasoning is found by its anchor after the file is reopened, an identical earlier reply keeps its own, and a fork of the prefix gets the parent's", async () => {
  const at = scope(), once: ApiMessage[] = [USER, { role: 'assistant', content: 'same' }, { role: 'user', content: 'again' }]
  const parent = daemon([sse(reasoning('r1'), said('same'), DONE), sse(reasoning('r2'), said('same'), DONE)], { stores: files() })
  await parent.step({}, at)
  await parent.step({ transcript: once }, at)
  expect(parent.body().input.filter(i => i['type'] === 'reasoning').map(i => i['id'])).toEqual(['r1'])
  const later = daemon([sse(said('ok'), DONE)], { stores: files() })
  await later.step({ transcript: [...once, { role: 'assistant', content: 'same' }, { role: 'user', content: 'more' }] }, at)
  expect(kinds(later.body().input)).toEqual(['user', 'reasoning', 'assistant', 'user', 'reasoning', 'assistant', 'user'])
  expect(later.body().input.filter(i => i['type'] === 'reasoning').map(i => i['id'])).toEqual(['r1', 'r2'])
  await later.step({ who: 'agent-fork', cacheLoop: 'agent-fork', transcript: once }, at)
  expect(later.body().input.filter(i => i['type'] === 'reasoning').map(i => i['id'])).toEqual(['r1'])
})

test('of two text-only turns a file records under one anchor and projection, the one recorded last is found', async () => {
  const owner = `${await providerKey(P)}/m`, transcript: ApiMessage[] = [USER, { role: 'assistant', content: 'same' }, { role: 'user', content: 'again' }], store = files()(scope())
  const key = { loop: 'main', owner, anchor: (await lookup(memoryStore(), request([USER]), P, 'm', () => {}, new Set())).anchor!, projection: await projection(transcript[1]!) }
  store.record([blockRec('first', owner, 'r_first'), { kind: 'response', handle: 'first', ...key }, blockRec('last', owner, 'r_last'), { kind: 'response', handle: 'last', ...key }])
  expect(JSON.parse(await encoded(store, transcript)).filter((i: Record<string, unknown>) => i['type'] === 'reasoning').map((i: Record<string, unknown>) => i['id'])).toEqual(['r_last'])
})

test('a tool turn without thinking stays sealed for its own model; another model, or the same provider id at another baseUrl, gets it unsealed, and the latter no provider id', async () => {
  const at = scope(), noThinking = anthropic('tool_use', toolAt(0, 'toolu_remote')), done = anthropic('end_turn', textAt(0, 'done'))
  const d = daemon([noThinking, done], { stores: files() })
  const ids = minted(await d.step({ target: 'cl/m' }, at))
  await d.step({ target: 'cl/m', transcript: afterCall(ids) }, at)
  expect(d.body()['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(d.body().messages[1]!.content).toEqual([{ type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} }])
  await d.step({ target: 'cl/n', transcript: afterCall(ids) }, at)
  expect('thinking' in d.body()).toBe(false)
  expect(d.body().messages[1]!.content[0]!['id']).toBe('toolu_remote')
  const moved = daemon([done], { stores: files(), config: configOf({ ...PROVIDERS, cl: { ...PROVIDERS.cl, baseUrl: 'https://elsewhere.invalid' } }) })
  await moved.step({ target: 'cl/m', transcript: afterCall(ids) }, at)
  expect('thinking' in moved.body()).toBe(false)
  expect(moved.body().messages[1]!.content[0]!['id']).toBe(ids[0])
})

test("two daemons on one file both record, and each one's next step reads the other's lines", async () => {
  const at = scope(), a = daemon([sse(call('call_a'), DONE), sse(said('ok'), DONE)], { stores: files() }), b = daemon([sse(call('call_b'), DONE), sse(said('ok'), DONE)], { stores: files() })
  const [ia] = minted(await a.step({}, at)), [ib] = minted(await b.step({ who: 'agent-b', cacheLoop: 'agent-b' }, at))
  await a.step({ transcript: afterCall([ib!]) }, at)
  await b.step({ who: 'agent-b', cacheLoop: 'agent-b', transcript: afterCall([ia!]) }, at)
  expect([a.body().input[1]!['call_id'], b.body().input[1]!['call_id']]).toEqual(['call_b', 'call_a'])
})

test('a records write that throws or comes up short on the first call line, in a batch or in the tail a held call ends, ends the step with one request error and no tool_use or stop, the reply cancelled', async () => {
  const faults: [(fd: number, b: Buffer) => number, string][] = [[() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }, 'ENOSPC'], [(_fd, b) => b.length - 1, 'EIO']]
  for (const [fault, code] of faults) for (const [target, reply] of [['p/m', sse(reasoning('r1'), call('call_1'), DONE)], ['oa/m', HELD]]) {
    const at = scope(), d = daemon([reply!], { stores: files() })
    const write = spyOn(fs, 'writeSync').mockImplementation(fault as typeof fs.writeSync)
    let out: StepEvent[]
    try { out = await d.step({ target }, at) } finally { write.mockRestore() }
    expect(minted(out)).toEqual([])
    expect(out.filter(e => e.type === 'stop')).toEqual([])
    expect(errorOf(out)).toEqual([`klyth: responses store unavailable (${code}): free space under ${at.configDir}/klyth/responses or trash that session's file, then retry`])
    expect(out.find(e => e.type === 'error')).toMatchObject({ kind: 'request' })
    expect(d.h.cancelled).toBe(1)
  }
})

test("a turn's lines are on disk when the host sees them: a call before its tool_use, the tail a held call ends included (a held klyth agent call with its input), and finish-time lines before the stop", async () => {
  for (const [target, reply, seen] of [['oa/m', HELD, ['tool_use: call', 'stop: call']], ['p/m', sse(reasoning('r1'), said('done'), DONE), ['stop: block response']]] as const) {
    const at = scope(), taken: string[] = []
    const d = daemon([reply], { stores: files(), each: e => void ((e.type === 'tool_use' || e.type === 'stop') && taken.push(`${e.type}: ${records(at).map(r => r['kind']).join(' ')}`)) })
    await d.step({ target }, at)
    expect(taken).toEqual([...seen])
  }
  const at = scope(), held = `${sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_h', type: 'function', function: { name: 'mcp__klyth__agent', arguments: '{"model":"p/n","prompt":"x"}' } }] } }] })}data: [DONE]\n\n`
  await daemon([held], { stores: files() }).step({ target: 'oa/m' }, at)
  expect(records(at).filter(r => r['kind'] === 'call').map(r => r['agent'])).toEqual([{ model: 'p/n', prompt: 'x' }])
})

test('the store is private, its directory 0700 and file 0600, and a session file that is a symlink or not 0600 is refused', async () => {
  const at = scope(), linked = scope(), d = daemon([sse(said('ok'), DONE)], { stores: files() })
  files()(at)
  expect([statSync(dirOf(at)).mode & 0o777, statSync(fileOf(at)).mode & 0o777]).toEqual([0o700, 0o600])
  seed(linked, [], '')
  fs.renameSync(fileOf(linked), join(linked.configDir, 'target'))
  symlinkSync(join(linked.configDir, 'target'), fileOf(linked))
  expect(errorOf(await d.step({}, linked))).toEqual([`klyth: responses store unavailable (ELOOP): free space under ${linked.configDir}/klyth/responses or trash that session's file, then retry`])
  chmodSync(fileOf(at), 0o644)
  expect(errorOf(await d.step({}, at))).toEqual([`klyth: responses store unavailable (not private): ${at.configDir}/klyth/responses must be a directory you own with mode 0700, reached with no symlink below ${at.configDir}, its session files mode 0600`])
})

test('a config dir reached through a symlink records and restores, the file landing in the real directory', async () => {
  const base = scope(), real = { configDir: join(base.configDir, 'real', 'config'), id: base.id }, linked = { ...real, configDir: join(base.configDir, 'link', 'config') }
  mkdirSync(real.configDir, { recursive: true })
  symlinkSync(join(base.configDir, 'real'), join(base.configDir, 'link'))
  const d = daemon([sse(call('call_1'), DONE), sse(said('ok'), DONE)], { stores: files() })
  await d.step({ transcript: afterCall(minted(await d.step({}, linked))) }, linked)
  expect([d.body().input[1]!['call_id'], records(real).map(r => r['kind'])]).toEqual(['call_1', ['call']])
})

test("a store closed under a step (another session began) refuses it with the cause when the turn's blocks are first read", async () => {
  const at = scope(), owner = `${await providerKey({ id: 'cl', kind: 'anthropic', baseUrl: 'https://cl.invalid' })}/m`, stores = files()
  seed(at, [callRec('h', owner, 'toolu_klyth_t', 'toolu_remote'), { kind: 'block', handle: 'h', owner, at: 0, block: { type: 'thinking', thinking: 'hmm', signature: 'SIG' } }])
  const closing: Env['responses'] = s => { const store = stores(s); return { ...store, blocks: owner => key => (store.close(), store.blocks(owner)(key)) } }
  const d = daemon([anthropic('end_turn', textAt(0, 'done'))], { stores: closing })
  expect(errorOf(await d.step({ target: 'cl/m', transcript: afterCall(['toolu_klyth_t']) }, at))).toEqual(["klyth: responses store unavailable (closed): the session changed under this step; the next step opens its own session's file"])
  expect(d.h.posts).toEqual([])
})

test('a store that cannot open refuses the step with the cause and keeps nothing, so the next step opens it', async () => {
  const at = scope(), d = daemon([sse(said('ok'), DONE)], { stores: files() })
  seed(at, [], '')
  chmodSync(fileOf(at), 0o400)
  expect(errorOf(await d.step({}, at))).toEqual([`klyth: responses store unavailable (EACCES): free space under ${at.configDir}/klyth/responses or trash that session's file, then retry`])
  expect(d.h.posts).toEqual([])
  chmodSync(fileOf(at), 0o600)
  expect(errorOf(await d.step({}, at))).toEqual([])
  expect(d.h.posts).toHaveLength(1)
})

test("a step naming another session closes the previous store, whose writes then throw; the `session` record is written once its transcript exists", async () => {
  const one = scope('one'), stores = files(), first = stores(one), transcript = join(one.configDir, 'two.jsonl')
  expect(stores({ ...one, id: 'two', transcript }).kind).toBe('file')
  expect(() => first.record([callRec('h', 'p~0/m', 'toolu_klyth_x')])).toThrow('responses store closed')
  expect(records({ ...one, id: 'two' })).toEqual([])
  writeFileSync(transcript, '')
  for (let i = 0; i < 2; i++) stores({ ...one, id: 'two', transcript })
  expect(records({ ...one, id: 'two' })).toEqual([{ kind: 'session', v: 1, transcript }])
})

test("a torn last line, a predecessor's before the first append or a peer's mid-life, costs only that line: the next append ends it first", async () => {
  const at = scope(), owner = 'p~0/m', logs: string[] = []
  seed(at, [callRec('old', owner, 'toolu_klyth_old', 'old_remote'), '{"kind":"call","handle":"torn'], '')
  const store = files()(at)
  store.record([callRec('new', owner, 'toolu_klyth_new', 'new_remote')])
  fs.appendFileSync(fileOf(at), '{"kind":"call","handle":"peer-torn')
  store.record([callRec('later', owner, 'toolu_klyth_later', 'later_remote')])
  const reopened = responseStores(line => void logs.push(line))(at)
  expect(logs).toEqual([expect.stringMatching(/^klyth responses [0-9a-f]{8} store=file records=5 dropped=2 bytes=\d+ swept=0$/)])
  expect(['toolu_klyth_old', 'toolu_klyth_new', 'toolu_klyth_later'].map(reopened.remote('p~0'))).toEqual(['old_remote', 'new_remote', 'later_remote'])
})

test('a line of the wrong shape is dropped and counted, one case per kind, and a turn with one bad block line reads as unsealed', async () => {
  const at = scope(), owner = 'p~0/m', logs: string[] = []
  seed(at, [
    { kind: 'session', v: 1, transcript: 'relative.jsonl' },
    { kind: 'affinity', loop: 'main', provider: 'p~0', id: 'not a header value' },
    { kind: 'call', handle: 'h', loop: 'main', owner, local: 'toolu_klyth_bad', remote: 7 },
    { kind: 'call', handle: 'h', loop: 'main', owner, local: 'toolu_klyth_agent', agent: 'not an input' },
    { kind: 'response', handle: 'h', loop: 'main', owner, anchor: 'a' },
    { kind: 'unknown' },
    'not json',
    callRec('good', owner, 'toolu_klyth_good', 'good_remote'), blockRec('good', owner, 'r1'), blockRec('good', owner, 'r2', ''),
    callRec('fine', owner, 'toolu_klyth_fine'), blockRec('fine', owner, 'r3'),
  ])
  const store = responseStores(line => void logs.push(line))(at)
  expect(logs[0]).toContain(' records=12 dropped=7 ')
  expect(store.agent('toolu_klyth_agent')).toBeUndefined()
  expect(['toolu_klyth_bad', 'toolu_klyth_good'].map(store.remote('p~0'))).toEqual([undefined, 'good_remote'])
  expect(store.blocks(owner)('toolu_klyth_good')).toBeUndefined()
  expect(store.blocks(owner)('toolu_klyth_fine')).toEqual([{ at: 0, block: { type: 'reasoning', id: 'r3', encrypted_content: 'opaque' } }])
})

// The rows a real Claude Code (2.1.299, offline probe) recorded for two routed replies, the probe file's path
// redacted: [text, tool_use] saved as two rows and [text, thinking, text, tool_use] as three, each read back as one
// message with the texts kept split and `citations: null` on each; the tool result came back as string content.
const INPUT = { file_path: '/tmp/replay-probe-fixture.txt' }
const PROBED = [
  { rows: [[{ type: 'text', text: 'Synthetic repeated text.', citations: null }], [{ type: 'tool_use', id: 'toolu_probe_fixed', name: 'Read', input: INPUT }]], stream: sse(said('Synthetic repeated text.'), call('call_1', JSON.stringify(INPUT)), DONE) },
  {
    rows: [[{ type: 'text', text: 'Alpha before thinking.', citations: null }], [{ type: 'text', text: 'Beta after thinking.', citations: null }], [{ type: 'tool_use', id: 'toolu_split_probe', name: 'Read', input: INPUT }]],
    stream: sse(said('Alpha before thinking.'), { type: 'response.reasoning_summary_text.delta', delta: 'thinking' }, said('Beta after thinking.'), call('call_2', JSON.stringify(INPUT)), DONE),
  },
]

test('contract seam: the projection rebuilt from a reply\'s events equals the projection of the rows the host recorded for it, and its string content anchors as blocks', async () => {
  for (const { rows, stream } of PROBED) {
    const host: ApiMessage = { role: 'assistant', content: rows.flat() }, id = String((rows.at(-1)![0] as Record<string, unknown>)['id'])
    const asm = assembler(CODECS['openai-responses'], 'p', remoteIds(), () => id)
    const decoder = CODECS['openai-responses'].decoder()
    const events = [...asm.feed(decoder.feed(new TextEncoder().encode(stream))), ...asm.feed(decoder.end())]
    expect(kinds(replied(events).content as readonly Record<string, unknown>[])).toEqual(kinds(rows.flat()))
    expect(await projection(replied(events))).toBe(await projection(host))
    const result = (content: unknown): ApiMessage => ({ role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] as ApiMessage['content'] })
    const anchor = async (messages: ApiMessage[]) => (await lookup(memoryStore(), request(messages), P, 'm', () => {}, new Set())).anchor
    expect(await anchor([USER, host, result('1\tSynthetic fixture.\n2\t')])).toBe(await anchor([USER, replied(events), result([{ type: 'text', text: '1\tSynthetic fixture.\n2\t' }])]))
  }
})

test('host-only fields (citations, cache_control) and string content anchor and project as the bare blocks do; any other change does not', async () => {
  const bare: ApiMessage[] = [USER, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'next' }]
  const dressed: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'task', cache_control: { type: 'ephemeral' } }] }, { role: 'assistant', content: [{ type: 'text', text: 'reply', citations: null }, { type: 'text', text: '' }] }, { role: 'user', content: [{ type: 'text', text: 'next' }] }]
  const anchor = async (messages: ApiMessage[]) => (await lookup(memoryStore(), request(messages), P, 'm', () => {}, new Set())).anchor
  expect(await anchor(dressed)).toBe(await anchor(bare))
  expect(await projection(dressed[1]!)).toBe(await projection(bare[1]!))
  expect(await anchor([USER, { role: 'assistant', content: 'reply!' }, bare[2]!])).not.toBe(await anchor(bare))
  expect(await anchor([USER, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x', is_error: 'yes' }] as ApiMessage['content'] }])).toBe(await anchor([USER, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] as ApiMessage['content'] }]))
})

test('[thinking, "" text, tool_use] places the thinking where the host, which drops the empty text, keeps the call', async () => {
  const at = scope(), d = daemon([anthropic('tool_use', thinkingAt(0, 'SIG'), textAt(1, ''), toolAt(2, 'toolu_remote')), anthropic('end_turn', textAt(0, 'done'))], { stores: files() })
  const ids = minted(await d.step({ target: 'cl/m' }, at))
  expect(records(at).filter(r => r['kind'] === 'block').map(r => r['at'])).toEqual([0])
  await d.step({ target: 'cl/m', transcript: afterCall(ids) }, at)
  expect(d.body().messages[1]!.content).toEqual([{ type: 'thinking', thinking: 'hmm', signature: 'SIG' }, { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} }])
})

test('classifier and compaction requests record no call, block or response; a classifier request with a session id and loop records its affinity', async () => {
  const at = scope(), d = daemon([sse(reasoning('r1'), call('call_1'), DONE), sse(reasoning('r2'), said('summary'), DONE)], { stores: files() })
  expect(minted(await d.step({ accounting: { purpose: 'classifier', owner: 'main' }, sessionId: 'seed', cacheLoop: 'main' }, at))).toHaveLength(1)
  expect(errorOf(await d.step({ accounting: { purpose: 'compaction', owner: 'main' }, compaction: {} }, at))).toEqual([])
  expect(records(at)).toEqual([{ kind: 'affinity', loop: 'main', provider: expect.stringMatching(/^p~[0-9a-f]{8}$/), id: 'seed' }])
})

test('Anthropic text-only thinking stores nothing, nor does openai-responses text-only reasoning that ends in an error; finished, it stores its block and response, counted on the next step line', async () => {
  const at = scope(), d = daemon([anthropic('end_turn', thinkingAt(0, 'SIG'), textAt(1, 'done')), sse(reasoning('r0'), said('cut')), sse(reasoning('r1'), said('done'), DONE), sse(said('ok'), DONE)], { stores: files() })
  await d.step({ target: 'cl/m' }, at)
  expect(records(at)).toEqual([])
  expect([errorOf(await d.step({}, at)).length, records(at)]).toEqual([1, []])
  await d.step({}, at)
  expect(records(at).map(r => r['kind'])).toEqual(['block', 'response'])
  await d.step({ transcript: [USER, { role: 'assistant', content: 'done' }, { role: 'user', content: 'go on' }] }, at)
  expect(d.h.logs.at(-1)).toContain(' store=file restored=0/1 ')
})

test('the anchor path is off for a codec that seals no reasoning items and above 4,096 messages, logged once per loop; call ids still resolve', async () => {
  const store = memoryStore(), logs: string[] = [], log = (line: string) => void logs.push(line), unbounded = new Set<string>()
  const C = { id: 'cl', kind: 'anthropic', baseUrl: 'https://cl.invalid' } as const, owner = `${await providerKey(C)}/m`, long = Array.from({ length: 4097 }, (_, i): ApiMessage => (i % 2 ? { role: 'assistant', content: `a${i}` } : { role: 'user', content: `u${i}` }))
  store.record([callRec('h', owner, 'toolu_klyth_c', 'call_c'), callRec('h2', `${await providerKey(P)}/m`, 'toolu_klyth_p', 'call_p'), blockRec('h2', `${await providerKey(P)}/m`, 'r')])
  const anthropicKind = await lookup(store, request(afterCall(['toolu_klyth_c'])), C, 'm', log, unbounded)
  expect([anthropicKind.anchor, anthropicKind.remote('toolu_klyth_c'), anthropicKind.sealed('toolu_klyth_c')]).toEqual([undefined, 'call_c', []])
  expect([anthropicKind.remote('toolu_klyth_unknown'), anthropicKind.restored()]).toEqual([undefined, ' store=memory restored=1/0'])
  for (let i = 0; i < 2; i++) {
    const big = await lookup(store, { ...request(afterCall(['toolu_klyth_p'], long)), who: 'big-loop' }, P, 'm', log, unbounded)
    expect([big.anchor, big.remote('toolu_klyth_p'), big.sealed('toolu_klyth_p')?.length]).toEqual([undefined, 'call_p', 1])
  }
  expect((await lookup(store, request(long.slice(0, 4096)), P, 'm', log, unbounded)).anchor).toMatch(/^[0-9a-f]{64}$/)
  expect(logs).toEqual(['klyth responses: anchors off above 4096 messages (big-loop)'])
})

test('traced, a request that does not extend its loop and route logs the first input item that differs and its purpose; only a step is remembered', async () => {
  const d = daemon([sse(said('ok'), DONE)], { trace: true }), first: ApiMessage[] = [USER, { role: 'assistant', content: 'one' }, { role: 'user', content: 'two' }]
  await d.step({ transcript: first })
  await d.step({ transcript: [...first, { role: 'assistant', content: 'three' }, { role: 'user', content: 'four' }] })
  await d.step({ transcript: [USER, { role: 'assistant', content: 'changed' }, first[2]!], accounting: { purpose: 'classifier', owner: 'main' } })
  await d.step({ transcript: [USER, first[1]!, { role: 'user', content: 'TWO' }] })
  expect(d.h.logs.filter(l => l.startsWith('klyth responses'))).toEqual(['klyth responses: prefix changed at item 1 of 3 (main, classifier)', 'klyth responses: prefix changed at item 2 of 3 (main, step)'])
  // Untraced (the default), the same steps log no prefix line and hash no input item.
  const off = daemon([sse(said('ok'), DONE)])
  await off.step({ transcript: first })
  await off.step({ transcript: [USER, first[1]!, { role: 'user', content: 'TWO' }] })
  expect(off.h.logs.filter(l => l.startsWith('klyth responses'))).toEqual([])
})

test('a session scope must name a safe id, an absolute config dir and transcript without control characters; a step that names another is refused unsent', async () => {
  expect([invalidSessionScope(undefined), invalidSessionScope({ configDir: '/c', id: 'a-b_1', transcript: '/c/t.jsonl' })]).toEqual([undefined, undefined])
  const refusal = (field: string) => `klyth: invalid session scope (${field}): set CLAUDE_CONFIG_DIR to an absolute path and restart`
  for (const [session, field] of [[{ configDir: '/c', id: '../x' }, 'id'], [{ configDir: '/c\u0007', id: 'a' }, 'configDir'], [{ configDir: 'c', id: 'a' }, 'configDir'], [{ configDir: '/c', id: 'a', transcript: 'rel.jsonl' }, 'transcript'], ['scope', 'session']] as const)
    expect(invalidSessionScope(session)).toBe(refusal(field))
  const d = daemon([sse(said('ok'), DONE)], { stores: files() })
  expect(errorOf(await d.step({}, { configDir: '/c', id: '../x' }))).toEqual([refusal('id')])
  expect(d.h.posts).toEqual([])
})

test("the first open in a config dir unlinks only other sessions' files whose recorded transcript is gone", () => {
  const at = scope('current'), gone = join(at.configDir, 'deleted.jsonl'), kept = join(at.configDir, 'kept.jsonl'), locked = join(at.configDir, 'locked'), logs: string[] = []
  const session = (transcript: string) => ({ kind: 'session', v: 1, transcript })
  writeFileSync(kept, '')
  mkdirSync(locked)
  for (const [id, lines] of [['current', [session(gone)]], ['gone', [callRec('h', 'p~0/m', 'toolu_klyth_x'), session(gone)]], ['kept', [session(kept)]], ['unconfirmed', [callRec('h', 'p~0/m', 'toolu_klyth_y')]], ['erroring', [session(join(locked, 't.jsonl'))]]] as const) seed({ ...at, id }, lines)
  for (const name of ['not.a.session.jsonl', 'notes.txt']) writeFileSync(join(dirOf(at), name), `${JSON.stringify(session(gone))}\n`)
  chmodSync(locked, 0)
  try {
    const stores = responseStores(line => void logs.push(line))
    stores(at)
    stores({ ...at, id: 'second' })
  } finally { chmodSync(locked, 0o700) }
  expect(readdirSync(dirOf(at)).sort()).toEqual(['current.jsonl', 'erroring.jsonl', 'kept.jsonl', 'not.a.session.jsonl', 'notes.txt', 'second.jsonl', 'unconfirmed.jsonl'])
  expect(logs.map(l => l.replace(/^.* swept=/, ''))).toEqual(['1', '0'])
})
