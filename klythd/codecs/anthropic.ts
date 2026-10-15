// The `anthropic` kind (the Messages API): request bodies from the normalized transcript, and a decoder for
// the provider's SSE stream. Pure. The key's header is the transport's, by the provider's `authHeader`.
import { isObject } from '../../hooks/config'
import { str } from '../../hooks/transcript'
import { count, decoderOver, lastUsers, lostThinking, obj, params, parseJson, sseReader, thinkingReader } from '../codec'
import type { Codec, Sink } from '../codec'
import type { Message } from '../history'
import { partitionedUsage } from '../../hooks/usage-evidence'
import type { UsageEvidence } from '../../hooks/usage-evidence'

type Json = Record<string, unknown>
type Block = Message['content'][number]

// The transcript as Messages turns. Normalized blocks already have the API's shapes; a tool_result carries
// is_error only when true, an empty text block (the API refuses it) and a reasoning item (a Responses
// block) go, and a turn's tool results come first (the API requires it).
export function toMessages(messages: readonly Message[]) {
  const live = (b: Block) => b.type !== 'reasoning' && !(b.type === 'text' && b.text === '')
  const wire = (b: Block) => (b.type === 'tool_result' ? { type: b.type, tool_use_id: b.tool_use_id, content: b.content.filter(live), ...(b.is_error ? { is_error: true } : {}) } : b)
  const first = (b: { type: string }) => Number(b.type === 'tool_result')
  return messages
    .map(({ role, content }) => ({ role, content: content.filter(live).map(wire).sort((a, b) => first(b) - first(a)) }))
    .filter(m => m.content.length > 0)
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

// Each usage count and the field that carries it.
const COUNTS = { in: 'input_tokens', out: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' } as const
type Held = { id?: string; name: string; json: string; input: unknown }

// A decoder for one response, read by each event's own `type`. Text and thinking deltas pass as they arrive;
// a tool call is held, by its block index, until its block stops, and so is each thinking block, which then
// passes whole if it is signed. After an error nothing more is read.
function decoder() {
  const held = new Map<unknown, Held>()
  const thinking = thinkingReader()
  // Numeric host usage keeps its legacy zero defaults; accounting keeps field presence separately.
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  const evidenceUsage: Json = {}
  let evidence: UsageEvidence | undefined
  let finished = false

  function take(u: Json, finality: 'provisional' | 'final' = 'provisional') {
    for (const [key, name] of Object.entries(COUNTS) as [keyof typeof COUNTS, string][]) {
      usage[key] = Math.max(usage[key], count(u[name]))
      if (Object.hasOwn(u, name)) evidenceUsage[name] = u[name]
    }
    const creation = obj(u['cache_creation'])
    for (const [target, nested] of [['cache_creation_5m_input_tokens', 'ephemeral_5m_input_tokens'], ['cache_creation_1h_input_tokens', 'ephemeral_1h_input_tokens']] as const) {
      if (Object.hasOwn(u, target)) evidenceUsage[target] = u[target]
      else if (Object.hasOwn(creation, nested)) evidenceUsage[target] = creation[nested]
    }
    evidence = partitionedUsage(evidenceUsage, 'anthropic', { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens', cacheWrite5m: 'cache_creation_5m_input_tokens', cacheWrite1h: 'cache_creation_1h_input_tokens' }, finality)
  }
  function event({ out, fail }: Sink, data: string) {
    const ev = parseJson(data)
    if (!isObject(ev)) return fail(`unparseable stream data: ${data.slice(0, 200)}`)
    const delta = obj(ev['delta'])
    const block = obj(ev['content_block'])
    switch (ev['type']) {
      case 'error':
        return fail(JSON.stringify(ev['error'] ?? ev))
      case 'message_start':
        return take(obj(obj(ev['message'])['usage']))
      case 'content_block_start':
        if (block['type'] === 'tool_use') held.set(ev['index'], { ...(typeof block['id'] === 'string' ? { id: block['id'] } : {}), name: typeof block['name'] === 'string' ? block['name'] : '', json: '', input: block['input'] })
        else if (block['type'] === 'thinking') thinking.add(ev['index'], { text: str(block['thinking']), signature: str(block['signature']) })
        else if (block['type'] === 'redacted_thinking') thinking.add(ev['index'], { redacted: str(block['data']) })
        return
      case 'content_block_delta': {
        if (delta['type'] === 'text_delta' && nonEmpty(delta['text'])) out.push({ t: 'text', text: delta['text'] })
        else if (delta['type'] === 'thinking_delta' && nonEmpty(delta['thinking'])) {
          out.push({ t: 'thinking', text: delta['thinking'] })
          thinking.add(ev['index'], { text: delta['thinking'] })
        } else if (delta['type'] === 'signature_delta') thinking.add(ev['index'], { signature: str(delta['signature']) })
        else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string' && held.has(ev['index'])) (held.get(ev['index']) as Held).json += delta['partial_json']
        return
      }
      case 'content_block_stop': {
        const block = thinking.seal(ev['index'])
        if (block !== undefined) return void out.push({ t: 'sealed', block })
        const h = held.get(ev['index'])
        if (h === undefined) return
        held.delete(ev['index'])
        const args = h.json !== '' ? h.json : isObject(h.input) ? h.input : ''
        return void out.push({ t: 'tool', ...(h.id === undefined ? {} : { id: h.id }), name: h.name, args })
      }
      case 'message_delta':
        take(obj(ev['usage']), typeof delta['stop_reason'] === 'string' ? 'final' : 'provisional')
        out.push({ t: 'usage', ...usage })
        if (typeof delta['stop_reason'] === 'string') {
          finished = true
          out.push({ t: 'finish', reason: delta['stop_reason'] })
        }
    }
  }
  const decoded = decoderOver(sseReader(), event, ({ fail }) => {
    if (held.size > 0) fail('the stream ended inside a tool call')
    else if (!finished) fail('the stream ended with no stop reason')
  })
  return { ...decoded, evidence: () => evidence }
}

export const anthropic: Codec = {
  encode(n, p, m) {
    const tools = m.tools ? n.tools : []
    const base: Json = { max_tokens: m.maxOutputTokens }
    if (!m.parallelToolCalls && tools.length > 0) base['tool_choice'] = { type: 'auto', disable_parallel_tool_use: true }
    const { body, level } = params(base, p, m, n.effort, n.outputTokens)
    // A tool turn whose signed thinking is lost goes without the thinking param: the API wants the blocks back.
    const lost = lostThinking(body['thinking'], n.messages)
    if (lost) delete body['thinking']
    // The cache mark goes on the last system block, the last tool and the last block of the last two user turns.
    const mark = m.cache === undefined ? {} : { cache_control: { type: 'ephemeral', ttl: m.cache } }
    const messages = toMessages(n.messages)
    for (const turn of lastUsers(n.maintenance ? messages.slice(0, n.prefixMessages === undefined ? -1 : toMessages(n.messages.slice(0, n.prefixMessages)).length) : messages)) turn.content = turn.content.map((b, i, all) => (i === all.length - 1 ? { ...b, ...mark } : b))
    const sent = {
      ...body,
      model: m.id,
      ...(n.system === '' ? {} : { system: m.cache === undefined ? n.system : [{ type: 'text', text: n.system, ...mark }] }),
      messages,
      ...(tools.length > 0 ? { tools: tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.schema, ...(i === tools.length - 1 ? mark : {}) })) } : {}),
      stream: true,
    }
    return { path: '/v1/messages', body: JSON.stringify(sent), headers: { 'anthropic-version': '2023-06-01' }, effort: level ?? 'none', ...(lost ? { lost } : {}) }
  },
  decoder,
  stops: { end_turn: 'end_turn', max_tokens: 'max_tokens', tool_use: 'tool_use', stop_sequence: 'end_turn', refusal: 'refusal' },
}
