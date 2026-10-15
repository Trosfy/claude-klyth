// One routed step inside klythd: the target resolved from the config the request carries, the key (whose
// approval check this is), the request encoded by its kind's codec, the answer decoded into StepEvents (a
// tool call only whole and parsed), and one debug line. Pure over a port: main.ts owns the transport.
import { isObject, own, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import { klythUserAgent } from '../hooks/product'
import { resolve } from '../hooks/names'
import { mintToolId, statsEvent } from '../hooks/protocol'
import type { ProviderStatus, SessionScope, StepEvent, StepWire, Usage, Wire } from '../hooks/protocol'
import { validateUsageEvidence } from '../hooks/usage-evidence'
import type { UsageEvidence, UsageExecutionSummary, UsageAttemptSummary } from '../hooks/usage-evidence'
import { coalesce } from '../hooks/step'
import { createKeys } from './auth'
import type { Runner } from './auth'
import { parseJson } from './codec'
import type { Codec, Decoded } from './codec'
import { CODECS } from './codecs'
import { cutText, ERROR_TEXT_MAX, errorDetail, httpErrorText, knownFix, logJson, oneLine, retryWait, MAX_ATTEMPTS } from './errors'
import type { Cut } from './errors'
import { normalize, remoteIds } from './history'
import type { Placed } from './history'
import { capture, invalidSessionScope, lookup, memoryStore, unavailable, type ResponseStore } from './responses'
// A provider request as the transport sends it: the stall window and an optional finite whole-request bound in seconds.
export type UpstreamRequest = { url: string; allowHttp: boolean; headers: Record<string, string>; body: string; stallS: number; totalS?: number }
// The provider's answer: its status and `retry-after` header (as sent), its body's bytes as they come (ending with how
// the body was cut, undefined when it ended), and `cancel`, which ends the request whether or not the body was read; or
// how the request was cut before any answer.
type Reply = { status: number; retryAfter?: string; body: AsyncGenerator<Uint8Array, Cut | undefined>; cancel(): void }
export type Answer = Reply | { cut: Cut }
export type Env = {
  version: string
  post(r: UpstreamRequest, signal: AbortSignal): Promise<Answer>
  run: Runner
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void> // ends early when `signal` aborts
  log(line: string): void
  requestHeaders?: (p: ProviderConfig) => { originator?: string; userAgent?: string } | { error: string }
  responses?: (scope: SessionScope) => ResponseStore // the file store of a step's session; absent, steps use one memory store
  trace?: true // logs the first input item that differs from the loop's last step (a digest per item per step): KLYTH_PREFIX_TRACE=1
}
// A finish reason as the short lowercase token the debug line, the stats and /klyth may show; any other text reads as `other`.
const finishToken = (reason: string) => reason.toLowerCase().match(/^[a-z0-9_.-]{1,64}$/)?.[0] ?? 'other'
type DaemonEvent = StepEvent | UsageExecutionSummary
// Decoded events as StepEvents: a tool call gets a minted id (its own id remembered for `provider`) once its
// input parses as an object. The first error ends the reading (`failed`); `end` gives the usage and one stop, or
// one error, and the finish reason as a token; `turn` gives the calls minted and the thinking blocks read, each
// with the number of text blocks (a run of text deltas is one, as the mod builds them) and calls before it.
export function assembler(codec: Codec, provider: string, ids: ReturnType<typeof remoteIds>, mint = mintToolId) {
  let failure: Extract<Decoded, { t: 'error' }> | undefined
  let progress = false
  let finish: string | undefined
  let usage: Usage | undefined
  let evidence: UsageEvidence | undefined
  let before = 0
  let inText = false
  const turn = { calls: [] as string[], blocks: [] as Placed[] }
  return {
    feed(ds: readonly Decoded[]): StepEvent[] {
      const out: StepEvent[] = []
      for (const d of ds) {
        if (failure !== undefined) break
        if (d.t !== 'usage' && d.t !== 'error') progress = true
        if (d.t === 'progress') continue
        if (d.t === 'text' || d.t === 'thinking') {
          if (d.t === 'text' && !inText) before++
          inText = d.t === 'text'
          out.push({ type: d.t, text: d.text })
        } else if (d.t === 'sealed') turn.blocks.push({ at: before, block: d.block })
        else if (d.t === 'usage') usage = { in: d.in, out: d.out, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, ...(d.reasoning === undefined ? {} : { reasoning: d.reasoning }) }
        else if (d.t === 'finish') finish = finishToken(d.reason)
        else if (d.t === 'error') failure = d
        else {
          const input = typeof d.args === 'string' ? parseJson(d.args.trim() === '' ? '{}' : d.args) : d.args
          if (d.name === '') failure = { t: 'error', message: 'a tool call arrived with no name' }
          else if (!isObject(input)) failure = { t: 'error', message: `the ${d.name} call's arguments are not a JSON object` }
          else {
            const id = mint()
            if (d.id !== undefined) ids.remember(provider, id, d.id)
            turn.calls.push(id)
            before++
            inText = false
            out.push({ type: 'tool_use', id, name: d.name, input })
          }
        }
      }
      return out
    },
    // `cut` is the transport's failure text, when the response was cut short.
    end(p: ProviderConfig, cut?: string, maintenance = false, tries = 1): { events: StepEvent[]; finish: string; note?: string } {
      if (cut !== undefined) return { events: [{ type: 'error', kind: 'request', text: cut }], finish: 'error' }
      if (failure !== undefined) {
        const { message, type } = errorDetail(failure.message)
        const text = `klyth: ${p.id} response failed: ${oneLine(message, 300)}${tries > 1 ? ` after ${tries} attempts` : ''}; ${knownFix(p.id, type) ?? 'retry, or see the debug log'}`
        return { events: [{ type: 'error', kind: 'response', text }], finish: 'error' }
      }
      const reason = own(codec.stops, finish ?? 'stop')
      if (maintenance && (finish === undefined || reason !== 'end_turn')) return { events: [{ type: 'error', kind: 'response', text: 'klyth: compaction requires a recognized successful provider finish' }], finish: 'error' }
      const events: StepEvent[] = [...(usage === undefined ? [] : [{ type: 'usage' as const, ...usage }]), { type: 'stop', reason: reason ?? 'end_turn' }]
      return { events, finish: finish ?? 'none', ...(reason === undefined ? { note: `finish_reason "${finish}" read as end_turn` } : {}) }
    },
    failed: () => failure !== undefined,
    retryFailure: () => !progress && failure?.provider ? failure.message : undefined,
    usage: () => usage,
    observeEvidence: (value: UsageEvidence | undefined) => { evidence = value === undefined ? undefined : validateUsageEvidence(value) },
    evidence: () => evidence,
    turn: () => turn,
  }
}

// The provider's error body, its first 4 KiB, as text; the request ends with it.
async function errorBody({ body, cancel }: Reply): Promise<string> {
  let text = ''
  try {
    for await (const piece of body) if ((text += new TextDecoder().decode(piece)).length >= ERROR_TEXT_MAX) break
  } finally {
    cancel()
  }
  return text.slice(0, ERROR_TEXT_MAX)
}

export function createStepper(env: Env) {
  // Fingerprints compare requests only within this daemon load; the private salt prevents prompt guessing.
  const salt = crypto.randomUUID() + crypto.randomUUID()
  const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\0${JSON.stringify(value) ?? 'undefined'}`).buffer as ArrayBuffer))).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
  const safeHash = (value: unknown) => hash(value).catch(() => 'unavailable')
  const load = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const keys = createKeys(env.run, env.now)
  const memory = memoryStore(), unbounded = new Set<string>() // the loops whose transcript outgrew the anchor path, logged once each
  const prefixes = new Map<string, string[]>() // each loop and route's last step input, item digests
  let memo: { text: string; config: Config | undefined } | undefined
  const configOf = (text: string) => (memo?.text === text ? memo : (memo = { text, config: parseConfig(text).config })).config

  async function* stepWithAccounting(w: StepWire, signal: AbortSignal, ready?: () => Promise<boolean>): AsyncGenerator<DaemonEvent, void> {
    const req = w.req
    const started = performance.now()
    let ttfbMs: number | null = null
    let reqBytes = 0
    let http = '-'
    let effort = '-'
    let notes = ''
    let diagnostic = ` load=${load}`
    let restored = () => ''
    const attempts: UsageAttemptSummary[] = []
    const config = configOf(w.configText)
    const t = config === undefined ? undefined : resolve(config, req.target)
    // The step's events end with one stop or error and the stats; the debug line goes out with the stats.
    const close = (events: StepEvent[], finish: string, u?: Usage, extra = ''): DaemonEvent[] => {
      const st = statsEvent({ ttfbMs, totalMs: Math.round(performance.now() - started), reqBytes, in: u === undefined ? null : u.in + u.cacheRead + u.cacheWrite, out: u?.out ?? null, ...(u?.reasoning === undefined ? {} : { reasoning: u.reasoning }), finish })
      const error = events.find(e => e.type === 'error')
      env.log(
        `klyth step ${req.who} → ${t?.kind === 'remote' ? t.target : req.target} kind=${t?.kind === 'remote' ? t.provider.kind : '-'} http=${http} effort=${effort} msgs=${req.transcript.length} tools=${req.tools.length} bytes=${reqBytes} ttfb=${ttfbMs ?? '-'} total=${st.totalMs} in=${st.in ?? '-'} out=${st.out ?? '-'} cache=${u?.cacheRead ?? '-'} wrote=${u?.cacheWrite ?? '-'} reasoning=${u?.reasoning ?? '-'}${diagnostic}${restored()} finish=${finish}${notes}${extra}${error?.type === 'error' ? ` error=${logJson(error.text)}` : ''}`,
      )
      const summary: UsageExecutionSummary | undefined = w.accounting === undefined ? undefined : {
        type: 'usage_summary',
        ...w.accounting,
        outcome: finish === 'aborted' ? 'aborted' : attempts.length === 0 ? 'refused' : finish === 'error' ? 'failure' : 'success',
        attempts: attempts.map(attempt => ({ ...attempt })),
      }
      return [...(summary === undefined ? [] : [summary]), ...events, st]
    }
    const refuse = (text: string) => close([{ type: 'error', kind: 'request', text }], 'error')
    if (t?.kind !== 'remote') return yield* refuse(`klyth: ${req.target} is not configured in this session; run /klyth reload`)
    const { provider: p, model: m } = t
    const c = req.compaction
    if (c !== undefined && (!isObject(c) || (c.prefixMessages !== undefined && (!Number.isInteger(c.prefixMessages) || c.prefixMessages < 0 || c.prefixMessages >= req.transcript.length)) || (c.outputTokens !== undefined && (!Number.isInteger(c.outputTokens) || c.outputTokens < 1 || c.outputTokens > Math.min(8000, m.maxOutputTokens))))) return yield* refuse('klyth: invalid compaction request')
    const invalid = invalidSessionScope(w.session), loop = req.cacheLoop ?? req.who
    if (invalid !== undefined) return yield* refuse(invalid)
    let look: Awaited<ReturnType<typeof lookup>>
    try { look = await lookup(w.session !== undefined && env.responses ? env.responses(w.session) : memory, req, p, m.id, env.log, unbounded) } catch (err) { return yield* refuse(unavailable(err, w.session?.configDir)) }
    restored = look.restored
    // Optional client headers apply only where the composition root permits them.
    const identity = env.requestHeaders?.(p) ?? {}
    if ('error' in identity) return yield* refuse(`klyth: ${identity.error}`)
    const approved = new Set(w.approved)
    keys.prune(approved)
    const codec = CODECS[p.kind]
    let key = await keys.get(p, approved)
    if ('error' in key) return yield* refuse(key.error)
    // normalize() reads a turn's blocks from the store on first reference: a store closed meanwhile (another session) refuses.
    let enc: ReturnType<Codec['encode']>
    try { enc = codec.encode({ system: req.system, ...(p.sessionHeader === undefined ? {} : { affinity: look.affinity }), messages: normalize(req.transcript, m.vision, look.remote, look.sealed, look.message, look.store.agent), tools: req.tools, ...(c === undefined ? {} : { maintenance: true as const, ...(c.prefixMessages === undefined ? {} : { prefixMessages: normalize(req.transcript.slice(0, c.prefixMessages), m.vision, look.remote, look.sealed, look.message).length }) }), ...(req.effort === undefined ? {} : { effort: req.effort }) , ...(c?.outputTokens === undefined ? {} : { outputTokens: c.outputTokens }) }, p, m) } catch (err) { if ((err as { code?: unknown }).code === undefined) throw err; return yield* refuse(unavailable(err, w.session?.configDir)) }
    if (enc.rejected !== undefined) return yield* refuse(enc.rejected)
    effort = typeof req.effort === 'string' && enc.effort !== req.effort && enc.effort !== 'none' ? `${req.effort}→${enc.effort}` : enc.effort
    reqBytes = new TextEncoder().encode(enc.body).length
    if (enc.lost) notes = ' note="thinking param left out: the signed blocks of this tool turn are not held"'
    const configured = Object.fromEntries(Object.entries({ ...p.headers, ...m.headers }).map(([k, v]) => [k.toLowerCase(), v]))
    // After the configured headers, so a static one of the same name cannot hide the id; before the identity overrides, which set only originator and User-Agent.
    const session = p.sessionHeader === undefined || look.affinity === undefined ? {} : { [p.sessionHeader.toLowerCase()]: look.affinity }
    const headers: Record<string, string> = { 'content-type': 'application/json', ...enc.headers, 'user-agent': klythUserAgent(env.version), ...configured, ...session, ...(identity.originator === undefined ? {} : { originator: identity.originator }), ...(identity.userAgent === undefined ? {} : { 'user-agent': identity.userAgent }) }
    const bound = Math.min(p.timeoutMs ?? Infinity, req.timeoutMs ?? Infinity) // the request's bound, or the provider's when smaller
    const byRequest = (req.timeoutMs ?? Infinity) < (p.timeoutMs ?? Infinity) // the request's bound is the tighter
    const stallS = Math.max(1, Math.floor(Math.min(600, bound / 1000)))
    const totalS = bound === Infinity ? undefined : Math.ceil(bound / 1000)
    const left = () => totalS === undefined ? Infinity : totalS * 1000 - (performance.now() - started) // ms of the step's bound not yet spent
    const { messages, input, system, instructions, tools, toolConfig, ...params } = JSON.parse(enc.body) as Record<string, unknown>
    const encoded = (input ?? messages ?? []) as unknown[]
    // Traced, a step that does not extend the last step of its loop and route names the first input item that differs.
    if (env.trace) {
      const digests = await Promise.all(encoded.map(safeHash)), changed = (prefixes.get(`${loop}\0${look.owner}`) ?? []).findIndex((d, i) => d !== digests[i])
      if (changed >= 0) env.log(`klyth responses: prefix changed at item ${changed} of ${digests.length} (${loop}, ${req.accounting?.purpose ?? '-'})`)
      if (req.accounting?.purpose === 'step') prefixes.set(`${loop}\0${look.owner}`, digests)
    }
    const oa = p.kind === 'openai'
    const history = oa ? encoded.slice(1) : encoded
    const indices = history.map((_, i) => i).filter(i => i < 16 || i >= history.length - 16)
    const sampled: string[] = []
    for (const i of indices) sampled.push(`${i}:${await safeHash(history[i])}`)
    // First-item metadata and at most sixteen blocks, with no provider-controlled label or plaintext.
    const { content: firstContent, ...firstMeta } = isObject(history[0]) ? history[0] : {}
    const firstBlocks: unknown[] = Array.isArray(firstContent) ? firstContent : firstContent === undefined ? [] : [firstContent]
    const firstSample: string[] = []
    for (let i = 0; i < firstBlocks.length; i++) {
      if (i >= 8 && i < firstBlocks.length - 8) continue
      const b = firstBlocks[i], type = isObject(b) ? b['type'] : typeof b === 'string' ? 'text' : 'other'
      const kind = ['text', 'input_text', 'output_text', 'image', 'input_image', 'image_url', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(String(type)) ? type : 'other'
      firstSample.push(`${i}:${kind}:${JSON.stringify(b)?.length ?? 0}:${await safeHash(b)}`)
    }
    const prefix = ` system=${await safeHash(oa ? encoded.slice(0, 1) : system ?? instructions)} tools=${await safeHash(tools ?? toolConfig)} params=${await safeHash({ ...params, prompt_cache_key: undefined })} historyTotal=${history.length} historyOmitted=${history.length - indices.length} history=${sampled.join(',') || '-'} firstMeta=${await safeHash(firstMeta)} firstBlocksTotal=${firstBlocks.length} firstBlocksOmitted=${firstBlocks.length - firstSample.length} firstBlocks=${firstSample.join(',') || '-'}`
    diagnostic = ` load=${load} session=${p.sessionHeader === undefined || headers[p.sessionHeader.toLowerCase()] === undefined ? '-' : await safeHash(headers[p.sessionHeader.toLowerCase()])}${prefix}`
    // A timeout names the step's whole bound, not the part of it a resend was given.
    const bounded = (c: Cut): Cut => (c.kind === 'total' && totalS !== undefined ? { ...c, detail: String(totalS) } : c)
    let tries = 0
    let refreshed = false
    const retry = async (a: Parameters<typeof retryWait>[0], text: string, reason: string) => {
      const wait = signal.aborted || c !== undefined || w.dispatch !== undefined ? undefined : retryWait(a, text, tries, env.now())
      if (wait === undefined || wait >= left()) return false
      env.log(`klyth retry ${req.who} → ${t.target} attempt=${tries + 1} after=${reason} wait=${wait}`)
      await env.sleep(wait, signal)
      return true
    }
    // One owner counts all sends; a refresh replaces only the key, never the body, route or deadline.
    for (;;) {
      if (signal.aborted) return void close([], 'aborted')
      if (left() <= 0) return yield* refuse(cutText(p, bounded({ kind: 'total', detail: '' }), byRequest, tries))
      const sentHeaders: Record<string, string> = { ...headers, ...(key.key === null ? {} : p.authHeader === 'x-api-key' ? { 'x-api-key': key.key } : { authorization: `Bearer ${key.key}` }) }
      if (w.dispatch !== undefined && (ready === undefined || (await ready()) !== true)) return yield* refuse('klyth: dispatch rejected')
      if (signal.aborted) return void close([], 'aborted')
      if (left() <= 0) return yield* refuse(cutText(p, bounded({ kind: 'total', detail: '' }), byRequest, tries))
      tries++
      const attempt: UsageAttemptSummary = { sequence: tries, outcome: 'unknown' }
      attempts.push(attempt)
      const answer = await env.post({ url: `${p.baseUrl}${enc.path}`, allowHttp: p.allowHttp, headers: sentHeaders, body: enc.body, stallS, ...(totalS === undefined ? {} : { totalS: Math.ceil(left() / 1000) }) }, signal)
      if (signal.aborted) {
        attempt.outcome = 'aborted'
        if ('status' in answer) answer.cancel()
        return void close([], 'aborted')
      }
      http = 'status' in answer ? String(answer.status) : '-'
      if ('cut' in answer) attempt.outcome = 'transportError'
      else if (answer.status < 200 || answer.status > 299) attempt.outcome = 'httpError'
      // Refresh at most once, immediately and before any output; it consumes the shared ten-send budget.
      if (c === undefined && w.dispatch === undefined && 'status' in answer && (answer.status === 401 || answer.status === 403)) {
        keys.drop(p)
        if (!refreshed && key.cached && tries < MAX_ATTEMPTS) {
          answer.cancel()
          refreshed = true
          key = await keys.get(p, approved)
          if ('error' in key) return yield* refuse(key.error)
          continue
        }
      }
      if ('cut' in answer || answer.status < 200 || answer.status > 299) {
        const text = 'cut' in answer ? '' : await errorBody(answer)
        if (signal.aborted) return void close([], 'aborted')
        if (await retry(answer, text, 'cut' in answer ? `cut ${answer.cut.kind}` : `http ${answer.status}`)) continue
        return yield* refuse('cut' in answer ? cutText(p, bounded(answer.cut), byRequest, tries) : httpErrorText(p, answer.status, text, m.id, tries))
      }
      const decoder = codec.decoder()
      const fresh = remoteIds(), asm = assembler(codec, p.id, fresh), keep = req.accounting?.purpose === 'step' ? capture(look.store, loop, look.owner, look.anchor, fresh.of(p.id)) : async () => {}
      let cut: Cut | undefined
      while (!signal.aborted && !asm.failed()) {
        if (left() <= 0) { cut = { kind: 'total', detail: String(totalS) }; break }
        const piece = await answer.body.next()
        if (left() <= 0) { cut = { kind: 'total', detail: String(totalS) }; break }
        if (piece.done) {
          cut = piece.value
          break
        }
        ttfbMs ??= Math.round(performance.now() - started)
        // A batch's records are written before it is yielded; a write that fails ends the step unseen.
        const batch = asm.feed(decoder.feed(piece.value))
        try { await keep(batch, asm.turn()) } catch (err) { answer.cancel(); return yield* refuse(unavailable(err, w.session?.configDir)) }
        yield* coalesce(batch)
        asm.observeEvidence(decoder.evidence?.())
        if (asm.evidence() !== undefined) attempt.evidence = asm.evidence()
      }
      if (asm.failed() || signal.aborted || cut !== undefined) answer.cancel()
      if (signal.aborted) return void close([], 'aborted')
      const tail = cut === undefined ? asm.feed(decoder.end()) : []
      if (cut === undefined) asm.observeEvidence(decoder.evidence?.())
      if (asm.evidence() !== undefined) attempt.evidence = asm.evidence()
      const failure = asm.retryFailure()
      if (failure !== undefined && cut === undefined && await retry({ failure, retryAfter: answer.retryAfter }, '', 'stream server/overload')) {
        attempt.outcome = 'responseError'
        continue
      }
      const end = asm.end(p, cut === undefined ? undefined : cutText(p, bounded(cut), byRequest), c !== undefined, tries)
      const observed = asm.evidence()
      if (observed !== undefined) attempt.evidence = observed
      attempt.outcome = cut !== undefined ? 'cut' : end.finish === 'error' ? 'responseError' : 'success'
      const { calls, blocks } = asm.turn()
      if (end.finish !== 'error' && calls.length > 0 && blocks.length > 0) notes += ` thinking=${blocks.length}`
      try { await keep(tail, asm.turn(), end.finish !== 'error') } catch (err) { answer.cancel(); return yield* refuse(unavailable(err, w.session?.configDir)) }
      yield* coalesce(tail)
      return yield* close(end.events, end.finish, end.finish === 'error' ? undefined : asm.usage(), end.note === undefined ? '' : ` note=${logJson(end.note)}`)
    }
  }

  async function* step(w: StepWire, signal: AbortSignal, ready?: () => Promise<boolean>): AsyncGenerator<StepEvent, void> {
    for await (const event of stepWithAccounting(w, signal, ready)) if (!('type' in event) || event.type !== 'usage_summary') yield event as StepEvent
  }

  // Each provider's key state, after forgetting those no longer approved; runs nothing.
  function status(w: Wire): ProviderStatus[] {
    keys.prune(new Set(w.approved))
    return keys.status(configOf(w.configText))
  }

  return { step, stepWithAccounting, status, config: configOf }
}
