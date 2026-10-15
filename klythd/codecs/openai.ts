// The `openai` kind: Chat Completions request bodies from the normalized transcript, and a decoder for the
// provider's SSE stream. Pure.
import { isObject } from '../../hooks/config'
import type { ModelConfig } from '../../hooks/config'
import { decoderOver, isIndex, params, parseJson, sseReader } from '../codec'
import type { Codec, Neutral, Sink } from '../codec'
import type { Image, Text } from '../history'
import { openAiUsage } from '../../hooks/usage-evidence'
import type { UsageEvidence } from '../../hooks/usage-evidence'

type Json = Record<string, unknown>
type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type OaMessage =
  | { role: 'system' | 'developer'; content: string }
  | { role: 'user'; content: string | Part[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const toPart = (b: Text | Image): Part =>
  b.type === 'text' ? b : { type: 'image_url', image_url: { url: b.source.type === 'url' ? b.source.url : `data:${b.source.media_type};base64,${b.source.data}` } }

// The request as Chat Completions messages: the system prompt in the model's role for it, tool results as
// `tool` messages ahead of their message's other content, and the images of tool results in a user message
// after them.
export function toMessages(n: Neutral, m: ModelConfig): OaMessage[] {
  const out: OaMessage[] = [m.systemRole === 'user' ? { role: 'user', content: `System instructions:\n\n${n.system}` } : { role: m.systemRole, content: n.system }]
  for (const msg of n.messages) {
    if (msg.role === 'assistant') {
      const text = msg.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
      const calls = msg.content.flatMap(b => (b.type === 'tool_use' ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []))
      if (calls.length > 0) out.push({ role: 'assistant', content: text === '' ? null : text, tool_calls: calls })
      else if (text !== '') out.push({ role: 'assistant', content: text })
      continue
    }
    const parts: Part[] = []
    const moved: Part[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        const body = b.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n')
        moved.push(...b.content.filter(c => c.type === 'image').map(toPart))
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${body}` : body })
      } else if (b.type === 'text' || b.type === 'image') parts.push(toPart(b))
    }
    const all = [...moved, ...parts]
    if (all.length > 0) out.push({ role: 'user', content: all.every(p => p.type === 'text') ? all.map(p => (p as Text).text).join('\n\n') : all })
  }
  return out
}

const optOf = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || v === null || ok(v)
const isStr = (v: unknown) => typeof v === 'string'

// Why a parsed SSE chunk does not have the shape klyth reads, or undefined. Unknown fields pass; a null
// field counts as absent.
function invalidChunk(c: unknown): string | undefined {
  if (!isObject(c)) return 'a chunk is not an object'
  if (!optOf(c['choices'], Array.isArray)) return 'choices is not an array'
  const choice = (c['choices'] as unknown[] | undefined)?.[0]
  if (choice !== undefined) {
    if (!isObject(choice)) return 'choices[0] is not an object'
    if (!optOf(choice['finish_reason'], isStr)) return 'finish_reason is not text'
    if (!optOf(choice['index'], isIndex)) return 'choices[0].index is not an index'
    const d = choice['delta']
    if (!optOf(d, isObject)) return 'delta is not an object'
    if (isObject(d)) {
      for (const k of ['content', 'reasoning_content', 'reasoning', 'role']) if (!optOf(d[k], isStr)) return `delta.${k} is not text`
      if (!optOf(d['tool_calls'], Array.isArray)) return 'delta.tool_calls is not an array'
      for (const tc of (d['tool_calls'] as unknown[] | undefined) ?? []) {
        if (!isObject(tc)) return 'a tool call is not an object'
        if (!optOf(tc['index'], isIndex)) return 'a tool call index is not an index'
        if (!optOf(tc['id'], isStr) || !optOf(tc['type'], isStr)) return 'a tool call id or type is not text'
        const f = tc['function']
        if (!optOf(f, isObject)) return 'a tool call function is not an object'
        if (isObject(f) && (!optOf(f['name'], isStr) || !optOf(f['arguments'], a => isStr(a) || isObject(a)))) return 'a tool call name or arguments has the wrong type'
      }
    }
  }
  const u = c['usage']
  if (!optOf(u, isObject)) return 'usage is not an object'
  if (isObject(u)) {
    if (!isIndex(u['prompt_tokens']) || !isIndex(u['completion_tokens'])) return 'usage prompt_tokens or completion_tokens is not a count'
    const details = u['prompt_tokens_details']
    if (!optOf(details, isObject) || (isObject(details) && !optOf(details['cached_tokens'], isIndex))) return 'usage cached tokens are not a count'
  }
  return undefined
}

type Held = { key: unknown; id?: string; name: string; args: string | Json }

// A decoder for one response. Text and reasoning deltas pass as they arrive; a tool call is held until its
// block ends (the next call, a text or reasoning delta, or the finish). After an error nothing more is read.
function decoder() {
  let held: Held | undefined
  const ended = new Set<unknown>()
  let finished = false
  let done = false
  let evidence: UsageEvidence | undefined

  function close({ out }: Sink) {
    if (held === undefined) return
    out.push({ t: 'tool', ...(held.id === undefined ? {} : { id: held.id }), name: held.name, args: held.args })
    ended.add(held.key)
    held = undefined
  }
  function fragment(s: Sink, tc: Json, position: number) {
    const key = tc['index'] ?? tc['id'] ?? position
    const id = typeof tc['id'] === 'string' ? tc['id'] : undefined
    const f = isObject(tc['function']) ? tc['function'] : {}
    const name = typeof f['name'] === 'string' ? f['name'] : ''
    const args = f['arguments']
    if (held !== undefined && held.key === key && (id === undefined || id === held.id)) {
      if (held.name === '') held.name = name
      if (typeof args === 'string' && typeof held.args === 'string') held.args += args
      else if (isObject(args)) held.args = args
      return
    }
    if (id === undefined && ended.has(key)) return s.fail('a tool call fragment arrived after its call had ended (interleaved calls are not supported)')
    close(s)
    held = { key, ...(id === undefined ? {} : { id }), name, args: isObject(args) ? args : typeof args === 'string' ? args : '' }
  }
  function event(s: Sink, data: string) {
    const c = parseJson(data)
    if (c === undefined) return s.fail(`unparseable stream data: ${data.slice(0, 200)}`)
    const why = invalidChunk(c)
    if (why !== undefined) return s.fail(`malformed stream chunk: ${why}`)
    const chunk = c as Json
    if (chunk['error'] !== undefined && chunk['error'] !== null) return s.fail(JSON.stringify(chunk['error']))
    const u = chunk['usage']
    if (isObject(u)) {
      const cached = (isObject(u['prompt_tokens_details']) ? (u['prompt_tokens_details']['cached_tokens'] as number | null | undefined) : 0) ?? 0
      const reasoning = isObject(u['completion_tokens_details']) ? u['completion_tokens_details']['reasoning_tokens'] : undefined
      s.out.push({ t: 'usage', in: (u['prompt_tokens'] as number) - cached, out: u['completion_tokens'] as number, cacheRead: cached, cacheWrite: 0, ...(isIndex(reasoning) ? { reasoning: reasoning as number } : {}) })
      evidence = openAiUsage(u, 'openai', Array.isArray(chunk['choices']) && (chunk['choices'] as unknown[]).length === 0 ? 'final' : 'provisional')
    }
    const choice = (chunk['choices'] as Json[] | undefined)?.[0]
    const delta = isObject(choice?.['delta']) ? (choice['delta'] as Json) : {}
    for (const kind of ['reasoning_content', 'reasoning', 'content'] as const) {
      const text = delta[kind]
      if (typeof text !== 'string' || text === '') continue
      close(s)
      s.out.push({ t: kind === 'content' ? 'text' : 'thinking', text })
    }
    ;((delta['tool_calls'] as Json[] | null | undefined) ?? []).forEach((tc, i) => s.failed || fragment(s, tc, i))
    const reason = choice?.['finish_reason']
    if (typeof reason !== 'string' || s.failed) return
    finished = true
    s.out.push({ t: 'finish', reason: reason.toLowerCase() })
    if (reason.toLowerCase() === 'error') s.fail('the provider ended the response with finish_reason "error"')
    else close(s)
  }
  const decoded = decoderOver(
    sseReader(),
    (s, data) => (data.trim() === '[DONE]' ? void (done = true) : event(s, data)),
    s => {
      if (!done && !finished) return s.fail('the stream ended with no finish reason')
      close(s)
      if (!s.failed && evidence !== undefined) evidence = { ...evidence, finality: 'final' }
    },
  )
  return { ...decoded, evidence: () => evidence }
}

export const openai: Codec = {
  encode(n, p, m) {
    const tools = m.tools ? n.tools : []
    const base: Json = {}
    if (m.maxTokensParam) base[m.maxTokensParam] = m.maxOutputTokens
    if (!m.parallelToolCalls && tools.length > 0) base['parallel_tool_calls'] = false
    const { body, level } = params(base, p, m, n.effort, n.outputTokens)
    const sent = {
      ...body,
      model: m.id,
      messages: toMessages(n, m),
      ...(tools.length > 0 ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
      stream: true,
      ...(p.streamUsage ? { stream_options: { include_usage: true } } : {}),
    }
    return { path: '/chat/completions', body: JSON.stringify(sent), effort: level ?? 'none' }
  },
  decoder,
  stops: { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'tool_use', function_call: 'tool_use' },
}
