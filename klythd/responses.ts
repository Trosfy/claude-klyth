// A session's provider response records, by neutral keys only: provider ids behind minted tool calls, each klyth
// agent call as made, thinking blocks a later request sends back (by call id, or by the anchor over the transcript
// before a text-only turn), each loop's affinity. Pure, hashing with Web Crypto; file store: responses-file.ts.
import { isObject, own, type ProviderConfig } from '../hooks/config'
import { stable } from '../hooks/compact-snapshot'
import { PRODUCT } from '../hooks/product'
import type { ApiMessage, StepEvent, StepRequest } from '../hooks/protocol'
import { str } from '../hooks/transcript'
import { validTranscriptPath } from '../hooks/usage-retention'
import { isIndex, parseJson } from './codec'
import type { Placed, Thinking } from './history'

export type Rec = { kind: 'session'; v: 1; transcript: string } | { kind: 'affinity'; loop: string; provider: string; id: string } | { kind: 'block'; handle: string; owner: string; at: number; block: Thinking }
  | { kind: 'call'; handle: string; loop: string; owner: string; local: string; remote?: string; agent?: Record<string, unknown> } | { kind: 'response'; handle: string; loop: string; owner: string; anchor: string; projection: string }
// One session's records: `remote` gives a minted call's provider id to that provider only, `agent` a klyth agent call's
// input as the provider made it (to any model: the host rewrote it as an Agent call), `blocks` a known turn's blocks (by
// `keyOf` its call or response) to the model that wrote them, none when another did, and `affinity` a loop's persisted
// id, recording `seed` when there is none. A file store reads what was appended at `refresh` only.
export type ResponseStore = {
  kind: 'file' | 'memory'; refresh(): void; close(): void
  remote(provider: string): (local: string) => string | undefined
  agent(local: string): Record<string, unknown> | undefined
  blocks(owner: string): (key: string) => readonly Placed[] | undefined
  affinity(loop: string, provider: string, seed: string): string
  record(lines: readonly Rec[]): void
}

const digest = crypto.subtle.digest.bind(crypto.subtle) // bound at load: record keys are no fingerprints, which a failing global digest degrades
const sha256 = async (text: string) => Array.from(new Uint8Array(await digest('SHA-256', new TextEncoder().encode(text).buffer as ArrayBuffer)), b => b.toString(16).padStart(2, '0')).join('')
const ID = /^[A-Za-z0-9_-]{1,128}$/, AFFINITY = /^[A-Za-z0-9._:-]{1,128}$/, HEAD = '{"kind":"block","handle":"'
const FIELDS: Readonly<Record<string, readonly string[]>> = { session: [], affinity: ['loop', 'provider'], call: ['handle', 'loop', 'owner', 'local'], response: ['handle', 'loop', 'owner', 'anchor', 'projection'] }

// The refusal text for a step's session scope, or undefined when the step has none or a valid one.
export function invalidSessionScope(session: unknown): string | undefined {
  const field = session === undefined ? undefined : !isObject(session) ? 'session' : typeof session['id'] !== 'string' || !ID.test(session['id']) ? 'id'
    : !validTranscriptPath(session['configDir']) ? 'configDir' : session['transcript'] !== undefined && !validTranscriptPath(session['transcript']) ? 'transcript' : undefined
  return field && `klyth: invalid session scope (${field}): set CLAUDE_CONFIG_DIR to an absolute path and restart`
}
// The refusal text for a store that cannot open or write: a system error's code and fix, else the privacy rule it broke.
export const unavailable = (err: unknown, configDir = '', code = (err as { code?: string }).code) => `klyth: responses store unavailable (${code ?? 'not private'}): ${code === undefined
  ? `${configDir}/klyth/responses must be a directory you own with mode 0700, reached with no symlink below ${configDir}, its session files mode 0600`
  : code === 'closed' ? 'the session changed under this step; the next step opens its own session\'s file' : `free space under ${configDir}/klyth/responses or trash that session's file, then retry`}`
// A provider's endpoint as records name it; a config id never holds `/`, so `owner = providerKey/model` splits back.
export const providerKey = async (p: Pick<ProviderConfig, 'id' | 'kind' | 'baseUrl'>) => `${p.id}~${(await sha256(`${p.kind}\0${p.baseUrl}`)).slice(0, 8)}`
// The key a record is found by: a call's local id, a text-only turn's anchor and projection, a loop's affinity.
const keyOf = (r: { kind: 'call'; local: string } | { kind: 'response'; anchor: string; projection: string } | { kind: 'affinity'; loop: string; provider: string }) =>
  r.kind === 'call' ? r.local : r.kind === 'response' ? `${r.anchor}\0${r.projection}` : `${r.loop}\0${r.provider}`
const thinkingOf = (b: unknown): Thinking | undefined => !isObject(b) ? undefined
  : b['type'] === 'thinking' && typeof b['thinking'] === 'string' && typeof b['signature'] === 'string' ? { type: 'thinking', thinking: b['thinking'], signature: b['signature'] }
  : b['type'] === 'redacted_thinking' && typeof b['data'] === 'string' ? { type: 'redacted_thinking', data: b['data'] }
  : b['type'] === 'reasoning' && typeof b['id'] === 'string' && typeof b['encrypted_content'] === 'string' && b['encrypted_content'] !== '' ? { type: 'reasoning', id: b['id'], encrypted_content: b['encrypted_content'] } : undefined
// A parsed `block` record of turn `handle` as its placed block, when it has the right shape.
const blockOf = (r: unknown, handle: string, block = isObject(r) && r['kind'] === 'block' && r['handle'] === handle && typeof r['owner'] === 'string' && isIndex(r['at']) ? thinkingOf(r['block']) : undefined): Placed | undefined =>
  block && { at: (r as { at: number }).at, block }
// A record other than `block` of the right shape (a file indexes block lines by their fixed head, then `blockOf`).
export const valid = (r: unknown): r is Exclude<Rec, { kind: 'block' }> => isObject(r) && typeof r['kind'] === 'string' && own(FIELDS, r['kind'])?.every(k => typeof r[k] === 'string') === true
  && (r['kind'] === 'session' ? validTranscriptPath(r['transcript']) : r['kind'] === 'affinity' ? typeof r['id'] === 'string' && AFFINITY.test(r['id']) : (r['remote'] === undefined || typeof r['remote'] === 'string') && (r['agent'] === undefined || isObject(r['agent'])))

// Content as anchors and projections see it: the blocks normalize() keeps, with none of the host's own fields, and an
// image as a digest of its type, size and first and last KiB, so a screenshot's bytes do not drive the cost.
const reduce = async (content: unknown): Promise<unknown[]> => (await Promise.all((typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []).map(async (b: unknown): Promise<unknown[]> => {
  if (!isObject(b) || b['type'] === 'thinking' || b['type'] === 'redacted_thinking') return []
  if (b['type'] === 'text') return str(b['text']) === '' ? [] : [{ type: 'text', text: b['text'] }]
  if (b['type'] === 'tool_use') return [{ type: 'tool_use', id: str(b['id']), name: str(b['name']), input: isObject(b['input']) ? b['input'] : {} }]
  if (b['type'] === 'tool_result') return [{ type: 'tool_result', tool_use_id: str(b['tool_use_id']), is_error: b['is_error'] === true, content: await reduce(b['content']) }]
  const s = isObject(b['source']) ? b['source'] : {}, data = str(s['type'] === 'url' ? s['url'] : s['data'])
  return [b['type'] === 'image' ? { type: 'image', digest: await sha256(`${str(s['media_type'])}\0${data.length}\0${data.slice(0, 1024)}\0${data.slice(-1024)}`) } : { type: b['type'] }]
}))).flat()
export const projection = async (m: ApiMessage) => sha256(stable(await reduce(m.content)))
// The assistant message the host builds from a step's events: text deltas join until a thinking or tool_use event.
export function replied(events: readonly StepEvent[]): ApiMessage {
  const content: ({ type: string } & Record<string, unknown>)[] = []
  for (const [i, e] of events.entries()) {
    if (e.type === 'tool_use') content.push({ type: 'tool_use', id: e.id, name: e.name, input: e.input })
    else if (e.type === 'text') content.push({ type: 'text', text: events[i - 1]?.type === 'text' ? `${content.pop()!['text']}${e.text}` : e.text })
  }
  return { role: 'assistant', content }
}

// One request's normalize() callbacks after one refresh: a call's provider id and blocks by its id, a text-only turn's
// blocks by its anchor (reasoning-item codecs, up to 4,096 messages); its owner, own anchor, affinity, and what it gave back.
export async function lookup(store: ResponseStore, req: StepRequest, p: Pick<ProviderConfig, 'id' | 'kind' | 'baseUrl'>, model: string, log: (line: string) => void, unbounded: Set<string>) {
  store.refresh()
  const provider = await providerKey(p), owner = `${provider}/${model}`, loop = req.cacheLoop ?? req.who, remote = store.remote(provider), blocks = store.blocks(owner), ids = new Set<string>(), held = new Set<readonly Placed[]>()
  const found = new Map<ApiMessage, readonly Placed[] | undefined>(), hit = (b: readonly Placed[] | undefined) => (b && held.add(b), b)
  const affinity = req.sessionId === undefined || req.cacheLoop === undefined || !AFFINITY.test(req.sessionId) ? req.sessionId : store.affinity(req.cacheLoop, provider, req.sessionId)
  let anchor = p.kind === 'openai-responses' && req.transcript.length <= 4096 ? await sha256('klyth-responses:1') : undefined
  if (p.kind === 'openai-responses' && anchor === undefined && !unbounded.has(loop)) (unbounded.add(loop), log(`klyth responses: anchors off above 4096 messages (${loop})`))
  for (const m of anchor === undefined ? [] : req.transcript) {
    const view = { role: m.role, blocks: await reduce(m.content) }
    if (m.role === 'assistant' && !view.blocks.some(b => isObject(b) && b['type'] === 'tool_use')) found.set(m, blocks(keyOf({ kind: 'response', anchor: anchor!, projection: await sha256(stable(view.blocks)) })))
    anchor = await sha256(`${anchor}\n${stable(view)}`)
  }
  return {
    store, owner, anchor, affinity, sealed: (id: string) => hit(blocks(id)), message: (m: ApiMessage) => hit(found.get(m)), remote: (id: string) => { const r = remote(id); return (r !== undefined && ids.add(id), r) },
    restored: () => ` store=${store.kind} restored=${ids.size}/${[...held].reduce((n, b) => n + b.length, 0)}`,
  }
}

// A call line's `agent`: the input of a klyth agent call, as the batch that holds its tool_use carries it.
const agentOf = (batch: readonly StepEvent[], local: string) => { const use = batch.find(e => e.type === 'tool_use' && e.id === local); return use?.type === 'tool_use' && use.name === PRODUCT.qualifiedTool ? { agent: use.input } : {} }
// One response's records as its batches come: its calls, with the blocks before them, in the batch that has them;
// with no call, at a successful end, a text-only turn's reasoning items and the anchor and projection that find them.
export function capture(store: ResponseStore, loop: string, owner: string, anchor: string | undefined, remote: (local: string) => string | undefined) {
  const handle = crypto.randomUUID(), events: StepEvent[] = []
  let calls = 0, blocks = 0
  return async (batch: readonly StepEvent[], turn: { calls: readonly string[]; blocks: readonly Placed[] }, end = false) => {
    const reasoned = (events.push(...batch), end && anchor !== undefined && turn.calls.length === 0 && turn.blocks.length > 0 && turn.blocks.every(p => p.block.type === 'reasoning'))
    const lines = turn.calls.length === 0 && !reasoned ? [] : [...turn.calls.slice(calls).map(local => ({ kind: 'call' as const, handle, loop, owner, local, ...(remote(local) === undefined ? {} : { remote: remote(local) }), ...agentOf(batch, local) })),
      ...turn.blocks.slice(blocks).map(p => ({ kind: 'block' as const, handle, owner, at: p.at, block: p.block })), ...(reasoned ? [{ kind: 'response' as const, handle, loop, owner, anchor, projection: await projection(replied(events)) }] : [])]
    if (lines.length > 0) (store.record(lines), ([calls, blocks] = [turn.calls.length, turn.blocks.length]))
  }
}

// The index of a file's lines, each added once with where it lies and a decoder of its first `end` bytes: a block line
// by its head alone, its turn read back with `read` and checked on first reference, then resident; others parsed.
export function indexer(read: (at: number, length: number) => string) {
  const keys = new Map<string, Exclude<Rec, { kind: 'block' | 'session' }>>(), where = new Map<string, number[]>(), resident = new Map<string, readonly Placed[] | undefined>()
  const load = (handle: string) => {
    if (resident.has(handle)) return resident.get(handle)
    const at = where.get(handle) ?? [], blocks = Array.from({ length: at.length / 2 }, (_, i) => blockOf(parseJson(read(at[2 * i]!, at[2 * i + 1]!)), handle))
    return resident.set(handle, blocks.every(b => b !== undefined) ? blocks as Placed[] : (index.dropped++, undefined)).get(handle)
  }
  const index = {
    records: 0, dropped: 0, confirmed: false,
    add(text: (end?: number) => string, at: number, length: number) {
      const head = (index.records++, text(HEAD.length + 64)), end = head.startsWith(HEAD) ? head.indexOf('"', HEAD.length) : -1, handle = head.slice(HEAD.length, end), r = end > HEAD.length ? undefined : parseJson(text())
      if (end > HEAD.length) return void ((where.get(handle) ?? where.set(handle, []).get(handle)!).push(at, length), resident.delete(handle))
      if (!valid(r)) index.dropped++
      else if (r.kind === 'session') index.confirmed = true
      else if (r.kind !== 'affinity' || !keys.has(keyOf(r))) keys.set(keyOf(r), r)
    },
    remote: (provider: string) => (local: string) => { const r = keys.get(local); return r?.kind === 'call' && r.owner.startsWith(`${provider}/`) ? r.remote : undefined },
    agent: (local: string) => { const r = keys.get(local); return r?.kind === 'call' ? r.agent : undefined },
    blocks: (owner: string) => (key: string) => { const r = keys.get(key); return r?.kind !== 'affinity' && r?.owner === owner ? load(r.handle) : undefined },
    affinity: (loop: string, provider: string) => { const r = keys.get(keyOf({ kind: 'affinity', loop, provider })); return r?.kind === 'affinity' ? r.id : undefined },
  }
  return index
}

// The memory store: the file store's index over lines kept in an array (a line's "offset" is its index), for a wire
// without a session scope and for tests.
export function memoryStore(): ResponseStore {
  const lines: string[] = []
  const index = indexer(at => lines[at]!)
  const store: ResponseStore = {
    kind: 'memory', refresh() {}, close() {}, remote: index.remote, agent: index.agent, blocks: index.blocks,
    affinity: (loop, provider, seed) => index.affinity(loop, provider) ?? (store.record([{ kind: 'affinity', loop, provider, id: seed }]), seed),
    record: recs => recs.forEach(r => { const line = JSON.stringify(r); index.add(end => line.slice(0, end), lines.length, line.length); lines.push(line) }),
  }
  return store
}
