// What a codec is: one provider kind's request encoder and response decoder, and the pieces codecs share. Pure.
import type { Effort } from '../types'
import { EFFORTS, isObject } from '../hooks/config'
import { maintenanceParams } from '../hooks/maintenance-params'
import type { ModelConfig, ProviderConfig } from '../hooks/config'
import type { RemoteTool, StopReason, Usage } from '../hooks/protocol'
import { ERROR_TEXT_MAX } from './errors'
import type { Message, Thinking } from './history'
type Json = Record<string, unknown>
const LINE_MAX = 16 * 1024 * 1024
// JSON text parsed, or undefined when it is not JSON.
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
// An object as it is, or an empty one for anything else.
export const obj = (v: unknown): Json => (isObject(v) ? v : {})
export const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
export const count = (v: unknown) => (isIndex(v) ? v : 0)
// A step's request as a codec encodes it.
export type Neutral = { system: string; messages: Message[]; tools: readonly RemoteTool[]; effort?: Effort | number; outputTokens?: number; maintenance?: true; prefixMessages?: number; affinity?: string }

// What a decoder reads out of a response, in order. A tool call is read whole: the decoder holds its
// fragments until its block ends, so a call cut short never appears. `args` is its arguments' JSON text, or
// the object a provider sent in its place; `finish` is the provider's finish reason as sent; `error` is a
// fault the response reported, or a response that broke its own format. `sealed` is a thinking block read
// whole, with its signature, to be sent back with the tool calls of its turn.
export type Decoded =
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'sealed'; block: Thinking }
  | { t: 'tool'; id?: string; name: string; args: string | Json }
  | ({ t: 'usage' } & Usage)
  | { t: 'finish'; reason: string }
  | { t: 'progress' } // meaningful activity buffered by the decoder; never exposed as a StepEvent
  | { t: 'error'; message: string; provider?: true } // a structured provider failure, not a decoder fault

// `feed` takes the response's bytes as they come; `end`, called once the response ended cleanly, gives what
// remains, an error when the response was incomplete.
type Decoder = { feed(bytes: Uint8Array): Decoded[]; end(): Decoded[]; evidence?(): import('../hooks/usage-evidence').UsageEvidence | undefined }
// What a decoder's handlers write to and read from: the events out so far, and the first fault, which ends
// the reading (a later one is not recorded).
export type Sink = { out: Decoded[]; failed: boolean; fail(message: string, provider?: true): void }

export type Codec = {
  // The request: its path under the provider's baseUrl, its body, the headers the kind requires, the effort
  // level applied, and `lost` when the thinking param was left out for want of a tool turn's signed blocks.
  encode(n: Neutral, p: ProviderConfig, m: ModelConfig): { path: string; body: string; headers?: Record<string, string>; effort: Effort | 'none'; lost?: true; rejected?: string }
  decoder(): Decoder
  // The stop reason each finish reason reads as; any other reads as end_turn.
  stops: Readonly<Record<string, StopReason>>
}

// Deep-merges `b` over `a`: plain objects merge, any other value replaces, and null deletes the key.
export function merge(a: Json, b: Json): Json {
  const out: Json = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k]
    else if (isObject(v) && isObject(out[k])) out[k] = merge(out[k] as Json, v)
    else out[k] = isObject(v) ? merge({}, v) : v
  }
  return out
}

// The declared effort level to apply for `requested`: itself, else the nearest declared below, else above.
export function effortLevel(m: ModelConfig, requested: unknown): Effort | undefined {
  if (m.effort === undefined || typeof requested !== 'string') return undefined
  const at = EFFORTS.indexOf(requested as Effort)
  if (at < 0) return undefined
  const declared = (e: Effort) => m.effort?.[e] !== undefined
  return [...EFFORTS.slice(0, at + 1)].reverse().find(declared) ?? EFFORTS.slice(at + 1).find(declared)
}

// The body's params in precedence order: `base` (what the kind sets first), provider params, model params,
// the model's overrides, then the applied effort level's params. Returns them with the level.
export function params(base: Json, p: ProviderConfig, m: ModelConfig, effort: unknown, outputTokens?: number): { body: Json; level: Effort | undefined } {
  const level = effortLevel(m, effort)
  const body = [p.params, m.params, m.overrides ?? {}, level === undefined ? {} : (m.effort?.[level] ?? {})].reduce(merge, base)
  return { body: maintenanceParams(body, p, m, outputTokens), level }
}

// Whether a request that asks for thinking (`thinking.type` enabled or adaptive; disabled, or no param, is
// sent as it stands) is in a tool turn (the messages after the last user message with no tool result) with a
// call whose signed thinking blocks klythd does not hold, so the request cannot send them back.
export const lostThinking = (thinking: unknown, messages: readonly Message[]) =>
  isObject(thinking) &&
  (thinking['type'] === 'enabled' || thinking['type'] === 'adaptive') &&
  messages.slice(messages.findLastIndex(m => m.role === 'user' && !m.content.some(b => b.type === 'tool_result')) + 1).some(m => m.unsealed)

// The last two user turns, which take cache marks beside the system prompt and the tools (the four a request
// may carry): the turn before the newest holds the mark the previous step wrote, so this step reads it
// however many blocks the tool turn since has added.
export const lastUsers = <M extends { role: string }>(messages: readonly M[]) => messages.filter(m => m.role === 'user').slice(-2)

// The thinking blocks of a response being read, by block index: each grows with its deltas and is sealed when
// its block stops; an unsigned one cannot be sent back to the API and is dropped. A redacted block's data
// comes in base64 pieces, each padded on its own, so they are joined as bytes.
export function thinkingReader() {
  const open = new Map<unknown, { text: string; signature: string; redacted: string[] }>()
  return {
    add(index: unknown, part: { text?: string; signature?: string; redacted?: string }) {
      const block = open.get(index) ?? { text: '', signature: '', redacted: [] }
      open.set(index, { text: block.text + (part.text ?? ''), signature: block.signature + (part.signature ?? ''), redacted: part.redacted ? [...block.redacted, part.redacted] : block.redacted })
    },
    seal(index: unknown): Thinking | undefined {
      const block = open.get(index)
      open.delete(index)
      if (block === undefined) return undefined
      const [first, ...rest] = block.redacted
      if (first !== undefined) return { type: 'redacted_thinking', data: rest.length === 0 ? first : btoa(block.redacted.map(p => atob(p)).join('')) }
      return block.signature === '' ? undefined : { type: 'thinking', thinking: block.text, signature: block.signature }
    },
  }
}

// Whole lines out of response bytes as they arrive (`\r\n` read as `\n`); a character split between reads is
// held for the next. A line over 16 MiB (checked at each read) is a throw. `end` gives a last line with no newline.
function lineReader() {
  // The engine's global types leave `stream` out of decode's options.
  const text = new TextDecoder() as { decode(bytes?: Uint8Array, options?: { stream: boolean }): string }
  let held = ''
  const trim = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l)
  return {
    feed(bytes: Uint8Array): string[] {
      const chunk = text.decode(bytes, { stream: true })
      const at = chunk.lastIndexOf('\n')
      const lines = at < 0 ? [] : (held + chunk.slice(0, at)).split('\n')
      held = at < 0 ? held + chunk : chunk.slice(at + 1)
      if (held.length > LINE_MAX) {
        held = ''
        throw new Error(`the stream sent a line over ${LINE_MAX / 1024 / 1024} MiB`)
      }
      return lines.map(trim)
    },
    end: () => ((held += text.decode()) === '' ? [] : [trim(held)]),
  }
}

// The `data:` payloads of an SSE stream, by whole lines.
export function sseReader() {
  const lines = lineReader()
  const data = (ls: string[]) => ls.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
  return { feed: (bytes: Uint8Array) => data(lines.feed(bytes)), end: () => data(lines.end()) }
}

// A decoder over `source`'s items: each goes to `item` until a fault ends the reading, and a source that throws
// (a corrupt frame) is a fault. `end` adds what a response that ended cleanly still owes.
export function decoderOver<T>(source: { feed(bytes: Uint8Array): Iterable<T>; end(): Iterable<T> }, item: (s: Sink, x: T) => void, end: (s: Sink) => void): Decoder {
  const s: Sink = { out: [], failed: false, fail: (message, provider) => void (s.failed || ((s.failed = true), s.out.push({ t: 'error', message: message.slice(0, ERROR_TEXT_MAX), ...(provider ? { provider } : {}) }))) }
  const read = (items: () => Iterable<T>) => {
    s.out = []
    try {
      for (const x of items()) if (!s.failed) item(s, x)
    } catch (err) {
      s.fail((err as Error).message)
    }
    return s.out
  }
  return {
    feed: bytes => read(() => source.feed(bytes)),
    end() {
      const out = read(() => source.end())
      if (!s.failed) end(s)
      return out
    },
  }
}
