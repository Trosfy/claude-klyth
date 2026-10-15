// The `bedrock` kind (Amazon Bedrock ConverseStream): request bodies from the normalized transcript, and a
// decoder for the provider's event stream. Pure.
import { isObject } from '../../hooks/config'
import { count, decoderOver, lastUsers, lostThinking, obj, params, parseJson, thinkingReader } from '../codec'
import type { Codec, Sink } from '../codec'
import type { Message } from '../history'
import { str } from '../../hooks/transcript'
import { frameReader } from './eventstream'
import type { Frame } from './eventstream'
import { partitionedUsage } from '../../hooks/usage-evidence'
import type { UsageEvidence } from '../../hooks/usage-evidence'

type Json = Record<string, unknown>

// Bedrock refuses a blank text block (dropped) and takes images as inline bytes only (a URL image is named).
const text = (t: string): Json[] => (t.trim() === '' ? [] : [{ text: t }])
const image = (b: Extract<Message['content'][number], { type: 'image' }>): Json =>
  b.source.type === 'url' ? { text: '[image omitted: Bedrock takes inline images only]' } : { image: { format: b.source.media_type.replace('image/', ''), source: { bytes: b.source.data } } }

function blocks(b: Message['content'][number]): Json[] {
  if (b.type === 'text') return text(b.text)
  if (b.type === 'image') return [image(b)]
  if (b.type === 'tool_use') return [{ toolUse: { toolUseId: b.id, name: b.name, input: b.input } }]
  if (b.type === 'thinking') return [{ reasoningContent: { reasoningText: { text: b.thinking, signature: b.signature } } }]
  if (b.type === 'redacted_thinking') return [{ reasoningContent: { redactedContent: b.data } }]
  if (b.type === 'reasoning') return []
  const content = b.content.flatMap(c => (c.type === 'text' ? text(c.text) : [image(c)]))
  return [{ toolResult: { toolUseId: b.tool_use_id, content: content.length > 0 ? content : [{ text: '(no output)' }], ...(b.is_error ? { status: 'error' } : {}) } }]
}

// The transcript as Converse messages, which must alternate roles: an empty message is dropped, neighbours merge.
export function toMessages(messages: readonly Message[]): { role: string; content: Json[] }[] {
  const out: { role: string; content: Json[] }[] = []
  for (const msg of messages) {
    const content = msg.content.flatMap(blocks)
    if (content.length === 0) continue
    const last = out.at(-1)
    if (last?.role === msg.role) last.content.push(...content)
    else out.push({ role: msg.role, content })
  }
  return out
}

// A decoder for one response. Text and reasoning deltas pass as they arrive; a tool call is held, keyed by
// its block index, until its block stops, and so is each reasoning block, which then passes whole if it is
// signed. After an error nothing more is read.
function decoder() {
  const frames = frameReader()
  const held = new Map<unknown, { id: string; name: string; args: string }>()
  const reasoning = thinkingReader()
  let stopped = false
  let evidence: UsageEvidence | undefined

  function event({ out, fail }: Sink, f: Frame) {
    const type = f.headers[':message-type']
    const name = f.headers[':event-type'] ?? f.headers[':exception-type'] ?? f.headers[':error-code'] ?? ''
    const body = parseJson(f.payload)
    if (body === undefined && type === 'event') return fail(`unparseable ${name} event`)
    const o = obj(body)
    if (type !== 'event') return fail(`${name}: ${str(o['message']) || f.headers[':error-message'] || f.payload}`)
    const i = o['contentBlockIndex']
    if (name === 'contentBlockStart') {
      const tool = obj(o['start'])['toolUse']
      if (isObject(tool)) held.set(i, { id: str(tool['toolUseId']), name: str(tool['name']), args: '' })
    } else if (name === 'contentBlockDelta') {
      const d = obj(o['delta'])
      const r = obj(d['reasoningContent'])
      if (str(d['text']) !== '') out.push({ t: 'text', text: str(d['text']) })
      if (str(r['text']) !== '') out.push({ t: 'thinking', text: str(r['text']) })
      if (Object.keys(r).length > 0) reasoning.add(i, { text: str(r['text']), signature: str(r['signature']), redacted: str(r['redactedContent']) })
      if (isObject(d['toolUse'])) {
        const tool = held.get(i)
        if (tool === undefined) return fail('tool input arrived for a block that never started')
        tool.args += str(d['toolUse']['input'])
      }
    } else if (name === 'contentBlockStop') {
      const tool = held.get(i)
      const block = reasoning.seal(i)
      held.delete(i)
      if (tool !== undefined) out.push({ t: 'tool', ...tool })
      if (block !== undefined) out.push({ t: 'sealed', block })
    } else if (name === 'messageStop') {
      stopped = true
      out.push({ t: 'finish', reason: str(o['stopReason']) })
      if (str(o['stopReason']).startsWith('malformed_')) fail(`the model ended with stopReason "${str(o['stopReason'])}"`)
    } else if (name === 'metadata' && isObject(o['usage'])) {
      const u = o['usage']
      out.push({ t: 'usage', in: count(u['inputTokens']), out: count(u['outputTokens']), cacheRead: count(u['cacheReadInputTokens']), cacheWrite: count(u['cacheWriteInputTokens']) })
      evidence = partitionedUsage(u, 'bedrock', { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheWriteInputTokens' }, stopped ? 'final' : 'provisional')
    }
  }
  const decoded = decoderOver({ feed: bytes => frames.feed(bytes), end: () => [] }, event, ({ fail }) => {
    if (frames.pending() > 0) fail('the stream ended inside an event frame')
    else if (held.size > 0) fail('the stream ended inside a tool call')
    else if (!stopped) fail('the stream ended with no stop reason')
    else if (evidence !== undefined) evidence = { ...evidence, finality: 'final' }
  })
  return { ...decoded, evidence: () => evidence }
}

export const bedrock: Codec = {
  encode(n, p, m) {
    const tools = m.tools ? n.tools : []
    const { body, level } = params({ inferenceConfig: { maxTokens: m.maxOutputTokens } }, p, m, n.effort, n.outputTokens)
    const fields = body['additionalModelRequestFields']
    const lost = isObject(fields) && lostThinking(fields['thinking'], n.messages)
    if (lost) body['additionalModelRequestFields'] = { ...fields, thinking: undefined }
    const point = m.cache === undefined ? [] : [{ cachePoint: { type: 'default', ...(m.cache === '1h' ? { ttl: m.cache } : {}) } }]
    const messages = toMessages(n.messages)
    const prefix = n.prefixMessages === undefined ? undefined : toMessages(n.messages.slice(0, n.prefixMessages))
    if (n.maintenance && prefix !== undefined && JSON.stringify(messages.slice(0, prefix.length)) !== JSON.stringify(prefix)) return { path: '', body: '', effort: level ?? 'none', rejected: 'klyth: Bedrock maintenance would merge across the cached prefix; history kept' }
    for (const turn of lastUsers(n.maintenance ? messages.slice(0, n.prefixMessages === undefined ? -1 : prefix!.length) : messages)) turn.content.push(...point)
    const sent = {
      ...body,
      messages,
      ...(n.system.trim() === '' ? {} : { system: [{ text: n.system }, ...point] }),
      ...(tools.length > 0 ? { toolConfig: { tools: [...tools.map(t => ({ toolSpec: { name: t.name, ...(t.description === '' ? {} : { description: t.description }), inputSchema: { json: t.schema } } })), ...point] } } : {}),
    }
    return { path: `/model/${encodeURIComponent(m.id)}/converse-stream`, body: JSON.stringify(sent), effort: level ?? 'none', ...(lost ? { lost } : {}) }
  },
  decoder,
  stops: { end_turn: 'end_turn', stop_sequence: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', model_context_window_exceeded: 'max_tokens', guardrail_intervened: 'refusal', content_filtered: 'refusal' },
}
