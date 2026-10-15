// The `openai-responses` kind (OpenAI's Responses API): request bodies from the normalized transcript, and a
// decoder for the provider's SSE stream. Pure. Every request is stateless (`store: false`) and streamed.
import { isObject, own } from '../../hooks/config'
import { count, decoderOver, isIndex, obj, params, parseJson, sseReader } from '../codec'
import type { Codec, Neutral, Sink } from '../codec'
import type { Image, Text } from '../history'
import { openAiUsage } from '../../hooks/usage-evidence'
import type { UsageEvidence } from '../../hooks/usage-evidence'

type Json = Record<string, unknown>
type Part = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }

const toPart = (b: Text | Image): Part =>
  b.type === 'text' ? { type: 'input_text', text: b.text } : { type: 'input_image', image_url: b.source.type === 'url' ? b.source.url : `data:${b.source.media_type};base64,${b.source.data}` }

// The request as Responses input items, in the order the turns had: an assistant turn's text, calls and held
// reasoning items one item each, a user turn's tool results as `function_call_output` items ahead of one user
// message, which holds the images of the tool results first and then the turn's own text and images.
export function toInput(n: Neutral): Json[] {
  const out: Json[] = []
  for (const msg of n.messages) {
    if (msg.role === 'assistant') {
      for (const b of msg.content) {
        if (b.type === 'text' && b.text !== '') out.push({ role: 'assistant', content: [{ type: 'output_text', text: b.text }] })
        else if (b.type === 'tool_use') out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) })
        else if (b.type === 'reasoning') out.push({ type: 'reasoning', id: b.id, encrypted_content: b.encrypted_content, summary: [] })
      }
      continue
    }
    const parts: Part[] = []
    const moved: Part[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        const body = b.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n')
        moved.push(...b.content.filter(c => c.type === 'image').map(toPart))
        out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `Error: ${body}` : body })
      } else if (b.type === 'text' || b.type === 'image') parts.push(toPart(b))
    }
    if (moved.length + parts.length > 0) out.push({ role: 'user', content: [...moved, ...parts] })
  }
  return out
}

// The decoded kind of each event that carries a text delta.
const DELTAS = { 'response.output_text.delta': 'text', 'response.refusal.delta': 'text', 'response.reasoning_summary_text.delta': 'thinking', 'response.reasoning_text.delta': 'thinking' } as const
const malformed = (why: string) => `malformed stream event: ${why}`

// A decoder for one response, read by each event's own `type`. Text, refusal and reasoning deltas pass as they
// arrive; a function call passes whole when its item is done (its argument deltas are not read), and so does
// each reasoning item that carries encrypted content. The finish is the response's terminal event. After an
// error nothing more is read.
function decoder() {
  let summaries = 0
  let called = false
  let refused = false
  let finished = false
  let evidence: UsageEvidence | undefined

  function item({ out, fail }: Sink, it: unknown) {
    if (!isObject(it)) return fail(malformed('an output item is not an object'))
    const { type, id, call_id: callId, name, arguments: args, encrypted_content: sealed } = it
    if (type === 'function_call') {
      if (typeof callId !== 'string' || typeof name !== 'string' || typeof args !== 'string') return fail(malformed('a function_call item has no call_id, name or arguments as text'))
      called = true
      out.push({ t: 'tool', id: callId, name, args })
    } else if (type === 'reasoning' && typeof id === 'string' && typeof sealed === 'string' && sealed !== '') out.push({ t: 'sealed', block: { type: 'reasoning', id, encrypted_content: sealed } })
  }
  // The usage and finish of a response that ended: completed, or incomplete for the reason it gives.
  function end({ out, fail }: Sink, r: Json, incomplete: boolean) {
    const u = r['usage']
    if (isObject(u)) {
      const { input_tokens: input, output_tokens: output } = u
      if (!isIndex(input) || !isIndex(output)) return fail(malformed('usage input_tokens or output_tokens is not a count'))
      const cached = count(obj(u['input_tokens_details'])['cached_tokens'])
      const reasoning = obj(u['output_tokens_details'])['reasoning_tokens']
      out.push({ t: 'usage', in: input - cached, out: output, cacheRead: cached, cacheWrite: 0, ...(isIndex(reasoning) ? { reasoning } : {}) })
      evidence = openAiUsage(u, 'openai-responses', 'final')
    }
    const why = obj(r['incomplete_details'])['reason']
    finished = true
    out.push({ t: 'finish', reason: incomplete ? (typeof why === 'string' ? why : 'incomplete') : refused ? 'refusal' : called ? 'tool_use' : 'completed' })
  }
  function event(s: Sink, data: string) {
    if (data.trim() === '[DONE]') return // the end marker compatible servers (LiteLLM, vLLM, OpenRouter) send after the terminal event
    const ev = parseJson(data)
    if (ev === undefined) return s.fail(`unparseable stream data: ${data.slice(0, 200)}`)
    if (!isObject(ev)) return s.fail(malformed('an event is not an object'))
    const type = typeof ev['type'] === 'string' ? ev['type'] : ''
    const kind = own(DELTAS, type)
    // Mark activity before validation/buffering, including several events in one transport chunk.
    if (/^response\.(output_item|content_part|function_call_arguments|output_text|refusal|reasoning)/.test(type)) s.out.push({ t: 'progress' })
    if (kind !== undefined) {
      const text = ev['delta']
      if (typeof text !== 'string') return s.fail(malformed('a delta is not text'))
      if (type === 'response.refusal.delta') refused = true
      if (text !== '') s.out.push({ t: kind, text })
    } else if (type === 'response.reasoning_summary_part.added') {
      if (summaries++ > 0) s.out.push({ t: 'thinking', text: '\n\n' })
    } else if (type === 'response.output_item.done') item(s, ev['item'])
    else if (type === 'response.completed' || type === 'response.incomplete') end(s, obj(ev['response']), type === 'response.incomplete')
    else if (type === 'response.failed') {
      const response = obj(ev['response'])
      if (isObject(response['usage'])) evidence = openAiUsage(response['usage'], 'openai-responses', 'final')
      if (Array.isArray(response['output']) && response['output'].length > 0) s.out.push({ t: 'progress' })
      const error = response['error'] ?? ev
      s.fail(typeof error === 'string' ? error : JSON.stringify(error), true)
    }
    else if (type === 'error') s.fail(JSON.stringify(ev), true)
  }
  const decoded = decoderOver(sseReader(), event, s => void (finished || s.fail('the stream ended with no finish reason')))
  return { ...decoded, evidence: () => evidence }
}

export const openaiResponses: Codec = {
  encode(n, p, m) {
    const tools = m.tools ? n.tools : []
    const base: Json = {}
    if (m.maxTokensParam) base[m.maxTokensParam] = m.maxOutputTokens
    if (!m.parallelToolCalls && tools.length > 0) base['parallel_tool_calls'] = false
    const { body, level } = params(base, p, m, n.effort, n.outputTokens)
    const sent = {
      ...body,
      model: m.id,
      instructions: n.system,
      input: toInput(n),
      ...(tools.length > 0 ? { tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false })) } : {}),
      stream: true,
      store: false,
      ...(n.affinity === undefined || 'prompt_cache_key' in body ? {} : { prompt_cache_key: n.affinity }), // the loop's cache id beside the session header, as Responses sends it; a params value wins
    }
    return { path: '/responses', body: JSON.stringify(sent), effort: level ?? 'none' }
  },
  decoder,
  stops: { completed: 'end_turn', tool_use: 'tool_use', max_output_tokens: 'max_tokens', content_filter: 'refusal', refusal: 'refusal' },
}
